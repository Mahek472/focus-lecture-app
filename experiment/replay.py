"""Replay a session: webcam + the lecture video side by side, with what the person was doing
(attentive / counting) and what the model detected, second by second.

Model scores are out-of-fold: every window is scored by a model that did not train on it
(leave-one-video-out with 2+ videos, otherwise the 4-chunk time split from `evaluate`).
Focus = 1 - P(distracted); the label uses a 3-window (~6 s) moving average, as the app's
5 s smoothing rule does; focus < 0.5 = "distracted".

Usage: python experiment/replay.py --participant TEST [--session s2]     (runs `sync` first if needed)
then it opens http://localhost:8767
"""
import argparse
import json
import os
import subprocess
import sys
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from focus_model import FocusModel, clean, to_bands  # noqa: E402
from headset_session import REC_DIR, blocks_from_markers, load_rec  # noqa: E402
from preprocess import windows  # noqa: E402

COND = {1: "attentive", 2: "distracted"}


def recordings_with_times(participant, settle_s, blink_uv):
    """Per video recording: band windows, blink mask, and each window's centre in seconds from video start."""
    name = f"{participant}_exp2"
    data, d = load_rec(f"{REC_DIR}/{name}.npz")
    sf, ch = float(d["sfreq"]), list(d["ch_names"])
    sess = json.load(open(f"{REC_DIR}/{name}_session.json", encoding="utf-8"))
    page_t = [m["t_client_ms"] for m in sess["markers"] if m.get("t_client_ms") is not None]
    x = clean(data, sf)
    xb = to_bands(x, sf)
    proto = FocusModel(ch, sf, blink_uv=blink_uv)
    w = int(proto.win_s * sf)
    recs = []
    for n, b in enumerate(blocks_from_markers(d["markers"])):  # n-th video: page markers 2n (start), 2n+1 (end)
        cond, stim = divmod(b["code"], 10)
        if cond not in COND:
            continue
        # true samples per second for this video from its start/end markers (board runs ~125.9 Hz)
        rate = sf
        if 2 * n + 1 < len(page_t):
            rate = (b["end"] - b["start"]) / ((page_t[2 * n + 1] - page_t[2 * n]) / 1000)
        s = b["start"] + int(settle_s * sf)
        wb, starts = windows(xb[..., s:b["end"]], sf, proto.win_s)
        ww, _ = windows(x[:, s:b["end"]], sf, proto.win_s)
        centre = (s - b["start"] + np.arange(len(wb)) * w + w / 2) / rate
        recs.append(dict(stim=stim, cond=cond, y=cond - 1, Xb=wb, keep=proto.blink_mask(ww), t=centre))
    return recs, ch, sf, sess


def out_of_fold(recs, ch, sf):
    stims = sorted({r["stim"] for r in recs})
    for r in recs:
        r["focus"] = np.full(len(r["Xb"]), np.nan)

    def fit(train):
        X = np.concatenate([r["Xb"][m] for r, m in train])
        y = np.concatenate([np.full(int(m.sum()), r["y"]) for r, m in train])
        return FocusModel(ch, sf).fit(X, y)

    if len(stims) >= 2:
        method = "leave-one-video-out"
        for v in stims:
            model = fit([(r, r["keep"]) for r in recs if r["stim"] != v])
            for r in recs:
                if r["stim"] == v:
                    r["focus"] = model.focus(r["Xb"])
    else:
        method = "time-chunk (one video: same video in train and test)"
        k = 4
        for i in range(k):
            train, test = [], []
            for r in recs:
                n = len(r["Xb"]); a, b = i * n // k, (i + 1) * n // k
                m = r["keep"].copy(); m[max(0, a - 1):min(n, b + 1)] = False
                train.append((r, m)); test.append((r, a, b))
            model = fit(train)
            for r, a, b in test:
                r["focus"][a:b] = model.focus(r["Xb"][a:b])
    return method


