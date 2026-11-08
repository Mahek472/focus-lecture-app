"""Recreate BBBD Experiment 2 on our headset and record it.

Protocol (BBBD paper, Exp 2, incidental learning):
  (default: 3 of BBBD's 5 videos, stims 1, 2, 5; --videos 1,2,3,4,5 for all)
  1. domain-knowledge pre-test (the shown videos' domain questions)
  2. ATTENTIVE: watch the videos in random order ("watch normally, relaxed, sit still");
     3 engagement ratings after each video
  3. memory quiz on all shown videos (cumulative, at the end; --quiz after-each for the README variant)
  4. DISTRACTED: watch the same videos again in the same order while silently counting
     back by 7 from a random prime between 800 and 1000; report the number reached after each
Each video: 3 s black -> white flash + 1 kHz beep (start marker) -> video -> flash + beep
(end marker) -> 3 s black, like the flash/beep BBBD embedded at stimulus on/offset.

This script runs a local web page (the participant screen) and the EEG recorder.
The page posts each flash to /api/marker, which becomes a BrainFlow marker in the EEG
stream: start code = 10 * condition + stim (11-15 attentive, 21-25 distracted), end = 99.
Quiz option order is shuffled per participant ("all/none/both options" stay last).

Webcam (default on, --no-camera to skip): the page records one clip per video, from the
black screen before to the black screen after, and logs each frame's capture time on the
same page clock as the markers. `sync` maps frames to EEG samples with the start/end
marker pair (BBBD's two-point linear transform) and checks that the flash, which lights
the face, shows up in the video at the marker time (BBBD validated with a StimTracker).

Repeat runs: a second run for the same participant never overwrites the first. It saves as
<participant>_s2 (then s3, ...), or under --session NAME, with its own video order and primes.
A lecture outside BBBD: --youtube ID --title "..." (or --video-file media/x.mp4); it has no quiz.

Usage
  python experiment/run_experiment.py run --participant P01 --board knight --port COM3
  python experiment/run_experiment.py run --participant P01 --port COM7 --videos 3,4        # another lecture, saved as P01_s2
  python experiment/run_experiment.py run --participant P01 --port COM7 --youtube <id> --title "My lecture"
  python experiment/run_experiment.py evaluate --participant P01 --sessions all             # all of P01's runs together
  python experiment/run_experiment.py run --participant TEST --no-eeg          # rehearse the flow
  python experiment/run_experiment.py evaluate --participant P01
  python experiment/run_experiment.py sync --participant P01                   # webcam frames -> EEG samples
then open http://localhost:8765 in Chrome, press F11 for full screen.
"""
import argparse
import json
import os
import random
import re
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
from headset_session import END, REC_DIR, blocks_from_markers, connect, load_rec  # noqa: E402
from preprocess import HEADSET_8  # noqa: E402

PINNED = re.compile(r"(?i)^(all|none|both) (of the )?(options|above)")
PRIMES = [p for p in range(801, 1000) if all(p % d for d in range(2, int(p ** 0.5) + 1))]


# ---------------------------------------------------------------- randomization

def shuffle_question(q, rng):
    """Shuffle options, keep 'All/None/Both options...' at the end; track the correct index."""
    idx = list(range(len(q["options"])))
    free = [i for i in idx if not PINNED.match(q["options"][i])]
    pinned = [i for i in idx if PINNED.match(q["options"][i])]
    rng.shuffle(free)
    order = free + pinned
    return {"id": q["id"], "text": q["text"], "options": [q["options"][i] for i in order],
            "correct": order.index(q["correct"]), "source_order": order}


CUSTOM_STIM = 9  # a lecture outside BBBD's five (marker codes 19 / 29); it has no quiz


def run_tag(participant, session=None):
    """File prefix: <participant> for the first run (unchanged), <participant>_<session> for later runs."""
    return f"{participant}_{session}" if session else participant


