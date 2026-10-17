import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

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
let hands = []; // latest detection: an array of hands, each hand = 21 landmarks

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// ---------- Model setup ----------
async function createHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands: 2,
  });
  try {
    return await HandLandmarker.createFromOptions(vision, options("GPU"));
  } catch (err) {
    console.warn("GPU unavailable, falling back to CPU", err);
    return await HandLandmarker.createFromOptions(vision, options("CPU"));
  }
}

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

    status.textContent = "Loading hand tracking model...";
    handLandmarker = await createHandLandmarker();

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
// Where the video sits on the canvas ("cover" fit, same as before)
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

// ---------- Detection ----------
function detect() {
  // Only run the model when the camera has a new frame
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  const result = handLandmarker.detectForVideo(video, performance.now());
  hands = result.landmarks;
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
    const pts = hand.map((lm) => toCanvas(lm, rect));

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
  }
}

function loop() {
  detect();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const rect = getVideoRect();
  drawVideo(rect);
  drawHands(rect);

  // Temporary debug text (we'll remove it later)
  ctx.fillStyle = "#fff";
  ctx.font = "16px system-ui";
  ctx.fillText("Hands detected: " + hands.length, 16, 28);

  requestAnimationFrame(loop);
}