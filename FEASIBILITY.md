# Focus detection feasibility (Team 20, NeuroPawn orange track)

This repo implements the *Focus Detection Feasibility Gameplan*. The question it answers: can our 8 headset channels (Fp1, Fz, Cz, Pz, P3, P4, O1, O2) tell attentive from distracted on BBBD Experiment 2?

**Answer: yes, with per-user calibration.** Gate 1 is a GO, and Gate 2 says to stop: the Riemannian model beats CBraMod.

## Results (AUC from model scores, 30 participants)

| Model | Window | Calibrated (leave-one-video-out) | Calibrated (train on 1 video) | New person (3 folds) | New person + re-centering |
|---|---|---|---|---|---|
| Riemannian (Tang recipe) | 2 s | 0.842 | 0.748 | 0.617 | 0.666 |
| Riemannian (Tang recipe) | 4 s | **0.872** | 0.796 | 0.636 | 0.702 |
| CBraMod frozen + probe | 4 s | 0.684 | — | 0.564 | — |
| CBraMod fine-tuned | — | not run (Gate 2 stop) | | | |

- **Gate 1: GO.** Calibrated AUC is 0.872. 28 of 29 participants are at or above 0.70, and the lowest is sub-29 at 0.645.
- **Gate 2: STOP.** The CBraMod probe is 0.19 below Riemannian, outside the 0.05 margin, so Riemannian wins.
- **New person:** 0.64, or 0.70 with unsupervised re-centering. As the gameplan expected, the product needs per-user calibration.
- **Calibration time:** training on a single video (about 3–8 min per condition) still gives 0.80.
- Per-band calibrated AUC at 4 s: delta 0.74, theta 0.75, alpha 0.77, beta 0.83.

### Sanity checks

- **Labels look right.** Posterior alpha is higher when distracted for 70% of participants (t = 3.18, p = 0.004). This matches BBBD Fig. 5B.
- **No leakage.** With condition labels randomly swapped per video, the calibrated AUC is 0.44, close to chance.

### Caveats to know before pitching

1. **Order confound.** BBBD always runs attentive first and distracted second. Some of the signal could be time-on-task drift (fatigue, electrode drift) rather than attention. Holding out a whole video controls for the stimulus but not for session order.
2. **"Distracted" means silent serial-7s, not natural mind wandering.** Beta being the best band could partly reflect effort or muscle activity from counting. Lecture lapses will be subtler than this, so treat 0.87 as an upper bound for the demo.
3. **CBraMod input scale.** BBBD derivatives are low amplitude (about 3 µV SD after our filtering). We used the paper's ÷100 µV scaling and did not tune it further, because a 0.19 gap is unlikely to come from scaling alone.

### Our layout vs Tang's (BBBD, Riemannian, 4 s windows)

| Layout | Calibrated | New person | New person + re-centering |
|---|---|---|---|
| Ours: Fp1, Fz, Cz, Pz, P3, P4, O1, O2 | **0.872** | **0.636** | **0.702** |
| Tang: F3, F4, T7, C3, C4, T8, O1, O2 | 0.854 | 0.622 | 0.687 |

Keep our layout. It scores slightly higher, T7 and T8 sit over the jaw muscles, and Fp1 lets us reject blinks.

## Headset test (NeuroPawn Knight, BrainFlow board 57, 125 Hz)

[scripts/headset_session.py](scripts/headset_session.py) wraps the Tang recipe as [scripts/focus_model.py](scripts/focus_model.py), so the backend can import the same model.

1. **Place electrodes:** P3, Fz, Cz, Fp1, P4, Pz, O1, O2 go on board channels 1–8 in that order (if the wiring differs, pass `--channels`). The ear-clip ground goes on RLD/COMM.
2. **Check signal:** verify the signal in the EXG Visualizer, then **close the visualizer** (only one program can use the port).
3. **Run the check:** `python scripts/headset_session.py check --port COM3`. It walks through rest, blinks, jaw clench, eyes closed and eyes open, then prints a per-channel verdict, the blink size on Fp1 and the eyes-closed alpha ratio.
4. **Record:** `python scripts/headset_session.py record --port COM3 --name mahek1`. This runs 10 one-minute blocks that alternate WATCH (a lecture clip) and COUNT BACK BY 7 (BBBD's distractor). The script sends the channel-on and RLD commands itself, using NeuroPawn's own tutorial pattern.
5. **Read the verdict:** `evaluate` runs automatically after recording. The verdict is the leave-one-block-pair-out AUC: 0.70 or above means it works, 0.60–0.70 means check the signal first, and below 0.60 means fall back to the BBBD replay demo. It also saves a calibration-trained model to `recordings/<name>_model.joblib`.

**Rehearsal on BBBD (`simulate`, 30 people, 125 Hz, same block design):** leave-one-pair-out averaged 0.87, and every person scored 0.70 or above. The 4-block held-out score averaged 0.75 and fell below 0.60 for 17% of people, so it is reported only as a secondary number. Increasing calibration from 6 to 10 blocks made no difference.

The code paths were tested on the BrainFlow synthetic board but not yet on the real Knight board.

## How to run

```bash
python -m venv .venv && .venv/Scripts/pip install numpy scipy scikit-learn pyriemann mne pandas requests remotezip
python scripts/download_bbbd.py --exp 2            # ~1.8 GB EEG derivatives only (range reads from the S3 zip)
python scripts/preprocess.py                       # 8 ch, avg ref, 1-40 Hz + 60 Hz notch, 2 s @128 Hz + 4 s @200 Hz
python scripts/riemann_check.py --win 2            # Gate 1 (also --win 4)
python scripts/riemann_check.py --win 4
pip install torch braindecode==2.0.0 huggingface_hub safetensors
python scripts/cbramod_probe.py                    # Gate 2 (CPU ~6 min)
python scripts/results_table.py
```

For the 64-channel fallback (only needed if Gate 1 fails), run `preprocess.py --montage all`, then `riemann_check.py --data data/processed/exp2_all`.

The CBraMod fine-tune needs a GPU: use [notebooks/cbramod_colab.ipynb](notebooks/cbramod_colab.ipynb), which runs [scripts/cbramod_finetune.py](scripts/cbramod_finetune.py). It only matters if Gate 2 passes.

## Code reuse

- **Riemannian features:** the feature stack is copied from Tang, Liang & Li 2023 (their OSF code: [osf.io/7mj5e](https://osf.io/7mj5e/)): `Covariances('lwf') → TangentSpace('riemann') → StandardScaler` per band, concatenated. We changed two things. AUC comes from `predict_proba` instead of hard labels, and the classifier is logistic regression, per the gameplan.
- **CBraMod:** `braindecode.models.CBraMod.from_pretrained("braindecode/cbramod-pretrained")`.
- **BBBD download:** adapted from `madjens/bbbd-dataset/data-download-scripts`.

## Layout

```
scripts/      download_bbbd, preprocess, riemann_check, cbramod_probe, cbramod_finetune, results_table
notebooks/    cbramod_colab.ipynb (GPU fine-tune)
results/      JSON per run (per-subject AUCs included), results_table.md, logs/
reference/    Tang OSF notebooks
data/         raw BBBD derivatives + processed .npz (not for git)
```
