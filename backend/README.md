# Backend (live demo)

FastAPI server for the frontend. It opens the Knight board, runs calibration, scores a 4 s EEG window every second while the lecture plays, applies the contract's lapse rules and camera override, and saves each run.

## Run

From the repo root, with the board plugged in and the signal checker stopped (only one program can hold the serial port):

```
.venv\Scripts\python -m uvicorn server:app --app-dir backend --port 8000
```

Then start the frontend (`cd frontend && npm run dev`, with `VITE_DATA_SOURCE=websocket` in `frontend/.env`). Vite proxies `/api` and `/ws` to `:8000`.

Demo flow: Sessions → Device setup (the checker) → Calibration (about 10 min) → Watch → Recap. The backend opens the board when calibration starts. Device setup must have released the port by then; the backend retries for 10 s.

## Environment variables

| Variable | Default | Use |
|---|---|---|
| `BOARD` | `knight` | `synthetic` runs on BrainFlow's synthetic board, for testing without a headset. |
| `BOARD_PORT` | auto | Serial port, such as `COM7`. By default it's the first "USB Serial Port (COMx)" found. |
| `CAL_BLOCK_S` | `60` | Seconds per calibration block (10 blocks). Use 10 for a quick test. |
| `BLINK_UV` | `150` | Windows with Fp1 peak-to-peak above this are dropped as blinks. The synthetic board needs a large value, such as 100000. |

## Modules

| File | What it does |
|---|---|
| `server.py` | REST endpoints and the WebSocket loop. It streams `eeg` every 100 ms and runs `LiveEngine.tick` every second while the video plays. `POST /run/{id}/stop` saves `recordings/live/<run>.json` and `<run>_eeg.npz`. |
| `sources.py` | `BoardSource`: the BrainFlow connection, the voltage-scale fix (÷79.57) and a rolling buffer. |
| `calibration.py` | Runs the 6 + 4 watch/count blocks, trains the model and reports leave-one-pair-out AUC. Saves `recordings/<pid>_live_model.joblib`. |
| `live.py` | `LiveEngine`: scoring, signal quality, smoothing, lapse rules, camera override and interventions. `Recenterer` adds rolling re-centering when an older saved model is reused. |
| `content.py` | The lecture list (YouTube) and transcripts. Placeholder lines are used until `backend/transcripts/<id>.json` exists. |

The model is `scripts/focus_model.py`, unchanged, with 4 s windows. Scoring uses a 10 s buffer filtered as a whole and skips the newest 1 s, because the zero-phase filter distorts the edge.

## Which model scores

1. The model calibrated in this session. This is the reliable path.
2. Otherwise, the participant's latest saved model (`<pid>_live_model.joblib` or `<pid>*_exp2_model.joblib`), with rolling re-centering. Status shows "Adapting to this session…" until 60 windows (about 1 min) are in. Reset it after re-seating the headset.
3. Otherwise, the status reports "No calibrated model for this participant".

## Not done

- Replay mode: refused with 400. Use the frontend's mock mode for replay demos.
- LLM recap: the recap is templated from the transcript lines and flags placeholder text.
