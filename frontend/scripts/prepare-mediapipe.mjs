// Runs before `npm run dev` / `npm run build`: puts MediaPipe's runtime and the face model in
// public/ so the camera works without internet at the venue (after this has run once).
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDst = path.join(root, "public", "mediapipe", "wasm");
const model = path.join(root, "public", "models", "face_landmarker.task");
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

mkdirSync(wasmDst, { recursive: true });
cpSync(wasmSrc, wasmDst, { recursive: true });

if (!existsSync(model)) {
  mkdirSync(path.dirname(model), { recursive: true });
  try {
    const r = await fetch(MODEL_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    writeFileSync(model, Buffer.from(await r.arrayBuffer()));
    console.log("downloaded face_landmarker.task");
  } catch (e) {
    console.warn(`could not download the face model (${e.message}); the camera check will be unavailable until it is in public/models/`);
  }
}
