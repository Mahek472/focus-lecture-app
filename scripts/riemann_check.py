"""Hour 1.5: Riemannian check (Tang, Liang & Li 2023 recipe) + Gate 1.

Feature stack per band is copied from Tang's OSF code (https://osf.io/7mj5e/,
cross_lecture_prediction.ipynb: `pipe1`, `cat_bands`):
    Covariances('lwf') -> TangentSpace('riemann') -> StandardScaler
fitted on training data per band, then the four band vectors concatenated and
fed to LogisticRegression. One change from Tang: AUC is computed from
predict_proba scores (gameplan rule), not from hard predicted labels.

Splits
  calibrated : per participant, leave-one-video-out (train on the other videos,
               both conditions; test on the held-out video, both conditions).
               Also reported: train on ONE video, test on the rest (~6 min calib).
  new person : 3 participant-grouped folds (GroupKFold), pooled windows.
               Also reported: same, with per-participant unsupervised Riemannian
               re-centering (uses the test person's unlabeled data only).

Sanity checks (gameplan "where it can fail")
  alpha      : posterior alpha power should be higher when distracted (BBBD Fig 5B)
  null       : calibrated split with condition labels randomly swapped per video
               pair; should land near 0.5, otherwise there is leakage.

Usage: python scripts/riemann_check.py [--data data/processed/exp2_our8] [--win 2|4]
"""
import argparse
import glob
import json
import os

import numpy as np
from pyriemann.estimation import Covariances
from pyriemann.tangentspace import TangentSpace
from pyriemann.utils.base import invsqrtm
from pyriemann.utils.mean import mean_riemann
from scipy import stats
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

BAND_NAMES = ["delta", "theta", "alpha", "beta"]


def load(data_dir, win):
    subs = []
    for f in sorted(glob.glob(f"{data_dir}/128hz/sub-*.npz")):
        d = np.load(f)
        Xb, y, video, start = d["Xb"], d["y"], d["video"], d["start"]
        if win == 4:  # join consecutive 2 s windows of the same recording
            keep = [i for i in range(len(y) - 1)
                    if video[i] == video[i + 1] and y[i] == y[i + 1]
                    and np.isclose(start[i + 1] - start[i], 2.0) and int(round(start[i] / 2)) % 2 == 0]
            keep = np.array(keep, dtype=int)
            Xb = np.concatenate([Xb[keep], Xb[keep + 1]], axis=-1)
            y, video = y[keep], video[keep]
        # covariance per band, computed once (Covariances is stateless)
        C = np.stack([Covariances("lwf").transform(Xb[:, b].astype(np.float64))
                      for b in range(Xb.shape[1])], axis=1)  # (n, 4, ch, ch)
        alpha_pow = np.log(np.var(Xb[:, 2], axis=-1))  # (n, ch)
        subs.append(dict(name=os.path.basename(f)[:-4], C=C, y=y, video=video,
                         alpha=alpha_pow, ch=list(d["ch_names"])))
    return subs


def band_features(Ctr, Cte, bands):
    """Tang's cat_bands: per-band TangentSpace + StandardScaler, concatenated."""
    tr, te = [], []
    for b in bands:
        pipe = make_pipeline(TangentSpace(metric="riemann"), StandardScaler())
        tr.append(pipe.fit_transform(Ctr[:, b]))
        te.append(pipe.transform(Cte[:, b]))
    return np.concatenate(tr, 1), np.concatenate(te, 1)


def fit_score(Ctr, ytr, Cte, yte, bands=(0, 1, 2, 3)):
    Ftr, Fte = band_features(Ctr, Cte, bands)
    clf = LogisticRegression(max_iter=2000, random_state=0).fit(Ftr, ytr)
    return roc_auc_score(yte, clf.predict_proba(Fte)[:, 1])


def has_both(y):
    return len(np.unique(y)) == 2


def calibrated_lovo(s, bands=(0, 1, 2, 3), y=None):
    y = s["y"] if y is None else y
    aucs = []
    for v in np.unique(s["video"]):
        te = s["video"] == v
        if has_both(y[te]) and has_both(y[~te]):
            aucs.append(fit_score(s["C"][~te], y[~te], s["C"][te], y[te], bands))
    return np.mean(aucs) if aucs else np.nan


def calibrated_one_video(s):
    aucs = []
    for v in np.unique(s["video"]):
        tr = s["video"] == v
        if has_both(s["y"][tr]) and has_both(s["y"][~tr]):
            aucs.append(fit_score(s["C"][tr], s["y"][tr], s["C"][~tr], s["y"][~tr]))
    return np.mean(aucs) if aucs else np.nan


def recenter(C):
    """Whiten each band's covariances by this person's own Riemannian mean."""
    out = np.empty_like(C)
    for b in range(C.shape[1]):
        W = invsqrtm(mean_riemann(C[:, b]))
        out[:, b] = W @ C[:, b] @ W
    return out


