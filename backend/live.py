"""The live loop's brain: score the newest EEG window, apply the contract's lapse rules.

Scoring (once a second, while the video plays):
  rolling buffer (last BUFFER_S s, uV) -> focus_model.clean + to_bands on the whole buffer
  -> skip the newest MARGIN_S (zero-phase filters distort the buffer's end) -> score the
  model's window just before it. Same filters as calibration, so live data matches training.
  Windows with an Fp1 blink, or with 3+ bad channels, give no score (state "unknown").

Lapse rules (contract, same as the frontend mock's runEngine.ts):
  5 s smoothing; lapse starts after 8 s below 0.4, ends after 4 s above 0.5; camera away for
  3 s starts a lapse on its own; intervention after a 10 s lapse, 90 s cooldown.
  Sensitivity shifts the start threshold: 0.4 + (sensitivity - 0.5) * 0.2.

Re-centering (only when reusing a model calibrated in an earlier session): covariances of
the recent windows give this session's reference R; each window's covariance C becomes
T^1/2 R^-1/2 C R^-1/2 T^1/2, where T is the model's training reference, before the model's
own tangent space. Unlabeled, rolling over the last RECENTER_WINDOWS windows, ready after
RECENTER_MIN windows (about 2 minutes).
"""
import time
from dataclasses import dataclass

import numpy as np
from pyriemann.estimation import Covariances
from pyriemann.utils.base import invsqrtm, sqrtm
from pyriemann.utils.mean import mean_riemann
from scipy.signal import welch

from focus_model import clean, to_bands
from preprocess import BANDS

BUFFER_S, MARGIN_S = 10.0, 1.0
RECENTER_WINDOWS, RECENTER_MIN, RECENTER_EVERY = 150, 60, 10


@dataclass
class LapseRules:
    smoothing_s: int = 5
    start_below: float = 0.4
    start_for_s: int = 8
    end_above: float = 0.5
    end_for_s: int = 4
    camera_override_s: int = 3
    intervention_after_s: int = 10
    cooldown_s: int = 90


class Recenterer:
    """Rolling unlabeled re-centering of a saved model to the current session."""

    def __init__(self, model):
        self.model = model
        self.covs = []                       # recent (4, ch, ch)
        self.R_inv_sqrt = None
        self.T_sqrt = [sqrtm(p[1].reference_) for p in model.band_pipes]   # TangentSpace reference per band
        self.since = 0

    @property
    def ready(self):
        return self.R_inv_sqrt is not None

    def seconds_left(self):
        return max(0, RECENTER_MIN - len(self.covs))

    def add(self, C):
        self.covs.append(C)
        self.covs = self.covs[-RECENTER_WINDOWS:]
        self.since += 1
        if len(self.covs) >= RECENTER_MIN and (self.R_inv_sqrt is None or self.since >= RECENTER_EVERY):
            arr = np.stack(self.covs)
            self.R_inv_sqrt = [invsqrtm(mean_riemann(arr[:, b])) for b in range(arr.shape[1])]
            self.since = 0

    def reset(self):
        self.covs, self.R_inv_sqrt, self.since = [], None, 0

    def p_distracted(self, C):
        """C: (4, ch, ch) covariances of one window."""
        feats = []
        for b, pipe in enumerate(self.model.band_pipes):
            Cb = C[b]
            if self.ready:
                W = self.T_sqrt[b] @ self.R_inv_sqrt[b]
                Cb = W @ Cb @ W.T
            feats.append(pipe[1:].transform(Cb[None]))   # tangent space + scaler, skipping Covariances
        return float(self.model.clf.predict_proba(np.concatenate(feats, axis=1))[0, 1])


