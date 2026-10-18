// flowers.js
// Draws a library of flower "sprites" (small off-screen canvases) once at startup.
// Later we stamp these onto the main canvas, which is far cheaper than redrawing
// every petal on every frame.

const SPRITE_SIZE = 256;                 // pixel size of each sprite
const SCALE = SPRITE_SIZE / 200;         // all drawing code below is written for a 200x200 box
const C = 100;                           // centre of that box

const rand = (a, b) => a + Math.random() * (b - a);
const hsl = (h, s, l, a = 1) => `hsla(${h}, ${s}%, ${l}%, ${a})`;

// Petal colour families (hue, saturation, lightness)
const PALETTES = [
  { h: 340, s: 80, l: 78 }, // pink
  { h: 8,   s: 85, l: 70 }, // coral
  { h: 25,  s: 90, l: 78 }, // peach
  { h: 48,  s: 95, l: 65 }, // yellow
  { h: 270, s: 65, l: 80 }, // lavender
  { h: 205, s: 80, l: 78 }, // sky blue
  { h: 50,  s: 30, l: 96 }, // white
  { h: 355, s: 80, l: 55 }, // red
];

// Pick a palette and nudge it a little so no two flowers match exactly
function randomTone() {
  const p = PALETTES[Math.floor(Math.random() * PALETTES.length)];
  return { h: p.h + rand(-8, 8), s: p.s, l: p.l + rand(-4, 4) };
}

// ---------- Building blocks ----------

// A petal pointing "up" from (0,0). roundness: 0 = pointy tip, 1 = rounded tip
function petalPath(ctx, len, wid, roundness) {
  const k = 0.15 + 0.8 * roundness;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-wid, -len * 0.3, -wid * k, -len * 0.95, 0, -len);
  ctx.bezierCurveTo(wid * k, -len * 0.95, wid, -len * 0.3, 0, 0);
  ctx.closePath();
}

// A ring of identical petals rotated evenly around the centre
function petalRing(ctx, { count, len, wid, roundness, tone, offset = 0, lightShift = 0 }) {
  for (let i = 0; i < count; i++) {
    ctx.save();
    ctx.translate(C, C);
    ctx.rotate(offset + (i / count) * Math.PI * 2);
    petalPath(ctx, len, wid, roundness);

    // Darker at the base, lighter at the tip
    const g = ctx.createLinearGradient(0, 0, 0, -len);
    g.addColorStop(0, hsl(tone.h, tone.s, tone.l - 12 + lightShift));
    g.addColorStop(1, hsl(tone.h, tone.s, tone.l + 6 + lightShift));
    ctx.fillStyle = g;
    ctx.fill();

    // Faint outline so petals stay visible against each other
    ctx.strokeStyle = hsl(tone.h, tone.s, tone.l - 22 + lightShift, 0.4);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }
}

