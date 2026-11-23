// Canvas renderer shared by the live preview, template thumbnails and export.
// Export sends the same layers as PNGs to ffmpeg, so preview == final video.
import { normalize } from './templates.js';

export const W = 1080, H = 1920;

const imgCache = new Map();
export function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (!imgCache.has(url)) {
    imgCache.set(url, new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
    }));
  }
  return imgCache.get(url);
}

export async function ensureFonts(tpl) {
  const t = normalize(tpl);
  const specs = [t.title, t.channel, t.links, t.captions].map((s) => `${s.weight} 48px "${s.font}"`);
  await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => null)));
}

// Everything a template needs to draw, resolved once.
export async function resolveAssets(tpl, brand) {
  const t = normalize(tpl);
  const [bgImage, logo] = await Promise.all([
    t.bg.type === 'image' ? loadImage(t.bg.image) : null,
    brand?.logo ? loadImage(brand.logo) : null,
  ]);
  await ensureFonts(t);
  return { bgImage, logo };
}

export function videoBox(tpl, meta) {
  const t = normalize(tpl);
  const w = Math.min(W, Math.max(200, t.video.width));
  const aspect = meta && meta.width && meta.height ? meta.height / meta.width : 9 / 16;
  const h = Math.round(w * aspect);
  return { x: Math.round((W - w) / 2), y: Math.round(t.video.y - h / 2), w: Math.round(w), h };
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawCover(ctx, src, sw, sh, x, y, w, h) {
  const s = Math.max(w / sw, h / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function gradientStops(stops) {
  return stops.map((s, i) => Array.isArray(s) ? s : [s, stops.length === 1 ? 0 : i / (stops.length - 1)]);
}

function drawPattern(ctx, bg) {
  if (!bg.pattern || bg.pattern === 'none') return;
  ctx.save();
  ctx.fillStyle = bg.patternColor;
  ctx.strokeStyle = bg.patternColor;
  if (bg.pattern === 'dots') {
    for (let y = 20; y < H; y += 44) for (let x = (y / 44) % 2 ? 42 : 20; x < W; x += 44) {
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    }
  } else if (bg.pattern === 'grid') {
    ctx.lineWidth = 2;
    for (let x = 0; x <= W; x += 72) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 72) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  } else if (bg.pattern === 'lines') {
    for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 2);
  } else if (bg.pattern === 'grain') {
    const rnd = mulberry(7);
    for (let i = 0; i < 26000; i++) ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
  }
  ctx.restore();
}

function drawVignette(ctx, amount) {
  if (!amount) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${Math.min(1, amount)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawAccents(ctx, accents) {
  for (const a of accents || []) {
    ctx.fillStyle = a.color || '#fff';
    if (a.type === 'bar') ctx.fillRect(a.x, a.y, a.w, a.h);
    else if (a.type === 'circle') { ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill(); }
  }
}

// Layer 1: background + video frame decoration (border/shadow). Transparent where blur shows.
export function drawUnder(ctx, tpl, meta, assets) {
  const t = normalize(tpl);
  const bg = t.bg;
  if (bg.type === 'solid') { ctx.fillStyle = bg.color; ctx.fillRect(0, 0, W, H); }
  else if (bg.type === 'gradient') {
    const a = ((bg.angle || 180) - 90) * Math.PI / 180;
    const r = Math.abs(W * Math.cos(a)) / 2 + Math.abs(H * Math.sin(a)) / 2;
    const g = ctx.createLinearGradient(W / 2 - Math.cos(a) * r, H / 2 - Math.sin(a) * r, W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r);
    for (const [c, p] of gradientStops(bg.stops)) g.addColorStop(Math.max(0, Math.min(1, p)), c);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } else if (bg.type === 'image') {
    ctx.fillStyle = bg.color || '#000'; ctx.fillRect(0, 0, W, H);
    if (assets?.bgImage) drawCover(ctx, assets.bgImage, assets.bgImage.naturalWidth, assets.bgImage.naturalHeight, 0, 0, W, H);
  }
  if (bg.tint) { ctx.fillStyle = bg.tint; ctx.fillRect(0, 0, W, H); }
  drawPattern(ctx, bg);
  drawVignette(ctx, bg.vignette);
  drawAccents(ctx, t.accents.filter((a) => a.layer !== 'over'));

  const v = t.video, box = videoBox(t, meta);
  const b = v.border || 0;
  if (v.hardShadow) {
    ctx.fillStyle = v.shadowColor;
    roundRect(ctx, box.x - b + v.hardShadow, box.y - b + v.hardShadow, box.w + 2 * b, box.h + 2 * b, v.radius + b); ctx.fill();
  }
  if (v.shadow) {
    ctx.save();
    ctx.shadowColor = v.shadowColor; ctx.shadowBlur = v.shadow; ctx.shadowOffsetY = v.shadow / 3;
    ctx.fillStyle = '#000';
    roundRect(ctx, box.x - b, box.y - b, box.w + 2 * b, box.h + 2 * b, v.radius + b); ctx.fill();
    ctx.restore();
  }
  if (b) {
    ctx.fillStyle = v.borderColor;
    roundRect(ctx, box.x - b, box.y - b, box.w + 2 * b, box.h + 2 * b, v.radius + b); ctx.fill();
  }
}

export function drawMask(ctx, tpl, meta) {
  const t = normalize(tpl), box = videoBox(t, meta);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, box.w, box.h);
  ctx.fillStyle = '#fff'; roundRect(ctx, 0, 0, box.w, box.h, t.video.radius); ctx.fill();
}

// Title line spacing: the template's value, but at least the real ink height
// of the tallest line (Urdu/Arabic titles reach far above and below).
function titleLineHeight(ctx, lines, size, ti) {
  ctx.textBaseline = 'middle';
  let ink = 0;
  for (const l of lines) { const m = ctx.measureText(l); ink = Math.max(ink, (m.actualBoundingBoxAscent || 0) + (m.actualBoundingBoxDescent || 0)); }
  return Math.max(size * (ti.lineHeight || 1.12), lines.length > 1 ? ink + size * 0.08 : 0);
}

function font(s, size) { return `${s.weight} ${size || s.size}px "${s.font}"`; }

function wrap(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// Layer 3: title, channel row, links. Transparent elsewhere.
export function drawOver(ctx, tpl, meta, assets, brand, title) {
  const t = normalize(tpl);
  ctx.textBaseline = 'middle';

  const ti = t.title;
  if (ti.show && title) {
    let size = ti.size;
    let text = (ti.prefix || '') + (ti.upper ? title.toUpperCase() : title);
    let lines;
    for (;;) { // shrink long titles to max 3 lines
      ctx.font = font(ti, size);
      lines = wrap(ctx, text, ti.maxWidth);
      if (lines.length <= 3 || size < 30) break;
      size -= 4;
    }
    const lh = titleLineHeight(ctx, lines, size, ti);
    const top = ti.y - (lines.length * lh) / 2;
    if (ti.box) {
      const wMax = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const pad = size * 0.4;
      ctx.fillStyle = ti.box;
      roundRect(ctx, W / 2 - wMax / 2 - pad, top - pad * 0.7, wMax + pad * 2, lines.length * lh + pad * 1.4, size * 0.3); ctx.fill();
    }
    ctx.textAlign = 'center';
    lines.forEach((l, i) => {
      const y = top + lh * (i + 0.5);
      ctx.save();
      if (ti.glow) { ctx.shadowColor = ti.glow; ctx.shadowBlur = size * 0.35; }
      ctx.fillStyle = ti.color;
      ctx.fillText(l, W / 2, y);
      ctx.restore();
    });
  }

  const ch = t.channel;
  if (ch.show && brand && (brand.channel || brand.handle || brand.logo)) {
    const logoOn = ch.logo && assets?.logo;
    const ls = logoOn ? ch.logoSize : 0;
    ctx.font = font(ch);
    const nameW = ctx.measureText(brand.channel || '').width;
    ctx.font = font(ch, ch.size * 0.72);
    const handleW = ctx.measureText(brand.handle || '').width;
    const textW = Math.max(nameW, handleW);
    const gap = logoOn ? 22 : 0;
    const total = ls + gap + textW;
    let x = W / 2 - total / 2;
    if (logoOn) {
      ctx.save();
      ctx.beginPath(); ctx.arc(x + ls / 2, ch.y, ls / 2, 0, Math.PI * 2); ctx.clip();
      drawCover(ctx, assets.logo, assets.logo.naturalWidth, assets.logo.naturalHeight, x, ch.y - ls / 2, ls, ls);
      ctx.restore();
      if (ch.logoRing) {
        ctx.strokeStyle = ch.logoRing; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(x + ls / 2, ch.y, ls / 2, 0, Math.PI * 2); ctx.stroke();
      }
      x += ls + gap;
    }
    ctx.textAlign = logoOn ? 'left' : 'center';
    const tx = logoOn ? x : W / 2;
    const twoLines = brand.channel && brand.handle;
    ctx.fillStyle = ch.color; ctx.font = font(ch);
    if (brand.channel) ctx.fillText(brand.channel, tx, twoLines ? ch.y - ch.size * 0.42 : ch.y);
    ctx.fillStyle = ch.handleColor; ctx.font = font(ch, ch.size * 0.72);
    if (brand.handle) ctx.fillText(brand.handle, tx, twoLines ? ch.y + ch.size * 0.5 : ch.y);
  }

  const li = t.links;
  const linkLines = [];
  if (li.show && brand) {
    if (li.cta && brand.cta) linkLines.push(brand.cta);
    for (const l of brand.links || []) if (l) linkLines.push(l);
  }
  if (linkLines.length) {
    ctx.textAlign = 'center';
    const lh = li.size * 1.5;
    let y = li.y;
    for (const [i, l] of linkLines.slice(0, 4).entries()) {
      const size = i === 0 && li.cta && brand.cta ? li.size * 1.05 : li.size * 0.9;
      ctx.font = font(li, size);
      const w = ctx.measureText(l).width;
      if (li.box) {
        ctx.fillStyle = li.box;
        roundRect(ctx, W / 2 - w / 2 - 28, y - lh / 2 + 4, w + 56, lh - 8, (lh - 8) / 2); ctx.fill();
      }
      ctx.fillStyle = li.color;
      ctx.fillText(l, W / 2, y);
      y += lh + 6;
    }
  }
  drawAccents(ctx, t.accents.filter((a) => a.layer === 'over'));
}

// ---------- captions ----------

export function captionChunks(transcript, clip, maxWords = 3) {
  const words = [];
  for (const seg of transcript?.segments || []) {
    if (seg.end < clip.start || seg.start > clip.end) continue;
    seg.words.forEach((w, i) => {
      if (w.e > clip.start && w.s < clip.end) words.push({ ...w, segEnd: i === seg.words.length - 1 });
    });
  }
  const chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) chunks.push(cur); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = cur[cur.length - 1];
    if (prev && (w.s - prev.e > 0.6)) flush();
    cur.push(w);
    const len = cur.reduce((n, x) => n + x.w.length + 1, 0);
    if (cur.length >= maxWords || len > 22 || /[.!?,;:]$/.test(w.w) || w.segEnd) flush();
  }
  flush();
  const dur = clip.end - clip.start;
  return chunks.map((ws, i) => {
    const next = chunks[i + 1];
    const start = Math.max(0, ws[0].s - clip.start);
    let end = ws[ws.length - 1].e - clip.start + 0.35;
    if (next) end = Math.min(end, next[0].s - clip.start);
    return {
      start, end: Math.min(dur, Math.max(end, start + 0.2)),
      abs: { start: ws[0].s, end: ws[ws.length - 1].e }, // source times, used to edit the text
      words: ws.map((w) => ({ w: w.w, s: Math.max(0, w.s - clip.start), e: Math.min(dur, w.e - clip.start), j: w.j || undefined })),
    };
  }).filter((c) => c.end > c.start);
}

// The user's own lyric lines -> caption chunks. Each line is one caption; word
// times are spread across the line so the highlight sweeps like karaoke.
// Song-structure labels people paste with lyrics ("[Verse 2 – HOP]", "**Chorus:**").
// They aren't sung, so they never become captions. "(ooh ooh)" stays a lyric.
const LABEL_WORDS = /^(intro|outro|verse|chorus|pre-?chorus|post-?chorus|hook|bridge|refrain|interlude|instrumental|break|breakdown|coda|drop|solo|spoken|ad-?libs?)\b[\w\s&'’.,:–—-]{0,40}$/i;
export function isSectionLabel(text) {
  const t = String(text || '').trim().replace(/^[*_\s]+|[*_\s]+$/g, '');
  if (!t) return false;
  if (t.startsWith('[') && t.endsWith(']')) return true;
  const core = t.replace(/^[()[\]{}:\-–—\s]+|[()[\]{}:\-–—\s]+$/g, '').replace(/^[*_\s]+|[*_\s]+$/g, '');
  return LABEL_WORDS.test(core);
}

export function syncedLyrics(lyrics) {
  return (lyrics?.lines || []).filter((l) => l.text && Number.isFinite(l.start) && !isSectionLabel(l.text)).sort((a, b) => a.start - b.start);
}

export function lyricEnd(lines, i) {
  const l = lines[i], next = lines[i + 1];
  let end = Number.isFinite(l.end) && l.end > l.start ? l.end : Math.min(next ? next.start : l.start + 4, l.start + 8);
  if (next) end = Math.min(end, next.start);
  return Math.max(end, l.start + 0.3);
}

// "No punctuation" captions: drop punctuation and symbols (. , ! ? " … * ( ) ۔ ، ؟ emoji…)
// but keep apostrophes inside words, so "don't" stays "don't".
export function plainText(text) {
  return String(text || '')
    .replace(/(\p{L})['’](?=\p{L})/gu, '$1\u0000')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\u0000/g, "'")
    .replace(/\s+/g, ' ').trim();
}

export function lyricChunks(lyrics, clip) {
  const lines = syncedLyrics(lyrics);
  const plain = !!lyrics?.plain;
  const dur = clip.end - clip.start;
  const out = [];
  lines.forEach((l, i) => {
    const end = lyricEnd(lines, i);
    if (end <= clip.start || l.start >= clip.end) return;
    const ws = (plain ? plainText(l.text) : l.text).split(/\s+/).filter(Boolean);
    if (!ws.length) return;
    const total = ws.reduce((n, w) => n + w.length + 1, 0) || 1;
    let t = l.start;
    const span = (end - l.start) * 0.9; // finish the sweep slightly before the line ends
    const words = ws.map((w) => {
      const d = span * (w.length + 1) / total;
      const word = { w, s: Math.max(0, t - clip.start), e: Math.min(dur, t + d - clip.start) };
      t += d;
      return word;
    });
    out.push({ start: Math.max(0, l.start - clip.start), end: Math.min(dur, end - clip.start), abs: { start: l.start, end }, words, lyric: true });
  });
  return out.filter((c) => c.end > c.start);
}

// Caption chunks for a short, from whichever source it uses.
export function clipChunks(project, clip, tpl) {
  if (clip.captions === false) return [];
  if ((clip.caption_source || 'transcript') === 'lyrics') return lyricChunks(project.lyrics, clip);
  if (project.transcript?.status === 'done') return captionChunks(project.transcript, clip, normalize(tpl).captions.maxWords);
  return [];
}

// Right-to-left scripts (Urdu, Arabic, Persian, Hebrew). Like dir="auto", the
// first letter that has a direction decides the direction of the whole caption.
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0900-\u0DFF]/;
export function isRtl(text) {
  for (const ch of text) {
    if (RTL.test(ch)) return true;
    if (LTR.test(ch)) return false;
  }
  return false;
}

// Lay out a chunk: returns lines of {text,x,width} and the block bounds.
// RTL captions place words from the right, so the first word sits on the right.
function layoutCaption(ctx, c, chunk) {
  ctx.font = font(c);
  ctx.textBaseline = 'middle';
  const space = ctx.measureText(' ').width;
  const texts = chunk.words.map((w) => (c.upper ? w.w.toUpperCase() : w.w));
  const maxW = 940;
  const rtl = isRtl(texts.join(' '));
  const lines = [[]];
  let lw = 0;
  // j = "join": a Chinese/Japanese/Korean piece that had no space before it in the transcript
  texts.forEach((t, i) => {
    const m = ctx.measureText(t), w = m.width;
    const gap = chunk.words[i].j ? 0 : space;
    if (lw && lw + gap + w > maxW) { lines.push([]); lw = 0; }
    const first = !lines[lines.length - 1].length;
    lines[lines.length - 1].push({ t, i, w, gap: first ? 0 : gap, up: m.actualBoundingBoxAscent || 0, down: m.actualBoundingBoxDescent || 0 });
    lw += (lw ? gap : 0) + w;
  });
  // Line spacing: the template's lineHeight, but never less than the real ink
  // height of the two lines plus their outline, so tall scripts (Urdu marks
  // above and below) can't overlap the next row.
  const lh = c.size * (c.lineHeight || 1.15);
  const ink = (c.strokeWidth || 0) * 2 + c.size * 0.06;
  const up = lines.map((ln) => Math.max(...ln.map((x) => x.up), c.size * 0.36));
  const down = lines.map((ln) => Math.max(...ln.map((x) => x.down), c.size * 0.12));
  const ys = new Array(lines.length);
  // captions.y is the LAST line: extra lines stack upward, so a long (or Urdu) line
  // never pushes down into the links below
  ys[lines.length - 1] = c.y;
  for (let li = lines.length - 2; li >= 0; li--) ys[li] = ys[li + 1] - Math.max(lh, down[li] + up[li + 1] + ink);
  const out = lines.map((ln, li) => {
    const total = ln.reduce((n, x) => n + x.w + x.gap, 0);
    const y = ys[li];
    if (rtl) {
      let x = W / 2 + total / 2;
      return ln.map((x0) => { x -= x0.gap + x0.w; return { ...x0, x, y }; });
    }
    let x = W / 2 - total / 2;
    return ln.map((x0) => { x += x0.gap; const r = { ...x0, x, y }; x += x0.w; return r; });
  }).flat();
  const pad = (c.strokeWidth || 0) + (c.box ? c.size * 0.35 : 4);
  const minX = Math.min(...out.map((o) => o.x)) - pad, maxX = Math.max(...out.map((o) => o.x + o.w)) + pad;
  // real glyph extents: Urdu/Arabic letters and marks reach well past the font size
  const minY = Math.min(...out.map((o) => o.y - Math.max(o.up, c.size * 0.62))) - pad;
  const maxY = Math.max(...out.map((o) => o.y + Math.max(o.down, c.size * 0.62))) + pad;
  return { words: out, rtl, lines: lines.length, bounds: { x: Math.floor(minX), y: Math.floor(minY), w: Math.ceil(maxX - minX), h: Math.ceil(maxY - minY) } };
}

export function drawCaption(ctx, tpl, chunk, activeIndex, dx = 0, dy = 0) {
  const c = normalize(tpl).captions;
  const lay = layoutCaption(ctx, c, chunk);
  ctx.save();
  ctx.translate(-dx, -dy);
  if (c.box) {
    const b = lay.bounds;
    ctx.fillStyle = c.box;
    roundRect(ctx, b.x, b.y, b.w, b.h, c.size * 0.25); ctx.fill();
  }
  ctx.font = font(c);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.direction = lay.rtl ? 'rtl' : 'ltr';
  ctx.lineJoin = 'round';
  for (const w of lay.words) {
    if (c.stroke && c.strokeWidth) {
      ctx.strokeStyle = c.stroke; ctx.lineWidth = c.strokeWidth * 2;
      ctx.strokeText(w.t, w.x, w.y);
    }
    ctx.fillStyle = w.i === activeIndex && c.active ? c.active : c.color;
    ctx.fillText(w.t, w.x, w.y);
  }
  ctx.restore();
  return lay.bounds;
}

// Which caption image is on screen at clip-relative time t.
export function captionAt(chunks, t, tpl) {
  const c = normalize(tpl).captions;
  for (const ch of chunks) {
    if (t >= ch.start && t < ch.end) {
      let active = -1;
      if (c.active) {
        active = 0;
        ch.words.forEach((w, i) => { if (t >= w.s) active = i; });
      }
      return { chunk: ch, active };
    }
  }
  return null;
}

// Timed caption images for export: one per (chunk, active word) state.
export function captionStates(chunks, tpl) {
  const c = normalize(tpl).captions;
  const out = [];
  for (const ch of chunks) {
    if (!c.active) { out.push({ chunk: ch, active: -1, start: ch.start, end: ch.end }); continue; }
    ch.words.forEach((w, i) => {
      const start = i === 0 ? ch.start : w.s;
      const end = i === ch.words.length - 1 ? ch.end : ch.words[i + 1].s;
      if (end > start) out.push({ chunk: ch, active: i, start, end });
    });
  }
  return out;
}

// ---------- live composite (preview & thumbnails) ----------

const blurCanvas = document.createElement('canvas');
blurCanvas.width = W / 4; blurCanvas.height = H / 4;

export function drawBlurBase(ctx, tpl, frame, fw, fh) {
  const t = normalize(tpl);
  const b = blurCanvas.getContext('2d');
  b.filter = `blur(${t.bg.blur.sigma}px) brightness(${Math.max(0.1, 1 + t.bg.blur.brightness * 1.6)}) saturate(1.15)`;
  b.fillStyle = '#000'; b.fillRect(0, 0, blurCanvas.width, blurCanvas.height);
  if (frame) drawCover(b, frame, fw, fh, -20, -20, blurCanvas.width + 40, blurCanvas.height + 40);
  b.filter = 'none';
  ctx.drawImage(blurCanvas, 0, 0, W, H);
}

export function drawVideoFrame(ctx, tpl, meta, frame, fw, fh) {
  const t = normalize(tpl), box = videoBox(t, meta);
  ctx.save();
  roundRect(ctx, box.x, box.y, box.w, box.h, t.video.radius); ctx.clip();
  if (frame) ctx.drawImage(frame, box.x, box.y, box.w, box.h);
  else {
    const g = ctx.createLinearGradient(box.x, box.y, box.x + box.w, box.y + box.h);
    g.addColorStop(0, '#3a3f4b'); g.addColorStop(1, '#16181d');
    ctx.fillStyle = g; ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  ctx.restore();
}

export function newCanvas(w = W, h = H) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Where each element sits (top/bottom in 1080x1920 pixels), for the AI chat:
// it can see overlaps and move things without guessing. Captions use the
// tallest caption in the short.
export function layoutBoxes(tpl, meta, brand, title, chunks) {
  const t = normalize(tpl);
  const ctx = newCanvas(8, 8).getContext('2d');
  const boxes = {};
  const v = videoBox(t, meta);
  boxes.video = { top: v.y, bottom: v.y + v.h };
  const ti = t.title;
  if (ti.show && title) {
    let size = ti.size, lines;
    const text = (ti.prefix || '') + (ti.upper ? title.toUpperCase() : title);
    for (;;) { ctx.font = font(ti, size); lines = wrap(ctx, text, ti.maxWidth); if (lines.length <= 3 || size < 30) break; size -= 4; }
    const h = lines.length * titleLineHeight(ctx, lines, size, ti) + (ti.box ? size * 0.8 : 0);
    boxes.title = { top: Math.round(ti.y - h / 2), bottom: Math.round(ti.y + h / 2), lines: lines.length };
  }
  const ch = t.channel;
  if (ch.show && brand && (brand.channel || brand.handle || brand.logo)) {
    const h = Math.max(ch.logo && brand.logo ? ch.logoSize : 0, brand.channel && brand.handle ? ch.size * 1.9 : ch.size * 1.2);
    boxes.channel = { top: Math.round(ch.y - h / 2), bottom: Math.round(ch.y + h / 2) };
  }
  const li = t.links;
  const n = li.show && brand ? (li.cta && brand.cta ? 1 : 0) + (brand.links || []).filter(Boolean).length : 0;
  if (n) {
    const lh = li.size * 1.5;
    boxes.links = { top: Math.round(li.y - lh / 2), bottom: Math.round(li.y + (Math.min(n, 4) - 1) * (lh + 6) + lh / 2), rows: Math.min(n, 4) };
  }
  if (chunks?.length) {
    let top = Infinity, bottom = -Infinity, lines = 1;
    for (const chunk of chunks) {
      const lay = layoutCaption(ctx, t.captions, chunk), b = lay.bounds;
      top = Math.min(top, b.y); bottom = Math.max(bottom, b.y + b.h);
      lines = Math.max(lines, lay.lines);
    }
    boxes.captions = { top: Math.round(top), bottom: Math.round(bottom), maxLines: lines };
  }
  const names = Object.keys(boxes), overlaps = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = boxes[names[i]], b = boxes[names[j]];
    const o = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (o > 0 && !(names[i] === 'video' || names[j] === 'video')) overlaps.push(`${names[i]} and ${names[j]} overlap by ${o}px`);
    else if (o > 0) overlaps.push(`${names[i] === 'video' ? names[j] : names[i]} covers the video by ${o}px`);
  }
  return { boxes, overlaps };
}
