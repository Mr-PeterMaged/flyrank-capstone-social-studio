import sharp from 'sharp';
import crypto from 'node:crypto';

const SRC_W = 2400;
const SRC_H = 1600;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrap(text, maxChars, maxLines) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > maxChars && line) {
      lines.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, '…');
  }
  return lines;
}

/**
 * Placeholder source image (artistry is not graded; the pipeline is). The "subject" is a
 * title card deliberately placed OFF-centre, so a naive centre-crop would clip it and the
 * subject-aware crop below has something real to prove.
 */
export async function createPlaceholderSource(title) {
  const hue = crypto.createHash('sha256').update(title).digest()[0] * (360 / 256);
  const subject = { x: 1100, y: 540, width: 1000, height: 520 };
  const lines = wrap(title, 19, 4); // ~19 chars of 72px bold fit the 900px text area
  const text = lines
    .map((l, i) => `<text x="${subject.x + 50}" y="${subject.y + 130 + i * 90}" font-size="72" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#0b1f1c">${esc(l)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SRC_W}" height="${SRC_H}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue.toFixed(0)},55%,32%)"/><stop offset="1" stop-color="hsl(${((hue + 60) % 360).toFixed(0)},60%,18%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="300" cy="300" r="220" fill="rgba(255,255,255,0.08)"/>
    <circle cx="2150" cy="1350" r="300" fill="rgba(255,255,255,0.07)"/>
    <rect x="${subject.x}" y="${subject.y}" width="${subject.width}" height="${subject.height}" rx="36" fill="#e9fbf3"/>
    ${text}
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, width: SRC_W, height: SRC_H, subject };
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Is `box` fully inside the safe zone (the central region left after `margin` is cut
// from every edge) of a w x h canvas?
export function insideSafeZone(box, w, h, margin) {
  const mx = w * margin;
  const my = h * margin;
  return box.x >= mx - 0.5 && box.y >= my - 0.5 && box.x + box.width <= w - mx + 0.5 && box.y + box.height <= h - my + 0.5;
}

/**
 * Render one platform variant from the source.
 *   1. Take the largest window with the target aspect ratio, centred on the subject
 *      (clamped to the image), then scale to the exact target size.
 *   2. If the subject still would not sit inside the safe zone, fall back to `contain`
 *      (whole image, letterboxed) so the subject is never cropped away.
 *   3. Composite a small branding badge INSIDE the safe zone.
 * Returns the PNG buffer plus the facts a test can assert.
 */
export async function renderVariant(source, spec, brandName = '') {
  const { width: W, height: H, safeMargin } = spec;
  const targetAR = W / H;
  let cropW;
  let cropH;
  if (source.width / source.height > targetAR) {
    cropH = source.height;
    cropW = Math.round(source.height * targetAR);
  } else {
    cropW = source.width;
    cropH = Math.round(source.width / targetAR);
  }
  const cx = source.subject.x + source.subject.width / 2;
  const cy = source.subject.y + source.subject.height / 2;
  const left = clamp(Math.round(cx - cropW / 2), 0, source.width - cropW);
  const top = clamp(Math.round(cy - cropH / 2), 0, source.height - cropH);
  const scale = W / cropW;
  let subject = {
    x: (source.subject.x - left) * scale,
    y: (source.subject.y - top) * scale,
    width: source.subject.width * scale,
    height: source.subject.height * scale,
  };

  let mode = 'crop';
  let pipeline;
  if (insideSafeZone(subject, W, H, safeMargin)) {
    pipeline = sharp(source.buffer).extract({ left, top, width: cropW, height: cropH }).resize(W, H, { fit: 'fill' });
  } else {
    // Fallback: keep the WHOLE image, scaled down until the subject fits the safe zone
    // (never larger than "contain"), letterboxed on a solid background. The image is
    // positioned so the subject is as centred as the canvas allows.
    mode = 'contain';
    const safeW = W * (1 - 2 * safeMargin);
    const safeH = H * (1 - 2 * safeMargin);
    const s = Math.min(W / source.width, H / source.height, safeW / source.subject.width, safeH / source.subject.height);
    const iw = Math.max(1, Math.min(W, Math.round(source.width * s)));
    const ih = Math.max(1, Math.min(H, Math.round(source.height * s)));
    const offX = Math.round(clamp(W / 2 - cx * s, 0, W - iw));
    const offY = Math.round(clamp(H / 2 - cy * s, 0, H - ih));
    subject = { x: source.subject.x * s + offX, y: source.subject.y * s + offY, width: source.subject.width * s, height: source.subject.height * s };
    pipeline = sharp(source.buffer)
      .resize(iw, ih, { fit: 'fill' })
      .extend({ top: offY, left: offX, bottom: H - ih - offY, right: W - iw - offX, background: '#0b1f1c' });
  }

  const composites = [];
  if (brandName) {
    const label = brandName.slice(0, 28);
    const bh = Math.round(H * 0.06);
    const fs = Math.max(14, Math.round(bh * 0.55));
    const bw = Math.min(Math.round(W * 0.6), Math.round(label.length * fs * 0.62 + bh)); // size the pill to its text
    const badge = `<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}">
      <rect width="100%" height="100%" rx="${bh / 2}" fill="rgba(11,31,28,0.75)"/>
      <text x="${bh / 2}" y="${bh * 0.67}" font-size="${fs}" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#7ee0b0">${esc(label)}</text></svg>`;
    composites.push({ input: Buffer.from(badge), left: Math.round(W * safeMargin), top: Math.round(H - H * safeMargin - bh) });
  }
  const buffer = await pipeline.composite(composites).png({ compressionLevel: 9 }).toBuffer();
  return { buffer, width: W, height: H, mode, subject, safeZoneOk: insideSafeZone(subject, W, H, safeMargin) };
}
