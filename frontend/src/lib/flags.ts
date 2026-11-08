/** ?video=sim (or ?video=normal to undo) makes every player use the simulated clock for this browser tab. */
export function forceSimVideo(): boolean {
  try {
    const v = new URLSearchParams(location.search).get("video");
    if (v) sessionStorage.setItem("wdim.video", v);
    return sessionStorage.getItem("wdim.video") === "sim";
  } catch { return false; }
}
