"""Live calibration on the headset: 6 blocks (default 45 s each, about 4.5 min), alternating
watch / count back by 7 (BBBD's distractor). Shorter than scripts/headset_session.py record's 10
blocks for the demo; 4 s windows with a 2 s step during training make up for the shorter blocks.

Model: focus_model.FocusModel with 4 s windows (on BBBD about +0.03 AUC over 2 s; the backend's
5 s smoothing and 8 s lapse rule make the extra latency irrelevant). Reported AUC: leave one
watch/count block pair out (3 pairs). The final model is trained on all blocks and saved as
recordings/<participant>_live_model.joblib for reuse in later sessions.
"""
import asyncio
import os
import random

import numpy as np
from sklearn.metrics import roc_auc_score

from focus_model import FocusModel, clean, to_bands

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REC = os.path.join(ROOT, "recordings")
WIN_S, STEP_S, SETTLE_S = 4.0, 2.0, 5.0
N_BLOCKS = int(os.environ.get("CAL_BLOCKS", 6))   # even: watch/count pairs
BLINK_UV = float(os.environ.get("BLINK_UV", 150))   # raise only for BrainFlow's synthetic board
PRIMES = [p for p in range(801, 1000) if all(p % d for d in range(2, int(p ** 0.5) + 1))]
def plan(n_blocks=N_BLOCKS):
    return [("calibration", "watch" if i % 2 == 0 else "count") for i in range(n_blocks)]


def windows(data, sf, win_s, step_s=STEP_S):
    """Overlapping windows (4 s every 2 s), [n, ..., samples]."""
    n, step = int(round(win_s * sf)), int(round(step_s * sf))
    starts = np.arange(0, data.shape[-1] - n + 1, step)
    return np.stack([data[..., s:s + n] for s in starts], axis=0) if len(starts) else np.zeros((0, *data.shape[:-1], n)), starts / sf


def block_windows(x, xb, sf, start, end, model):
    settle = min(SETTLE_S, 0.2 * (end - start) / sf)   # skip the task switch at the block start
    s = start + int(settle * sf)
    if end - s < int(WIN_S * sf):
        return np.zeros((0, xb.shape[0], xb.shape[1], int(WIN_S * sf)))
    wb, _ = windows(xb[..., s:end], sf, WIN_S)
    w, _ = windows(x[:, s:end], sf, WIN_S)
    return wb[model.blink_mask(w)]


def train(recording, sf, channels, blocks):
    """blocks: [(start, end, label)] in samples. Returns (model, auc, details)."""
    proto = FocusModel(channels, sf, win_s=WIN_S, blink_uv=BLINK_UV)
    x = clean(recording.astype(np.float64), sf)
    xb = to_bands(x, sf)
    per = [(block_windows(x, xb, sf, s, e, proto), y) for s, e, y in blocks]
    stack = lambda bs: (np.concatenate([b for b, _ in bs]), np.concatenate([np.full(len(b), y) for b, y in bs]))
    pairs = [per[i:i + 2] for i in range(0, len(per) - 1, 2)]
    aucs = []
    for i, pr in enumerate(pairs):
        if len({y for b, y in pr if len(b)}) < 2:
            continue
        rest = [bp for j, p in enumerate(pairs) if j != i for bp in p if len(bp[0])]
        Xr, yr = stack(rest)
        if len(set(yr)) < 2:
            continue
        Xp, yp = stack([bp for bp in pr if len(bp[0])])
        aucs.append(roc_auc_score(yp, FocusModel(channels, sf, win_s=WIN_S, blink_uv=BLINK_UV).fit(Xr, yr).p_distracted(Xp)))
    usable = [bp for bp in per if len(bp[0])]
    if len({y for _, y in usable}) < 2:
        raise RuntimeError("Calibration has no usable windows for one of the tasks (all dropped as blinks or too short). Check Fp1 contact and repeat.")
    X, y = stack(usable)
    model = FocusModel(channels, sf, win_s=WIN_S, blink_uv=BLINK_UV).fit(X, y)
    auc = float(np.mean(aucs)) if aucs else float("nan")
    return model, auc, {"windows": int(len(y)), "pair_aucs": [round(a, 3) for a in aucs]}


async def run_calibration(source, participant, emit, block_s=None, n_blocks=None):
    """Runs the block protocol on a BoardSource, sending `calibration` messages through emit().
    block_s / n_blocks come from the UI's Settings (else CAL_BLOCK_S / CAL_BLOCKS, 45 s x 6)."""
    block_s = int(block_s or os.environ.get("CAL_BLOCK_S", 45))
    PLAN = plan(int(n_blocks or N_BLOCKS))
    blocks = []
    for k, (phase, task) in enumerate(PLAN):
        start = source.total
        prime = random.choice(PRIMES) if task == "count" else None
        for left in range(block_s, 0, -1):
            msg = {"type": "calibration", "block": k + 1, "n_blocks": len(PLAN), "phase": phase, "task": task,
                   "seconds_left": left, "block_s": block_s}
            if prime:
                msg["start_number"] = prime
            await emit(msg)
            await asyncio.sleep(1)
        blocks.append((start, source.total, 1 if task == "count" else 0))
    await emit({"type": "status", "state": "calibrating", "message": "Training the model on this calibration"})
    rec = source.recording()
    model, auc, info = await asyncio.to_thread(train, rec, source.sfreq, source.channels, blocks)
    os.makedirs(REC, exist_ok=True)
    model.save(os.path.join(REC, f"{participant}_live_model.joblib"))
    np.savez_compressed(os.path.join(REC, f"{participant}_live_calibration.npz"), data=rec, sfreq=source.sfreq,
                        ch_names=np.array(source.channels), blocks=np.array(blocks), uv_scale="corrected", board="knight")
    await emit({"type": "calibration", "block": len(PLAN), "n_blocks": len(PLAN), "phase": "test", "task": "watch",
                "seconds_left": 0, "block_s": block_s, "done": True, "auc": round(auc, 3) if auc == auc else None})
    return model, auc, info
