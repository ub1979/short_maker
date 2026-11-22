// Mouse editing on the 9:16 preview: hover to see an element, drag it up or
// down, A−/A+ to resize, double-click to edit its text. Everything is centred
// horizontally in the templates, so moving is vertical only.
// Changes are per-short tweaks (clip.overrides), same as the Template tab.
import { layoutBoxes, clipChunks, W, H } from './render.js';
import { getPath, SCHEMA } from './design.js';
import { esc } from './util.js';

const RANGE = new Map(SCHEMA.flatMap((g) => g.fields).filter((f) => f[2] === 'range').map((f) => [f[0], f[3]]));

const EL = {
  captions: { label: 'Captions', y: 'captions.y', size: 'captions.size', step: 4, lh: 'captions.lineHeight', edit: 'Edit text' },
  title: { label: 'Title', y: 'title.y', size: 'title.size', step: 4, lh: 'title.lineHeight', edit: 'Edit title' },
  channel: { label: 'Channel', y: 'channel.y', size: 'channel.size', step: 3, edit: 'Edit name' },
  links: { label: 'Links', y: 'links.y', size: 'links.size', step: 2, edit: 'Edit links' },
  video: { label: 'Video', y: 'video.y', size: 'video.width', step: 40, edit: null },
};
const ORDER = ['captions', 'title', 'channel', 'links', 'video']; // hit-test priority

let ctx; // { S, selClip, effective, onChange, editTitle, editBrand, editCaption }
let canvas, layer, outlines; // outlines: redrawn on every mouse move; the title editor lives beside it
let inline = null;  // open title editor: { close(save) }
let hover = null, picked = null, drag = null;
let cache = { key: '', boxes: {} };

export function initStageEdit(c) {
  ctx = c;
  canvas = document.getElementById('preview');
  layer = document.getElementById('editLayer');
  outlines = document.createElement('div');
  layer.appendChild(outlines);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; paint(); } });
  canvas.addEventListener('pointerdown', (e) => { if (inline) { inline.close(true); return; } onDown(e); });
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('dblclick', onDbl);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picked && !e.target.closest?.('input,textarea')) { picked = null; paint(); }
  });
}

// Call when the selected short, its template or the brand changes.
export function refreshStageEdit() {
  if (inline && inline.clipId !== ctx?.selClip()?.id) inline.close(true); // switched short: save and close
  cache.key = '';
  if (!ctx?.selClip()) { hover = picked = null; drag = null; }
  paint();
}

function boxes() {
  const c = ctx.selClip();
  if (!c) return {};
  const tpl = ctx.effective(c);
  const S = ctx.S;
  const key = JSON.stringify([c.id, tpl, S.brand, c.title, c.start, c.end, c.caption_source, c.captions, S.trVersion, S.lyVersion, S.project.transcript?.status]);
  if (cache.key !== key) {
    const title = c.title || S.project.name;
    const chunks = c.captions === false ? [] : clipChunks(S.project, c, tpl);
    cache = { key, boxes: layoutBoxes(tpl, S.project.source, S.brand, title, chunks).boxes };
  }
  return cache.boxes;
}

const toCanvas = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H, scale: r.height / H };
};

function hit(p) {
  const b = boxes();
  for (const name of ORDER) {
    const box = b[name];
    if (!box) continue;
    const slack = name === 'video' ? 0 : 14;
    if (p.y >= box.top - slack && p.y <= box.bottom + slack) return name;
  }
  return null;
}

function onMove(e) {
  if (drag) {
    const p = toCanvas(e);
    const [lo, hi] = RANGE.get(EL[drag.name].y);
    const v = Math.round(Math.max(lo, Math.min(hi, drag.base + (p.y - drag.startY))) / 2) * 2;
    if (v !== drag.value) { drag.value = v; set(EL[drag.name].y, v, false); }
    drag.moved = drag.moved || Math.abs(p.y - drag.startY) > 3;
    paint();
    return;
  }
  const h = ctx.selClip() ? hit(toCanvas(e)) : null;
  if (h !== hover) { hover = h; paint(); }
}

