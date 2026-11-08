import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// The dev server proxies the existing Python services, so neither needs CORS changes:
//   /api/*    -> FastAPI backend on :8000 (REST)        /ws/* -> its WebSocket
//   /signal/* -> scripts/live_signal.py on :8766 (device-setup signal checker)
// and serves /agent/* itself (deviceAgent below), so the page can list serial ports and
// start / stop the signal checker. A browser page can't launch programs; the dev server can.

const ROOT = path.resolve(__dirname, "..");
const PYTHON = [path.join(ROOT, ".venv", "Scripts", "python.exe"), path.join(ROOT, ".venv", "bin", "python")].find(existsSync) ?? "python";

function listPorts(): Promise<{ port: string; description: string }[]> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const ps = "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | ForEach-Object { $_.Name }";
      execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 8000 }, (_err, out) => {
        resolve(String(out ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).flatMap((name) => {
          const m = name.match(/^(.*)\((COM\d+)\)$/);
          return m ? [{ port: m[2], description: m[1].trim() }] : [];
        }).sort((a, b) => Number(/usb/i.test(b.description)) - Number(/usb/i.test(a.description))));
      });
    } else {
      execFile("sh", ["-c", "ls /dev/cu.* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null"], (_e, out) =>
        resolve(String(out ?? "").split("\n").filter(Boolean).map((p) => ({ port: p, description: /usb/i.test(p) ? "USB serial" : "serial" }))));
    }
  });
}

