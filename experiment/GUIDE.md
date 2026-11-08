# Recreating BBBD Experiment 2 on our headset

This recreates the BBBD Experiment 2 protocol on the NeuroPawn Knight board and records it. The person watches 3 educational videos normally, takes a quiz, then rewatches the same videos while silently counting back by 7. The model is then scored the same way it was on BBBD (leave one video out), so the result compares directly with the BBBD number of 0.872.

**Videos:** 3 of BBBD's 5, the shortest ones: Why are Stars Star-Shaped (3:29), How Modern Light Bulbs Work (2:23) and Why Do We Have More Boys Than Girls (2:34). That's about 8.5 minutes per pass.

**Time needed:** about 30 minutes per participant: two viewing passes of about 9 minutes each, plus about 10 minutes of quizzes and ratings. To run all 5 BBBD videos (about 65 minutes), add `--videos 1,2,3,4,5` to both `run_experiment.py` and `print_quiz.py`.

## What the code does for you

| Requirement | How it's handled |
|---|---|
| Random video order | Shuffled per participant ID. The distracted pass reuses the attentive order, as BBBD did. |
| Black screen + flash + beep | Before each video: 3 s black, then a white flash and a 1 kHz beep as playback starts. After each video: a flash and beep, then 3 s black. Nothing has to be edited into the videos. |
| Sync with EEG | Each flash writes a marker into the EEG stream. Start markers are 10 + the BBBD video number for attentive (11, 12, 15) and 20 + the number for distracted (21, 22, 25); end markers are 99. |
| Quiz answers not all A | Options are shuffled per participant. "All/None/Both of the options" stays last. Question order is shuffled too. |
| Quiz documents | `print_quiz.py` writes a printable copy with the same order plus a separate answer key. |
| Distractor | A random prime between 800 and 1000 is shown for 8 s before each distracted video. Afterwards the participant types the number they reached, as a check that they really counted. |
| Webcam | One clip per video, from the black screen before it to the black screen after, saved to `recordings/<ID>_cam/` (e.g. `attentive_stim2.webm`). The participant doesn't see the preview during the study. Add `--no-camera` to skip it. |
| Saving | The EEG is saved to `recordings/<ID>_exp2.npz`. Orders, quiz answers, scores, ratings and player events go to `recordings/<ID>_exp2_session.json`. |

### How the webcam and EEG stay in sync

The method mirrors BBBD's. BBBD sent the same start and end triggers to its EEG amplifier and its eye tracker, then mapped each device's clock onto one timeline with a linear transform between those two points. A light sensor and microphone recorded the flash and beep, which confirmed the triggers matched the screen.

We do the same:
1. **Shared events.** At each flash, the page notes its own clock time and sends a marker into the EEG stream, so every start and end marker exists both as an EEG sample and as a page time.
2. **Frame times.** Each webcam clip stores a timestamp for every frame, and the page notes the clock time when the clip started recording. That gives every frame a page time.
3. **Two-point mapping.** `sync` converts page time to EEG sample with the line through the start and end markers, the same transform BBBD used.
4. **Flash check.** The white flash lights up the face, so the webcam sees a brightness jump. `sync` finds that jump at the start and end of each clip and corrects the frame times by any measured offset. This is our version of BBBD's light sensor.

Expected accuracy is within about one webcam frame (33 ms at 30 fps). The EEG is analysed in 2 s windows, so that is far finer than needed.

**About downloading the videos:** the app plays the official YouTube embeds and draws the black screen, flash and beep around them, so the result matches BBBD's embedded flash without downloading or editing anything. YouTube's terms don't allow downloading these channels' videos. If you have permission or your own copies, put them in `experiment/static/media/` and set `"file": "media/stim1.mp4"` in [stimuli.json](stimuli.json); the app then plays the local file instead.

## The day before

1. Install everything on the recording laptop:
   ```
   python -m venv .venv
   .venv\Scripts\pip install numpy scipy scikit-learn pyriemann mne brainflow joblib opencv-python-headless
   ```
2. Rehearse the participant flow with no headset. Click through it once.
   ```
   .venv\Scripts\python experiment\run_experiment.py run --participant TEST --no-eeg
   ```
3. Print the quiz backup for each planned participant:
   ```
   .venv\Scripts\python experiment\print_quiz.py --participant P01
   ```
   This writes `recordings/P01_quiz.html`. Print it with Ctrl+P; the answer key starts on its own page, so keep that page away from the participant.

## Session steps

**Roles:** an experimenter at the laptop (Mahek), someone handling electrodes and checking the signal (Eric), and the participant.

1. **Room setup.** Use a quiet room with the participant facing the screen at about 60 cm. Speakers or headphones should be on with the volume up, since the beep marks each video. Phones go on silent and out of sight.
2. **Electrodes.** Place P3, Fz, Cz, Fp1, P4, Pz, O1, O2 on board channels 1–8 in that order, with the ear-clip ground on RLD/COMM. Add conductive paste on each recording electrode.
3. **Visualizer check.** Open the EXG Visualizer, turn on each channel, and confirm a signal on all 8. Then **close the visualizer**, because only one program can use the board at a time. Note the COM port it used.
4. **Quick signal check (1 min).**
   ```
   .venv\Scripts\python scripts\headset_session.py check --port COM3 --name P01
   ```
   Every channel should say "ok", the blink ratio should be above 2x, and eyes-closed alpha should be above 1.5x. If not, fix contact or the ear clip and rerun.
