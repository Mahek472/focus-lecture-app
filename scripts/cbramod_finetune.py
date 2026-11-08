"""Hour 2.5-3.5: CBraMod fine-tune (only if Gate 2 passed). Meant for a Colab GPU.

One fold per split, early stopping on a validation AUC, up to 10 epochs:
  calibrated : pooled over participants, cross-video. Train videos 1-3,
               validate on video 4, test on video 5 (every participant seen).
  new person : fold 0 of GroupKFold(3); 3 training participants held out for validation.
The frozen probe is scored on the exact same fold (train = train + val), so the
gameplan rule "keep only if >= 0.03 above the probe" compares like with like.

Usage: python scripts/cbramod_finetune.py [--data data/processed/exp2_our8] [--epochs 10]
"""
import argparse
import copy
import json
import os

import numpy as np
import torch
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

from cbramod_probe import extract, load_200hz, load_cbramod, probe_auc


def folds(y, video, group):
    out = {}
    tr, va, te = np.isin(video, [1, 2, 3]), video == 4, video == 5
    out["calibrated (pooled, train v1-3 / val v4 / test v5)"] = (tr, va, te)
    tr_idx, te_idx = next(GroupKFold(3).split(y, y, group))
    tr_groups = np.unique(group[tr_idx])
    val_groups = np.random.default_rng(0).choice(tr_groups, 3, replace=False)
    va = np.isin(group, val_groups)
    tr = np.isin(group, tr_groups) & ~va
    te = np.zeros(len(y), bool); te[te_idx] = True
    out["new person (GroupKFold fold 0)"] = (tr, va, te)
    return out


@torch.no_grad()
def predict(model, X, device, batch=256):
    model.eval()
    out = []
    for i in range(0, len(X), batch):
        xb = torch.tensor(X[i:i + batch] / 100.0, dtype=torch.float32, device=device)
        with torch.autocast(device, enabled=device == "cuda"):
            out.append(model(xb).float().squeeze(1).cpu().numpy())
    return np.concatenate(out)


def finetune(X, y, tr, va, te, device, epochs, batch=64, patience=3):
    model = load_cbramod(X.shape[1], X.shape[2], device, return_encoder_output=True)
    model.reset_head(1)  # pretrained backbone + fresh linear head on the flattened tokens
    model.to(device)
    head = list(model.final_layer.parameters())
    head_ids = {id(p) for p in head}
    backbone = [p for p in model.parameters() if id(p) not in head_ids]
    opt = torch.optim.AdamW([{"params": backbone, "lr": 1e-4}, {"params": head, "lr": 1e-3}],
                            weight_decay=0.05)
    loss_fn = torch.nn.BCEWithLogitsLoss()
    scaler = torch.amp.GradScaler(enabled=device == "cuda")
    idx = np.flatnonzero(tr)
    best, best_state, bad = -1, None, 0
    rng = np.random.default_rng(0)
    for ep in range(epochs):
        model.train()
        rng.shuffle(idx)
        for i in range(0, len(idx), batch):
            b = idx[i:i + batch]
            xb = torch.tensor(X[b] / 100.0, dtype=torch.float32, device=device)
            yb = torch.tensor(y[b], dtype=torch.float32, device=device)
            with torch.autocast(device, enabled=device == "cuda"):
                loss = loss_fn(model(xb).squeeze(1), yb)
            opt.zero_grad()
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
        val_auc = roc_auc_score(y[va], predict(model, X[va], device))
        print(f"  epoch {ep + 1}: loss {loss.item():.3f} val AUC {val_auc:.3f}", flush=True)
        if val_auc > best:
            best, best_state, bad = val_auc, copy.deepcopy(model.state_dict()), 0
        else:
            bad += 1
            if bad >= patience:
                break
    model.load_state_dict(best_state)
    return roc_auc_score(y[te], predict(model, X[te], device)), best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/processed/exp2_our8")
    ap.add_argument("--out", default="results")
    ap.add_argument("--epochs", type=int, default=10)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    tag = os.path.basename(args.data.rstrip("/"))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print("device", device, flush=True)

    X, y, video, group, _ = load_200hz(args.data)
    cache = f"{args.data}/cbramod_frozen_features.npz"
    F = np.load(cache)["F"] if os.path.exists(cache) else extract(X, device)

    rows = {}
    for name, (tr, va, te) in folds(y, video, group).items():
        print(name, f"train {tr.sum()} val {va.sum()} test {te.sum()}", flush=True)
        probe = probe_auc(F[tr | va], y[tr | va], F[te], y[te])
        ft, val = finetune(X, y, tr, va, te, device, args.epochs)
        keep = ft >= probe + 0.03
        rows[name] = dict(probe=float(probe), finetuned=float(ft), best_val=float(val), keep_finetuned=bool(keep))
        print(f"  probe {probe:.3f}  fine-tuned {ft:.3f}  -> {'KEEP' if keep else 'drop'} fine-tune", flush=True)

    json.dump(dict(data=args.data, rows=rows), open(f"{args.out}/cbramod_finetune_{tag}.json", "w"), indent=2)


if __name__ == "__main__":
    main()
