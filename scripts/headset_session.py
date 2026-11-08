"""Headset test: does the frozen Tang recipe work on our NeuroPawn Knight board?

  check     ~1 min guided signal check: flat/noisy channels, 60 Hz hum, blinks on Fp1,
            eyes-closed alpha at O1/O2/Pz.
  record    alternating 1-min blocks, W = watch the lecture clip, C = watch while
            silently counting back by 7s from a random prime (BBBD's distractor).
            Default 6 calibration + 4 test blocks (10 min). Alternating, not 3 min + 3 min,
            so time-on-task drift cannot masquerade as attention (BBBD caveat).
  evaluate  verdict = leave-one-block-pair-out AUC over all blocks (stable); also trains on the
            calibration blocks and scores the 4 held-out blocks (secondary, noisy).
            Gate: >= 0.70 works on our hardware; 0.60-0.70 check signal quality; < 0.60 fall back to replay.
  simulate  build a recording in the same format from BBBD (resampled to 125 Hz), so the
            pipeline can be tested end to end without the headset.

Board setup (session, then chon_N_12 + rldadd_N per channel, 1 s apart) follows
NeuroPawn's own tutorial: github.com/NeuroPawn/p300 collection.py setup_board().

Examples
  python scripts/headset_session.py check    --board knight --port COM3
  python scripts/headset_session.py record   --board knight --port COM3 --name mahek1
  python scripts/headset_session.py evaluate --name mahek1
  python scripts/headset_session.py record   --board synthetic --name synth --block-s 10
  python scripts/headset_session.py simulate --subject sub-01 --name bbbd_sub01
"""
import argparse
import glob
import json
import os
import random
import sys
import time

import numpy as np
from scipy.signal import welch
from sklearn.metrics import roc_auc_score

from focus_model import FocusModel, clean, to_bands
from preprocess import HEADSET_8, windows

REC_DIR = "recordings"
# BrainFlow <= 5.23.0 scales Knight counts as 4 V / (2^15 - 1) / 12 * 1e6 = 10.17 uV, which is
# 79.57x too large; fixed upstream on 2026-10-21 (brainflow-dev/brainflow PR #867, not yet released).
KNIGHT_SCALE_FIX = 1 / 79.57
W, C = 1, 2  # marker codes; +10 for test-phase blocks
END = 99
PRIMES = [p for p in range(801, 1000) if all(p % d for d in range(2, int(p ** 0.5) + 1))]


# ---------------------------------------------------------------- board

def knight_scale(board, gain):
    """Multiply BrainFlow's Knight EEG rows by this to get true uV."""
    if not board.startswith("knight"):
        return 1.0
    from importlib.metadata import version
    v = tuple(int(p) for p in version("brainflow").split(".")[:3])
    fix = KNIGHT_SCALE_FIX if v <= (5, 23, 0) else 1.0
    return fix * 12 / gain  # BrainFlow's scale assumes gain 12


def load_rec(path):
    """Recording as (data uV, npz). Files saved before the scale fix are corrected here."""
    d = np.load(path)
    data = d["data"].astype(np.float64)
    if "uv_scale" not in d.files and str(d["board"]).startswith("knight"):
        data *= KNIGHT_SCALE_FIX
    return data, d


def connect(board, port, gain, rld=True):
    from brainflow.board_shim import BoardIds, BoardShim, BrainFlowInputParams
    BoardShim.disable_board_logger()
    params = BrainFlowInputParams()
    ids = {"knight": BoardIds.NEUROPAWN_KNIGHT_BOARD, "knight-imu": BoardIds.NEUROPAWN_KNIGHT_BOARD_IMU,
           "synthetic": BoardIds.SYNTHETIC_BOARD}
    if board != "synthetic":
        if not port:
            sys.exit("--port is required for the Knight board (e.g. COM3); close the EXG Visualizer first")
        params.serial_port = port
    b = BoardShim(ids[board].value, params)
    b.prepare_session()
    b.start_stream(450000)
    time.sleep(3.0)
    if board != "synthetic":
        print(f"Configuring channels, Route RLD {'on' if rld else 'off'}...", flush=True)
        for ch in range(1, 9):
            b.config_board(f"chon_{ch}_{gain}")
            time.sleep(1.0)
            b.config_board(f"rldadd_{ch}" if rld else f"rldremove_{ch}")
            time.sleep(1.0)
        time.sleep(2.0)
    b.get_board_data()  # drop samples from before channels were on
    bid = b.get_board_id()
    info = dict(eeg=BoardShim.get_exg_channels(bid)[:8], marker=BoardShim.get_marker_channel(bid),
                sfreq=BoardShim.get_sampling_rate(bid), scale=knight_scale(board, gain))
    return b, info


