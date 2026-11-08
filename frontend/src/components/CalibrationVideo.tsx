import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";

// Filler clip for calibration, shown on the same screen. The participant can load a video file
// from disk (e.g. a downloaded lecture) or paste a YouTube link. Loops so it never runs out mid-block.

export interface CalibrationVideoHandle { play(): void; hasVideo(): boolean }

function youtubeId(url: string): string | null {
  const s = url.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1, 12) || null;
    if (u.hostname.includes("youtube")) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch { /* not a URL */ }
  return null;
}

type Source = { kind: "file"; url: string; name: string } | { kind: "youtube"; id: string } | null;

// Local filler clip (BBBD stim1, not one of the session lectures), loaded by default so calibration
// needs no picking or network; another file or link can still replace it.
const DEFAULT_CLIP = "/media/calibration.mp4";

export const CalibrationVideo = forwardRef<CalibrationVideoHandle, { overlay?: ReactNode }>(function CalibrationVideo({ overlay }, ref) {
  const [src, setSrc] = useState<Source>(null);
  useEffect(() => {
    let live = true;
    fetch(DEFAULT_CLIP, { method: "HEAD" }).then((r) => {
      if (live && r.ok && (r.headers.get("content-type") ?? "").startsWith("video/"))
        setSrc((s) => s ?? { kind: "file", url: DEFAULT_CLIP, name: "Why are stars star-shaped (BBBD)" });
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState("");
  const [ytPlay, setYtPlay] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Release the object URL when the file changes or the screen closes.
  useEffect(() => () => { if (src?.kind === "file" && src.url.startsWith("blob:")) URL.revokeObjectURL(src.url); }, [src]);

  useImperativeHandle(ref, () => ({
    play() {
      if (src?.kind === "file") void video.current?.play().catch(() => {});
      else if (src?.kind === "youtube") setYtPlay(true);
    },
    hasVideo: () => !!src,
  }), [src]);

  const onFile = (f?: File) => {
    if (!f) return;
    setSrc({ kind: "file", url: URL.createObjectURL(f), name: f.name });
    setLinkError("");
  };
  const onLink = () => {
    const id = youtubeId(link);
    if (!id) { setLinkError("That doesn't look like a YouTube link."); return; }
    setSrc({ kind: "youtube", id }); setYtPlay(false); setLinkError("");
  };
  const fullscreen = () => { void frame.current?.requestFullscreen?.().catch(() => {}); };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div ref={frame} style={{ position: "relative", background: "#0b0f13", aspectRatio: "16 / 9", width: "100%", overflow: "hidden" }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type.startsWith("video/")) onFile(f); }}>
        {src?.kind === "file" && (
          <video ref={video} src={src.url} controls loop playsInline style={{ width: "100%", height: "100%" }} aria-label={`Calibration clip: ${src.name}`} />
        )}
        {src?.kind === "youtube" && (
          <iframe key={`${src.id}-${ytPlay}`} title="Calibration clip"
            src={`https://www.youtube-nocookie.com/embed/${src.id}?rel=0&modestbranding=1&playsinline=1&loop=1&playlist=${src.id}${ytPlay ? "&autoplay=1" : ""}`}
            allow="autoplay; encrypted-media; fullscreen" allowFullScreen style={{ border: 0, width: "100%", height: "100%" }} />
        )}
        {!src && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center", color: "#cfd8e1", gap: 10, padding: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>No calibration clip loaded</div>
            <div className="small" style={{ color: "#93a1ae" }}>Choose a video file, drop one here, or paste a YouTube link below.</div>
            <div><button className="btn" onClick={() => fileInput.current?.click()}>Choose video file</button></div>
          </div>
        )}
        {overlay && (
          <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: 0, padding: "10px 14px", background: "rgba(8,12,16,0.82)", color: "#f2f5f7",
            fontSize: 20, fontWeight: 600, textAlign: "center", pointerEvents: "none", zIndex: 2 }}>{overlay}</div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input ref={fileInput} type="file" accept="video/*" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
        <button className="btn" onClick={() => fileInput.current?.click()}>{src?.kind === "file" ? "Change file" : "Load video file"}</button>
        <form style={{ display: "flex", gap: 8, flex: "1 1 260px" }} onSubmit={(e) => { e.preventDefault(); onLink(); }}>
          <input type="text" style={{ flex: 1, minWidth: 0 }} placeholder="or paste a YouTube link" aria-label="YouTube link"
            value={link} onChange={(e) => setLink(e.target.value)} />
          <button className="btn" type="submit" disabled={!link.trim()}>Load link</button>
        </form>
        {src && <button className="btn btn--quiet" onClick={fullscreen}>Full screen</button>}
      </div>
      {src?.kind === "file" && <p className="small muted" style={{ margin: 0 }}>Playing {src.name} from this computer, on loop.</p>}
      {linkError && <p className="small" style={{ margin: 0, color: "var(--signal)" }}>{linkError}</p>}
    </div>
  );
});
