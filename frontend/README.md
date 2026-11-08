# What did I miss? Frontend

React + TypeScript (Vite) UI for the Team 20 lecture focus app. Every screen works on mock data with no headset and no backend. One environment flag switches to the real FastAPI backend.

## Run it

```
cd frontend
npm install
npm run dev            # http://localhost:5173, mock data
```

To use the real backend, copy `.env.example` to `.env`, set `VITE_DATA_SOURCE=websocket`, and restart `npm run dev`. The dev server proxies:

| Path | Goes to | What |
|---|---|---|
| `/api/*` | `http://localhost:8000` | FastAPI REST (contract) |
| `/ws/{run_id}` | `ws://localhost:8000` | Contract WebSocket |
| `/signal/*` | `http://localhost:8766` | `scripts/live_signal.py`, the device-setup signal checker |

Nothing in the existing backend, model or scripts was changed.

**Offline demos:** add `?video=sim` to any URL to run the lecture on a labelled simulated clock instead of YouTube or the video file. It is remembered for the browser tab; `?video=normal` turns it off.

## Screens

| Route | Screen |
|---|---|
| `/sessions` | Past and scheduled sessions; New session (lecture, participant, live or replay, pause / alert / recap only, sensitivity) |
| `/setup/:runId` | Device setup: serial port, Route RLD, head map of contact quality, live trace per electrode, guided blink / clench / eyes-closed check, gate (7 of 8 usable, and Fp1, O1, O2 not poor) |
| `/calibration/:runId` | 6 calibration + 4 held-out test blocks, alternating watch and count-back-by-7; result as AUC with plain-language meaning |
| `/watch/:runId` | The instrument: video with captions, focus estimate with uncertainty, band power and engagement index, signal and camera status, stacked 8-channel EEG, artifact warnings, markers (key M), whole-lecture focus timeline, intervention overlay; replay adds the true label and "model agrees" |
| `/recap/:runId` | Student recap (focused share, lapses with replay, summary and flashcards, language, transcript) and operator review (overview brush to zoom, markers / lapses / lecture rows, band power and raw EEG for a selected range, CSV and PNG export) |
| `/participants`, `/participants/:id` | Consent (EEG, webcam), calibration result, notes, session history |
| `/settings` | Model, lapse rules, notch 50/60 Hz, channel montage, theme, captions, mock options |

## Code layout

```
src/
  data/
    types.ts            contract types (field names match the contract doc)
    DataSource.ts       the interface both sources implement
    WebSocketSource.ts  real backend
    recorder.ts         records a run for review and export
    mock/               MockSource, runEngine (contract lapse rules), eegSimulator, content
  components/           TraceViewer, HeadMap, FocusTimeline, BandPowerPanel, VideoPlayer, InterventionOverlay, Status
  screens/              one file per screen
  state/                settings, data source provider, useRun
  lib/                  dsp (filters, FFT), uncertainty, exporters, format, canvas helpers
  styles/               tokens.css (palette, type scale, dark mode), app.css
```

The live traces and the focus timeline draw on canvas: 8 channels at 125 Hz, min/max decimated per pixel. With `prefers-reduced-motion` they redraw 4 times a second instead of 60.

## To confirm with the backend

The contract doc fixes the `focus` message exactly. These details are not in it; the UI assumes the following, and each lives in one place (`WebSocketSource.ts` or `types.ts`):

1. **Lecture list:** `GET /sessions` returns lectures (`[{id, title, video, length_s}]`). Past runs are kept in the browser.
2. **Video and transcript:** `GET /video?lecture_id=` serves the video when `video` is empty; `GET /transcript?lecture_id=` returns `[{start, end, text}]`.
3. **Start calls:** `POST /session/start` takes `{lecture_id, participant_id, mode, intervention, sensitivity}` and returns `{run_id}`. `POST /calibration/start` takes `{run_id}`.
4. **Recap:** `GET /run/{id}/recap?lang=` returns `{focused_fraction, items: [{lapse, summary[], flashcards[{front, back}]}]}`.
5. **WebSocket message shapes the contract names but doesn't spell out:** `bands` (`{bands: {ch: {delta, theta, alpha, beta}}}`), `intervention` (`{action, t_video, rewind_to}`), `calibration` (`{block, n_blocks, phase, task, seconds_left, block_s, start_number?, done?, auc?}`), `status`, plus `settings` sent by the UI.
6. **Not in the contract, optional:**
   - `confidence` on `focus`; without it the UI derives the uncertainty band and says so on screen.
   - raw `eeg` chunks; without them the live trace panels stay empty during a lecture.
   - `camera` on `status`.
7. **Camera message (UI → backend, once a second while the webcam runs):**
   `{type: "camera", t_video, state, face, head_turned, head_down, eyes_off, blink_rate}`, where `state` is one of `watching`, `face_missing`, `head_turned`, `head_down`, `eyes_off`. The backend applies the 3 s camera override when `state` isn't `watching`. `blink_rate` is information only and never triggers a lapse. All camera analysis happens in the browser (MediaPipe Face Landmarker); no video is sent.
8. **Voltage scale:** BrainFlow 5.23.0 reports Knight EEG 79.57 times too large. `scripts/live_signal.py` already corrects it; any new backend code must too (see `knight_scale()` in `scripts/headset_session.py`).
