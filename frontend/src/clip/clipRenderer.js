// Draws one frame of the lyrics clip. The live preview and the exported video both call this same
// function, so what the preview shows is what the video contains.
import { FONTS, fontCss } from './fonts';

export const SIZES = {
  '9:16': [1080, 1920],
  '4:5': [1080, 1350],
  '1:1': [1080, 1080],
  '16:9': [1920, 1080],
};

export const ANIMATIONS = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'pop', label: 'Pop' },
  { id: 'slide', label: 'Slide up' },
  { id: 'zoom', label: 'Zoom in' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'wordpop', label: 'Word pop' },
];

export const DEFAULT_CLIP = {
  aspect: '9:16',
  font: 'poppins',
  fontScale: 1, // 0.6 - 1.6
  textColor: '#ffffff',
  highlightColor: '#ffd700',
  style: 'highlight', // highlight: words light up as they are sung | plain
  outline: 6, // 0 - 12
  shadow: true,
  dim: 0.45, // how dark the picture is made, 0 - 0.8
  posX: 0.5, // where the middle of the text sits, as a share of the width...
  posY: 0.8, // ...and of the height. It is dragged on the preview.
  animation: 'pop',
  animSpeed: 1, // 0.5 - 2
};

const HOLD = 0.4; // seconds a line stays after its last word
const ENTER = 0.35; // seconds an entrance animation takes at speed 1
const EXIT = 0.25; // seconds a line fades out at its end

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const easeOutBack = (x) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

function drawBackground(ctx, W, H, image) {
  if (image) {
    const scale = Math.max(W / image.width, H / image.height); // cover
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#1e1b4b');
    g.addColorStop(1, '#be185d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

// The line that is on screen at time t: the latest one that has started, until it ends or the next starts.
function findActive(lines, t) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start <= t) idx = i;
    else break;
  }
  if (idx < 0) return null;
  const line = lines[idx];
  const next = lines[idx + 1];
  const end = Math.max(Math.min(line.end + HOLD, next ? next.start : Infinity), line.start + 0.3);
  return t < end ? { line, end } : null;
}

// Break the words into rows that fit, and time each word in proportion to its length.
function layout(ctx, line, maxWidth) {
  const texts = line.text.trim().split(/\s+/).filter(Boolean);
  const space = ctx.measureText(' ').width;
  const weights = texts.map((w) => w.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const duration = Math.max(line.end - line.start, 0.3);

  let acc = 0;
  const words = texts.map((text, i) => {
    const start = line.start + (duration * acc) / total;
    acc += weights[i];
    return { text, w: ctx.measureText(text).width, start, end: line.start + (duration * acc) / total };
  });

  const rows = [];
  let row = null;
  for (const word of words) {
    if (!row || row.width + space + word.w > maxWidth) {
      row = { words: [], width: 0 };
      rows.push(row);
    }
    word.x = row.words.length ? row.width + space : 0;
    row.width = word.x + word.w;
    row.words.push(word);
  }
  return rows;
}

function drawWord(ctx, word, x, y, px, clip, t, scale) {
  ctx.save();
  if (scale !== 1) {
    const cx = x + word.w / 2;
    const cy = y - px * 0.3;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
  }
  if (clip.outline > 0) {
    ctx.lineWidth = (clip.outline * px) / 55;
    ctx.strokeStyle = '#000000';
    ctx.strokeText(word.text, x, y);
  }
  if (clip.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = px * 0.08;
    ctx.shadowOffsetY = px * 0.04;
  }
  ctx.fillStyle = clip.textColor;
  ctx.fillText(word.text, x, y);
  ctx.shadowColor = 'transparent';

  const sung = clamp01((t - word.start) / Math.max(word.end - word.start, 0.05));
  if (clip.style === 'highlight' && sung > 0) {
    ctx.beginPath();
    ctx.rect(x - 4, y - px * 1.1, (word.w + 8) * sung, px * 1.5);
    ctx.clip();
    ctx.fillStyle = clip.highlightColor;
    ctx.fillText(word.text, x, y);
  }
  ctx.restore();
}

export function drawClipFrame(ctx, W, H, t, lines, image, clip) {
  ctx.clearRect(0, 0, W, H);
  drawBackground(ctx, W, H, image);
  ctx.fillStyle = `rgba(0, 0, 0, ${clip.dim})`;
  ctx.fillRect(0, 0, W, H);

  const active = findActive(lines, t);
  if (!active) return;
  const { line, end } = active;

  const font = FONTS.find((f) => f.id === clip.font) ?? FONTS[0];
  const px = Math.round(Math.min(W, H) * 0.1 * clip.fontScale);
  ctx.font = fontCss(font, px);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';

  const rows = layout(ctx, line, W * 0.84);
  if (!rows.length) return;
  const rowH = px * 1.25;
  const blockH = rows.length * rowH;
  const cx = clip.posX * W;
  const cy = clip.posY * H;

  // Entrance animation of the whole line, and a short fade at its end.
  const p = clamp01((t - line.start) / (ENTER / Math.max(clip.animSpeed, 0.25)));
  let alpha = 1;
  let scale = 1;
  let dy = 0;
  switch (clip.animation) {
    case 'fade': alpha = p; break;
    case 'pop': alpha = p; scale = 0.7 + 0.3 * easeOutBack(p); break;
    case 'slide': alpha = p; dy = (1 - easeOutCubic(p)) * H * 0.05; break;
    case 'zoom': alpha = p; scale = 1.35 - 0.35 * easeOutCubic(p); break;
    default: break;
  }
  if (clip.animation !== 'none') alpha *= clamp01((end - t) / EXIT);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy + dy);
  ctx.scale(scale, scale);
  rows.forEach((row, r) => {
    const baseline = -blockH / 2 + r * rowH + rowH * 0.8;
    for (const word of row.words) {
      if (clip.animation === 'typewriter' && word.start > t) continue; // not sung yet
      let wordScale = 1;
      if (clip.animation === 'wordpop' && t >= word.start && t <= word.end) {
        wordScale = 1 + 0.18 * Math.sin(Math.PI * clamp01((t - word.start) / Math.max(word.end - word.start, 0.05)));
      }
      drawWord(ctx, word, -row.width / 2 + word.x, baseline, px, clip, t, wordScale);
    }
  });
  ctx.restore();
}
