"""The frozen focus model: Tang et al. 2023 Riemannian recipe as a reusable object.

Same steps as the BBBD feasibility run (preprocess.py + riemann_check.py), packaged
so the headset script and the live backend share one implementation:
  continuous uV -> average reference -> 60 Hz notch -> 1-40 Hz -> 4 Tang bands
  -> 2 s windows -> per band Covariances('lwf') -> TangentSpace -> StandardScaler
  -> concatenate -> LogisticRegression.  Output: P(distracted); focus = 1 - P.

Windows whose Fp1 peak-to-peak exceeds `blink_uv` are dropped (blinks/EOG).
"""
import joblib
import mne
import numpy as np
from pyriemann.estimation import Covariances
from pyriemann.tangentspace import TangentSpace
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from preprocess import BANDS, windows


def clean(data_uv, sfreq):
    """(ch, t) uV -> average reference, 60 Hz notch, 1-40 Hz bandpass."""
    x = data_uv - data_uv.mean(axis=0, keepdims=True)
    x = mne.filter.notch_filter(x, sfreq, 60, verbose="error")
    return mne.filter.filter_data(x, sfreq, 1, 40, verbose="error")


def to_bands(x, sfreq):
    """(ch, t) cleaned -> (4, ch, t), filtered on the continuous signal like Tang."""
    return np.stack([mne.filter.filter_data(x, sfreq, lo, hi, verbose="error") for lo, hi in BANDS])


class FocusModel:
    def __init__(self, ch_names, sfreq, win_s=2.0, blink_uv=150.0):
        self.ch_names, self.sfreq, self.win_s, self.blink_uv = list(ch_names), sfreq, win_s, blink_uv
        self.band_pipes, self.clf = None, None

    def segment(self, data_uv):
        """Continuous (ch, t) uV -> band windows (n, 4, ch, w), window starts (s), blink mask."""
        x = clean(data_uv, self.sfreq)
        wb, starts = windows(to_bands(x, self.sfreq), self.sfreq, self.win_s)
        w, _ = windows(x, self.sfreq, self.win_s)
        return wb, starts, self.blink_mask(w)

    def blink_mask(self, w):
        """True = keep. w: (n, ch, samples) cleaned broadband windows."""
        if "Fp1" not in self.ch_names or not self.blink_uv:
            return np.ones(len(w), bool)
        fp1 = w[:, self.ch_names.index("Fp1")]
        return np.ptp(fp1, axis=-1) < self.blink_uv

    def _features(self, Xb, fit):
        out = []
        for b in range(Xb.shape[1]):
            if fit:
                self.band_pipes[b].fit(Xb[:, b])
            out.append(self.band_pipes[b].transform(Xb[:, b]))
        return np.concatenate(out, axis=1)

    def fit(self, Xb, y):
        self.band_pipes = [make_pipeline(Covariances("lwf"), TangentSpace(metric="riemann"), StandardScaler())
                           for _ in range(Xb.shape[1])]
        self.clf = LogisticRegression(max_iter=2000, random_state=0).fit(self._features(Xb, True), y)
        return self

    def p_distracted(self, Xb):
        return self.clf.predict_proba(self._features(Xb, False))[:, 1]

    def focus(self, Xb):
        return 1.0 - self.p_distracted(Xb)

    def save(self, path):
        joblib.dump(self, path)

    @staticmethod
    def load(path):
        return joblib.load(path)
