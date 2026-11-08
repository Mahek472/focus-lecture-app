"""FastAPI backend for the live demo (contract: docs/UI contract.md + frontend/README.md).

Run:  .venv\\Scripts\\python -m uvicorn server:app --app-dir backend --port 8000
The frontend reaches it through the Vite proxy (/api -> :8000, /ws -> :8000).

Flow: Device setup (frontend + signal checker) -> POST /calibration/start: the backend opens the
board, runs the 10-block calibration, trains and saves the participant's model -> Watch: the
WebSocket loop streams EEG, scores a window every second while the video plays, applies the
lapse rules and the camera override, and sends focus / bands / lapse / intervention / status.
Without a calibration in this session, the participant's latest saved model is used with rolling
re-centering. POST /run/{id}/stop saves the run (EEG + focus log + lapses) to recordings/live/.
Live mode only: replay runs are refused (the frontend's mock mode covers replay demos).
"""
import asyncio
import glob
import json
import os
import sys
import time
import uuid

import numpy as np
from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, HERE)

from calibration import run_calibration  # noqa: E402
from content import LECTURES, lecture, snippet, transcript  # noqa: E402
from focus_model import FocusModel  # noqa: E402
from live import BUFFER_S, LiveEngine  # noqa: E402
from sources import BoardSource  # noqa: E402

REC = os.path.join(ROOT, "recordings")
app = FastAPI(title="What did I miss? backend")
runs: dict[str, "Run"] = {}
board: BoardSource | None = None
board_lock = asyncio.Lock()


class Run:
    def __init__(self, run_id, req):
        self.id, self.req = run_id, req
        self.lecture = lecture(req["lecture_id"])
        self.transcript, self.placeholder = transcript(req["lecture_id"])
        self.intervention, self.sensitivity = req.get("intervention", "alert"), float(req.get("sensitivity", 0.5))
        self.clients: set[WebSocket] = set()
        self.model, self.model_origin, self.engine = None, None, None
        self.video = {"t": 0.0, "playing": False}
        self.focus_log, self.lapses, self.camera_log, self.events = [], [], [], []
        self.open_lapse, self.dismiss_open = None, False
        self.state, self.message = "idle", None
        self.loop_task, self.cal_task = None, None
        self.watch_start_sample = None
        self.created = time.time()


async def ensure_board():
    global board
    async with board_lock:
        if board is None or not board.running:
            board = await asyncio.to_thread(BoardSource)
        return board


def latest_saved_model(participant):
    paths = glob.glob(os.path.join(REC, f"{participant}_live_model.joblib")) + glob.glob(os.path.join(REC, f"{participant}*_exp2_model.joblib"))
    return max(paths, key=os.path.getmtime) if paths else None


async def emit(run, msg):
    if msg.get("type") == "focus":
        run.focus_log.append(msg)
    elif msg.get("type") == "lapse_start":
        run.open_lapse = (msg["t_video"], msg.get("reason", "eeg"))
    elif msg.get("type") == "lapse_end" and run.open_lapse:
        s, why = run.open_lapse
        run.lapses.append({"start": s, "end": msg["t_video"], "snippet": snippet(run.transcript, s, msg["t_video"]), "reason": why,
                           "dismissed": run.dismiss_open})
        run.open_lapse, run.dismiss_open = None, False
    for ws in list(run.clients):
        try:
            await ws.send_json(msg)
        except Exception:  # noqa: BLE001
            run.clients.discard(ws)


async def status(run):
    eng = run.engine
    msg = {"type": "status", "state": run.state, "mode": "live", "message": run.message,
           "sfreq": board.sfreq if board else None, "model": run.model_origin}
    if eng:
        away = eng.camera_away()
        msg["camera"] = {"face_in_view": away is not None and not away, "override": eng.away_secs >= eng.rules.camera_override_s,
                         "reason": str(away).replace("_", " ") if away else None}
        if eng.recenterer is not None:
            msg["baseline"] = {"active": True, "ready": eng.recenterer.ready, "seconds_left": eng.recenterer.seconds_left()}
    await emit(run, msg)