def new_person(subs, do_recenter):
    C = np.concatenate([recenter(s["C"]) if do_recenter else s["C"] for s in subs])
    y = np.concatenate([s["y"] for s in subs])
    g = np.concatenate([np.full(len(s["y"]), i) for i, s in enumerate(subs)])
    fold_aucs, per_sub = [], {}
    for tr, te in GroupKFold(n_splits=3).split(C, y, g):
        Ftr, Fte = band_features(C[tr], C[te], (0, 1, 2, 3))
        clf = LogisticRegression(max_iter=2000, random_state=0).fit(Ftr, y[tr])
        p = clf.predict_proba(Fte)[:, 1]
        fold_aucs.append(roc_auc_score(y[te], p))
        for i in np.unique(g[te]):
            m = g[te] == i
            if has_both(y[te][m]):
                per_sub[subs[i]["name"]] = roc_auc_score(y[te][m], p[m])
    return float(np.mean(fold_aucs)), fold_aucs, per_sub


def swapped_labels(s, rng):
    """Null: randomly swap attentive/distracted per video (keeps recording structure)."""
    y = s["y"].copy()
    for v in np.unique(s["video"]):
        if rng.random() < 0.5:
            m = s["video"] == v
            y[m] = 1 - y[m]
    return y


def summary(x):
    x = np.asarray([v for v in x if not np.isnan(v)])
    return dict(mean=float(x.mean()), sd=float(x.std()), n=int(len(x)),
                frac_ge_070=float((x >= 0.70).mean()), frac_lt_060=float((x < 0.60).mean()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/processed/exp2_our8")
    ap.add_argument("--win", type=int, choices=[2, 4], default=2)
    ap.add_argument("--out", default="results")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    tag = f"riemann_{os.path.basename(args.data.rstrip('/'))}_{args.win}s"

    subs = load(args.data, args.win)
    print(f"{len(subs)} participants, {sum(len(s['y']) for s in subs)} windows of {args.win} s, "
          f"channels {subs[0]['ch']}", flush=True)

    # sanity 1: alpha higher when distracted (posterior channels if present)
    post = [i for i, c in enumerate(subs[0]["ch"]) if c in ("Pz", "P3", "P4", "O1", "O2", "Oz", "POz")]
    diffs = np.array([s["alpha"][s["y"] == 1][:, post].mean() - s["alpha"][s["y"] == 0][:, post].mean()
                      for s in subs])
    t = stats.ttest_1samp(diffs, 0)
    alpha_check = dict(mean_log_alpha_diff=float(diffs.mean()), frac_subjects_higher_when_distracted=float((diffs > 0).mean()),
                       t=float(t.statistic), p=float(t.pvalue))
    print("alpha check (distracted - attentive, log power):", alpha_check, flush=True)

    rows = {}
    per_sub = {s["name"]: {} for s in subs}
    for s in subs:
        per_sub[s["name"]]["cal_lovo"] = calibrated_lovo(s)
    rows["calibrated, leave-one-video-out"] = summary([per_sub[k]["cal_lovo"] for k in per_sub])
    print("calibrated LOVO:", rows["calibrated, leave-one-video-out"], flush=True)

    for s in subs:
        per_sub[s["name"]]["cal_one_video"] = calibrated_one_video(s)
    rows["calibrated, train on 1 video"] = summary([per_sub[k]["cal_one_video"] for k in per_sub])
    print("calibrated 1-video:", rows["calibrated, train on 1 video"], flush=True)

    band_rows = {}
    for b, name in enumerate(BAND_NAMES):
        band_rows[name] = summary([calibrated_lovo(s, bands=(b,)) for s in subs])
    print("calibrated LOVO per band:", {k: round(v["mean"], 3) for k, v in band_rows.items()}, flush=True)

    rng = np.random.default_rng(0)
    null = summary([calibrated_lovo(s, y=swapped_labels(s, rng)) for s in subs])
    print("null (labels swapped per video):", null, flush=True)

    for rc in (False, True):
        key = "new person, 3 grouped folds" + (" + re-centering" if rc else "")
        m, folds, ps = new_person(subs, rc)
        rows[key] = dict(mean=m, folds=[float(f) for f in folds], per_sub_mean=summary(list(ps.values()))["mean"])
        for k, v in ps.items():
            per_sub[k]["new_person" + ("_rc" if rc else "")] = v
        print(key, rows[key], flush=True)

    cal = rows["calibrated, leave-one-video-out"]["mean"]
    if cal >= 0.70:
        gate = "GO (calibrated AUC >= 0.70)"
    elif cal >= 0.60:
        gate = "CONTINUE CAUTIOUSLY (0.60-0.70)"
    else:
        gate = "FAIL (< 0.60): rerun with --montage all; pass = electrode layout problem, fail = kill/pivot"
    print("\nGATE 1:", gate)

    json.dump(dict(data=args.data, win_s=args.win, n_subjects=len(subs), gate1=gate, rows=rows,
                   per_band=band_rows, null=null, alpha_check=alpha_check, per_subject=per_sub),
              open(f"{args.out}/{tag}.json", "w"), indent=2)
    print(f"saved {args.out}/{tag}.json")


if __name__ == "__main__":
    main()