5. **Start the experiment.**
   ```
   .venv\Scripts\python experiment\run_experiment.py run --participant P01 --port COM3
   ```
   Chrome opens the participant screen at http://localhost:8765. The setup page lists each channel's signal live.
   - Chrome asks for camera access: click **Allow**. A preview appears in the corner.
   - Place the webcam so the whole face is in frame and lit by the screen. Use a dim room if you can, because the flash check needs to see the screen light up the face.
   - Press F11 for full screen. Click **Test flash + beep** to confirm the screen flashes and the beep plays.
   - Click **Start study** and hand over the mouse.
6. **The participant does the rest.** The screens guide them through:
   - general-knowledge pre-test (29 questions)
   - 3 videos, watched normally, with 3 ratings after each
   - memory quiz on the 3 videos (35 questions)
   - the same 3 videos again, counting back by 7 from the number shown, typing the number reached after each

   During the session, sit out of view and stay quiet. If the participant needs to stop, press Ctrl+C in the terminal; everything recorded so far is saved.
7. **After "Thank you".** The recording saves automatically. Run:
   ```
   .venv\Scripts\python experiment\run_experiment.py evaluate --participant P01
   ```
   It prints the AUC for each video, the mean focus score per condition, the memory quiz score, and a verdict:
   - **0.70 or above:** the model works on our headset.
   - **0.60–0.70:** check signal quality first.
   - **Below 0.60:** if the signal was clean, use the BBBD replay demo.

   It also saves `recordings/P01_exp2_model.joblib`, a model trained on this person that the live app can load.
8. **Sync the webcam with the EEG.**
   ```
   .venv\Scripts\python experiment\run_experiment.py sync --participant P01
   ```
   For each clip it prints:
   - the number of frames and the fps
   - the measured flash offset at the start and the end
   - the correction applied
   - the EEG rate implied by the two markers, which should match 125 Hz

   It also writes `recordings/P01_cam/<clip>_frames.csv`, mapping each frame to its time from video start and its EEG sample. **Good sync:** the start and end flash offsets agree within about 33 ms. A "-" means the flash wasn't visible on camera (face out of frame or room too bright), so no correction was applied for that clip.

## Running the same participant again on another lecture

A second run never overwrites the first. If the participant already has a recording, `run` saves the new one as `<ID>_s2` (then `_s3`, ...) and prints that name. Each session gets its own video order, starting numbers and quiz shuffle.

1. **Pick the lecture.**
   - The BBBD videos not used yet are 3 (Immune system, 7:49) and 4 (Who invented the internet, 6:33). These keep the quiz.
   - Any other lecture: use `--youtube <video id> --title "..."`, or `--video-file media/lecture.mp4` for a file in `experiment/static/media/`. There is no quiz for these, so the quiz screens are skipped.
2. **Print the quiz, if the lecture has one:** `.venv\Scripts\python experiment\print_quiz.py --participant P01 --videos 3,4`. It writes `recordings/P01_s2_quiz.html`, matching the order the run will use.
3. **Run the session:**
   ```
   .venv\Scripts\python experiment\run_experiment.py run --participant P01 --port COM7 --videos 3,4
   .venv\Scripts\python experiment\run_experiment.py run --participant P01 --port COM7 --youtube <video id> --title "My lecture"
   ```
   To choose the name yourself, add `--session lecture2`. A name that already exists is refused, and nothing is overwritten.
4. **Score it:**
   - **This run alone:** `evaluate --participant P01 --session s2`.
   - **All of P01's runs together (better):** `evaluate --participant P01 --sessions all`. It holds out one lecture at a time across sessions, so even two single-lecture runs give a real leave-one-lecture-out score. It saves `recordings/P01_combined_exp2_model.joblib`.
5. **Sync and replay:** use the same `--session s2` with `sync` and `experiment\replay.py`.

## Options

- `--videos 1,2,3,4,5` runs the full BBBD set (about 23 min per pass). Pass the same list to `print_quiz.py`.
- `--quiz after-each` runs the README variant with a quiz after each video. The default is the paper's version: one quiz at the end, with participants not told about the test in advance.
- `--board synthetic` runs a dry run with BrainFlow's fake board (no real brain signal).
- `--channels ...` lets you list the names of board channels 1–8 if the wiring differs.

## Things to watch

- **YouTube ads.** If an ad plays before a video, the start marker fires on the ad. Use an account with YouTube Premium in Chrome, or local files. The session file logs every pause and buffering event, so a bad video can be spotted later.
- **Internet.** The YouTube embeds need a stable connection; local files avoid this.
- **Voltage scale.** BrainFlow 5.23.0 and earlier report Knight EEG 79.57x too large. BrainFlow fixed this upstream on 2026-10-21 (PR #867), but the fix isn't released yet. Our scripts correct for it automatically through `knight_scale()` in `scripts/headset_session.py`. Any code that reads BrainFlow directly, such as the live backend, must multiply the EEG rows by `1/79.57` until BrainFlow ships the fix.
- **Blinks.** Windows with large Fp1 spikes (over 150 µV) are dropped automatically. If too many drop, the Fp1 contact is likely poor.
- **Differences from BBBD.** BBBD had 64 wet electrodes in a sound booth with an eye tracker; we have 8 headset electrodes in a normal room. Expect somewhat lower numbers. The comparison is still fair, because the scoring method is identical.

## Files

- [run_experiment.py](run_experiment.py): server, EEG recorder, webcam upload, `evaluate` and `sync`
- [static/index.html](static/index.html): the participant screen
- [stimuli.json](stimuli.json): all 5 Exp 2 videos (YouTube IDs and optional local files); `--videos` picks which to show
- [quiz_exp2.json](quiz_exp2.json): BBBD's pre-test and memory questions (CC-BY 4.0; correct answer stored as the first option, shuffled at runtime)
- [print_quiz.py](print_quiz.py): printable quiz plus answer key