def run_protocol(board, info, steps, ch_names):
    """steps: list of (marker, seconds, prompt). Returns (ch, t) uV and per-sample markers."""
    chunks = []
    try:
        for marker, secs, prompt in steps:
            print(f"\a\n>>> {prompt}  ({secs:.0f} s)", flush=True)
            board.insert_marker(marker)
            t_end = time.time() + secs
            while (left := t_end - time.time()) > 0:
                time.sleep(min(1.0, left))
                chunks.append(board.get_board_data())
                if int(left) % 15 == 0 and left > 1:
                    print(f"    {int(left)} s left", flush=True)
        board.insert_marker(END)
        time.sleep(0.5)
    except KeyboardInterrupt:
        print("\ninterrupted; saving what was recorded", flush=True)
    finally:
        chunks.append(board.get_board_data())
        board.stop_stream()
        board.release_session()
    raw = np.concatenate(chunks, axis=1)
    return raw[info["eeg"]] * info["scale"], raw[info["marker"]]


def blocks_from_markers(markers):
    idx = np.flatnonzero(markers)
    codes = markers[idx].astype(int)
    out = []
    for i, (s, c) in enumerate(zip(idx, codes)):
        if c == END:
            continue
        e = idx[i + 1] if i + 1 < len(idx) else len(markers)
        out.append(dict(code=int(c), start=int(s), end=int(e)))
    return out


def save_rec(name, data, markers, sfreq, ch_names, board, **extra):
    os.makedirs(REC_DIR, exist_ok=True)
    path = f"{REC_DIR}/{name}.npz"
    np.savez_compressed(path, data=data.astype(np.float32), markers=markers, sfreq=sfreq,
                        ch_names=np.array(ch_names), board=board, uv_scale="corrected", **extra)
    print(f"saved {path}: {data.shape[1] / sfreq:.0f} s, {len(ch_names)} ch @ {sfreq} Hz")
    return path


# ---------------------------------------------------------------- check

def bandpower(x, sfreq, lo, hi):
    f, p = welch(x, sfreq, nperseg=min(x.shape[-1], int(2 * sfreq)))
    return p[..., (f >= lo) & (f < hi)].mean(-1)


def cmd_check(a):
    ch = a.channels
    board, info = connect(a.board, a.port, a.gain, not a.no_rld)
    steps = [(1, 10, "Sit still, eyes open, relax your jaw"),
             (2, 10, "Blink HARD every 2 seconds"),
             (3, 10, "Clench your teeth for 2 s, relax, repeat"),
             (4, 20, "Close your eyes and relax"),
             (5, 20, "Open your eyes, look at the screen")]
    data, markers = run_protocol(board, info, steps, ch)
    sf = info["sfreq"]
    save_rec(f"{a.name}_check", data, markers, sf, ch, a.board)
    seg = {b["code"]: (b["start"], b["end"]) for b in blocks_from_markers(markers)}
    x = clean(data, sf)
    rest = x[:, slice(*seg[1])]

    print("\nchannel   std(uV)  60Hz/EEG   verdict")
    line = bandpower(data, sf, 58, 62) / bandpower(data, sf, 1, 40)
    for i, n in enumerate(ch):
        sd = rest[i].std()
        v = "FLAT - check contact" if sd < 0.5 else "NOISY - paste/contact/reference" if sd > 100 else \
            "60 Hz hum high" if line[i] > 1 else "ok"
        print(f"{n:8s} {sd:8.1f} {line[i]:9.2f}   {v}")
    if "Fp1" in ch:
        fp = ch.index("Fp1")
        r = np.ptp(x[fp, slice(*seg[2])]) / max(np.ptp(rest[fp]), 1e-9)
        print(f"\nBlinks on Fp1: {r:.1f}x rest peak-to-peak  ({'ok' if r > 2 else 'weak - check Fp1 contact'})")
    post = [ch.index(c) for c in ("O1", "O2", "Pz") if c in ch]
    if post:
        closed = bandpower(x[post, slice(*seg[4])], sf, 8, 12).mean()
        opened = bandpower(x[post, slice(*seg[5])], sf, 8, 12).mean()
        r = closed / opened
        print(f"Eyes-closed alpha (O1/O2/Pz): {r:.2f}x eyes open  "
              f"({'ok' if r > 1.5 else 'weak - check occipital contact / reference'})")
    if np.median(line) > 1:
        print("Most channels hum at 60 Hz: check the ear-clip ground (RLD/COMM) first.")