def run_exists(tag):
    return any(os.path.exists(p) for p in (f"{REC_DIR}/{tag}_exp2.npz", f"{REC_DIR}/{tag}_exp2_session.json", f"{REC_DIR}/{tag}_cam"))


def participant_tags(participant):
    """All runs on disk for a participant: the first run, then _s2, _s3, ... (and any other named sessions)."""
    tags = [participant] if run_exists(participant) else []
    if os.path.isdir(REC_DIR):
        for f in sorted(os.listdir(REC_DIR)):
            m = re.match(rf"^{re.escape(participant)}_(.+)_exp2_session\.json$", f)
            if m:
                tags.append(f"{participant}_{m.group(1)}")
    return tags


def next_free_session(participant):
    if not run_exists(participant):
        return None
    k = 2
    while run_exists(run_tag(participant, f"s{k}")):
        k += 1
    return f"s{k}"


def build_session(participant, quiz_mode, videos_subset, camera=True, extra_videos=(), seed_tag=None):
    # seeded by the run's file tag, so a second session gets its own order and primes
    rng = random.Random(f"bbbd-exp2-{seed_tag or participant}")
    stimuli = json.load(open(os.path.join(HERE, "stimuli.json")))["videos"]
    if videos_subset is not None:
        stimuli = [v for v in stimuli if v["stim"] in videos_subset]
    stimuli = stimuli + list(extra_videos)
    order = stimuli[:]
    rng.shuffle(order)
    quiz = json.load(open(os.path.join(HERE, "quiz_exp2.json"), encoding="utf-8"))["questions"]

    def block(qtype, stims):
        out = []
        for v in stims:
            qs = [shuffle_question(q, rng) for q in quiz[qtype].get(str(v["stim"]), [])]  # custom lectures: no quiz
            rng.shuffle(qs)
            out.append({"stim": v["stim"], "title": v["title"], "questions": qs})
        return out

    pre_order = stimuli[:]
    rng.shuffle(pre_order)
    mem_order = order[:]
    rng.shuffle(mem_order)
    return {"participant": participant, "run": seed_tag or participant, "quiz_mode": quiz_mode,
            "attentive_order": [v["stim"] for v in order],
            "distracted_order": [v["stim"] for v in order],  # BBBD: same order as attentive
            "videos": {v["stim"]: v for v in stimuli},
            "primes": [rng.choice(PRIMES) for _ in order],
            "domain_quiz": block("domain", pre_order),
            "memory_quiz": block("memory", mem_order),
            "black_s": 3, "flash_ms": 100, "beep_hz": 1000, "camera": camera}


# ---------------------------------------------------------------- recorder

class Recorder:
    def __init__(self, board, port, gain, channels, rld=True):
        self.channels, self.chunks, self.lock = channels, [], threading.Lock()
        self.board, self.info = (None, None)
        self.markers_log, self.running = [], False
        if board != "none":
            self.board, self.info = connect(board, port, gain, rld)
            self.running = True
            threading.Thread(target=self._poll, daemon=True).start()

    def _poll(self):
        while self.running:
            time.sleep(0.5)
            with self.lock:
                if self.running:
                    self.chunks.append(self.board.get_board_data())

    def marker(self, code, label, t_client=None):
        with self.lock:
            if self.board:
                self.board.insert_marker(float(code))
            self.markers_log.append({"code": code, "label": label, "t": time.time(), "t_client_ms": t_client,
                                     "samples_before": int(sum(c.shape[1] for c in self.chunks))})

    def status(self):
        with self.lock:
            if not self.board:
                return {"eeg": False}
            recent = self.chunks[-4:] if self.chunks else []
        if not recent:
            return {"eeg": True, "samples": 0}
        x = np.concatenate(recent, axis=1)[self.info["eeg"]] * self.info["scale"]
        sd = x.std(axis=1)
        return {"eeg": True, "sfreq": self.info["sfreq"],
                "samples": int(sum(c.shape[1] for c in self.chunks)),
                "channel_sd_uv": {n: round(float(s), 1) for n, s in zip(self.channels, sd)}}

    def stop_and_save(self, name, board_name):
        if not self.board:
            return None
        with self.lock:
            self.running = False
            self.board.insert_marker(END)
            time.sleep(0.3)
            self.chunks.append(self.board.get_board_data())
            self.board.stop_stream()
            self.board.release_session()
        raw = np.concatenate(self.chunks, axis=1)
        os.makedirs(REC_DIR, exist_ok=True)
        path = f"{REC_DIR}/{name}.npz"
        np.savez_compressed(path, data=(raw[self.info["eeg"]] * self.info["scale"]).astype(np.float32),
                            markers=raw[self.info["marker"]], uv_scale="corrected",
                            sfreq=self.info["sfreq"], ch_names=np.array(self.channels), board=board_name)
        print(f"saved {path}: {raw.shape[1] / self.info['sfreq']:.0f} s", flush=True)
        return path


