import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";
import { buildLibrary, drawSprite } from "./flowers.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const landing = document.getElementById("landing");
const startBtn = document.getElementById("startBtn");
const status = document.getElementById("status");

let handLandmarker = null;
let lastVideoTime = -1;
let hands = []; // latest result: each hand = { landmarks, key, gesture }

// Permanent layer: flowers that finished blooming get stamped here once, so drawing
// the whole garden costs one image per frame no matter how many flowers there are
const gardenCanvas = document.createElement("canvas");
const gardenCtx = gardenCanvas.getContext("2d");

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  // Resize the permanent flower layer too, keeping what's already on it
  const copy = document.createElement("canvas");
  copy.width = gardenCanvas.width;
  copy.height = gardenCanvas.height;
  copy.getContext("2d").drawImage(gardenCanvas, 0, 0);
  gardenCanvas.width = canvas.width;
  gardenCanvas.height = canvas.height;
  gardenCtx.drawImage(copy, 0, 0);
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// ---------- Model setup (starts loading as soon as the page opens) ----------
async function createHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
  });

  let landmarker;
  try {
    landmarker = await HandLandmarker.createFromOptions(vision, options("GPU"));
  } catch (err) {
    console.warn("GPU unavailable, falling back to CPU", err);
    landmarker = await HandLandmarker.createFromOptions(vision, options("CPU"));
  }

  // Warm-up: run one dummy detection now so the first real frame isn't slow
  try {
    const dummy = document.createElement("canvas");
    dummy.width = dummy.height = 256;
    landmarker.detectForVideo(dummy, performance.now());
  } catch (err) {
    console.warn("Warm-up skipped", err);
  }
  return landmarker;
}

const modelPromise = createHandLandmarker();
modelPromise.catch(() => {}); // errors are handled in start()

// ---------- Start button ----------
async function start() {
  startBtn.disabled = true;
  try {
    status.textContent = "Asking for camera...";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    status.textContent = "Getting hand tracking ready...";
    handLandmarker = await modelPromise;

    landing.classList.add("hidden");
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    status.textContent = "Something went wrong: " + err.message;
    startBtn.disabled = false;
  }
}
startBtn.addEventListener("click", start);

// ---------- Coordinate mapping ----------
// Where the video sits on the canvas ("cover" fit)
function getVideoRect() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(canvas.width / vw, canvas.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (canvas.width - w) / 2, y: (canvas.height - h) / 2, w, h };
}

// MediaPipe gives landmarks as 0..1 fractions of the video frame.
// Convert to canvas pixels, including the horizontal mirror flip.
function toCanvas(lm, rect) {
  return {
    x: canvas.width - (rect.x + lm.x * rect.w),
    y: rect.y + lm.y * rect.h,
  };
}

// ---------- Gesture classification ----------
const WRIST = 0;
// [middle joint, fingertip] landmark indices for each of the 4 fingers
const FINGERS = {
  index: [6, 8],
  middle: [10, 12],
  ring: [14, 16],
  pinky: [18, 20],
};
const EXTEND_RATIO = 1.1; // how much farther the tip must be than the joint
const STABLE_FRAMES = 4;  // frames that must agree before a gesture switches

// Distance in real video pixels (the 0..1 values are stretched by the aspect ratio)
function dist(a, b) {
  const dx = (a.x - b.x) * video.videoWidth;
  const dy = (a.y - b.y) * video.videoHeight;
  return Math.hypot(dx, dy);
}

function isExtended(hand, [joint, tip]) {
  return dist(hand[WRIST], hand[tip]) > dist(hand[WRIST], hand[joint]) * EXTEND_RATIO;
}

function classify(hand) {
  const index = isExtended(hand, FINGERS.index);
  const middle = isExtended(hand, FINGERS.middle);
  const ring = isExtended(hand, FINGERS.ring);
  const pinky = isExtended(hand, FINGERS.pinky);

  if (index && middle && ring && pinky) return "open";
  if (index && !middle && !ring && !pinky) return "point";
  if (!index && !middle && !ring && !pinky) return "fist";
  return "none";
}

// Per-hand memory, keyed by "Left" / "Right"
const handState = {};

function updateGestures(result) {
  const seen = new Set();

  hands = result.landmarks.map((landmarks, i) => {
    const key = result.handedness[i][0].categoryName;
    seen.add(key);

    const state = (handState[key] ??= { recent: [], stable: "none" });
    state.recent.push(classify(landmarks));
    if (state.recent.length > STABLE_FRAMES) state.recent.shift();

    // Only switch when the last N frames all agree
    const full = state.recent.length === STABLE_FRAMES;
    if (full && state.recent.every((g) => g === state.recent[0])) {
      state.stable = state.recent[0];
    }

    return { landmarks, key, gesture: state.stable };
  });

  // Forget hands that left the frame
  for (const key of Object.keys(handState)) {
    if (!seen.has(key)) delete handState[key];
  }
}

