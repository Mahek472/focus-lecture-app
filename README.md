# Focus Lecture App (Team 20, NeuroPawn orange track)

A passive BCI that notices when a student zones out during a lecture and recaps what they missed.

## Docs

- [UI contract](docs/UI%20contract.md): frontend screens, backend REST and WebSocket contract, lapse rules
- [Team 20 reference](docs/Neurotech%20Hackathon%20Team%2020%20Reference%20(NeuroPawn%20Orange%20Track).pdf): event, hardware, directions considered, literature
- [Focus detection feasibility gameplan](docs/Focus%20Detection%20Feasibility%20Gameplan.pdf): the 4-hour BBBD test plan and gates

## Feasibility result (BBBD Exp 2, our 8 channels)

Riemannian (Tang recipe), 4 s windows: calibrated AUC 0.872 (Gate 1: GO), new person 0.64 (0.70 with re-centering).
CBraMod frozen probe: 0.684, so Riemannian wins (Gate 2: stop, no fine-tune).