function deviceAgent(): Plugin {
  let child: ChildProcess | null = null;
  let state = { running: false, port: "", rld: true, log: [] as string[], exitCode: null as number | null };
  const stop = () => { if (child && child.exitCode === null) child.kill(); child = null; state.running = false; };
  return {
    name: "device-agent",
    configureServer(server) {
      server.httpServer?.on("close", stop);
      process.on("exit", stop);
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/agent/")) return next();
        const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
        const body = async () => {
          let raw = ""; for await (const c of req) raw += c;
          try { return JSON.parse(raw || "{}"); } catch { return {}; }
        };
        if (req.url === "/agent/ports") return send(200, await listPorts());
        if (req.url === "/agent/clips") {   // recorded webcam clips: recordings/<run>_cam/<clip>.webm
          const dir = path.join(ROOT, "recordings");
          const out: { run: string; clip: string; url: string; mb: number }[] = [];
          if (existsSync(dir)) for (const d of readdirSync(dir)) {
            if (!d.endsWith("_cam") || !statSync(path.join(dir, d)).isDirectory()) continue;
            for (const f of readdirSync(path.join(dir, d))) if (f.endsWith(".webm"))
              out.push({ run: d.replace(/_cam$/, ""), clip: f.replace(/\.webm$/, ""), url: `/agent/clip/${d}/${f}`,
                         mb: Math.round(statSync(path.join(dir, d, f)).size / 1e5) / 10 });
          }
          return send(200, out);
        }
        if (req.url.startsWith("/agent/clip/")) {   // serve one clip, with Range support so the video can seek
          const rel = decodeURIComponent(req.url.slice("/agent/clip/".length)).split("?")[0];
          if (!/^[\w-]+_cam\/[\w-]+\.webm$/.test(rel)) return send(400, { error: "bad clip path" });
          const file = path.join(ROOT, "recordings", rel);
          if (!existsSync(file)) return send(404, { error: "no such clip" });
          const size = statSync(file).size, range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
          res.setHeader("Content-Type", "video/webm"); res.setHeader("Accept-Ranges", "bytes");
          if (range) {
            const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : size - 1;
            res.statusCode = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`); res.setHeader("Content-Length", end - start + 1);
            return void createReadStream(file, { start, end }).pipe(res);
          }
          res.setHeader("Content-Length", size);
          return void createReadStream(file).pipe(res);
        }
        if (req.url === "/agent/status") return send(200, state);
        if (req.url === "/agent/stop" && req.method === "POST") { stop(); return send(200, { ok: true }); }
        if (req.url === "/agent/start" && req.method === "POST") {
          const { port, rld = true } = await body();
          if (!port || !/^[\w/.-]+$/.test(port)) return send(400, { error: "invalid port" });
          stop();
          const args = ["-W", "ignore", "-u", path.join(ROOT, "scripts", "live_signal.py"), "--port", port, "--no-browser", ...(rld ? [] : ["--no-rld"])];
          state = { running: true, port, rld, log: [], exitCode: null };
          const proc = spawn(PYTHON, args, { cwd: ROOT });
          child = proc;
          const keep = (b: Buffer) => { state.log.push(...String(b).split(/\r?\n/).filter(Boolean)); state.log = state.log.slice(-20); };
          proc.stdout?.on("data", keep); proc.stderr?.on("data", keep);
          proc.on("exit", (code) => { if (child === proc) { state.running = false; state.exitCode = code; child = null; } });
          return send(200, { ok: true });
        }
        return send(404, { error: "unknown agent route" });
      });
    },
  };
}

// ---------------------------------------------------------------- Gemini recap
// POST /agent/gemini/recap: summarises what was said while the participant was distracted.
// The key stays on this server (GEMINI_API_KEY from the environment, frontend/.env or ../.env);
// the page never sees it. For YouTube lectures Gemini watches just the distracted clips
// (videoMetadata offsets); otherwise it works from the transcript text.

interface RecapPart { start: number; end: number; transcript: string; reasons: string[] }
interface RecapRequest { title: string; youtube?: string; language: string; parts: RecapPart[]; focused_fraction?: number | null }

const LANG_NAME: Record<string, string> = { en: "English", es: "Spanish", fr: "French", hi: "Hindi", zh: "Chinese (Simplified)" };
const MAX_VIDEO_CLIPS = 8;

const RECAP_SCHEMA = {
  type: "OBJECT",
  properties: {
    overview: { type: "STRING" },
    parts: { type: "ARRAY", items: { type: "OBJECT", properties: {
      index: { type: "INTEGER" },
      title: { type: "STRING" },
      summary: { type: "ARRAY", items: { type: "STRING" } },
      key_terms: { type: "ARRAY", items: { type: "OBJECT", properties: { term: { type: "STRING" }, meaning: { type: "STRING" } }, required: ["term", "meaning"] } },
      check_question: { type: "OBJECT", properties: { question: { type: "STRING" }, answer: { type: "STRING" } }, required: ["question", "answer"] },
      importance: { type: "STRING", enum: ["core", "supporting", "aside"] },
    }, required: ["index", "title", "summary", "key_terms", "check_question", "importance"] } },
    study_tips: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["overview", "parts", "study_tips"],
};

const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function recapPrompt(r: RecapRequest, withVideo: boolean) {
  const lang = LANG_NAME[r.language] ?? "English";
  const list = r.parts.map((p, i) => `Part ${i + 1}: ${ts(p.start)}-${ts(p.end)} (${p.reasons.join(", ")})` +
    (p.transcript ? `\nTranscript: ${p.transcript}` : "\nTranscript: (none available)")).join("\n\n");
  return `You are helping a student catch up on a lecture titled "${r.title}". An EEG headset and webcam flagged the parts below as moments the student was likely not paying attention.
${withVideo ? "The attached video clips are those parts, in the same order (each starts a few seconds early for context)." : "Work only from the transcript text; if a part has no transcript, say briefly that it could not be summarised."}

${list}

Write a focused recap of ONLY what the student missed, for a learner who may have ADHD, dyslexia or another learning difference:
- Short, concrete sentences. Plain words. Define jargon in key_terms.
- summary: 2-4 bullets per part, each one idea, in the order it was taught.
- title: a 3-6 word label for the part.
- importance: "core" if later material depends on it, "supporting" for examples/details, "aside" for tangents.
- check_question: one quick question (with answer) to confirm understanding.
- overview: 2-3 sentences tying the missed parts to the lecture as a whole. Encouraging, never judgemental; do not mention attention, EEG or distraction.
- study_tips: 2-3 specific, practical ways to review this material.
- index is the 1-based part number. Write everything in ${lang}. Do not invent content that is not in the clips or transcript.`;
}

class GeminiError extends Error { constructor(msg: string, readonly retryable: boolean) { super(msg); } }

async function callGemini(key: string, model: string, r: RecapRequest, withVideo: boolean, timeoutMs: number) {
  const parts: object[] = [];
  if (withVideo && r.youtube) {
    for (const p of r.parts.slice(0, MAX_VIDEO_CLIPS)) {
      parts.push({
        fileData: { fileUri: `https://www.youtube.com/watch?v=${r.youtube}`, mimeType: "video/*" },
        videoMetadata: { startOffset: `${Math.max(0, Math.floor(p.start - 5))}s`, endOffset: `${Math.ceil(p.end + 2)}s` },
      });
    }
  }
  parts.push({ text: recapPrompt(r, withVideo && !!r.youtube) });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: RECAP_SCHEMA, temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e: Error) => { throw new GeminiError(e.name === "TimeoutError" ? `${model} timed out` : e.message, true); });
  const body = await res.json().catch(() => ({})) as { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] } }[] };
  if (!res.ok) {
    const msg = body.error?.message ?? `Gemini returned HTTP ${res.status}`;
    // busy, rate-limited, retired or unknown model: worth trying the next model
    throw new GeminiError(msg, [404, 429, 500, 503, 504].includes(res.status) || /no longer available|not found|not supported/i.test(msg));
  }
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("Gemini returned an empty answer");
  return JSON.parse(text);
}

