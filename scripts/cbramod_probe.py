"""Hour 2-2.5: CBraMod frozen + linear probe, then Gate 2.

Model and pretrained weights come straight from braindecode 2.0
(`CBraMod.from_pretrained("braindecode/cbramod-pretrained")`, the port of
wjq-learning/CBraMod). Input follows the CBraMod paper: 200 Hz, 1 s patches,
units of 100 uV. 4 s windows -> encoder output (n, ch, 4 patches, 200) ->
mean over patches -> (ch * 200) feature vector -> StandardScaler + LogisticRegression.

Same splits and AUC rule as riemann_check.py. Gate 2 compares against the
Riemannian result on the same 4 s windows (results/riemann_<data>_4s.json).

Runs on CPU in ~6 min for Exp 2 (8 ch); uses CUDA if available.
Usage: python scripts/cbramod_probe.py [--data data/processed/exp2_our8]
"""
import argparse
import glob
import json
import os

import numpy as np
import torch
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from riemann_check import summary


def load_200hz(data_dir):
    X, y, video, group, names = [], [], [], [], []
    for i, f in enumerate(sorted(glob.glob(f"{data_dir}/200hz/sub-*.npz"))):
        d = np.load(f)
        X.append(d["X"]); y.append(d["y"]); video.append(d["video"])
        group.append(np.full(len(d["y"]), i)); names.append(os.path.basename(f)[:-4])
    return (np.concatenate(X), np.concatenate(y), np.concatenate(video),
            np.concatenate(group), names)


def load_cbramod(n_chans, n_times, device, **kw):
    from braindecode.models import CBraMod
    return CBraMod.from_pretrained("braindecode/cbramod-pretrained", n_chans=n_chans,
                                   n_times=n_times, sfreq=200, **kw).to(device)


@torch.no_grad()
def extract(X, device, batch=128):
    model = load_cbramod(X.shape[1], X.shape[2], device, return_encoder_output=True).eval()
    feats = []
    for i in range(0, len(X), batch):
        xb = torch.tensor(X[i:i + batch] / 100.0, dtype=torch.float32, device=device)
        feats.append(model(xb).mean(dim=2).flatten(1).cpu().numpy())  # mean over patches
        if i % (batch * 20) == 0:
            print(f"  {i}/{len(X)}", flush=True)
    return np.concatenate(feats)


def probe_auc(Ftr, ytr, Fte, yte):
    clf = make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=3000, random_state=0))
    clf.fit(Ftr, ytr)
    return roc_auc_score(yte, clf.predict_proba(Fte)[:, 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/processed/exp2_our8")
    ap.add_argument("--out", default="results")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    tag = os.path.basename(args.data.rstrip("/"))
    device = "cuda" if torch.cuda.is_available() else "cpu"

    X, y, video, group, names = load_200hz(args.data)
    cache = f"{args.data}/cbramod_frozen_features.npz"
    if os.path.exists(cache):
        F = np.load(cache)["F"]
    else:
        print(f"extracting CBraMod features for {X.shape} on {device}", flush=True)
        F = extract(X, device)
        np.savez_compressed(cache, F=F)
    print("features", F.shape, flush=True)

    # calibrated: per participant, leave-one-video-out
    cal = {}
    for i, name in enumerate(names):
        m = group == i
        aucs = []
        for v in np.unique(video[m]):
            te, tr = m & (video == v), m & (video != v)
            if len(np.unique(y[te])) == 2 and len(np.unique(y[tr])) == 2:
                aucs.append(probe_auc(F[tr], y[tr], F[te], y[te]))
        cal[name] = float(np.mean(aucs)) if aucs else np.nan
    cal_row = summary(list(cal.values()))
    print("calibrated LOVO:", cal_row, flush=True)

    # new person: 3 participant-grouped folds
    folds = [probe_auc(F[tr], y[tr], F[te], y[te]) for tr, te in GroupKFold(3).split(F, y, group)]
    new_row = dict(mean=float(np.mean(folds)), folds=[float(f) for f in folds])
    print("new person:", new_row, flush=True)

    riem_path = f"{args.out}/riemann_{tag}_4s.json"
    gate = "riemannian 4 s result missing; run riemann_check.py --win 4"
    riem_cal = None
    if os.path.exists(riem_path):
        riem_cal = json.load(open(riem_path))["rows"]["calibrated, leave-one-video-out"]["mean"]
        gap = cal_row["mean"] - riem_cal
        gate = (f"PASS: probe {cal_row['mean']:.3f} vs Riemannian {riem_cal:.3f} (gap {gap:+.3f}); try fine-tuning"
                if gap >= -0.05 else
                f"STOP: probe {cal_row['mean']:.3f} vs Riemannian {riem_cal:.3f} (gap {gap:+.3f}); Riemannian wins")
    print("\nGATE 2:", gate)

    json.dump(dict(data=args.data, win_s=4, gate2=gate, riemann_4s_calibrated=riem_cal,
                   rows={"calibrated, leave-one-video-out": cal_row, "new person, 3 grouped folds": new_row},
                   per_subject=cal), open(f"{args.out}/cbramod_probe_{tag}.json", "w"), indent=2)


if __name__ == "__main__":
    main()