async def ensure_engine(run):
    if run.engine:
        return True
    src = await ensure_board()
    recenter = False
    if run.model is None:
        path = latest_saved_model(run.req["participant_id"])
        if not path:
            if run.message != (msg := "No calibrated model for this participant. Run calibration first."):
                run.state, run.message = "error", msg
                await status(run)
            return False
        run.model, run.model_origin, recenter = FocusModel.load(path), f"saved: {os.path.basename(path)} (re-centering to this session)", True
    if list(run.model.ch_names) != src.channels:
        run.state, run.message = "error", f"Model channels {run.model.ch_names} don't match the board {src.channels}."
        await status(run)
        return False
    run.engine = LiveEngine(run.model, src.sfreq, src.channels, run.intervention, run.sensitivity, recenter=recenter)
    run.watch_start_sample = src.total
    run.state, run.message = "running", None
    await status(run)
    return True


async def run_loop(run):
    """Per run: stream EEG to the traces every 100 ms; score once a second while the video plays."""
    sent, last_tick, last_status = None, 0.0, 0.0
    while run.clients:
        await asyncio.sleep(0.1)
        if board and board.running:
            if sent is None:
                sent = board.total
            chunk, sent = board.since(sent)
            if chunk.shape[1]:
                await emit(run, {"type": "eeg", "sfreq": board.sfreq, "channels": board.channels,
                                 "samples": np.round(chunk.astype(float), 2).tolist()})
        now = time.time()
        if run.video["playing"] and now - last_tick >= 1.0 and run.state not in ("calibrating", "stopped"):
            last_tick = now
            if await ensure_engine(run):
                buf = board.latest(BUFFER_S)
                t = run.video["t"]
                for m in await asyncio.to_thread(run.engine.tick, t, buf):
                    await emit(run, m)
        if now - last_status >= 5:
            last_status = now
            await status(run)


# ---------------------------------------------------------------------- REST

@app.get("/sessions")
def sessions():
    return LECTURES


@app.get("/video")
def video(lecture_id: str):
    raise HTTPException(404, "Lectures play from YouTube; no local video file")


@app.get("/transcript")
def get_transcript(lecture_id: str):
    return transcript(lecture_id)[0]


@app.post("/session/start")
def session_start(req: dict = Body(...)):
    if req.get("mode") == "replay":
        raise HTTPException(400, "The live backend runs live sessions only; use the frontend's mock mode for replay demos.")
    if not lecture(req.get("lecture_id", "")):
        raise HTTPException(404, f"Unknown lecture {req.get('lecture_id')}")
    run_id = f"live-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
    runs[run_id] = Run(run_id, req)
    return {"run_id": run_id}


def get_run(run_id):
    if run_id not in runs:
        raise HTTPException(404, "Unknown run")
    return runs[run_id]


@app.post("/calibration/start")
async def calibration_start(body: dict = Body(...)):
    run = get_run(body.get("run_id", ""))
    if run.cal_task and not run.cal_task.done():
        raise HTTPException(409, "Calibration already running")

    async def go():
        try:
            run.state, run.message = "connecting", "Opening the board"
            await status(run)
            src = await ensure_board()
            run.state, run.message = "calibrating", None
            run.engine = None
            model, auc, info = await run_calibration(src, run.req["participant_id"], lambda m: emit(run, m))
            run.model, run.model_origin = model, f"calibrated this session (AUC {auc:.2f}, {info['windows']} windows of 4 s)"
            run.state, run.message = "ready", None
        except Exception as e:  # noqa: BLE001
            run.state, run.message = "error", str(e)
        await status(run)

    run.cal_task = asyncio.create_task(go())
    return {"ok": True}


@app.get("/run/{run_id}/lapses")
def lapses(run_id: str):
    return get_run(run_id).lapses


