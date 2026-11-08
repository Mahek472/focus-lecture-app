"""Hour 1b: BBBD derivatives -> one .npz per participant.

Per recording (one subject x one video x one condition):
  pick channels -> average reference over the picked channels -> 1-40 Hz
  bandpass + 60 Hz notch -> non-overlapping 2 s windows.
Label: attentive = 0, distracted = 1, read from the raw sidecar's TaskName
("... Attentive Condition" / "... Distracted Condition"), not assumed from ses-01/02.

Outputs (in --out):
  128hz/sub-XX.npz  X (n, ch, 256) uV, Xb (n, 4, ch, 256) per Tang band
                    (delta, theta, alpha, beta; filtered on the continuous
                    signal before windowing, as Tang did), y, video, start
  200hz/sub-XX.npz  X (n, ch, 800) 4 s windows at 200 Hz for CBraMod, y, video, start

Usage:
  python scripts/preprocess.py                    # our 8 headset channels
  python scripts/preprocess.py --montage all      # all 64 (Gate 1 fallback)
"""
import argparse
import glob
import json
import os
import re

import mne
import numpy as np

OUR_8 = ["Fp1", "Fz", "Cz", "Pz", "P3", "P4", "O1", "O2"]  # Team 20 layout
TANG_8 = ["F3", "F4", "T7", "C3", "C4", "T8", "O1", "O2"]  # Tang 2023 (T3/T4 = T7/T8 in 10-10)
HEADSET_8 = ["P3", "Fz", "Cz", "Fp1", "P4", "Pz", "O1", "O2"]  # our Knight board, channels 1-8 as wired
MONTAGES = {"our8": OUR_8, "tang8": TANG_8, "headset8": HEADSET_8}
BANDS = [(1, 4), (4, 8), (8, 13), (13, 30)]  # Tang 2023: delta, theta, alpha, beta
WIN_S = 2.0
CBRAMOD_SFREQ, CBRAMOD_WIN_S = 200, 4.0


def condition_label(root, sub, ses, task):
    """0 = attentive, 1 = distracted, from the raw sidecar TaskName."""
    js = os.path.join(root, sub, ses, "eeg", f"{sub}_{ses}_{task}_eeg.json")
    if os.path.exists(js):
        name = json.load(open(js))["TaskName"].lower()
        if "attentive" in name or "attend" in name:
            return 0
        if "distract" in name:
            return 1
        raise ValueError(f"unknown condition in {js}: {name}")
    return {"ses-01": 0, "ses-02": 1}[ses]  # Exp 1-3: attend first, distract second


def load_clean(path, picks):
    raw = mne.io.read_raw_bdf(path, preload=True, verbose="error")
    # derivatives are zero-padded to whole seconds at the end
    nz = np.flatnonzero(np.abs(raw.get_data()).sum(0) > 0)
    if len(nz) == 0:
        return None
    raw.crop(tmax=nz[-1] / raw.info["sfreq"], include_tmax=True)
    raw.pick(picks)
    raw.set_eeg_reference("average", projection=False, verbose="error")
    raw.notch_filter(60, verbose="error")
    raw.filter(1, 40, verbose="error")
    return raw


def windows(data, sfreq, win_s):
    n = int(round(win_s * sfreq))
    k = data.shape[-1] // n
    starts = np.arange(k) * n
    return np.stack([data[..., s:s + n] for s in starts], axis=0), starts / sfreq


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bids", default="data/bbbd/experiment2")
    ap.add_argument("--out", default=None)
    ap.add_argument("--montage", choices=["our8", "tang8", "headset8", "all"], default="our8")
    args = ap.parse_args()
    out = args.out or f"data/processed/exp2_{args.montage}"
    os.makedirs(f"{out}/128hz", exist_ok=True)
    os.makedirs(f"{out}/200hz", exist_ok=True)

    files = sorted(glob.glob(f"{args.bids}/derivatives/sub-*/ses-*/eeg/*_desc-eeg.bdf"))
    by_sub = {}
    for f in files:
        sub, ses, task = re.search(r"(sub-\d+)_(ses-\d+)_(task-stim\d+)", f).groups()
        by_sub.setdefault(sub, []).append((ses, task, f))

    for sub, recs in sorted(by_sub.items()):
        acc = {k: [] for k in ["X", "Xb", "y", "video", "start", "X200", "y200", "video200", "start200"]}
        picks = None
        for ses, task, f in sorted(recs):
            raw0 = mne.io.read_raw_bdf(f, preload=False, verbose="error")
            picks = MONTAGES.get(args.montage) or raw0.ch_names[:64]
            raw = load_clean(f, picks)
            if raw is None:
                print("empty", f)
                continue
            y = condition_label(args.bids, sub, ses, task)
            vid = int(task[-2:])
            sf = raw.info["sfreq"]
            data = raw.get_data() * 1e6  # uV

            band = np.stack([mne.filter.filter_data(data, sf, lo, hi, verbose="error")
                             for lo, hi in BANDS])  # (4, ch, t)
            w, st = windows(data, sf, WIN_S)
            wb, _ = windows(band, sf, WIN_S)
            acc["X"].append(w); acc["Xb"].append(wb)
            acc["y"].append(np.full(len(w), y)); acc["video"].append(np.full(len(w), vid))
            acc["start"].append(st)

            r200 = raw.copy().resample(CBRAMOD_SFREQ, verbose="error")
            w2, st2 = windows(r200.get_data() * 1e6, CBRAMOD_SFREQ, CBRAMOD_WIN_S)
            acc["X200"].append(w2); acc["y200"].append(np.full(len(w2), y))
            acc["video200"].append(np.full(len(w2), vid)); acc["start200"].append(st2)

        if not acc["X"]:
            continue
        cat = {k: np.concatenate(v) for k, v in acc.items()}
        np.savez_compressed(f"{out}/128hz/{sub}.npz", X=cat["X"].astype(np.float32),
                            Xb=cat["Xb"].astype(np.float32), y=cat["y"], video=cat["video"],
                            start=cat["start"], ch_names=np.array(picks), sfreq=128)
        np.savez_compressed(f"{out}/200hz/{sub}.npz", X=cat["X200"].astype(np.float32),
                            y=cat["y200"], video=cat["video200"], start=cat["start200"],
                            ch_names=np.array(picks), sfreq=CBRAMOD_SFREQ)
        print(f"{sub}: {len(cat['y'])} windows (distracted {cat['y'].mean():.2f}), "
              f"videos {sorted(set(cat['video']))}", flush=True)


if __name__ == "__main__":
    main()
