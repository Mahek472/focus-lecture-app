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

Usage
  python experiment/run_experiment.py run --participant P01 --board knight --port COM3
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


def build_session(participant, quiz_mode, videos_subset, camera=True):
    rng = random.Random(f"bbbd-exp2-{participant}")
    stimuli = json.load(open(os.path.join(HERE, "stimuli.json")))["videos"]
    if videos_subset:
        stimuli = [v for v in stimuli if v["stim"] in videos_subset]
    order = stimuli[:]
    rng.shuffle(order)
    quiz = json.load(open(os.path.join(HERE, "quiz_exp2.json"), encoding="utf-8"))["questions"]

    def block(qtype, stims):
        out = []
        for v in stims:
            qs = [shuffle_question(q, rng) for q in quiz[qtype][str(v["stim"])]]
            rng.shuffle(qs)
            out.append({"stim": v["stim"], "title": v["title"], "questions": qs})
        return out

    pre_order = stimuli[:]
    rng.shuffle(pre_order)
    mem_order = order[:]
    rng.shuffle(mem_order)
    return {"participant": participant, "quiz_mode": quiz_mode,
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
                cam_dir = f"{REC_DIR}/{args.participant}_cam"
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
    json.dump(out, open(f"{REC_DIR}/{args.participant}_exp2_session.json", "w", encoding="utf-8"), indent=1)


def shutdown(recorder, args, state):
    time.sleep(0.5)
    recorder.stop_and_save(f"{args.participant}_exp2", args.board)
    print("session finished; Ctrl+C to quit (or it exits in 3 s)", flush=True)
    time.sleep(3)
    os._exit(0)


def cmd_run(args):
    session = build_session(args.participant, args.quiz, args.videos, camera=not args.no_camera)
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
        recorder.stop_and_save(f"{args.participant}_exp2", args.board)


# ---------------------------------------------------------------- evaluate

def cmd_evaluate(args):
    """BBBD 'calibrated' split on our own recording: leave one video out (both conditions)."""
    from sklearn.metrics import roc_auc_score
    from focus_model import FocusModel, clean, to_bands
    from preprocess import windows

    name = f"{args.participant}_exp2"
    data, d = load_rec(f"{REC_DIR}/{name}.npz")
    sf, ch = float(d["sfreq"]), list(d["ch_names"])
    x = clean(data, sf)
    xb = to_bands(x, sf)
    proto = FocusModel(ch, sf, blink_uv=args.blink_uv)
    recs = []
    for b in blocks_from_markers(d["markers"]):
        cond, stim = divmod(b["code"], 10)
        if cond not in (1, 2):
            continue
        s = b["start"] + int(args.settle_s * sf)
        wb, _ = windows(xb[..., s:b["end"]], sf, proto.win_s)
        w, _ = windows(x[:, s:b["end"]], sf, proto.win_s)
        keep = proto.blink_mask(w)
        recs.append({"stim": stim, "y": cond - 1, "Xb": wb[keep], "dropped": int((~keep).sum())})
    stims = sorted({r["stim"] for r in recs})
    print(f"{len(recs)} recordings ({len(stims)} videos x conditions); "
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
    sess = json.load(open(f"{REC_DIR}/{name}_session.json", encoding="utf-8"))
    mem = sess.get("scores", {}).get("memory", {})
    print("\nfold     AUC    focus(attentive)  focus(distracted)  memory quiz")
    for v in aucs:
        q = mem.get(str(v)) or mem.get(v) or {}
        print(f"  {str(v):6s} {aucs[v]:.3f}      {focus[v].get('attentive', np.nan):.2f}             "
              f"{focus[v].get('distracted', np.nan):.2f}            {q.get('correct', '-')}/{q.get('total', '-')}")
    mean = float(np.mean(list(aucs.values())))
    verdict = ("WORKS (>= 0.70)" if mean >= 0.70 else "BORDERLINE (0.60-0.70): check signal quality"
               if mean >= 0.60 else "FAILS (< 0.60): if signal is clean, use the BBBD replay demo")
    print(f"\n{method} AUC: {mean:.3f}  (BBBD, our 8 channels: 0.872)  ->  {verdict}")
    Xall = np.concatenate([r["Xb"] for r in recs]); yall = np.concatenate([np.full(len(r["Xb"]), r["y"]) for r in recs])
    FocusModel(ch, sf).fit(Xall, yall).save(f"{REC_DIR}/{name}_model.joblib")
    json.dump({"participant": args.participant, "lovo_auc": aucs, "mean_auc": mean, "verdict": verdict, "focus": focus},
              open(f"{REC_DIR}/{name}_result.json", "w"), indent=2)
    print(f"saved {REC_DIR}/{name}_model.joblib (all videos) and _result.json")


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
    name = f"{args.participant}_exp2"
    sess = json.load(open(f"{REC_DIR}/{name}_session.json", encoding="utf-8"))
    log = [m for m in sess["markers"] if m.get("t_client_ms") is not None]
    eeg, sf = None, None
    if os.path.exists(f"{REC_DIR}/{name}.npz"):
        d = np.load(f"{REC_DIR}/{name}.npz")
        idx = np.flatnonzero(d["markers"])
        eeg, sf = list(zip(d["markers"][idx].astype(int), idx)), float(d["sfreq"])  # (code, sample)
    cam_dir = f"{REC_DIR}/{args.participant}_cam"
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
    ap.add_argument("cmd", choices=["run", "evaluate", "sync"])
    ap.add_argument("--participant", required=True)
    ap.add_argument("--board", choices=["knight", "knight-imu", "synthetic"], default="knight")
    ap.add_argument("--port")
    ap.add_argument("--gain", type=int, default=12)
    ap.add_argument("--channels", default=",".join(HEADSET_8))
    ap.add_argument("--no-eeg", action="store_true", help="run the participant flow without a board")
    ap.add_argument("--no-camera", action="store_true", help="don't record the webcam")
    ap.add_argument("--no-rld", action="store_true", help="leave Route RLD off (as in the EXG Visualizer default)")
    ap.add_argument("--quiz", choices=["end", "after-each"], default="end")
    ap.add_argument("--videos", default="1,2,5",
                    help="stim numbers to show; default = the 3 shortest (~8.5 min per pass); 1,2,3,4,5 = full BBBD")
    ap.add_argument("--http-port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--settle-s", type=float, default=2)
    ap.add_argument("--blink-uv", type=float, default=150)
    a = ap.parse_args()
    a.channels = a.channels.split(",")
    a.videos = [int(v) for v in a.videos.split(",") if v]
    {"run": cmd_run, "evaluate": cmd_evaluate, "sync": cmd_sync}[a.cmd](a)


if __name__ == "__main__":
    main()
