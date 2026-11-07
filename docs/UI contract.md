
# Focus Lecture App: UI Guide and Backend Contract

Doc: https://claude.ai/artifact/4Mg5jzB5BLgPwiGmvJAsa9

- Frontend (Lohith, React + Vite): Setup, Calibration (live only), Watch (main), intervention overlay, Recap (summary + flashcards).
- Backend (Mahek, FastAPI on :8000): REST /sessions, /session/start, /calibration/start, /video, /transcript, /run/{id}/lapses, /run/{id}/recap, /run/{id}/stop.
- WebSocket /ws/{run_id}: backend sends focus (1 Hz, score 0-1, state, quality, truth in replay), bands, lapse_start/lapse_end, intervention, calibration, status. Frontend sends video_state (1 Hz + on play/pause/seek), intervention_response, feedback (false alarm).
- Rules: 5 s smoothing; lapse when score < 0.4 for 8 s, ends above 0.5 for 4 s; camera override 3 s; intervention after 10 s, 90 s cooldown.
- Replay demo: spliced BBBD sessions (alternating attentive/distracted chunks), Whisper transcript, eye-tracker features stand in for camera (BBBD has no face video).
- A tested mock server is in the doc so the UI can start before the model is ready.