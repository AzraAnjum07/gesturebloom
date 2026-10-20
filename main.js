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
const toolbar = document.getElementById("toolbar");
const backdropBtn = document.getElementById("backdropBtn");
const petalsBtn = document.getElementById("petalsBtn");
const skeletonBtn = document.getElementById("skeletonBtn");
const photoBtn = document.getElementById("photoBtn");
const recordBtn = document.getElementById("recordBtn");

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
  status.classList.add("loading");
  try {
    status.textContent = "Asking for camera...";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    status.textContent = "Planting seeds...";
    handLandmarker = await modelPromise;

    landing.classList.add("hidden");
    toolbar.classList.remove("hidden");
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    status.classList.remove("loading");
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
const sparkles = [];             // little twinkles that appear as flowers bloom
const pens = {};                 // per-hand: smoothed fingertip + last planting spot
const holds = {};                // per-hand: open-palm hold timers

const BLOOM_MS = 650;            // how long a flower takes to bloom
const HOLD_MS = 450;             // how long to hold an open hand before erasing
const GHOST_MS = 200;            // how fast the still image of the old garden fades
const MAX_PLACED = 1500;         // most flowers we keep individually for scattering
const MAX_SPARKLES = 120;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Sizes scale with the screen so it looks the same everywhere
function flowerBase() {
  return Math.min(canvas.width, canvas.height) * 0.1;
}

function plant(sprite, x, y, size, rotation) {
  garden.push({ sprite, x, y, size, rotation, born: performance.now() });
}

// A couple of twinkles around a freshly planted flower
function addSparkles(x, y, size) {
  const now = performance.now();
  for (let i = 0; i < 2; i++) {
    const a = rand(0, Math.PI * 2);
    const r = rand(size * 0.2, size * 0.55);
    sparkles.push({
      x: x + Math.cos(a) * r,
      y: y + Math.sin(a) * r,
      size: rand(6, 12),
      born: now,
      delay: rand(150, 450), // twinkle just after the bloom pops
      life: rand(500, 850),
    });
  }
  if (sparkles.length > MAX_SPARKLES) sparkles.splice(0, sparkles.length - MAX_SPARKLES);
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

  const [fx, fy] = at();
  const fs = base * rand(0.75, 1.3);
  plant(pick(library.flowers), fx, fy, fs, rand(0, Math.PI * 2));
  if (Math.random() < 0.4) addSparkles(fx, fy, fs);
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

// ---------- Sparkles ----------
function drawSparkles(now) {
  let alive = 0;
  for (const s of sparkles) {
    const age = now - s.born - s.delay;
    if (age >= s.life) continue; // finished
    if (age >= 0) {
      const t = age / s.life;
      const a = Math.sin(t * Math.PI);   // fades in, then out
      const r = s.size * (0.6 + 0.4 * a);

      ctx.save();
      ctx.translate(s.x, s.y - t * 10);   // drifts up a touch
      ctx.rotate(t * 1.2);
      ctx.globalAlpha = a;
      ctx.shadowColor = "#ffd86b";
      ctx.shadowBlur = 8;
      ctx.fillStyle = "#fff7d1";
      ctx.strokeStyle = "rgba(255, 190, 70, 0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {      // four-pointed star
        const ang = (i * Math.PI) / 4;
        const rad = i % 2 === 0 ? r : r * 0.28;
        ctx.lineTo(Math.cos(ang) * rad, Math.sin(ang) * rad);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    sparkles[alive++] = s;
  }
  sparkles.length = alive;
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

  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)"; // faint full circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "#f26a98"; // the filling part
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

// ---------- Detection ----------
function detect() {
  // Only run the model when the camera has a new frame
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const result = handLandmarker.detectForVideo(video, performance.now());
  updateGestures(result);
}

// ---------- Backdrops ----------
// video: how visible the camera is (0 = hidden). stops: optional gradient behind it.
const BACKDROPS = [
  { name: "Camera", video: 1 },
  { name: "Dreamy", video: 0.4, stops: ["#ffe4ec", "#fff1e6", "#e7e0ff"] },
  { name: "Pastel", video: 0, stops: ["#ffe4ec", "#fff1e6", "#e7e0ff"] },
  { name: "Dusk", video: 0, stops: ["#ffd9c7", "#f6a5c0", "#6b5b9a"] },
  { name: "Night", video: 0, stops: ["#12122a", "#221538", "#33204a"] },
];
let backdropIndex = 0;
let showSkeleton = true;
let showPetals = true;

function drawVideo(rect) {
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}

function drawBackdrop(rect) {
  const backdrop = BACKDROPS[backdropIndex];

  if (backdrop.stops) {
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, backdrop.stops[0]);
    g.addColorStop(0.5, backdrop.stops[1]);
    g.addColorStop(1, backdrop.stops[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (backdrop.video > 0) {
    ctx.globalAlpha = backdrop.video;
    drawVideo(rect);
    ctx.globalAlpha = 1;
  }
}

// ---------- Ambient petals ----------
const PETAL_COUNT = 26;
const PETAL_COLORS = ["#ffb7c9", "#ffd3e0", "#fff0f5", "#f9c6e0", "#e8d5ff"];
let petals = [];

function newPetal(anywhere) {
  return {
    x: rand(0, canvas.width),
    y: anywhere ? rand(0, canvas.height) : rand(-60, -10),
    size: rand(8, 17),
    speed: rand(20, 45),     // fall speed, px/s
    sway: rand(0.6, 1.6),    // sway frequency
    swayAmp: rand(18, 45),   // sway strength
    phase: rand(0, Math.PI * 2),
    rot: rand(0, Math.PI * 2),
    spin: rand(-1.2, 1.2),
    color: pick(PETAL_COLORS),
  };
}

function drawPetals(now, dt) {
  if (petals.length === 0) {
    petals = Array.from({ length: PETAL_COUNT }, () => newPetal(true));
  }
  const k = Math.min(canvas.width, canvas.height) / 720;

  for (let i = 0; i < petals.length; i++) {
    const p = petals[i];
    p.y += p.speed * k * dt;
    p.x += Math.sin((now / 1000) * p.sway + p.phase) * p.swayAmp * dt;
    p.rot += p.spin * dt;
    if (p.y > canvas.height + 30) {
      petals[i] = newPetal(false);
      continue;
    }

    const flip = 0.4 + 0.6 * Math.abs(Math.cos(p.rot * 0.9 + p.phase)); // tumbling look
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.scale(1, flip);
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, p.size * k, p.size * 0.55 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ---------- Vignette + film grain ----------
const grainCanvas = document.createElement("canvas");
grainCanvas.width = grainCanvas.height = 128;
{
  const g = grainCanvas.getContext("2d");
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255; // opaque grey noise, faded when drawn
  }
  g.putImageData(img, 0, 0);
}
let grainPattern = null;

function drawFinish() {
  // Soft plum vignette
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = Math.hypot(cx, cy);
  const vg = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
  vg.addColorStop(0, "rgba(70, 25, 80, 0)");
  vg.addColorStop(1, "rgba(70, 25, 80, 0.22)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Grain: the noise tile jumps to a random offset every frame so it shimmers
  grainPattern ??= ctx.createPattern(grainCanvas, "repeat");
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.globalCompositeOperation = "overlay";
  ctx.translate(Math.random() * 128, Math.random() * 128);
  ctx.fillStyle = grainPattern;
  ctx.fillRect(-128, -128, canvas.width + 128, canvas.height + 128);
  ctx.restore();
}

// ---------- Skeleton ----------
function drawHands(rect) {
  for (const hand of hands) {
    const pts = hand.landmarks.map((lm) => toCanvas(lm, rect));

    // Bones: soft dark outline first so they stay visible on light backdrops
    ctx.lineCap = "round";
    for (const [width, color] of [
      [6, "rgba(91, 58, 94, 0.35)"],
      [3, "rgba(255, 255, 255, 0.95)"],
    ]) {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
        ctx.beginPath();
        ctx.moveTo(pts[start].x, pts[start].y);
        ctx.lineTo(pts[end].x, pts[end].y);
        ctx.stroke();
      }
    }

    // Joints
    ctx.fillStyle = "#ff8fb1";
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Gesture label near the wrist
    ctx.font = "700 20px Quicksand, system-ui, sans-serif";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(91, 58, 94, 0.6)";
    ctx.strokeText(hand.gesture, pts[0].x - 20, pts[0].y + 32);
    ctx.fillStyle = "#fff";
    ctx.fillText(hand.gesture, pts[0].x - 20, pts[0].y + 32);
  }
}

// ---------- Toolbar: backdrop, petals, skeleton, photo, record ----------
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

backdropBtn.addEventListener("click", () => {
  backdropIndex = (backdropIndex + 1) % BACKDROPS.length;
  backdropBtn.textContent = "🎨 Backdrop: " + BACKDROPS[backdropIndex].name;
});

petalsBtn.addEventListener("click", () => {
  showPetals = !showPetals;
  petalsBtn.textContent = "🌸 Petals: " + (showPetals ? "On" : "Off");
});

skeletonBtn.addEventListener("click", () => {
  showSkeleton = !showSkeleton;
  skeletonBtn.textContent = "🖐 Skeleton: " + (showSkeleton ? "On" : "Off");
});

photoBtn.addEventListener("click", () => {
  // The canvas holds the last finished frame, so this saves exactly what you see
  canvas.toBlob((blob) => {
    if (blob) download(blob, `gesturebloom-${stamp()}.png`);
  }, "image/png");
});

// Video recording (records the canvas, not the buttons)
let recorder = null;
let recordedChunks = [];
let recordTimer = null;

function pickMimeType() {
  const types = [
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function startRecording() {
  const mimeType = pickMimeType();
  const stream = canvas.captureStream(30);
  recorder = new MediaRecorder(
    stream,
    mimeType ? { mimeType, videoBitsPerSecond: 6000000 } : undefined
  );
  recordedChunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  recorder.onstop = () => {
    const type = recorder.mimeType || mimeType || "video/webm";
    const blob = new Blob(recordedChunks, { type });
    download(blob, `gesturebloom-${stamp()}.${type.includes("mp4") ? "mp4" : "webm"}`);
    recorder = null;
  };
  recorder.start();

  // Button turns red and shows a running timer
  const startedAt = performance.now();
  recordBtn.classList.add("recording");
  recordBtn.textContent = "⏹ Stop 0:00";
  recordTimer = setInterval(() => {
    const s = Math.floor((performance.now() - startedAt) / 1000);
    recordBtn.textContent = `⏹ Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
}

function stopRecording() {
  clearInterval(recordTimer);
  recordBtn.classList.remove("recording");
  recordBtn.textContent = "⏺ Record";
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

if (typeof MediaRecorder === "undefined") {
  recordBtn.style.display = "none"; // browser can't record, so hide the button
} else {
  recordBtn.addEventListener("click", () => {
    if (recorder) stopRecording();
    else startRecording();
  });
}

// ---------- Main loop ----------
let lastFrame = performance.now();

function loop() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05); // seconds since last frame
  lastFrame = now;

  detect();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rect = getVideoRect();

  drawBackdrop(rect);
  if (showPetals) drawPetals(now, dt);
  updatePlanting(rect);
  drawGarden(now);
  drawParticles(now, dt);
  drawSparkles(now);
  drawFinish();
  if (showSkeleton) drawHands(rect);
  updateErase(rect, now);

  requestAnimationFrame(loop);
}