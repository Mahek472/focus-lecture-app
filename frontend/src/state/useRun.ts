import { useEffect, useState } from "react";
import type { Lecture, SessionSummary, TranscriptLine } from "../data/types";
import { useSource } from "./source";

export interface RunInfo { session: SessionSummary; lecture: Lecture; transcript: TranscriptLine[] }

/** The session, lecture and transcript for a run id (null while loading, "missing" if unknown). */
export function useRun(runId: string | undefined): RunInfo | null | "missing" {
  const { source } = useSource();
  const [info, setInfo] = useState<RunInfo | null | "missing">(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [sessions, lectures] = await Promise.all([source.listSessions(), source.listLectures()]);
      const session = sessions.find((s) => s.run_id === runId);
      const lecture = lectures.find((l) => l.id === session?.lecture_id);
      if (!session || !lecture) { if (alive) setInfo("missing"); return; }
      const transcript = await source.getTranscript(lecture.id).catch(() => []);
      if (alive) setInfo({ session, lecture, transcript });
    })().catch(() => alive && setInfo("missing"));
    return () => { alive = false; };
  }, [source, runId]);
  return info;
}
