# Focus Lecture App (Team 20, NeuroPawn orange track)

A passive BCI that notices when a student zones out during a lecture and recaps what they missed.

## Docs

- [UI contract](docs/UI%20contract.md): frontend screens, backend REST and WebSocket contract, lapse rules
- [Team 20 reference](docs/Neurotech%20Hackathon%20Team%2020%20Reference%20(NeuroPawn%20Orange%20Track).pdf): event, hardware, directions considered, literature
- [Focus detection feasibility gameplan](docs/Focus%20Detection%20Feasibility%20Gameplan.pdf): the 4-hour BBBD test plan and gates

## Feasibility result (BBBD Exp 2, our 8 channels)

Riemannian (Tang recipe), 4 s windows: calibrated AUC 0.872 (Gate 1: GO), new person 0.64 (0.70 with re-centering).
CBraMod frozen probe: 0.684, so Riemannian wins (Gate 2: stop, no fine-tune).

## Code

See [FEASIBILITY.md](FEASIBILITY.md) for the full results and run steps, and [experiment/GUIDE.md](experiment/GUIDE.md) for running a recording session.

| Folder | What it does |
|---|---|
| `scripts/` | BBBD download and preprocessing, the Riemannian check (Gate 1), the CBraMod probe and fine-tune (Gate 2), the shared `focus_model.py`, the headset session tools, and the live signal checker |
| `experiment/` | BBBD Experiment 2 recreation: participant web page (randomized videos, flash and beep, shuffled quiz, webcam), EEG recorder, `evaluate`, `sync`, and the replay viewer |
| `notebooks/` | Colab notebook for CBraMod fine-tuning on a GPU |
| `results/` | Result JSONs (per-participant AUCs) and logs |

```
pip install -r requirements.txt
python scripts/live_signal.py --port COM7                                   # adjust the headset
python experiment/run_experiment.py run --participant P01 --port COM7       # record a session
python experiment/run_experiment.py evaluate --participant P01
python experiment/replay.py --participant P01                               # webcam + lecture + model verdict
```

Not in the repo: `data/` (BBBD; re-download with `scripts/download_bbbd.py`) and `recordings/` (participant EEG and webcam video).

**Knight board voltage:** BrainFlow 5.23.0 reports EEG 79.57x too large. The scripts correct this automatically; see `knight_scale()` in `scripts/headset_session.py`.