// ---------- Garden ----------
const library = buildLibrary();  // all flower sprites, built once at startup
const garden = [];               // flowers that are still blooming (newest last)
const placed = [];               // flowers that finished blooming (kept so we can scatter them)
const particles = [];            // flowers currently flying away
const ghosts = [];               // frozen snapshots of the garden that fade out during a scatter
const pens = {};                 // per-hand: smoothed fingertip + last planting spot
const holds = {};                // per-hand: open-palm hold timers

const BLOOM_MS = 650;            // how long a flower takes to bloom
const HOLD_MS = 450;             // how long to hold an open hand before erasing
const GHOST_MS = 200;            // how fast the still image of the old garden fades
const MAX_PLACED = 1500;         // most flowers we keep individually for scattering

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Sizes scale with the screen so it looks the same everywhere
function flowerBase() {
  return Math.min(canvas.width, canvas.height) * 0.1;
}

function plant(sprite, x, y, size, rotation) {
  garden.push({ sprite, x, y, size, rotation, born: performance.now() });
}

// One bouquet cluster: maybe a filler and a leaf behind, then the main flower on top.
// Array order = draw order, so later items sit in front.
function plantCluster(x, y) {
  const base = flowerBase();
  const spread = base * 0.3;
  const at = () => [x + rand(-spread, spread), y + rand(-spread, spread)];

  if (Math.random() < 0.25) {
    plant(pick(library.fillers), ...at(), base * rand(1.1, 1.6), rand(0, Math.PI * 2));
  }
  if (Math.random() < 0.4) {
    plant(pick(library.leaves), ...at(), base * rand(0.9, 1.3), rand(0, Math.PI * 2));
  }
  plant(pick(library.flowers), ...at(), base * rand(0.75, 1.3), rand(0, Math.PI * 2));
}

// Runs every frame: plants along the fingertip path of every hand that is pointing
function updatePlanting(rect) {
  const spacing = flowerBase() * 0.35; // small gap = dense, bouquet-like trail
  const active = new Set();

  for (const hand of hands) {
    if (hand.gesture !== "point") continue;
    active.add(hand.key);

    const tip = toCanvas(hand.landmarks[8], rect); // landmark 8 = index fingertip
    const pen = pens[hand.key];

    if (!pen) {
      // Pen just touched down: plant right away
      pens[hand.key] = { x: tip.x, y: tip.y, lastX: tip.x, lastY: tip.y };
      plantCluster(tip.x, tip.y);
      continue;
    }

    // Smooth the fingertip a little so landmark jitter doesn't scatter flowers
    pen.x += (tip.x - pen.x) * 0.5;
    pen.y += (tip.y - pen.y) * 0.5;

    // Walk from the last planting spot towards the finger, planting every `spacing` px
    let dx = pen.x - pen.lastX;
    let dy = pen.y - pen.lastY;
    let d = Math.hypot(dx, dy);
    let steps = 0;
    while (d >= spacing && steps++ < 12) {
      pen.lastX += (dx / d) * spacing;
      pen.lastY += (dy / d) * spacing;
      plantCluster(pen.lastX, pen.lastY);
      dx = pen.x - pen.lastX;
      dy = pen.y - pen.lastY;
      d = Math.hypot(dx, dy);
    }
    // If tracking glitched and the finger "teleported", skip the gap instead of flooding
    if (d >= spacing) {
      pen.lastX = pen.x;
      pen.lastY = pen.y;
    }
  }

  // Hands that stopped pointing (fist, open, out of frame) lift the pen
  for (const key of Object.keys(pens)) {
    if (!active.has(key)) delete pens[key];
  }
}

// Bloom animation: pops open with a little overshoot, then settles
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function drawGarden(now) {
  // Stamp flowers whose bloom has finished onto the permanent layer.
  // The array is in time order, so we only ever need to look at the front.
  while (garden.length && now - garden[0].born >= BLOOM_MS) {
    const f = garden.shift();
    drawSprite(gardenCtx, f.sprite, f.x, f.y, f.size, f.rotation);
    placed.push(f);
  }
  if (placed.length > MAX_PLACED) placed.splice(0, placed.length - MAX_PLACED);

  // Frozen snapshots of the old garden: they fade quickly while the particles fly off
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const alpha = 1 - (now - ghosts[i].start) / GHOST_MS;
    if (alpha <= 0) {
      ghosts.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = alpha;
    ctx.drawImage(ghosts[i].canvas, 0, 0);
  }
  ctx.globalAlpha = 1;

  // The permanent layer: one image, however many flowers it holds
  ctx.drawImage(gardenCanvas, 0, 0);

  // Flowers that are still blooming
  for (const f of garden) {
    const t = Math.min((now - f.born) / BLOOM_MS, 1);
    const scale = easeOutBack(t);
    const alpha = Math.min(t * 3, 1);
    // (1 - t) * 0.6 adds a slight untwist while it opens
    drawSprite(ctx, f.sprite, f.x, f.y, f.size * scale, f.rotation + (1 - t) * 0.6, alpha);
  }
}