# ---------------------------------------------------------------- web server

def make_handler(session, recorder, state, args):
    class H(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=os.path.join(HERE, "static"), **kw)

        def log_message(self, *a):
            pass

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/api/session":
                return self._json(session)
            if self.path == "/api/status":
                return self._json(recorder.status())
            return super().do_GET()  # page + local videos in static/media/ (stimuli.json "file")

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if self.path.startswith("/api/upload/"):  # webcam clip (.webm) or its frame times (.json)
                fname = os.path.basename(self.path.split("/api/upload/")[1])
                cam_dir = f"{REC_DIR}/{args.tag}_cam"
                os.makedirs(cam_dir, exist_ok=True)
                open(os.path.join(cam_dir, fname), "wb").write(raw)
                print(f"saved {cam_dir}/{fname} ({len(raw) / 1e6:.1f} MB)", flush=True)
                return self._json({"ok": True})
            body = json.loads(raw or b"{}")
            if self.path == "/api/marker":
                recorder.marker(body["code"], body.get("label", ""), body.get("t_client"))
                print(f"marker {body['code']:>3} {body.get('label', '')}", flush=True)
            elif self.path == "/api/event":
                state["events"].append({**body, "t_server": time.time()})
            elif self.path == "/api/answers":
                state["answers"][body["phase"]] = body["answers"]
                save_session(session, state, recorder, args)
            elif self.path == "/api/finish":
                state["finished"] = True
                save_session(session, state, recorder, args)
                threading.Thread(target=shutdown, args=(recorder, args, state), daemon=True).start()
            return self._json({"ok": True})
    return H


def score(session, answers):
    out = {}
    for phase, key in (("domain", "domain_quiz"), ("memory", "memory_quiz")):
        given = answers.get(phase)
        if not given:
            continue
        per_stim = {}
        for blk in session[key]:
            qs = blk["questions"]
            right = sum(1 for q in qs if given.get(f"{blk['stim']}-{q['id']}") == q["correct"])
            per_stim[blk["stim"]] = {"correct": right, "total": len(qs)}
        out[phase] = per_stim
    return out


def save_session(session, state, recorder, args):
    os.makedirs(REC_DIR, exist_ok=True)
    out = {**session, "board": args.board, "channels": args.channels, "markers": recorder.markers_log,
           "events": state["events"], "answers": state["answers"], "scores": score(session, state["answers"])}
    json.dump(out, open(f"{REC_DIR}/{args.tag}_exp2_session.json", "w", encoding="utf-8"), indent=1)


def shutdown(recorder, args, state):
    time.sleep(0.5)
    recorder.stop_and_save(f"{args.tag}_exp2", args.board)
    print("session finished; Ctrl+C to quit (or it exits in 3 s)", flush=True)
    time.sleep(3)
    os._exit(0)