// Round flower centre with a soft highlight
function centre(ctx, r, tone) {
  const g = ctx.createRadialGradient(C - r * 0.3, C - r * 0.3, r * 0.1, C, C, r);
  g.addColorStop(0, hsl(tone.h, tone.s, tone.l + 15));
  g.addColorStop(1, hsl(tone.h, tone.s, tone.l - 10));
  ctx.beginPath();
  ctx.arc(C, C, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}

// Sunflower-style seed pattern (golden-angle spiral)
function seeds(ctx, radius, color) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const n = 110;
  ctx.fillStyle = color;
  for (let i = 1; i < n; i++) {
    const r = radius * Math.sqrt(i / n);
    const a = i * golden;
    ctx.beginPath();
    ctx.arc(C + r * Math.cos(a), C + r * Math.sin(a), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Little lines with dots on the end, coming out of the centre
function stamens(ctx, count, reach, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand(-0.2, 0.2);
    const r = reach * rand(0.8, 1.1);
    const x = C + Math.cos(a) * r;
    const y = C + Math.sin(a) * r;
    ctx.beginPath();
    ctx.moveTo(C, C);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- Flower types ----------

const TYPES = {
  daisy(ctx, tone) {
    petalRing(ctx, { count: Math.floor(rand(12, 18)), len: 90, wid: 11, roundness: 0.5, tone });
    centre(ctx, 17, { h: 45, s: 95, l: 55 });
  },

  blossom(ctx, tone) {
    petalRing(ctx, { count: 5, len: 80, wid: 40, roundness: 1, tone, offset: rand(0, 1) });
    centre(ctx, 11, { h: 48, s: 90, l: 60 });
    stamens(ctx, 9, 20, hsl(40, 80, 45));
  },

  rose(ctx, tone) {
    const layers = [
      { count: 8, len: 84, wid: 40 },
      { count: 7, len: 64, wid: 32 },
      { count: 6, len: 46, wid: 24 },
      { count: 5, len: 30, wid: 16 },
      { count: 4, len: 16, wid: 9 },
    ];
    layers.forEach((layer, i) => {
      petalRing(ctx, { ...layer, roundness: 1, tone, offset: i * 0.45, lightShift: -i * 3 });
    });
  },

  sunflower(ctx) {
    const tone = { h: rand(38, 48), s: 95, l: 58 }; // always yellow-orange
    petalRing(ctx, { count: 20, len: 92, wid: 10, roundness: 0.2, tone });
    petalRing(ctx, { count: 20, len: 80, wid: 10, roundness: 0.2, tone, offset: Math.PI / 20, lightShift: 4 });
    centre(ctx, 36, { h: 25, s: 55, l: 24 });
    seeds(ctx, 32, hsl(30, 50, 40));
  },

  lily(ctx, tone) {
    petalRing(ctx, { count: 6, len: 90, wid: 26, roundness: 0.1, tone });
    petalRing(ctx, { count: 6, len: 60, wid: 7, roundness: 0.1, tone, lightShift: -18 }); // stripe
    stamens(ctx, 6, 24, hsl(20, 70, 40));
  },

  dahlia(ctx, tone) {
    const rings = 5;
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      petalRing(ctx, {
        count: 16 - i * 2,
        len: 88 - t * 56,
        wid: 15 - t * 6,
        roundness: 0.3,
        tone,
        offset: i * 0.3,
        lightShift: -i * 2,
      });
    }
  },
};

// ---------- Leaves and fillers ----------

// Leaf grows upward from the sprite centre (the centre is where it attaches)
function drawLeaf(ctx) {
  const h = rand(100, 150), s = rand(35, 55), l = rand(30, 42);
  ctx.save();
  ctx.translate(C, C);
  petalPath(ctx, 92, 24, 0);

  const g = ctx.createLinearGradient(0, 0, 0, -92);
  g.addColorStop(0, hsl(h, s, l - 8));
  g.addColorStop(1, hsl(h, s, l + 10));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = hsl(h, s, l - 15, 0.5);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Midrib
  ctx.strokeStyle = hsl(h, s - 10, l + 22, 0.7);
  ctx.beginPath();
  ctx.moveTo(0, -4);
  ctx.lineTo(0, -80);
  ctx.stroke();
  ctx.restore();
}

// Baby's-breath style filler: thin stems topped with tiny five-dot flowers
function drawFiller(ctx) {
  const tone = Math.random() < 0.6 ? { h: 50, s: 30, l: 97 } : randomTone();
  const sprigs = Math.floor(rand(7, 11));

  for (let i = 0; i < sprigs; i++) {
    const a = rand(0, Math.PI * 2);
    const d = rand(30, 82);
    const x = C + Math.cos(a) * d;
    const y = C + Math.sin(a) * d;

    ctx.strokeStyle = hsl(120, 30, 40, 0.7);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(C, C);
    ctx.lineTo(x, y);
    ctx.stroke();

    for (let k = 0; k < 5; k++) {
      const pa = (k / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(pa) * 4.5, y + Math.sin(pa) * 4.5, 4, 0, Math.PI * 2);
      ctx.fillStyle = hsl(tone.h, tone.s, tone.l);
      ctx.fill();
      ctx.strokeStyle = hsl(tone.h, tone.s, tone.l - 25, 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = hsl(45, 90, 60);
    ctx.fill();
  }
}

// ---------- Public API ----------

function makeSprite(draw) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SPRITE_SIZE;
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  draw(ctx);
  return canvas;
}

// Builds all sprites once. Flower types are cycled so every type is well represented.
export function buildLibrary({ flowers = 48, leaves = 8, fillers = 8 } = {}) {
  const types = Object.values(TYPES);
  return {
    flowers: Array.from({ length: flowers }, (_, i) =>
      makeSprite((ctx) => types[i % types.length](ctx, randomTone()))
    ),
    leaves: Array.from({ length: leaves }, () => makeSprite(drawLeaf)),
    fillers: Array.from({ length: fillers }, () => makeSprite(drawFiller)),
  };
}

// Stamp a sprite onto a canvas. (x, y) is the sprite's centre, size is its width in px.
export function drawSprite(ctx, sprite, x, y, size, rotation = 0, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
  ctx.restore();
}