// ---------- Scatter (erase) ----------
// Every flower becomes a particle that flies away from `origin` (the palm) and fades
function scatterGarden(origin) {
  const now = performance.now();
  const ox = origin ? origin.x : canvas.width / 2;
  const oy = origin ? origin.y : canvas.height / 2;
  const k = Math.min(canvas.width, canvas.height) / 720; // scales speeds to the screen size

  // Freeze what's on screen into a still image that fades quickly. The particles start
  // exactly on top of it, so the flowers appear to lift off the page.
  const snap = document.createElement("canvas");
  snap.width = gardenCanvas.width;
  snap.height = gardenCanvas.height;
  snap.getContext("2d").drawImage(gardenCanvas, 0, 0);
  ghosts.push({ canvas: snap, start: now });

  for (const f of [...placed, ...garden]) {
    // Fly directly away from the palm, with some randomness
    const angle = Math.atan2(f.y - oy, f.x - ox) + rand(-0.6, 0.6);
    const speed = rand(500, 1300) * k;
    particles.push({
      sprite: f.sprite,
      x: f.x,
      y: f.y,
      size: f.size,
      rotation: f.rotation,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 250 * k, // small upward kick
      spin: rand(-7, 7),
      born: now,
      life: rand(1000, 1500),
    });
  }

  placed.length = 0;
  garden.length = 0;
  gardenCtx.clearRect(0, 0, gardenCanvas.width, gardenCanvas.height);
}

function drawParticles(now, dt) {
  const k = Math.min(canvas.width, canvas.height) / 720;
  const gravity = 1100 * k;
  const drag = Math.exp(-1.3 * dt); // air resistance

  let alive = 0;
  for (const p of particles) {
    const age = (now - p.born) / p.life;
    if (age >= 1) continue; // finished: dropped when the array is compacted below

    p.vy += gravity * dt;
    p.vx *= drag;
    p.vy *= drag;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rotation += p.spin * dt;

    const alpha = Math.pow(1 - age, 1.4);
    drawSprite(ctx, p.sprite, p.x, p.y, p.size * (1 - 0.35 * age), p.rotation, alpha);
    particles[alive++] = p;
  }
  particles.length = alive;
}

// ---------- Open-hand erase ----------
function hasGarden() {
  return placed.length > 0 || garden.length > 0;
}

function drawRing(x, y, progress) {
  const r = flowerBase() * 0.8;
  ctx.lineWidth = 7;
  ctx.lineCap = "round";

  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)"; // faint full circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "#ff8fb1"; // the filling part
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
  ctx.stroke();
}

function updateErase(rect, now) {
  // Forget timers for hands that left the frame
  for (const key of Object.keys(holds)) {
    if (!hands.some((h) => h.key === key)) delete holds[key];
  }

  for (const hand of hands) {
    if (hand.gesture !== "open") {
      delete holds[hand.key];
      continue;
    }

    const hold = (holds[hand.key] ??= { start: now, done: false });
    if (hold.done) continue; // already erased: close the hand and reopen to erase again
    if (!hasGarden()) {      // nothing to erase yet, so keep the timer reset
      hold.start = now;
      continue;
    }

    // Palm centre = halfway between the wrist and the base of the middle finger
    const wrist = toCanvas(hand.landmarks[0], rect);
    const knuckle = toCanvas(hand.landmarks[9], rect);
    const palm = { x: (wrist.x + knuckle.x) / 2, y: (wrist.y + knuckle.y) / 2 };

    const progress = (now - hold.start) / HOLD_MS;
    if (progress >= 1) {
      scatterGarden(palm);
      hold.done = true;
    } else {
      drawRing(palm.x, palm.y, progress);
    }
  }
}

// TEMPORARY test aid: press "c" to scatter from the middle of the screen
window.addEventListener("keydown", (e) => {
  if (e.key === "c") scatterGarden(null);
});

// ---------- Detection ----------
function detect() {
  // Only run the model when the camera has a new frame
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const result = handLandmarker.detectForVideo(video, performance.now());
  updateGestures(result);
}

// ---------- Drawing ----------
function drawVideo(rect) {
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawHands(rect) {
  for (const hand of hands) {
    const pts = hand.landmarks.map((lm) => toCanvas(lm, rect));

    // Bones
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 3;
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(pts[start].x, pts[start].y);
      ctx.lineTo(pts[end].x, pts[end].y);
      ctx.stroke();
    }

    // Joints
    ctx.fillStyle = "#ff8fb1";
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Gesture label near the wrist
    ctx.fillStyle = "#fff";
    ctx.font = "20px system-ui";
    ctx.fillText(hand.gesture, pts[0].x - 20, pts[0].y + 32);
  }
}

let lastFrame = performance.now();

function loop() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05); // seconds since last frame
  lastFrame = now;

  detect();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rect = getVideoRect();
  drawVideo(rect);
  updatePlanting(rect);
  drawGarden(now);
  drawParticles(now, dt);
  drawHands(rect);
  updateErase(rect, now);

  // Temporary debug text (we'll remove it later)
  ctx.fillStyle = "#fff";
  ctx.font = "16px system-ui";
  ctx.fillText(`Hands: ${hands.length}   Flowers: ${placed.length + garden.length}`, 16, 28);

  requestAnimationFrame(loop);
}