# ---------------------------------------------------------------- record

def block_plan(n_calib, n_test):
    plan = [(W if i % 2 == 0 else C) for i in range(n_calib)]
    plan += [(W if i % 2 == 0 else C) + 10 for i in range(n_test)]
    return plan


def cmd_record(a):
    board, info = connect(a.board, a.port, a.gain, not a.no_rld)
    steps = []
    for code in block_plan(a.calib_blocks, a.test_blocks):
        phase = "TEST" if code > 10 else "CALIBRATION"
        if code % 10 == W:
            prompt = f"[{phase}] WATCH the lecture, just follow along"
        else:
            prompt = f"[{phase}] Keep eyes on the video but COUNT BACK BY 7 silently from {random.choice(PRIMES)}"
        steps.append((code, a.block_s, prompt))
    print(f"{len(steps)} blocks x {a.block_s} s. Start the lecture video now and keep it playing.")
    input("Press Enter to begin...")
    data, markers = run_protocol(board, info, steps, a.channels)
    save_rec(a.name, data, markers, info["sfreq"], a.channels, a.board)
    if not a.no_eval:
        a.data = None
        cmd_evaluate(a)


# ---------------------------------------------------------------- evaluate

def block_windows(xb, x, model, blk, settle_s):
    s = blk["start"] + int(settle_s * model.sfreq)
    if blk["end"] - s < model.win_s * model.sfreq:
        return None, None
    wb, _ = windows(xb[..., s:blk["end"]], model.sfreq, model.win_s)
    w, _ = windows(x[:, s:blk["end"]], model.sfreq, model.win_s)
    keep = model.blink_mask(w)
    return wb[keep], keep


def cmd_evaluate(a):
    data, d = load_rec(f"{REC_DIR}/{a.name}.npz")
    sf, ch = float(d["sfreq"]), list(d["ch_names"])
    model = FocusModel(ch, sf, blink_uv=a.blink_uv)
    x = clean(data, sf)
    xb = to_bands(x, sf)
    blocks = [b for b in blocks_from_markers(d["markers"]) if b["code"] % 10 in (W, C)]

    per_block, dropped, total = [], 0, 0
    for b in blocks:
        wb, keep = block_windows(xb, x, model, b, a.settle_s)
        if wb is None:
            continue
        dropped += int((~keep).sum()); total += len(keep)
        per_block.append(dict(b, test=b["code"] > 10, y=int(b["code"] % 10 == C), Xb=wb))
    cal = [b for b in per_block if not b["test"]]
    tst = [b for b in per_block if b["test"]]
    stack = lambda bs: (np.concatenate([b["Xb"] for b in bs]),
                        np.concatenate([np.full(len(b["Xb"]), b["y"]) for b in bs]))
    print(f"{len(cal)} calibration + {len(tst)} test blocks; "
          f"{dropped}/{total} windows dropped as blinks (Fp1 > {a.blink_uv} uV)")

    Xc, yc = stack(cal)
    model.fit(Xc, yc)
    res = dict(name=a.name, sfreq=sf, channels=ch, n_calib_windows=int(len(yc)), blink_dropped=dropped)
    if tst:
        Xt, yt = stack(tst)
        auc = roc_auc_score(yt, model.p_distracted(Xt))
        res["test_auc"] = float(auc)
        for b in tst:
            b["mean_focus"] = float(model.focus(b["Xb"]).mean())
        print("\ntest block   condition   mean focus score")
        for b in tst:
            print(f"  {b['code']:>3}       {'count' if b['y'] else 'watch':9s}   {b['mean_focus']:.2f}")
        print(f"\nHeld-out test AUC: {auc:.3f}  (secondary: only 4 blocks, noisy)")

    # verdict: leave one W/C block pair out across all blocks. In the BBBD rehearsal
    # (30 people) this was 0.87 with 100% >= 0.70, while the 4-block held-out score
    # averaged 0.75 and fell below 0.60 for 17% of people the model works for.
    pairs = [per_block[i:i + 2] for i in range(0, len(per_block) - 1, 2)]
    lopo = []
    for i, pr in enumerate(pairs):
        if len({b["y"] for b in pr}) < 2:
            continue
        rest = [b for j, p in enumerate(pairs) if j != i for b in p]
        Xr, yr = stack(rest)
        Xp, yp = stack(pr)
        lopo.append(roc_auc_score(yp, FocusModel(ch, sf).fit(Xr, yr).p_distracted(Xp)))
    if lopo:
        m = float(np.mean(lopo))
        res["leave_one_pair_out_auc"] = m
        gate = ("WORKS on our headset (>= 0.70)" if m >= 0.70 else
                "BORDERLINE (0.60-0.70): check signal quality before blaming the model" if m >= 0.60 else
                "FAILS (< 0.60): if signal is clean, fall back to the BBBD replay demo")
        res["verdict"] = gate
        print(f"Leave-one-block-pair-out AUC: {m:.3f} over {len(lopo)} pairs  ->  {gate}")

    model.save(f"{REC_DIR}/{a.name}_model.joblib")
    json.dump(res, open(f"{REC_DIR}/{a.name}_result.json", "w"), indent=2)
    print(f"saved {REC_DIR}/{a.name}_model.joblib (calibration-trained) and _result.json")