// Tried in order; a busy, retired or slow model falls through to the next (GEMINI_MODEL goes first).
const FALLBACK_MODELS = ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest"];

async function recapWithFallback(key: string, models: string[], r: RecapRequest, withVideo: boolean) {
  const errors: string[] = [];
  for (const [i, model] of models.entries()) {
    const last = i === models.length - 1;
    try {
      return { result: await callGemini(key, model, r, withVideo, withVideo && r.youtube ? 150_000 : last ? 90_000 : 45_000), model };
    } catch (e) {
      errors.push(`${model}: ${(e as Error).message}`);
      if (!(e instanceof GeminiError && e.retryable)) break;
    }
  }
  throw new Error(errors.join(" | "));
}

function geminiAgent(env: Record<string, string>): Plugin {
  const key = () => process.env.GEMINI_API_KEY || env.GEMINI_API_KEY || "";
  const models = () => [...new Set([process.env.GEMINI_MODEL || env.GEMINI_MODEL, ...FALLBACK_MODELS].filter((m): m is string => !!m))];
  const model = () => models()[0];
  return {
    name: "gemini-agent",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/agent/gemini/")) return next();
        const send = (code: number, body: unknown) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
        if (req.url === "/agent/gemini/status") return send(200, { configured: !!key(), model: model() });
        if (req.url !== "/agent/gemini/recap" || req.method !== "POST") return send(404, { error: "unknown gemini route" });
        if (!key()) return send(503, { error: "GEMINI_API_KEY is not set. Add it to focus-lecture-app/frontend/.env and restart npm run dev." });
        let raw = ""; for await (const c of req) raw += c;
        let r: RecapRequest;
        try { r = JSON.parse(raw); } catch { return send(400, { error: "bad JSON" }); }
        if (!Array.isArray(r.parts) || !r.parts.length) return send(400, { error: "no parts to recap" });
        if (r.youtube && !/^[\w-]{11}$/.test(r.youtube)) r.youtube = undefined;
        try {
          const { result, model: used } = await recapWithFallback(key(), models(), r, true);
          return send(200, { ...result, model: used, used_video: !!r.youtube });
        } catch (e) {
          if (!r.youtube) return send(502, { error: (e as Error).message });
          try {   // a private / region-locked video, or no model could take video: fall back to the transcript
            const { result, model: used } = await recapWithFallback(key(), models(), r, false);
            return send(200, { ...result, model: used, used_video: false, video_error: (e as Error).message });
          } catch (e2) { return send(502, { error: (e2 as Error).message }); }
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  // geminiAgent first: deviceAgent answers every other /agent/* route with 404
  plugins: [react(), geminiAgent({ ...loadEnv(mode, ROOT, ""), ...loadEnv(mode, __dirname, "") }), deviceAgent()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/ws": { target: "ws://localhost:8000", ws: true },
      "/signal": { target: "http://localhost:8766", changeOrigin: true, rewrite: (p) => p.replace(/^\/signal/, "") },
    },
  },
}));