def cmd_run(args):
    # never overwrite an earlier run: a repeat for the same participant becomes session s2, s3, ...
    if args.session is None:
        args.session = next_free_session(args.participant)
        if args.session:
            print(f"{args.participant} already has a recording; keeping it. This run saves as {run_tag(args.participant, args.session)}.", flush=True)
    args.tag = run_tag(args.participant, args.session)
    if run_exists(args.tag):
        sys.exit(f"{args.tag} already has recordings in {REC_DIR}/. Pick another --session name; nothing was overwritten.")
    extra = []
    if args.youtube or args.video_file:
        extra.append({"stim": CUSTOM_STIM, "title": args.title or "Lecture", "channel": "", "youtube": args.youtube,
                      "duration_s": args.length or 0, "file": args.video_file})
    session = build_session(args.participant, args.quiz, args.videos, camera=not args.no_camera,
                            extra_videos=extra, seed_tag=args.tag)
    print(f"run {args.tag}: videos {[session['videos'][s]['title'] for s in session['attentive_order']]}", flush=True)
    print("attentive/distracted order:", session["attentive_order"], flush=True)
    recorder = Recorder("none" if args.no_eeg else args.board, args.port, args.gain, args.channels,
                        rld=not args.no_rld)
    state = {"events": [], "answers": {}, "finished": False}
    ThreadingHTTPServer.allow_reuse_address = False  # on Windows reuse lets a stale server share the port
    srv = ThreadingHTTPServer(("127.0.0.1", args.http_port), make_handler(session, recorder, state, args))
    url = f"http://localhost:{args.http_port}"
    print(f"participant screen: {url}  (Chrome, F11 for full screen)", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\ninterrupted: saving what was recorded", flush=True)
        save_session(session, state, recorder, args)
        recorder.stop_and_save(f"{args.tag}_exp2", args.board)


# ---------------------------------------------------------------- evaluate

def cmd_evaluate(args):
    """BBBD 'calibrated' split on our own recording: leave one video out (both conditions)."""
    from sklearn.metrics import roc_auc_score
    from focus_model import FocusModel, clean, to_bands
    from preprocess import windows

    # which runs: --sessions all (every run of this participant), a comma list ("first" = the
    # unsuffixed first run), or just the one named by --session
    if args.sessions == "all":
        tags = participant_tags(args.participant)
    elif args.sessions:
        tags = [run_tag(args.participant, None if s == "first" else s) for s in args.sessions.split(",")]
    else:
        tags = [args.tag]
    tags = [t for t in tags if os.path.exists(f"{REC_DIR}/{t}_exp2.npz")]
    if not tags:
        sys.exit(f"no recordings found for {args.participant} in {REC_DIR}/")
    name = f"{tags[0]}_exp2" if len(tags) == 1 else f"{args.participant}_combined_exp2"
    recs, mem, ch, sf = [], {}, None, None
    for tag in tags:
        data, d = load_rec(f"{REC_DIR}/{tag}_exp2.npz")
        sf, ch = float(d["sfreq"]), list(d["ch_names"])
        x = clean(data, sf)
        xb = to_bands(x, sf)
        proto = FocusModel(ch, sf, blink_uv=args.blink_uv)
        for b in blocks_from_markers(d["markers"]):
            cond, stim = divmod(b["code"], 10)
            if cond not in (1, 2):
                continue
            s = b["start"] + int(args.settle_s * sf)
            wb, _ = windows(xb[..., s:b["end"]], sf, proto.win_s)
            w, _ = windows(x[:, s:b["end"]], sf, proto.win_s)
            keep = proto.blink_mask(w)
            # a video is identified by run + stimulus, so the same lecture in two sessions stays separate
            group = stim if len(tags) == 1 else f"{tag.removeprefix(args.participant).lstrip('_') or 'first'}:{stim}"
            recs.append({"stim": group, "y": cond - 1, "Xb": wb[keep], "dropped": int((~keep).sum())})
        sess_file = f"{REC_DIR}/{tag}_exp2_session.json"
        if os.path.exists(sess_file):
            for k, v in json.load(open(sess_file, encoding="utf-8")).get("scores", {}).get("memory", {}).items():
                mem[k if len(tags) == 1 else f"{tag.removeprefix(args.participant).lstrip('_') or 'first'}:{k}"] = v
    empty = [f"{('attentive', 'distracted')[r['y']]} {r['stim']}" for r in recs if not len(r["Xb"])]
    if empty:
        print(f"skipped (no usable 2 s windows after blink rejection): {', '.join(empty)}")
    recs = [r for r in recs if len(r["Xb"])]
    stims = sorted({r["stim"] for r in recs}, key=str)
    print(f"runs: {', '.join(tags)}; {len(recs)} recordings ({len(stims)} videos x conditions); "
          f"{sum(r['dropped'] for r in recs)} blink windows dropped")
    stack = lambda rs: (np.concatenate([r["Xb"] for r in rs]),
                        np.concatenate([np.full(len(r["Xb"]), r["y"]) for r in rs]))
    aucs, focus = {}, {}
    if len(stims) >= 2:  # BBBD calibrated split: leave one video out
        method = "Leave-one-video-out"
        for v in stims:
            tr = [r for r in recs if r["stim"] != v]
            te = [r for r in recs if r["stim"] == v]
            if len({r["y"] for r in te}) < 2 or len({r["y"] for r in tr}) < 2:
                continue
            (Xtr, ytr), (Xte, yte) = stack(tr), stack(te)
            m = FocusModel(ch, sf).fit(Xtr, ytr)
            aucs[v] = float(roc_auc_score(yte, m.p_distracted(Xte)))
            focus[v] = {("attentive", "distracted")[r["y"]]: float(m.focus(r["Xb"]).mean()) for r in te}
    else:  # one video only: contiguous time chunks, 1-window gap around the test chunk (weaker test)
        method = "Time-chunk (one video only; same video in train and test)"
        k = 4
        for i in range(k):
            tr, te = [], []
            for r in recs:
                n = len(r["Xb"]); a, b = i * n // k, (i + 1) * n // k
                keep_tr = np.ones(n, bool); keep_tr[max(0, a - 1):min(n, b + 1)] = False
                te.append({**r, "Xb": r["Xb"][a:b]}); tr.append({**r, "Xb": r["Xb"][keep_tr]})
            (Xtr, ytr), (Xte, yte) = stack(tr), stack(te)
            m = FocusModel(ch, sf).fit(Xtr, ytr)
            aucs[f"chunk{i + 1}"] = float(roc_auc_score(yte, m.p_distracted(Xte)))
            focus[f"chunk{i + 1}"] = {("attentive", "distracted")[r["y"]]: float(m.focus(r["Xb"]).mean()) for r in te}
    print("\nfold       AUC    focus(attentive)  focus(distracted)  memory quiz")
    for v in aucs:
        q = mem.get(str(v)) or {}
        print(f"  {str(v):8s} {aucs[v]:.3f}      {focus[v].get('attentive', np.nan):.2f}             "
              f"{focus[v].get('distracted', np.nan):.2f}            {q.get('correct', '-')}/{q.get('total', '-')}")
    mean = float(np.mean(list(aucs.values())))
    verdict = ("WORKS (>= 0.70)" if mean >= 0.70 else "BORDERLINE (0.60-0.70): check signal quality"
               if mean >= 0.60 else "FAILS (< 0.60): if signal is clean, use the BBBD replay demo")
    print(f"\n{method} AUC: {mean:.3f}  (BBBD, our 8 channels: 0.872)  ->  {verdict}")
    Xall = np.concatenate([r["Xb"] for r in recs]); yall = np.concatenate([np.full(len(r["Xb"]), r["y"]) for r in recs])
    FocusModel(ch, sf).fit(Xall, yall).save(f"{REC_DIR}/{name}_model.joblib")
    json.dump({"participant": args.participant, "runs": tags, "method": method, "lovo_auc": {str(k): v for k, v in aucs.items()},
               "mean_auc": mean, "verdict": verdict, "focus": {str(k): v for k, v in focus.items()}},
              open(f"{REC_DIR}/{name}_result.json", "w"), indent=2)
    print(f"saved {REC_DIR}/{name}_model.joblib (all videos) and _result.json")


# ---------------------------------------------------------------- score with an earlier model

def cmd_score(args):
    """Apply a saved calibrated model, unchanged, to another run: calibrate once, use on a new lecture."""
    from sklearn.metrics import roc_auc_score
    from focus_model import FocusModel, clean, to_bands
    from preprocess import windows

    model_tag = run_tag(args.participant, None if args.model_session in (None, "first") else args.model_session)
    model_path = f"{REC_DIR}/{model_tag}_exp2_model.joblib"
    if not os.path.exists(model_path):
        sys.exit(f"no model at {model_path}: run evaluate on that run first")
    if args.tag == model_tag:
        sys.exit("the model and the test run are the same run; pass --session for the run to test")
    model = FocusModel.load(model_path)
    data, d = load_rec(f"{REC_DIR}/{args.tag}_exp2.npz")
    sf, ch = float(d["sfreq"]), list(d["ch_names"])
    if ch != model.ch_names:
        sys.exit(f"channel order differs: model {model.ch_names} vs run {ch}")
    x = clean(data, sf)
    xb = to_bands(x, sf)
    proto = FocusModel(ch, sf, blink_uv=args.blink_uv)
    rows, ys, ps = [], [], []
    for b in blocks_from_markers(d["markers"]):
        cond, stim = divmod(b["code"], 10)
        if cond not in (1, 2):
            continue
        s = b["start"] + int(args.settle_s * sf)
        wb, _ = windows(xb[..., s:b["end"]], sf, proto.win_s)
        w, _ = windows(x[:, s:b["end"]], sf, proto.win_s)
        keep = proto.blink_mask(w)
        if not keep.any():
            continue
        p = model.p_distracted(wb[keep])
        ys.append(np.full(len(p), cond - 1)); ps.append(p)
        # how the estimate evolves inside the block: mean focus per quarter
        quarters = [float(1 - q.mean()) for q in np.array_split(p, 4) if len(q)]
        rows.append((("attentive", "distracted")[cond - 1], stim, len(p), int((~keep).sum()), float(1 - p.mean()),
                     float(np.mean(p < 0.5)), quarters))
    y, p = np.concatenate(ys), np.concatenate(ps)
    auc = float(roc_auc_score(y, p)) if len(set(y)) == 2 else float("nan")
    print(f"model: {model_tag} (trained on that run)   test run: {args.tag}")
    print("\ncondition    video  windows  blinks  mean focus  % called focused  focus by quarter")
    for cond, stim, n, drop, f, called, qs in rows:
        print(f"  {cond:10s}  {stim:>3}   {n:6d}  {drop:6d}     {f:.2f}        {called * 100:5.0f}%        "
              + "  ".join(f"{q:.2f}" for q in qs))
    caught = float(np.mean(p[y == 1] >= 0.5)) if (y == 1).any() else float("nan")
    kept = float(np.mean(p[y == 0] < 0.5)) if (y == 0).any() else float("nan")
    # AUC only checks the ordering; the app acts on the 0.5 threshold, so both must hold
    if caught < 0.3 or kept < 0.3:
        verdict = (f"NOT USABLE AS SAVED: ordering AUC {auc:.2f}, but only {caught:.0%} of counting and {kept:.0%} of watching "
                   "land on the right side of 0.5 (signal level shifted between sessions; needs re-centering)")
    else:
        verdict = ("WORKS (>= 0.70)" if auc >= 0.70 else "BORDERLINE (0.60-0.70)" if auc >= 0.60 else "DOES NOT TRANSFER (< 0.60)")
    print(f"\nAUC on the new lecture: {auc:.3f}; counting caught {caught:.0%}, watching kept {kept:.0%}")
    print(f"-> {verdict}")
    print("Reference: on BBBD, training on one video and testing on others averaged 0.80 (our 8 channels, 4 s), "
          "0.75 with 2 s windows.")
    out = f"{REC_DIR}/{args.tag}_scored_with_{model_tag}.json"
    json.dump({"model": model_tag, "test_run": args.tag, "auc": auc, "counting_caught": caught, "watching_kept": kept, "verdict": verdict,
               "blocks": [dict(condition=c, video=s, windows=n, blink_dropped=dr, mean_focus=f, called_focused=cf, quarters=q)
                          for c, s, n, dr, f, cf, q in rows]}, open(out, "w"), indent=2)
    print(f"saved {out}")


# ---------------------------------------------------------------- webcam sync

def read_clip(webm):
    """Frame timestamps (ms from recording start, from the WebM container) and mean brightness."""
    import cv2
    cap, pts, bright = cv2.VideoCapture(webm), [], []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        pts.append(cap.get(cv2.CAP_PROP_POS_MSEC))
        bright.append(float(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).mean()))
    return np.asarray(pts), np.asarray(bright)


