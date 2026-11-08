import { defineConfig, type Plugin } from "vite";
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

export default defineConfig({
  plugins: [react(), deviceAgent()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/ws": { target: "ws://localhost:8000", ws: true },
      "/signal": { target: "http://localhost:8766", changeOrigin: true, rewrite: (p) => p.replace(/^\/signal/, "") },
    },
  },
});
