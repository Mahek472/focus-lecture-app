// Client for the dev server's /agent/gemini/* routes (vite.config.ts). The API key never reaches the page.

import type { Distraction } from "./insights";

export interface GeminiPart {
  index: number;
  title: string;
  summary: string[];
  key_terms: { term: string; meaning: string }[];
  check_question: { question: string; answer: string };
  flashcards?: { question: string; answer: string }[];   // 3-5 study cards for the part
  importance: "core" | "supporting" | "aside";
}

export interface GeminiRecap {
  overview: string;
  parts: GeminiPart[];
  study_tips: string[];
  model: string;
  used_video: boolean;
  video_error?: string;
}

export async function geminiStatus(): Promise<{ configured: boolean; model: string } | null> {
  try {
    const r = await fetch("/agent/gemini/status");
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function geminiRecap(req: { title: string; youtube?: string; language: string; distractions: Distraction[]; focused_fraction?: number | null }): Promise<GeminiRecap> {
  const r = await fetch("/agent/gemini/recap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: req.title, youtube: req.youtube, language: req.language, focused_fraction: req.focused_fraction,
      parts: req.distractions.map((d) => ({ start: d.start, end: d.end, transcript: d.snippet, reasons: d.reasons })),
    }),
  });
  const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as GeminiRecap;
}
