# Next steps

What's left before a live demo, as of 8 Nov 2026. The frontend runs end to end on mock data, and the camera branch works live. The live backend (`backend/`, see its README) now runs calibration, live scoring, lapses and the camera override; the recap is templated until the LLM is added. Owners follow the UI contract: backend Mahek, frontend Lohith.

## 1. Backend: blocks the live demo (Mahek)

The frontend's Sessions, Calibration, Watch and Recap screens call a FastAPI server on `:8000` that doesn't exist yet. It can mostly reuse existing code: `scripts/focus_model.py` (the model) and `scripts/headset_session.py` (board connection and voltage-scale fix).

- [x] **REST:** `/sessions`, `/session/start`, `/calibration/start`, `/video`, `/transcript`, `/run/{id}/lapses`, `/run/{id}/recap`, `/run/{id}/stop`.
- [x] **WebSocket `/ws/{run_id}`:** `focus` (1 Hz), `bands`, `lapse_start`/`lapse_end`, `intervention`, `calibration`, `status`.
- [x] **Lapse rules from the contract:**
  - 5 s smoothing.
  - A lapse starts below 0.4 for 8 s and ends above 0.5 for 4 s.
  - Camera override after 3 s away.
  - Intervention after a 10 s lapse, with a 90 s cooldown.
- [x] **Camera override:** accept the frontend's `camera` message (see `frontend/README.md`) and treat `state != "watching"` for 3 s as a lapse. Blink rate is information only.
- [x] **Calibration:** 6 calibration + 4 held-out test blocks of alternating watch / count-back-by-7. Train the per-person model and report the held-out AUC.
- [x] **Re-centering** (calibrate per session for the demo; rolling re-centering is the fallback when an older model is reused): the model doesn't carry across sessions as saved. On our data, session 1's model called everything focused in session 2. Recalibrate per session, or add rolling re-centering (Riemannian, unlabeled), which recovered AUC 0.79 in one direction.
- [ ] **Recap** (templated for now; LLM skipped): an LLM summary and flashcards per lapse from the transcript. Decide the LLM provider and the transcript source (Whisper, or the placeholder lines).
- [x] **Voltage scale:** BrainFlow 5.23.0 reports Knight EEG 79.57x too large; apply `knight_scale()` from `scripts/headset_session.py`.

## 2. Decisions needed

- [x] **Live EEG traces** (the backend sends `eeg` messages): the contract has no raw-EEG message, so with the real backend the Watch trace panel stays empty. Either the backend sends `eeg` messages (the frontend already handles them), or we drop the panel in live mode. The board can't serve both the backend and the signal checker at once.
- [ ] **Classifier** (staying with logistic regression for the demo): on BBBD, Tang's RBF SVM beat logistic regression for a calibrated person (AUC 0.904 against 0.872 with 4 s windows; better for 93% of participants), but was worse uncalibrated. The app needs probabilities for its thresholds, so the SVM would need probability calibration (Platt scaling).
- [x] **Window length** (the live backend uses 4 s, with `focus_model.py` unchanged): 4 s windows scored about +0.03 AUC over 2 s for both classifiers. `focus_model.py` uses 2 s. With the backend's 5 s smoothing and 8 s lapse rule, 4 s costs no real responsiveness.

## 3. Frontend (Lohith)

- [x] **Align with the real backend:** check the 7 assumed request/message shapes listed under "To confirm with the backend" in `frontend/README.md` once the backend exists.
- [x] **Show why a lapse happened:** mark camera lapses ("looked away", "face not in view", "head down") on the Watch timeline and in the recap. Today they look the same as EEG lapses.
- [x] **Record camera states:** add them to the run recorder, so they appear in the operator review and the CSV export.
- [x] **Baseline status,** if the backend adds re-centering: "Adapting to this session…" plus a reset button.
- [x] **Settings → Model:** update the text if the SVM or 4 s windows are adopted.

## 4. Experiment recordings

- [x] **Chunked webcam upload in `experiment/static/index.html`:** today a clip uploads only when its video ends, so stopping early loses it. This is how TEST_s2's counting clip was lost.
- [x] **"Stop and save" button** on the participant page, so the experimenter can end a session early without losing data.

## 5. Before the demo

- [ ] **Electrode-drift check:** run the 10-minute alternating-block calibration on the headset (`scripts/headset_session.py record`). Every recording so far had watching before counting, so drift over time hasn't been ruled out.
- [ ] **Room test:** check the camera with the presenter, in the demo room's lighting and seating. Calibrate gaze; head-turn (25°) and head-down (18°) thresholds may need tuning.
- [ ] **Backup video:** record a demo video, in replay mode if the headset or backend fails (`?video=sim` runs offline).
- [ ] **Repo visibility:** make the repo public before submission (due 11:45 am, Sunday 8 Nov). The team reference doc in `docs/` would then be public too.

## Done, for reference

- Feasibility: our 8 channels on BBBD reach a calibrated AUC of 0.872 (Gate 1: go). CBraMod lost (Gate 2: stop). See `FEASIBILITY.md`.
- Headset tools, live signal checker, Experiment 2 runner with webcam sync, replay viewer, cross-session `score`.
- Frontend: all screens on mock data. Device setup controls the real board. Camera branch (MediaPipe: face, head turned or down, eyes off screen after gaze calibration, blink rate) and the Camera review screen.
