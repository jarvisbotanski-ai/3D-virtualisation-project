// Single requestAnimationFrame loop for the whole page.
// Tasks are functions (dt, now) => boolean; returning true keeps the loop alive.
// When no task wants a frame, the loop sleeps until something calls wake().
const tasks = new Set();
let raf = 0;
let last = 0;

function frame(now) {
  raf = 0;
  // dt is clamped to ~2 frames, not 100 ms: after a GC pause or a shader compile
  // a 300 ms frame would otherwise let every damped follower cover 94 % of its
  // remaining distance in one step, which reads as a lurch right after a hitch.
  // Clamping makes the camera fall slightly behind and glide back instead.
  const dt = Math.min(1 / 30, last ? (now - last) / 1000 : 1 / 60);
  last = now;
  let again = false;
  for (const t of [...tasks]) {
    try { if (t(dt, now)) again = true; } catch (e) { console.error(e); }
  }
  if (again) raf = requestAnimationFrame(frame);
  else last = 0;
}

export function wake() {
  if (!raf) raf = requestAnimationFrame(frame);
}

export function addTask(fn) {
  tasks.add(fn);
  wake();
  return () => tasks.delete(fn);
}