function onDown(e) {
  if (e.button !== 0 || !ctx.selClip()) return;
  const p = toCanvas(e);
  const name = hit(p);
  picked = name;
  if (name) {
    const tpl = ctx.effective(ctx.selClip());
    drag = { name, startY: p.y, base: getPath(tpl, EL[name].y), value: null, moved: false };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  paint();
}

function onUp() {
  if (drag?.moved) ctx.onChange(true);
  drag = null;
  paint();
}

function onDbl(e) {
  const name = hit(toCanvas(e));
  if (name) edit(name);
}

function edit(name) {
  if (name === 'title') editTitleInline();
  else if (name === 'channel' || name === 'links') ctx.editBrand();
  else if (name === 'captions') ctx.editCaption();
}

function set(path, value, done) {
  ctx.apply(path, value); // to this short or all shorts, per the "Edits apply to" switch
  cache.key = '';
  ctx.onChange(done);
}

function spacing(name, dir) {
  const path = EL[name].lh;
  const [lo, hi] = RANGE.get(path);
  const cur = getPath(ctx.effective(ctx.selClip()), path) || 1.15;
  set(path, Math.round(Math.max(lo, Math.min(hi, cur + dir * 0.1)) * 100) / 100, true);
  paint();
}

function resize(name, dir) {
  const el = EL[name];
  const [lo, hi] = RANGE.get(el.size);
  const cur = getPath(ctx.effective(ctx.selClip()), el.size);
  set(el.size, Math.max(lo, Math.min(hi, cur + dir * el.step)), true);
  paint();
}

// Title: edit right on the preview.
function editTitleInline() {
  const c = ctx.selClip();
  const b = boxes().title;
  const r = canvas.getBoundingClientRect(), scale = r.height / H;
  const top = b ? b.top * scale : 60;
  inline?.close(true);
  const ta = document.createElement('textarea');
  ta.className = 'inline-edit';
  ta.value = c.title || '';
  ta.placeholder = 'Title on the short';
  ta.style.top = `${Math.max(4, top - 6)}px`;
  layer.appendChild(ta);
  ta.focus(); ta.select();
  let closed = false;
  const close = (save) => {
    if (closed) return;
    closed = true;
    inline = null;
    const v = ta.value.trim();
    ta.remove();
    if (save && v !== (c.title || '')) ctx.editTitle(v, c.id); // the short it was opened on
    paint();
  };
  inline = { close, clipId: c.id };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); close(true); }
    if (e.key === 'Escape') close(false);
  });
  ta.addEventListener('blur', () => close(true));
}

// Outline + label for hover, handles + toolbar for the picked element.
function paint() {
  if (!layer) return;
  const c = ctx.selClip();
  const b = c ? boxes() : {};
  const r = canvas.getBoundingClientRect();
  const scale = r.height / H || 0;
  const parts = [];
  for (const name of new Set([hover, picked].filter(Boolean))) {
    const box = b[name];
    if (!box) continue;
    const on = name === picked;
    const top = box.top * scale, h = (box.bottom - box.top) * scale;
    const y = getPath(ctx.effective(c), EL[name].y);
    parts.push(`<div class="ebox ${on ? 'on' : ''}" style="top:${top}px;height:${h}px">
      <span class="etag">${EL[name].label}${on || drag ? ` · y ${Math.round(y)}` : ''}${on && ctx.S.applyAll && ctx.S.project.clips.length > 1 ? ' · all shorts' : ''}</span></div>`);
    if (on && !drag) {
      const below = top + h + 40 < r.height;
      parts.push(`<div class="etools" style="top:${below ? top + h + 6 : Math.max(4, top - 36)}px" data-el="${name}">
        <button data-act="smaller" title="Smaller">A&minus;</button><button data-act="bigger" title="Bigger">A+</button>
        ${EL[name].lh ? '<button data-act="lhless" title="Lines closer together">&#8597;&minus;</button><button data-act="lhmore" title="More space between lines">&#8597;+</button>' : ''}
        ${EL[name].edit ? `<button data-act="edit">${esc(EL[name].edit)}</button>` : ''}
        <button data-act="reset" title="Back to the template's position and size">Reset</button></div>`);
    }
  }
  outlines.innerHTML = parts.join('');
  canvas.style.cursor = drag ? 'grabbing' : hover ? 'grab' : '';
  outlines.querySelector('.etools')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const name = e.currentTarget.dataset.el;
    if (btn.dataset.act === 'smaller') resize(name, -1);
    else if (btn.dataset.act === 'bigger') resize(name, 1);
    else if (btn.dataset.act === 'lhless') spacing(name, -1);
    else if (btn.dataset.act === 'lhmore') spacing(name, 1);
    else if (btn.dataset.act === 'edit') edit(name);
    else if (btn.dataset.act === 'reset') resetEl(name);
  });
}

function resetEl(name) {
  for (const path of [EL[name].y, EL[name].size, EL[name].lh].filter(Boolean)) ctx.apply(path, undefined);
  cache.key = '';
  ctx.onChange(true);
  paint();
}
