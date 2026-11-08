"""Live signal checker: adjust the headset while watching each channel's voltage.

Opens a browser page with, per channel:
  - the last 5 s of signal, filtered like the model (60 Hz notch + 1-40 Hz)
  - noise level = SD of the last 2 s in uV: green < 30, amber 30-60, red > 60, grey = flat
  - 60 Hz hum ratio from the raw signal (high = poor contact / ground)
  - alpha share (8-12 Hz of 1-40 Hz): should rise at O1/O2/Pz when you close your eyes
Same board setup as the experiment (scripts/headset_session.connect), so close the EXG
Visualizer first. Ctrl+C to stop.

Usage
  python scripts/live_signal.py --port COM7
  python scripts/live_signal.py --board synthetic        # without the headset
"""
import argparse
import json
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from scipy.signal import butter, iirnotch, sosfiltfilt, tf2sos, welch

from headset_session import connect
from preprocess import HEADSET_8

BUFFER_S, SHOW_S, STAT_S = 10, 5, 2


class Stream:
    def __init__(self, board, info):
        self.board, self.info, self.sf = board, info, info["sfreq"]
        self.buf = np.zeros((len(info["eeg"]), 0))
        self.lock = threading.Lock()
        nyq = self.sf / 2
        self.sos = np.vstack([tf2sos(*iirnotch(60, 30, self.sf)),
                              butter(4, [1 / nyq, 40 / nyq], btype="band", output="sos")])
        threading.Thread(target=self._poll, daemon=True).start()

    def _poll(self):
        keep = int(BUFFER_S * self.sf)
        while True:
            time.sleep(0.1)
            new = self.board.get_board_data()[self.info["eeg"]] * self.info["scale"]  # true uV
            with self.lock:
                self.buf = np.concatenate([self.buf, new], axis=1)[:, -keep:]

    def snapshot(self):
        with self.lock:
            raw = self.buf.copy()
        if raw.shape[1] < self.sf * 3:
            return {"ready": False}
        x = raw - raw.mean(axis=1, keepdims=True)
        filt = sosfiltfilt(self.sos, x, axis=1)
        show, stat = filt[:, -int(SHOW_S * self.sf):], filt[:, -int(STAT_S * self.sf):]
        f, p_raw = welch(x[:, -int(4 * self.sf):], self.sf, nperseg=int(2 * self.sf))
        _, p = welch(filt[:, -int(4 * self.sf):], self.sf, nperseg=int(2 * self.sf))
        band = lambda P, lo, hi: P[:, (f >= lo) & (f < hi)].sum(axis=1)
        return {"ready": True, "sfreq": self.sf,
                "traces": np.round(show[:, ::2], 1).tolist(),  # every 2nd sample is plenty for drawing
                "sd": np.round(stat.std(axis=1), 1).tolist(),
                "ptp": np.round(np.ptp(stat, axis=1), 0).tolist(),
                "hum": np.round(band(p_raw, 58, 62) / (band(p_raw, 1, 40) + 1e-9), 2).tolist(),
                "alpha": np.round(band(p, 8, 12) / (band(p, 1, 40) + 1e-9), 2).tolist(),
                "dc": np.round(raw[:, -int(STAT_S * self.sf):].mean(axis=1), 0).tolist()}


PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Live Signal</title>
<style>
:root{--bg:#0d0f12;--panel:#161a20;--fg:#e6e8eb;--muted:#8b929c;--good:#3ecf8e;--ok:#f5b83d;--bad:#ff5c5c;--flat:#6b7280;--line:#7cb7ff}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid #222}
h1{font-size:18px;margin:0;font-weight:600} .muted{color:var(--muted)} select{background:var(--panel);color:var(--fg);border:1px solid #333;border-radius:6px;padding:4px 8px}
.row{display:grid;grid-template-columns:56px 1fr 120px 92px 110px;gap:12px;align-items:center;padding:6px 16px;border-bottom:1px solid #1d2128}
.name{font-weight:700;font-size:16px} canvas{width:100%;height:64px;background:var(--panel);border-radius:6px;display:block}
.sd{font-size:24px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums} .sd small{font-size:12px;font-weight:400;color:var(--muted)}
.tag{font-size:12px;padding:2px 8px;border-radius:999px;background:#222;display:inline-block}
.bar{height:8px;background:#222;border-radius:4px;overflow:hidden} .bar i{display:block;height:100%;background:var(--line)}
.legend span{margin-right:12px} @media(max-width:720px){.row{grid-template-columns:44px 1fr 90px}.hide-sm{display:none}}
</style></head><body>
<header><h1>Live signal</h1>
<span class="muted" id="info">connecting...</span>
<label class="muted">Scale <select id="scale"><option>50</option><option selected>100</option><option>200</option><option>500</option><option>2000</option></select> µV</label>
<span class="legend muted"><span style="color:var(--good)">● &lt;30 good</span><span style="color:var(--ok)">● 30–60 ok</span><span style="color:var(--bad)">● &gt;60 bad</span><span style="color:var(--flat)">● flat</span></span>
</header>
<div class="row muted" style="font-size:12px"><span>Ch</span><span>last 5 s, 1–40 Hz + 60 Hz notch</span><span style="text-align:right">noise (2 s SD)</span><span class="hide-sm">60 Hz hum</span><span class="hide-sm">alpha share</span></div>
<div id="rows"></div>
<p class="muted" style="padding:8px 16px">Checks: blink hard → big spikes on Fp1 · clench teeth → bursts everywhere · close eyes 10 s → alpha bar rises at O1/O2/Pz.
If every channel is red and moves together, check the ear clip (RLD/COMM). If single channels are red, reseat those electrodes (part hair, add paste).</p>
<script>
const CH = __CHANNELS__, rows = document.getElementById("rows");
CH.forEach((c, i) => rows.insertAdjacentHTML("beforeend",
  `<div class="row"><span class="name">${c}</span><canvas id="cv${i}" width="1200" height="128"></canvas>
   <span class="sd" id="sd${i}">–</span><span class="hide-sm"><span class="tag" id="hum${i}">–</span></span>
   <span class="hide-sm"><div class="bar"><i id="al${i}" style="width:0"></i></div><small class="muted" id="alt${i}"></small></span></div>`));
const color = sd => sd < 0.5 ? "var(--flat)" : sd < 30 ? "var(--good)" : sd < 60 ? "var(--ok)" : "var(--bad)";
function draw(cv, y, scale, col) {
  const g = cv.getContext("2d"), w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h); g.strokeStyle = "#2a2f38"; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
  y.forEach((v, k) => { const px = k / (y.length - 1) * w, py = h / 2 - Math.max(-1, Math.min(1, v / scale)) * h / 2;
                        k ? g.lineTo(px, py) : g.moveTo(px, py); });
  g.stroke();
}
async function tick() {
  try {
    const d = await fetch("/data").then(r => r.json());
    if (d.ready) {
      document.getElementById("info").textContent = `${d.sfreq} Hz · updating`;
      const scale = +document.getElementById("scale").value;
      CH.forEach((c, i) => {
        const col = getComputedStyle(document.body).getPropertyValue(color(d.sd[i]).slice(4, -1)).trim();
        draw(document.getElementById("cv" + i), d.traces[i], scale, col || "#7cb7ff");
        const el = document.getElementById("sd" + i);
        el.innerHTML = `${d.sd[i].toFixed(0)}<small> µV</small>`; el.style.color = color(d.sd[i]);
        const hum = document.getElementById("hum" + i);
        hum.textContent = d.hum[i] > 1 ? `high ${d.hum[i]}` : `ok ${d.hum[i]}`;
        hum.style.background = d.hum[i] > 1 ? "#5a1f1f" : "#1f3a2c";
        document.getElementById("al" + i).style.width = Math.min(100, d.alpha[i] * 200) + "%";
        document.getElementById("alt" + i).textContent = `${Math.round(d.alpha[i] * 100)}%`;
      });
    } else document.getElementById("info").textContent = "buffering...";
  } catch (e) { document.getElementById("info").textContent = "lost connection to the script"; }
  setTimeout(tick, 250);
}
tick();
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", choices=["knight", "knight-imu", "synthetic"], default="knight")
    ap.add_argument("--port")
    ap.add_argument("--gain", type=int, default=12)
    ap.add_argument("--channels", default=",".join(HEADSET_8))
    ap.add_argument("--no-rld", action="store_true", help="leave Route RLD off (as in the EXG Visualizer default)")
    ap.add_argument("--http-port", type=int, default=8766)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    channels = a.channels.split(",")
    board, info = connect(a.board, a.port, a.gain, not a.no_rld)
    stream = Stream(board, info)
    page = PAGE.replace("__CHANNELS__", json.dumps(channels)).encode()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            body, ctype = (json.dumps(stream.snapshot()).encode(), "application/json") if self.path == "/data" \
                else (page, "text/html; charset=utf-8")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    ThreadingHTTPServer.allow_reuse_address = False
    srv = ThreadingHTTPServer(("127.0.0.1", a.http_port), H)
    url = f"http://localhost:{a.http_port}"
    print(f"live signal: {url}   (Ctrl+C to stop)", flush=True)
    if not a.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        board.stop_stream()
        board.release_session()


if __name__ == "__main__":
    main()