def build(participant, settle_s, blink_uv):
    cam_dir = f"{REC_DIR}/{participant}_cam"
    if not os.path.exists(cam_dir):
        sys.exit(f"no webcam clips in {cam_dir}")
    recs, ch, sf, sess = recordings_with_times(participant, settle_s, blink_uv)
    method = out_of_fold(recs, ch, sf)
    clips = []
    for r in recs:
        clip = f"{COND[r['cond']]}_stim{r['stim']}"
        csv = f"{cam_dir}/{clip}_frames.csv"
        if not os.path.exists(f"{cam_dir}/{clip}.webm"):
            continue
        if not os.path.exists(csv):
            subprocess.run([sys.executable, os.path.join(HERE, "run_experiment.py"), "sync", "--participant", participant],
                           check=True)
        fr = np.genfromtxt(csv, delimiter=",", names=True)
        offset = float(fr["t_from_video_start_s"][0])  # video-start time of the clip's first frame (pts 0)
        f = r["focus"]
        smooth = np.convolve(np.nan_to_num(f, nan=np.nanmean(f)), np.ones(3) / 3, mode="same")
        detected = smooth < 0.5
        truth = bool(r["y"])
        clips.append(dict(clip=clip, title=sess["videos"][str(r["stim"])]["title"],
                          youtube=sess["videos"][str(r["stim"])]["youtube"],
                          webm=f"/{participant}_cam/{clip}.webm", offset_s=offset, truth_distracted=truth,
                          t=np.round(r["t"], 2).tolist(), focus=np.round(f, 3).tolist(),
                          smooth=np.round(smooth, 3).tolist(), blink=(~r["keep"]).tolist(),
                          accuracy=float(np.mean(detected == truth))))
    return dict(participant=participant, method=method, channels=ch, clips=clips)


PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Session Replay</title>
<style>
:root{--bg:#0e1013;--panel:#171a1f;--fg:#e7e9ec;--muted:#8d949e;--focus:#3ecf8e;--dist:#ff6b6b;--line:#7cb7ff}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:center;padding:12px 16px;border-bottom:1px solid #23272e}
h1{font-size:18px;margin:0} .muted{color:var(--muted)} select,button{font:inherit;background:var(--panel);color:var(--fg);border:1px solid #333;border-radius:6px;padding:5px 10px}
.vids{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:12px 16px}
.vid{position:relative;background:#000;border-radius:8px;overflow:hidden;aspect-ratio:4/3}
.vid video{width:100%;height:100%;object-fit:cover;transform:scaleX(-1)} .vid iframe,#yt{width:100%;height:100%;border:0}
.cap{position:absolute;left:8px;top:8px;background:#000a;padding:2px 8px;border-radius:4px;font-size:12px}
.status{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:0 16px}
.card{background:var(--panel);border-radius:8px;padding:10px 14px} .card b{display:block;font-size:22px}
canvas{display:block;width:calc(100% - 32px);height:150px;margin:12px 16px;background:var(--panel);border-radius:8px;cursor:pointer}
@media(max-width:760px){.vids,.status{grid-template-columns:1fr}}
</style></head><body>
<header><h1>Session replay</h1><span class="muted" id="meta"></span>
<label class="muted">Clip <select id="clip"></select></label><button id="play">Play</button></header>
<div class="vids">
  <div class="vid"><video id="cam" playsinline></video><span class="cap">Webcam</span></div>
  <div class="vid"><div id="yt"></div><span class="cap" id="ytcap">Lecture</span></div>
</div>
<div class="status">
  <div class="card"><span class="muted">What they were doing</span><b id="truth">–</b></div>
  <div class="card"><span class="muted">Model detects (focus score)</span><b id="pred">–</b></div>
  <div class="card"><span class="muted">Model right?</span><b id="ok">–</b><span class="muted" id="acc"></span></div>
</div>
<canvas id="tl" width="1600" height="300"></canvas>
<p class="muted" style="padding:0 16px 16px">Line: focus score per 2 s window (out-of-fold). Thick line: ~6 s smoothed. Below 0.5 = model says distracted.
Background: green = watching normally, red = counting back by 7. Click the timeline to seek. Grey ticks: windows dropped as blinks.</p>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
const D = __DATA__, $ = id => document.getElementById(id), cam = $("cam");
let C = D.clips[0], yt, ytReady = false;
$("meta").textContent = `${D.participant} · scores: ${D.method}`;
D.clips.forEach((c, i) => $("clip").insertAdjacentHTML("beforeend", `<option value="${i}">${c.clip} (${c.title})</option>`));
window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player("yt", {videoId: C.youtube, playerVars: {controls: 0, rel: 0, modestbranding: 1, mute: 1},
                            events: {onReady: () => { ytReady = true; yt.mute(); }}});
};
function load(i) {
  C = D.clips[i]; cam.src = C.webm; cam.currentTime = 0;
  $("ytcap").textContent = "Lecture: " + C.title;
  if (ytReady) yt.cueVideoById(C.youtube);
  $("acc").textContent = ` · ${Math.round(C.accuracy * 100)}% of windows correct in this clip`;
  draw();
}
const vt = () => cam.currentTime + C.offset_s;              // seconds from lecture-video start
function at(t) {                                             // window covering time t
  let best = -1, dist = 1e9;
  C.t.forEach((c, k) => { const d = Math.abs(c - t); if (d < dist) { dist = d; best = k; } });
  return dist <= 1.5 ? best : -1;
}
function draw() {
  const g = $("tl").getContext("2d"), W = 1600, H = 300, T = Math.max(...C.t) + 2, X = t => t / T * W, Y = v => H - 20 - v * (H - 40);
  g.clearRect(0, 0, W, H);
  g.fillStyle = C.truth_distracted ? "#ff6b6b22" : "#3ecf8e22"; g.fillRect(0, 0, W, H);
  g.strokeStyle = "#555"; g.setLineDash([8, 8]); g.beginPath(); g.moveTo(0, Y(0.5)); g.lineTo(W, Y(0.5)); g.stroke(); g.setLineDash([]);
  const line = (vals, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath();
    vals.forEach((v, k) => { if (v === null || isNaN(v)) return; const p = [X(C.t[k]), Y(v)]; k ? g.lineTo(...p) : g.moveTo(...p); }); g.stroke(); };
  line(C.focus, 2, "#7cb7ff88"); line(C.smooth, 5, "#7cb7ff");
  g.fillStyle = "#888"; C.blink.forEach((b, k) => b && g.fillRect(X(C.t[k]) - 2, H - 14, 4, 10));
  g.fillStyle = "#ccc"; g.font = "22px system-ui"; g.fillText("focus 1.0", 8, 26); g.fillText("0.5", 8, Y(0.5) - 6);
  const px = X(vt()); g.strokeStyle = "#fff"; g.lineWidth = 3; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();
}
function update() {
  const t = vt(), k = at(t);
  $("truth").textContent = t < 0 ? "Black screen (before video)" : C.truth_distracted ? "Counting back by 7" : "Watching normally";
  $("truth").style.color = t < 0 ? "" : C.truth_distracted ? "var(--dist)" : "var(--focus)";
  if (k >= 0) {
    const s = C.smooth[k], dist = s < 0.5, right = dist === C.truth_distracted;
    $("pred").textContent = `${dist ? "Distracted" : "Focused"} (${s.toFixed(2)})`;
    $("pred").style.color = dist ? "var(--dist)" : "var(--focus)";
    $("ok").textContent = right ? "✓ yes" : "✗ no"; $("ok").style.color = right ? "var(--focus)" : "var(--dist)";
  } else { $("pred").textContent = "–"; $("ok").textContent = "–"; $("pred").style.color = $("ok").style.color = ""; }
  if (ytReady && t >= 0 && !cam.paused) {
    if (yt.getPlayerState() !== 1) yt.playVideo();
    if (Math.abs(yt.getCurrentTime() - t) > 0.6) yt.seekTo(t, true);
  } else if (ytReady && yt.getPlayerState() === 1 && (cam.paused || t < 0)) yt.pauseVideo();
  draw();
  requestAnimationFrame(update);
}
$("clip").onchange = e => load(+e.target.value);
$("play").onclick = () => { cam.paused ? cam.play() : cam.pause(); };
cam.onplay = () => $("play").textContent = "Pause"; cam.onpause = () => $("play").textContent = "Play";
$("tl").onclick = e => { const r = e.target.getBoundingClientRect(), T = Math.max(...C.t) + 2;
                         cam.currentTime = Math.max(0, (e.clientX - r.left) / r.width * T - C.offset_s);
                         if (ytReady) yt.seekTo(Math.max(0, vt()), true); };
load(0); update();
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--participant", required=True)
    ap.add_argument("--session", help="a repeat run, e.g. s2 (files <participant>_<session>_*)")
    ap.add_argument("--settle-s", type=float, default=2)
    ap.add_argument("--blink-uv", type=float, default=150)
    ap.add_argument("--http-port", type=int, default=8767)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    data = build(f"{a.participant}_{a.session}" if a.session else a.participant, a.settle_s, a.blink_uv)
    for c in data["clips"]:
        print(f"{c['clip']:20s} truth {'distracted' if c['truth_distracted'] else 'attentive':10s} "
              f"windows correct {c['accuracy']:.0%}  (webcam starts {c['offset_s']:+.1f} s from video start)")
    html = PAGE.replace("__DATA__", json.dumps(data)).encode()

    class H(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(html)))
                self.end_headers()
                self.wfile.write(html)
            else:
                super().do_GET()  # webcam clips from recordings/

    ThreadingHTTPServer.allow_reuse_address = False
    srv = ThreadingHTTPServer(("127.0.0.1", a.http_port), partial(H, directory=os.path.abspath(REC_DIR)))
    url = f"http://localhost:{a.http_port}"
    print(f"replay: {url}   (Ctrl+C to stop)", flush=True)
    if not a.no_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