class LiveEngine:
    def __init__(self, model, sfreq, channels, intervention="alert", sensitivity=0.5, rules=None, recenter=False):
        self.model, self.sf, self.ch = model, float(sfreq), list(channels)
        self.intervention, self.sensitivity = intervention, sensitivity
        self.rules = rules or LapseRules()
        self.recenterer = Recenterer(model) if recenter else None
        self.scores, self.below, self.above = [], 0, 0
        self.in_lapse, self.lapse_start, self.lapse_secs, self.lapse_reason = False, 0.0, 0, "eeg"
        self.last_intervention = -1e9
        self.camera = None                 # (state, received_at)
        self.away_secs = 0

    # ------------------------------------------------------------------ inputs
    def set_camera(self, state):
        self.camera = (state, time.time())

    def camera_away(self):
        if not self.camera or time.time() - self.camera[1] > 3:
            return None                    # no fresh camera data: EEG only
        return self.camera[0] if self.camera[0] != "watching" else False

    # ------------------------------------------------------------------ scoring
    def score_window(self, buf):
        """buf: (ch, n) uV, newest last. Returns (p_distracted | None, quality, bands, reason_no_score)."""
        n_win, margin = int(self.model.win_s * self.sf), int(MARGIN_S * self.sf)
        if buf.shape[1] < n_win + margin + int(2 * self.sf):
            return None, {}, {}, "buffering"
        x = clean(buf.astype(np.float64), self.sf)
        xb = to_bands(x, self.sf)
        end = x.shape[1] - margin
        w, wb = x[:, end - n_win:end], xb[:, :, end - n_win:end]
        sd = x[:, end - int(2 * self.sf):end].std(axis=1)
        quality = {c: ("bad" if s < 0.5 or s > 60 else "check" if s > 30 else "good") for c, s in zip(self.ch, sd)}
        f, p = welch(w, self.sf, nperseg=min(n_win, int(2 * self.sf)))
        bands = {c: {name: float(p[i, (f >= lo) & (f < hi)].sum() * (f[1] - f[0])) for name, (lo, hi) in zip(("delta", "theta", "alpha", "beta"), BANDS)}
                 for i, c in enumerate(self.ch)}
        if not self.model.blink_mask(w[None])[0]:
            return None, quality, bands, "blink"
        if sum(q == "bad" for q in quality.values()) >= 3:
            return None, quality, bands, "signal"
        if self.recenterer is not None:
            C = np.stack([Covariances("lwf").transform(wb[i][None])[0] for i in range(wb.shape[0])])
            pd = self.recenterer.p_distracted(C)
            self.recenterer.add(C)
        else:
            pd = float(self.model.p_distracted(wb[None])[0])
        return pd, quality, bands, None

    # ------------------------------------------------------------------ one second
    def tick(self, t_video, buf, truth=None):
        out = []
        pd, quality, bands, why = self.score_window(buf)
        away = self.camera_away()
        self.away_secs = self.away_secs + 1 if away else 0
        override = self.away_secs >= self.rules.camera_override_s

        if pd is not None:
            self.scores.append(1.0 - pd)
        win = self.scores[-self.rules.smoothing_s:]
        if not win:
            return out
        score = float(np.mean(win))
        spread = float(np.std(win))
        bad = sum(q == "bad" for q in quality.values())
        if pd is None and why in ("signal",):
            state = "unknown"
        elif override:
            state = "drifting"
        else:
            state = "drifting" if score < self.rules.end_above else "focused"
        conf = max(0.1, min(0.95, 1 - 2 * spread - 0.15 * bad - (0.3 if pd is None else 0)))
        if self.recenterer is not None and not self.recenterer.ready:
            conf = min(conf, 0.3)             # still learning this session's baseline
        msg = {"type": "focus", "t_video": round(t_video, 2), "score": round(score, 3), "state": state,
               "quality": quality, "confidence": round(conf, 2)}
        if truth:
            msg["truth"] = truth
        out.append(msg)
        if bands:
            out.append({"type": "bands", "t_video": round(t_video, 2), "bands": bands})

        start_below = self.rules.start_below + (self.sensitivity - 0.5) * 0.2
        if not self.in_lapse:
            self.below = self.below + 1 if (state != "unknown" and score < start_below) else 0
            if self.below >= self.rules.start_for_s or override:
                self.in_lapse, self.lapse_secs, self.above = True, 0, 0
                self.lapse_reason = f"camera: {away}" if override else "eeg"
                self.lapse_start = max(0.0, t_video - (self.rules.camera_override_s if override else self.rules.start_for_s))
                out.append({"type": "lapse_start", "t_video": round(self.lapse_start, 2), "reason": self.lapse_reason})
        else:
            self.lapse_secs += 1
            self.above = self.above + 1 if (score > self.rules.end_above and not override) else 0
            if self.above >= self.rules.end_for_s:
                self.in_lapse, self.below = False, 0
                out.append({"type": "lapse_end", "t_video": round(max(self.lapse_start, t_video - self.rules.end_for_s), 2)})
            elif (self.lapse_secs == self.rules.intervention_after_s and self.intervention != "recap"
                  and t_video - self.last_intervention >= self.rules.cooldown_s):
                self.last_intervention = t_video
                out.append({"type": "intervention", "action": self.intervention, "t_video": round(t_video, 2),
                            "rewind_to": round(max(0.0, self.lapse_start - 2), 2)})
        return out

    def finish(self, t_video):
        if not self.in_lapse:
            return None
        self.in_lapse = False
        return {"type": "lapse_end", "t_video": round(t_video, 2)}