def flash_lag_ms(t, bright, t_flash, window_ms=1000):
    """Validation like BBBD's StimTracker: the white flash lights the face, so the webcam sees
    a brightness jump. Return its time minus the marker time (ms), or None if not found."""
    near = np.flatnonzero(np.abs(t - t_flash) < window_ms)
    if len(near) < 3:
        return None
    jump = np.diff(bright[near[0]:near[-1] + 1])
    if jump.max() < 3 * (np.median(np.abs(jump)) + 1e-6):  # no clear flash in view
        return None
    # the first bright frame comes 0-1 frame after the true flash onset: subtract half a frame
    half_frame = np.median(np.diff(t)) / 2
    return float(t[near[0] + 1 + int(np.argmax(jump))] - t_flash - half_frame)


def cmd_sync(args):
    """Webcam frame -> page clock -> EEG sample, per clip.

    page time of a frame = recorder start (page clock) + the frame's WebM timestamp.
    page time -> EEG sample uses the video's start/end markers, the two-point linear transform
    BBBD used to put its devices on one timeline. The flash, visible on the face, measures any
    residual webcam offset; with both flashes found, frame times are shifted by their mean.
    """
    name = f"{args.tag}_exp2"
    sess = json.load(open(f"{REC_DIR}/{name}_session.json", encoding="utf-8"))
    log = [m for m in sess["markers"] if m.get("t_client_ms") is not None]
    eeg, sf = None, None
    if os.path.exists(f"{REC_DIR}/{name}.npz"):
        d = np.load(f"{REC_DIR}/{name}.npz")
        idx = np.flatnonzero(d["markers"])
        eeg, sf = list(zip(d["markers"][idx].astype(int), idx)), float(d["sfreq"])  # (code, sample)
    cam_dir = f"{REC_DIR}/{args.tag}_cam"
    print("clip                 frames   fps  start flash  end flash  correction  EEG Hz from markers")
    for i, m in enumerate(log):
        if m["code"] == END or i + 1 >= len(log):
            continue
        cond, stim = divmod(m["code"], 10)
        clip = f"{('attentive', 'distracted')[cond - 1]}_stim{stim}"
        if not os.path.exists(f"{cam_dir}/{clip}.webm"):
            continue
        meta = json.load(open(f"{cam_dir}/{clip}.json"))
        pts, bright = read_clip(f"{cam_dir}/{clip}.webm")
        t = meta["rec_start_ms"] + pts
        t0, t1 = m["t_client_ms"], log[i + 1]["t_client_ms"]
        lag0, lag1 = flash_lag_ms(t, bright, t0), flash_lag_ms(t, bright, t1)
        corr = -float(np.mean([lag0, lag1])) if lag0 is not None and lag1 is not None else 0.0
        t = t + corr
        cols, header, hz = [np.arange(len(t)), t, (t - t0) / 1000], "frame,t_page_ms,t_from_video_start_s", "-"
        if eeg and i + 1 < len(eeg):
            (c0, s0), (c1, s1) = eeg[i], eeg[i + 1]
            assert c0 == m["code"] and c1 == END, f"marker order mismatch at {clip}"
            slope = (s1 - s0) / (t1 - t0)  # EEG samples per page-clock ms
            cols.append(np.round(s0 + (t - t0) * slope))
            header += ",eeg_sample"
            hz = f"{slope * 1000:.2f} (nominal {sf:g})"
        np.savetxt(f"{cam_dir}/{clip}_frames.csv", np.column_stack(cols), delimiter=",", header=header,
                   comments="", fmt="%.3f")
        fps = (len(t) - 1) / ((t[-1] - t[0]) / 1000) if len(t) > 1 else 0
        f = lambda x: "-" if x is None else f"{x:+.0f} ms"
        print(f"{clip:20s} {len(t):6d} {fps:5.1f} {f(lag0):>12s} {f(lag1):>10s} {corr:+9.0f} ms  {hz}")
    print(f"\nwrote {cam_dir}/<clip>_frames.csv (frame -> page time -> EEG sample)")
    print("start and end flash within about +/-1 frame (~33 ms at 30 fps) of each other = consistent sync;\n"
          "'-' = flash not visible on camera (face out of frame or room too bright), no correction applied")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["run", "evaluate", "score", "sync"])
    ap.add_argument("--participant", required=True)
    ap.add_argument("--board", choices=["knight", "knight-imu", "synthetic"], default="knight")
    ap.add_argument("--port")
    ap.add_argument("--gain", type=int, default=12)
    ap.add_argument("--channels", default=",".join(HEADSET_8))
    ap.add_argument("--no-eeg", action="store_true", help="run the participant flow without a board")
    ap.add_argument("--no-camera", action="store_true", help="don't record the webcam")
    ap.add_argument("--no-rld", action="store_true", help="leave Route RLD off (as in the EXG Visualizer default)")
    ap.add_argument("--quiz", choices=["end", "after-each"], default="end")
    ap.add_argument("--videos", default=None,
                    help="BBBD stim numbers to show; default 1,2,5 (the 3 shortest), or none when --youtube/--video-file is given; "
                         "1,2,3,4,5 = full BBBD")
    ap.add_argument("--session", help="name for a repeat run of the same participant (files <participant>_<session>_*); "
                                      "run picks s2, s3, ... automatically if the participant already has data")
    ap.add_argument("--model-session", help="score: the run whose saved model to use (default: first)")
    ap.add_argument("--sessions", help="evaluate: 'all' runs of the participant, or a comma list such as first,s2")
    ap.add_argument("--youtube", help="a lecture outside BBBD: YouTube video id (no quiz for it)")
    ap.add_argument("--video-file", help="a lecture outside BBBD: file in experiment/static/media/, e.g. media/lecture.mp4")
    ap.add_argument("--title", help="title of that lecture")
    ap.add_argument("--length", type=int, help="its length in seconds (optional)")
    ap.add_argument("--http-port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--settle-s", type=float, default=2)
    ap.add_argument("--blink-uv", type=float, default=150)
    a = ap.parse_args()
    a.channels = a.channels.split(",")
    if a.videos is None:
        a.videos = "" if (a.youtube or a.video_file) else "1,2,5"
    a.videos = [int(v) for v in a.videos.split(",") if v]
    a.tag = run_tag(a.participant, a.session)
    {"run": cmd_run, "evaluate": cmd_evaluate, "score": cmd_score, "sync": cmd_sync}[a.cmd](a)


if __name__ == "__main__":
    main()