# ---------------------------------------------------------------- simulate

def cmd_simulate(a):
    """Splice BBBD attentive/distracted recordings into the headset block format at 125 Hz.
    Calibration blocks come from videos 1-3, test blocks from videos 4-5 (cross-video)."""
    import mne
    root = f"{a.bids}/derivatives/{a.subject}"
    sf = 125.0
    pools = {}
    for f in sorted(glob.glob(f"{root}/ses-*/eeg/*_desc-eeg.bdf")):
        ses, vid = f.split("_ses-")[1][:2], int(f.split("task-stim")[1][:2])
        raw = mne.io.read_raw_bdf(f, preload=True, verbose="error").pick(a.channels)
        nz = np.flatnonzero(np.abs(raw.get_data()).sum(0) > 0)
        raw.crop(tmax=nz[-1] / raw.info["sfreq"]).resample(sf, verbose="error")
        y = C if ses == "02" else W  # Exp 2: ses-01 attentive, ses-02 distracted
        pools.setdefault((y, vid in (4, 5)), []).append(raw.get_data() * 1e6)
    n = int(a.block_s * sf)
    chunks = {k: [p[:, i:i + n] for p in v for i in range(0, p.shape[1] - n + 1, n)] for k, v in pools.items()}
    parts, markers = [], []
    for code in block_plan(a.calib_blocks, a.test_blocks):
        key = (code % 10, code > 10)
        seg = chunks[key].pop(0)
        m = np.zeros(seg.shape[1]); m[0] = code
        parts.append(seg); markers.append(m)
    data, markers = np.concatenate(parts, 1), np.concatenate(markers)
    markers[-1] = END
    save_rec(a.name, data, markers, sf, a.channels, f"bbbd-sim:{a.subject}")


# ---------------------------------------------------------------- cli

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["check", "record", "evaluate", "simulate"])
    ap.add_argument("--name", default="session")
    ap.add_argument("--board", choices=["knight", "knight-imu", "synthetic"], default="knight")
    ap.add_argument("--port", help="serial port, e.g. COM3 (Windows) or /dev/cu.usbserial-* (macOS)")
    ap.add_argument("--gain", type=int, default=12, choices=[1, 2, 3, 4, 6, 8, 12])
    ap.add_argument("--no-rld", action="store_true", help="leave Route RLD off (as in the EXG Visualizer default)")
    ap.add_argument("--channels", default=",".join(HEADSET_8),
                    help="names of board channels 1..8 in wiring order")
    ap.add_argument("--block-s", type=float, default=60)
    ap.add_argument("--calib-blocks", type=int, default=6)
    ap.add_argument("--test-blocks", type=int, default=4)
    ap.add_argument("--settle-s", type=float, default=5, help="skip the start of each block (task switch)")
    ap.add_argument("--blink-uv", type=float, default=150)
    ap.add_argument("--no-eval", action="store_true")
    ap.add_argument("--subject", default="sub-01")
    ap.add_argument("--bids", default="data/bbbd/experiment2")
    a = ap.parse_args()
    a.channels = a.channels.split(",")
    {"check": cmd_check, "record": cmd_record, "evaluate": cmd_evaluate, "simulate": cmd_simulate}[a.cmd](a)


if __name__ == "__main__":
    main()
