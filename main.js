const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const landing = document.getElementById("landing");
const startBtn = document.getElementById("startBtn");

// Keep the canvas pixel size equal to the window size
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    landing.classList.add("hidden");
    requestAnimationFrame(draw);
  } catch (err) {
    alert("Couldn't access the camera: " + err.message);
  }
}

// Runs every frame (~60 times a second)
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Scale the video so it fills the screen without stretching ("cover" fit)
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(canvas.width / vw, canvas.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  const x = (canvas.width - w) / 2;
  const y = (canvas.height - h) / 2;

  // Mirror horizontally so moving your hand right moves it right on screen
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, x, y, w, h);
  ctx.restore();

  requestAnimationFrame(draw);
}

startBtn.addEventListener("click", startCamera);