@app.get("/run/{run_id}/recap")
def recap(run_id: str, lang: str = "en"):
    run = get_run(run_id)
    known = [f for f in run.focus_log if f["state"] != "unknown"]
    focused = sum(f["state"] == "focused" for f in known) / len(known) if known else 0.0
    items = []
    for lp in run.lapses:
        if lp["dismissed"]:
            continue
        lines = [s.strip() for s in lp["snippet"].split(". ") if s.strip()] or ["Nothing was said during this stretch."]
        cards = []
        for line in lines[:3]:
            words = line.replace(".", "").replace(",", "").split()
            key = max(words, key=len) if words else ""
            cards.append({"front": line.replace(key, "_____", 1), "back": f"{key}. {line}"})
        items.append({"lapse": lp, "summary": lines, "flashcards": cards})
    note = ("Templated recap (no LLM yet)." + (" Transcript lines are placeholders, not the video's real words." if run.placeholder else "")
            + ("" if lang == "en" else " Only English is available until the LLM recap is added."))
    return {"run_id": run_id, "focused_fraction": focused, "items": items, "language": "en", "note": note}


@app.post("/run/{run_id}/stop")
async def stop(run_id: str):
    global board
    run = get_run(run_id)
    if run.engine and (end := run.engine.finish(run.video["t"])):
        await emit(run, end)
    run.state = "stopped"
    await status(run)
    os.makedirs(os.path.join(REC, "live"), exist_ok=True)
    base = os.path.join(REC, "live", run_id)
    json.dump({"run_id": run_id, "request": run.req, "model": run.model_origin, "lapses": run.lapses,
               "focus": run.focus_log, "camera": run.camera_log, "events": run.events}, open(base + ".json", "w"), indent=1)
    if board and run.watch_start_sample is not None:
        rec = board.recording()[:, run.watch_start_sample:]
        np.savez_compressed(base + "_eeg.npz", data=rec, sfreq=board.sfreq, ch_names=np.array(board.channels),
                            uv_scale="corrected", board="knight")
    if board:   # free the board for Device setup / the next session
        board.close(); board = None
    return {"ok": True, "saved": os.path.relpath(base, ROOT)}


# ---------------------------------------------------------------------- WebSocket

@app.websocket("/ws/{run_id}")
async def ws(websocket: WebSocket, run_id: str):
    await websocket.accept()
    run = runs.get(run_id)
    if not run:
        await websocket.send_json({"type": "status", "state": "error", "message": "Unknown run"})
        await websocket.close(); return
    run.clients.add(websocket)
    await status(run)
    if not run.loop_task or run.loop_task.done():
        run.loop_task = asyncio.create_task(run_loop(run))
    try:
        while True:
            m = await websocket.receive_json()
            kind = m.get("type")
            if kind == "video_state":
                run.video = {"t": float(m.get("t_video", 0)), "playing": bool(m.get("playing"))}
            elif kind == "camera":
                run.camera_log.append({k: m.get(k) for k in ("t_video", "state", "blink_rate")})
                if run.engine:
                    run.engine.set_camera(m.get("state", "watching"))
            elif kind == "settings":
                run.intervention, run.sensitivity = m.get("intervention", run.intervention), float(m.get("sensitivity", run.sensitivity))
                if run.engine:
                    run.engine.intervention, run.engine.sensitivity = run.intervention, run.sensitivity
            elif kind == "feedback":            # "I was focused": dismiss the lapse around that time
                run.events.append(m)
                t = float(m.get("t_video", 0))
                if run.open_lapse and t >= run.open_lapse[0] - 2:
                    run.dismiss_open = True            # still open: dismissed when it ends
                for lp in run.lapses:
                    if lp["start"] - 2 <= t <= lp["end"] + 15:
                        lp["dismissed"] = True
            elif kind == "reset_baseline" and run.engine and run.engine.recenterer:
                run.engine.recenterer.reset()
            else:
                run.events.append(m)
    except WebSocketDisconnect:
        pass
    finally:
        run.clients.discard(websocket)
