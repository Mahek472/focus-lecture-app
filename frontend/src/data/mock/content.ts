// Mock content. Lectures are the BBBD Experiment 2 stimuli used by experiment/run_experiment.py.
// Transcript lines are PLACEHOLDERS written for the mock (not the videos' real words); the real
// backend serves the Whisper transcript.

import type { Lecture, Participant, SessionSummary, TranscriptLine } from "../types";

export const LECTURES: Lecture[] = [
  { id: "stim2", title: "How modern light bulbs work", video: "", length_s: 143, youtube: "oCEKMEeZXug" },
  { id: "stim5", title: "Why do we have more boys than girls", video: "", length_s: 154, youtube: "3IaYhG11ckA" },
  { id: "stim1", title: "Why are stars star-shaped", video: "", length_s: 209, youtube: "VVAKFJ8VVp4" },
];

const POOLS: Record<string, string[]> = {
  stim2: [
    "Light bulbs turn electrical energy into light, and some into heat.",
    "An incandescent bulb heats a thin filament until it glows.",
    "Most of the energy in an incandescent bulb is lost as heat rather than light.",
    "Halogen bulbs add a gas that helps the filament last longer.",
    "Fluorescent tubes excite a gas, which makes ultraviolet light.",
    "A coating inside the tube turns that ultraviolet into visible light.",
    "LEDs make light directly from a semiconductor junction.",
    "Because little energy becomes heat, LEDs use far less power.",
    "Efficiency is measured as light output per watt of power.",
    "Different bulbs produce different colour temperatures of light.",
  ],
  stim5: [
    "Slightly more boys than girls are born worldwide.",
    "The ratio at birth is roughly 105 boys for every 100 girls.",
    "Evolutionary theory predicts a balance in the long run.",
    "If one sex becomes rarer, parents of that sex have more grandchildren.",
    "Boys have a higher mortality rate in childhood.",
    "By adulthood the numbers become roughly equal.",
    "The extra boys at birth may compensate for that higher mortality.",
    "Some regions show larger imbalances for social reasons.",
    "Scientists still debate which factors matter most.",
    "Population data help test these ideas.",
  ],
  stim1: [
    "Stars are round balls of gas, yet we draw them with points.",
    "Light passing through a small opening spreads out, which is called diffraction.",
    "The shape of the opening sets the pattern of the spread.",
    "Telescopes with support struts add spikes to bright stars.",
    "Our own eyes also diffract light as it enters.",
    "Tiny structures in the lens of the eye create a spiky pattern.",
    "That is why stars look pointy to the naked eye.",
    "The pattern differs slightly from person to person.",
    "Space telescope images show spikes from their mirror design.",
    "So the points come from our instruments, not from the stars.",
  ],
};

export function transcriptFor(lectureId: string): TranscriptLine[] {
  const lec = LECTURES.find((l) => l.id === lectureId);
  const pool = POOLS[lectureId] ?? POOLS.stim2;
  const lines: TranscriptLine[] = [];
  const step = 7;
  for (let t = 0, i = 0; t < (lec?.length_s ?? 140); t += step, i++) {
    lines.push({ start: t, end: Math.min(t + step, lec?.length_s ?? 140), text: pool[i % pool.length] });
  }
  return lines;
}

export const PARTICIPANTS: Participant[] = [
  { id: "P01", name: "Participant P01", consent_eeg: true, consent_webcam: true, calibration_date: "2026-11-07", calibration_auc: 0.84, notes: "Wet electrodes with paste. Glasses off." },
  { id: "P02", name: "Participant P02", consent_eeg: true, consent_webcam: false, notes: "EEG only; webcam consent not given." },
  { id: "P03", name: "Participant P03", consent_eeg: false, consent_webcam: false, notes: "Scheduled; consent form not signed yet." },
];

export const PAST_SESSIONS: SessionSummary[] = [
  { run_id: "demo-replay-1", lecture_id: "stim2", lecture_title: "How modern light bulbs work", participant_id: "P01", date: "2026-11-07T15:10:00", duration_s: 143, mode: "replay", status: "complete", focused_fraction: 0.71 },
  { run_id: "demo-live-1", lecture_id: "stim1", lecture_title: "Why are stars star-shaped", participant_id: "P01", date: "2026-11-07T17:40:00", duration_s: 209, mode: "live", status: "complete", focused_fraction: 0.82 },
  { run_id: "scheduled-1", lecture_id: "stim5", lecture_title: "Why do we have more boys than girls", participant_id: "P02", date: "2026-11-08T10:00:00", duration_s: 0, mode: "live", status: "scheduled" },
];
