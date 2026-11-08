import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TranscriptLine } from "../data/types";
import { fmtTime } from "../lib/format";

// Plays the backend's video file (contract /video), or a YouTube embed for the mock lectures.
// If neither can play (offline, blocked), it falls back to a labelled simulated clock so the
// session still runs. Reports video time and playing state every 250 ms.

export interface VideoHandle { play(): void; pause(): void; seek(t: number): void; time(): number; playing(): boolean }

interface YTPlayer {
  playVideo(): void; pauseVideo(): void; seekTo(t: number, allow: boolean): void;
  getCurrentTime(): number; getPlayerState(): number; destroy(): void;
}
declare global {
  interface Window { YT?: { Player: new (el: HTMLElement, o: object) => YTPlayer }; onYouTubeIframeAPIReady?: () => void }
}

let ytLoading: Promise<void> | null = null;
function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve();
  ytLoading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api"; s.onerror = () => reject(new Error("YouTube API unavailable"));
    window.onYouTubeIframeAPIReady = () => resolve();
    document.head.appendChild(s);
  });
  return ytLoading;
}

interface Props {
  src?: string;
  youtube?: string;
  length_s: number;
  title: string;
  transcript: TranscriptLine[];
  captions: boolean;
  onState: (t: number, playing: boolean) => void;
  onEnded?: () => void;
  forceSim?: boolean;        // run on the simulated clock (offline demos: add ?video=sim to the URL)
}

export const VideoPlayer = forwardRef<VideoHandle, Props>(function VideoPlayer(p, ref) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const yt = useRef<YTPlayer | null>(null);
  const sim = useRef({ t: 0, playing: false, at: 0 });
  const [mode, setMode] = useState<"youtube" | "file" | "sim" | "loading">(p.forceSim ? "sim" : p.src ? "file" : p.youtube ? "loading" : "sim");
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const ended = useRef(false);

  useEffect(() => {
    if (p.forceSim || p.src || !p.youtube) return;
    let cancelled = false;
    const fallback = window.setTimeout(() => !cancelled && !yt.current && setMode("sim"), 6000);
    loadYouTube().then(() => {
      if (cancelled || !host.current || !window.YT) return;
      yt.current = new window.YT.Player(host.current, {
        videoId: p.youtube, width: "100%", height: "100%",
        playerVars: { rel: 0, modestbranding: 1, controls: 1, cc_load_policy: 0, playsinline: 1 },
        events: { onReady: () => setMode("youtube"), onError: () => setMode("sim") },
      });
    }).catch(() => setMode("sim"));
    return () => { cancelled = true; clearTimeout(fallback); yt.current?.destroy(); yt.current = null; };
  }, [p.src, p.youtube]);

  const api: VideoHandle = {
    play() {
      if (mode === "youtube") yt.current?.playVideo();
      else if (mode === "file") void video.current?.play();
      else if (!sim.current.playing) { sim.current.playing = true; sim.current.at = performance.now(); }
    },
    pause() {
      if (mode === "youtube") yt.current?.pauseVideo();
      else if (mode === "file") video.current?.pause();
      else { sim.current.t = api.time(); sim.current.playing = false; }
    },
    seek(s: number) {
      const x = Math.max(0, Math.min(p.length_s, s));
      ended.current = false;
      if (mode === "youtube") yt.current?.seekTo(x, true);
      else if (mode === "file" && video.current) video.current.currentTime = x;
      else { sim.current.t = x; sim.current.at = performance.now(); setT(x); }
    },
    time() {
      if (mode === "youtube") return yt.current?.getCurrentTime() ?? 0;
      if (mode === "file") return video.current?.currentTime ?? 0;
      const s = sim.current;
      return s.playing ? Math.min(p.length_s, s.t + (performance.now() - s.at) / 1000) : s.t;
    },
    playing() {
      if (mode === "youtube") return yt.current?.getPlayerState() === 1;
      if (mode === "file") return !!video.current && !video.current.paused && !video.current.ended;
      return sim.current.playing;
    },
  };
  useImperativeHandle(ref, () => api);

  const stateRef = useRef(p.onState); stateRef.current = p.onState;
  const endRef = useRef(p.onEnded); endRef.current = p.onEnded;
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = api.time(), pl = api.playing();
      if (mode === "sim" && now >= p.length_s && sim.current.playing) { sim.current.t = p.length_s; sim.current.playing = false; }
      setT(now); setPlaying(pl);
      stateRef.current(now, pl);
      if (now >= p.length_s - 0.5 && !pl && !ended.current) { ended.current = true; endRef.current?.(); }
    }, 250);
    return () => clearInterval(id);
  });

  const line = p.transcript.find((l) => t >= l.start && t < l.end);

  return (
    <div style={{ position: "relative", background: "#0b0f13", aspectRatio: "16 / 9", width: "100%", maxHeight: "100%", overflow: "hidden" }}>
      {p.src ? (
        <video ref={video} src={p.src} style={{ width: "100%", height: "100%" }} controls aria-label={p.title} />
      ) : (
        <div className="video-embed" style={{ position: "absolute", inset: 0, display: mode === "sim" ? "none" : "block" }}><div ref={host} /></div>
      )}
      {mode === "sim" && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center", color: "#cfd8e1", gap: 10, padding: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{p.title}</div>
          <div className="small" style={{ color: "#93a1ae" }}>The video can't play here, so the session runs on a simulated clock.</div>
          <div className="num" style={{ fontSize: 28 }}>{fmtTime(t)} / {fmtTime(p.length_s)}</div>
          <div><button className="btn" onClick={() => (playing ? api.pause() : api.play())}>{playing ? "Pause" : "Play"}</button></div>
        </div>
      )}
      {mode === "loading" && <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", color: "#93a1ae" }}>Loading video</div>}
      {(mode === "youtube" || mode === "file") && !playing && t < 0.5 && (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", background: "rgba(11,15,19,0.45)", zIndex: 2 }}>
          <button className="btn btn--primary" onClick={() => api.play()}>Play lecture</button>
        </div>
      )}
      {p.captions && line && (
        <div aria-live="off" style={{ position: "absolute", left: "8%", right: "8%", bottom: mode === "sim" ? 12 : 56, textAlign: "center", pointerEvents: "none" }}>
          <span style={{ background: "rgba(8,12,16,0.82)", color: "#f2f5f7", padding: "4px 10px", fontSize: 17, lineHeight: 1.5, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>{line.text}</span>
        </div>
      )}
    </div>
  );
});
