"""EEG source for the live loop: the NeuroPawn Knight board via scripts/headset_session.connect
(channels on, RLD, BrainFlow voltage fix), polled every 100 ms in a thread. Keeps the whole
recording so calibration can cut its blocks and the run can be saved."""
import os
import subprocess
import threading
import time

import numpy as np

from headset_session import connect
from preprocess import HEADSET_8

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def find_board_port():
    """First 'USB Serial Port (COMx)' on Windows; override with BOARD_PORT."""
    if os.environ.get("BOARD_PORT"):
        return os.environ["BOARD_PORT"]
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'USB Serial Port \\(COM\\d+\\)' } | ForEach-Object { $_.Name }"],
                             capture_output=True, text=True, timeout=10).stdout
        import re
        m = re.search(r"\((COM\d+)\)", out)
        return m.group(1) if m else None
    except Exception:
        return None


class BoardSource:
    kind = "live"

    def __init__(self, channels=HEADSET_8, gain=12, rld=True, port=None):
        self.channels = list(channels)
        kind = os.environ.get("BOARD", "knight")   # BOARD=synthetic: BrainFlow's fake board, for testing without the headset
        port = port or (find_board_port() if kind != "synthetic" else "")
        if kind != "synthetic" and not port:
            raise RuntimeError("No USB serial port found for the board. Plug it in, or set BOARD_PORT.")
        err = None
        for _ in range(10):               # the Device setup checker may still be releasing the port
            try:
                self.board, self.info = connect(kind, port, gain, rld)
                break
            except Exception as e:  # noqa: BLE001
                err = e
                time.sleep(1.0)
        else:
            raise RuntimeError(f"Could not open the board on {port}: {err}")
        self.port, self.sfreq = port, float(self.info["sfreq"])
        self.chunks, self.total, self.lock = [], 0, threading.Lock()
        self.running = True
        threading.Thread(target=self._poll, daemon=True).start()

    def _poll(self):
        while self.running:
            time.sleep(0.1)
            try:
                raw = self.board.get_board_data()
            except Exception:  # noqa: BLE001
                continue
            if raw.shape[1] == 0:
                continue
            x = (raw[self.info["eeg"]] * self.info["scale"]).astype(np.float32)
            with self.lock:
                self.chunks.append(x)
                self.total += x.shape[1]

    def recording(self):
        with self.lock:
            return np.concatenate(self.chunks, axis=1) if self.chunks else np.zeros((len(self.channels), 0), np.float32)

    def latest(self, seconds):
        n = int(seconds * self.sfreq)
        with self.lock:
            out, have = [], 0
            for c in reversed(self.chunks):
                out.append(c); have += c.shape[1]
                if have >= n:
                    break
        return np.concatenate(out[::-1], axis=1)[:, -n:] if out else np.zeros((len(self.channels), 0), np.float32)

    def since(self, sample_index):
        """New samples after an absolute sample index (for streaming eeg messages)."""
        with self.lock:
            total = self.total
        if total <= sample_index:
            return np.zeros((len(self.channels), 0), np.float32), total
        return self.latest((total - sample_index) / self.sfreq), total

    def close(self):
        self.running = False
        try:
            self.board.stop_stream(); self.board.release_session()
        except Exception:  # noqa: BLE001
            pass
