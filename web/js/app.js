import { api, esc, toast, fmt, parseTime, debounce, uploadFile } from './util.js';
import { BUILTIN, normalize, deepMerge, clone } from './templates.js';
import {
  W, H, newCanvas, resolveAssets, drawUnder, drawOver, drawBlurBase, drawVideoFrame,
  captionChunks, captionAt, drawCaption, clipChunks, syncedLyrics, layoutBoxes,
} from './render.js';
import { buildRenderForm } from './export.js';
import { renderDesignForm, setPath, getPath, SCHEMA } from './design.js';
import { openSettings, activeConnectionLabel } from './settings.js';
import { initLyrics, resetLyricsView, renderLyrics, highlightLyrics, lyricsKey, autoState, focusLyricAt } from './lyrics.js';
import { initStageEdit, refreshStageEdit } from './stage-edit.js';

const $ = (id) => document.getElementById(id);
const S = {
  project: null,
  brand: null,
  custom: [],
  selected: null,
  chat: [],
  clipPlay: false,
  safe: 'none',
  dirty: true,
  lyVersion: 0,
};
const video = $('video');
const preview = $('preview');
const pctx = preview.getContext('2d');

// ---------------- templates ----------------
const allTemplates = () => [...BUILTIN, ...S.custom];
const getTemplate = (id) => allTemplates().find((t) => t.id === id) || BUILTIN[0];
const clipById = (id) => S.project?.clips.find((c) => c.id === id);
const selClip = () => clipById(S.selected);
function effective(clip) {
  return deepMerge(normalize(getTemplate(clip.template_id)), clip.overrides || {});
}

// ---------------- routing ----------------
async function boot() {
  [S.brand, S.custom] = await Promise.all([api('/api/brand'), api('/api/templates')]);
  wireStatic();
  const m = location.hash.match(/^#p\/([a-z0-9]+)/);
  if (m) openProject(m[1]).catch(() => showHome());
  else showHome();
  requestAnimationFrame(loop);
  setInterval(poll, 1500);
}

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#p\/([a-z0-9]+)/);
  if (m && m[1] !== S.project?.id) openProject(m[1]);
  if (!m && S.project) showHome();
});

async function showHome() {
  S.project = null; S.selected = null;
  video.pause(); video.removeAttribute('src'); video.load();
  $('editor').hidden = true; $('home').hidden = false;
  $('crumb').innerHTML = '';
  if (location.hash) history.replaceState(null, '', location.pathname);
  const list = await api('/api/projects');
  const grid = $('projectGrid');
  if (!list.length) { grid.innerHTML = '<div class="empty">No videos yet. Drop one above to start.</div>'; return; }
  grid.innerHTML = list.map((p, i) => `
    <div class="pcard" data-id="${p.id}" style="animation-delay:${i * 40}ms">
      <video src="/media/${p.id}/play#t=${Math.min(5, (p.source?.duration || 10) / 3)}" preload="metadata" muted></video>
      <div class="pmeta"><div><strong>${esc(p.name)}</strong><div class="mono dim">${fmt(p.source?.duration, 0)} · ${p.clips} short${p.clips === 1 ? '' : 's'}</div></div>
      <button class="del" title="Delete">✕</button></div>
    </div>`).join('');
  grid.querySelectorAll('.pcard').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.del')) return;
      openProject(el.dataset.id);
    };
    el.querySelector('.del').onclick = async () => {
      if (!confirm('Delete this video and all its shorts? This cannot be undone.')) return;
      await api(`/api/projects/${el.dataset.id}`, { method: 'DELETE' });
      showHome();
    };
  });
}

async function openProject(id) {
  S.project = await api(`/api/projects/${id}`);
  S.project.lyrics ||= { lines: [] };
  S.chat = [];
  resetLyricsView();
  autoState();
  $('chatLog').innerHTML = '';
  location.hash = `p/${id}`;
  $('home').hidden = true; $('editor').hidden = false;
  $('crumb').innerHTML = `<input id="projName" value="${esc(S.project.name)}" title="Rename">`;
  $('projName').onchange = (e) => api(`/api/projects/${id}`, { method: 'PATCH', body: { name: e.target.value } });
  const src = S.project.source;
  $('srcMeta').textContent = `${src.width}×${src.height} · ${fmt(src.duration, 0)} · ${src.fps}fps`;
  loadVideo();
  S.selected = S.project.clips[0]?.id || null;
  renderAll();
  if (S.selected) seek(selClip().start);
}

function loadVideo() {
  const st = S.project.status || {};
  const msg = $('playerMsg');
  if (st.proxy === 'working') {
    msg.hidden = false;
    msg.textContent = `Preparing a preview copy… ${Math.round((st.proxy_progress || 0) * 100)}%`;
    return;
  }
  if (st.proxy === 'error') { msg.hidden = false; msg.textContent = 'Could not prepare this video: ' + st.proxy_error; return; }
  msg.hidden = true;
  const url = `/media/${S.project.id}/play?v=${S.project.proxy ? 'p' : 's'}`;
  if (!video.src.endsWith(url)) { video.src = url; }
}

// ---------------- upload ----------------
async function handleFile(file) {
  if (!file) return;
  const bar = $('upbar');
  bar.hidden = false;
  const setP = (p, txt) => { bar.querySelector('i').style.width = `${p * 100}%`; bar.querySelector('em').textContent = txt; };
  try {
    const p = await uploadFile('/api/projects', file, 'file', (x) => setP(x, x < 1 ? `Uploading ${Math.round(x * 100)}%` : 'Reading video…'));
    bar.hidden = true;
    await openProject(p.id);
    toast('Video ready. Press Transcribe or make your first short.');
  } catch (e) {
    bar.hidden = true;
    toast(e.message, true);
  }
}

// ---------------- render UI ----------------
function renderAll() {
  renderClips();
  renderTimeline();
  renderTranscript();
  renderInspector();
  S.dirty = true;
}

function renderClips() {
  renderApplySeg();
  const list = $('clipList');
  const clips = S.project.clips;
  list.innerHTML = clips.length ? clips.map((c, i) => `
    <div class="clipcard ${c.id === S.selected ? 'on' : ''}" data-id="${c.id}">
      <span class="n">#${c.num ?? i + 1}</span>
      <span class="st ${c.render?.status || ''}"></span>
      <div><div class="t">${esc(c.title || 'Untitled short')}</div><div class="s">${fmt(c.start, 0)}–${fmt(c.end, 0)} · ${Math.round(c.end - c.start)}s</div></div>
    </div>`).join('') : '<span class="dim" style="font-size:13px">No shorts yet. Mark a range on the timeline or ask the AI.</span>';
  list.querySelectorAll('.clipcard').forEach((el) => { el.onclick = () => selectClip(el.dataset.id, true); });
}

function selectClip(id, seekTo) {
  S.selected = id;
  S.clipPlay = false;
  renderClips(); renderTimeline(); renderInspector(); highlightTranscript(); refreshStageEdit();
  const c = selClip();
  if (c && seekTo) seek(c.start);
  S.dirty = true;
}

function renderTimeline() {
  const dur = S.project.source.duration || 1;
  $('tlClips').innerHTML = S.project.clips.map((c, i) => `
    <div class="tl-clip ${c.id === S.selected ? 'on' : ''}" data-id="${c.id}" style="left:${(c.start / dur) * 100}%;width:${((c.end - c.start) / dur) * 100}%">
      <span class="lbl">${c.num ?? i + 1}</span>
      ${c.id === S.selected ? '<div class="h l" data-h="start"></div><div class="h r" data-h="end"></div>' : ''}
    </div>`).join('');
}

function renderTranscript() {
  const tr = S.project.transcript || {};
  const box = $('transcript');
  const btn = $('transcribeBtn');
  btn.disabled = tr.status === 'working';
  btn.textContent = tr.status === 'done' ? 'Re-transcribe' : 'Transcribe';
  if (tr.status === 'working') {
    const secs = Math.round(Date.now() / 1000 - (tr.started || Date.now() / 1000));
    box.innerHTML = `<div class="tr-empty"><span class="spin"></span>Transcribing on this Mac… ${secs}s<br><span class="mono" style="font-size:11px">First run downloads the Whisper model.</span></div>`;
    return;
  }
  if (tr.status === 'error') { box.innerHTML = `<div class="tr-empty" style="color:var(--red)">${esc(tr.error)}</div>`; return; }
  if (tr.status !== 'done') {
    box.innerHTML = '<div class="tr-empty">Transcribe to get captions, searchable text, and AI-picked moments.</div>';
    return;
  }
  const q = $('trSearch').value.trim().toLowerCase();
  const segs = tr.segments.filter((s) => !q || s.text.toLowerCase().includes(q));
  box.innerHTML = segs.map((s) => {
    let text = esc(s.text);
    if (q) text = text.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
    return `<div class="seg-line" data-s="${s.start}" data-e="${s.end}"><span class="ts">${fmt(s.start, 0)}</span><span class="t">${text}</span><button class="add" title="New short starting here">+ short</button></div>`;
  }).join('') || '<div class="tr-empty">No matches.</div>';
  box.querySelectorAll('.seg-line').forEach((el) => {
    el.onclick = (e) => {
      const s = +el.dataset.s;
      if (e.target.closest('.add')) { newClipAt(s); return; }
      seek(s);
    };
  });
  highlightTranscript();
  $('capNote').textContent = '';
}

function highlightTranscript() {
  const t = video.currentTime;
  const c = selClip();
  document.querySelectorAll('.seg-line').forEach((el) => {
    const s = +el.dataset.s, e = +el.dataset.e;
    el.classList.toggle('now', t >= s && t < e);
    el.classList.toggle('inclip', !!c && e > c.start && s < c.end);
  });
}

function renderInspector() {
  const c = selClip();
  $('emptyStage').hidden = !!c;
  $('clipTimes').style.visibility = c ? 'visible' : 'hidden';
  $('renderBox').style.visibility = c ? 'visible' : 'hidden';
  document.querySelectorAll('.inspector .tab').forEach((t) => t.style.opacity = c ? 1 : 0.4);
  if (!c) { $('tplGrid').innerHTML = ''; return; }
  const typing = (id) => document.activeElement === $(id);
  if (!typing('cTitle')) $('cTitle').value = c.title || '';
  $('cCaptions').checked = c.captions !== false;
  updateCapNote();
  if (!typing('cStart')) $('cStart').value = fmt(c.start);
  if (!typing('cEnd')) $('cEnd').value = fmt(c.end);
  $('cDur').textContent = `${(c.end - c.start).toFixed(1)}s`;
  renderRender();
  renderCaptionEditor();
  renderTemplates();
  renderDesign();
  renderPost();
}

function updateCapNote() {
  const c = selClip();
  if (!c) return;
  const src = c.caption_source || 'transcript';
  $('capSrc').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === src));
  $('capSrc').hidden = c.captions === false;
  let note = '';
  if (src === 'lyrics') {
    const n = syncedLyrics(S.project.lyrics).length;
    note = n ? '' : '(add & sync lines in My lyrics)';
  } else if (S.project.transcript?.status !== 'done') note = '(needs transcript)';
  $('capNote').textContent = note;
}

// ---------- caption text editor ----------
S.trVersion = 0;
function renderCaptionEditor() {
  const c = selClip();
  const box = $('capEdit');
  const tr = S.project.transcript || {};
  if (!c || tr.status !== 'done' || c.captions === false || c.caption_source === 'lyrics') { box.hidden = true; return; }
  if (box.contains(document.activeElement)) return; // don't wipe a line being typed
  const tpl = effective(c);
  const chunks = captionChunks(tr, c, tpl.captions.maxWords);
  const edited = new Set(tr.segments.filter((sg) => sg.edited).map((sg) => sg.start));
  box.hidden = false;
  $('capCount').textContent = `(${chunks.length})`;
  $('capList').innerHTML = chunks.map((ch, i) => {
    const seg = tr.segments.find((sg) => ch.abs.start >= sg.start - 0.01 && ch.abs.end <= sg.end + 0.5);
    return `<div class="caprow ${seg && edited.has(seg.start) ? 'edited' : ''}" data-i="${i}" data-s="${ch.abs.start}" data-e="${ch.abs.end}" data-rel="${ch.start}">
      <span class="ts" title="Jump here">${fmt(ch.start, 1)}</span><input value="${esc(ch.words.map((w) => w.w).join(' '))}"></div>`;
  }).join('') || '<div class="dim" style="padding:8px">No speech in this short.</div>';
  $('capList').querySelectorAll('.caprow').forEach((row) => {
    const inp = row.querySelector('input');
    const original = inp.value;
    row.querySelector('.ts').onclick = () => seek(c.start + +row.dataset.rel + 0.01);
    inp.onfocus = () => { S.clipPlay = false; video.pause(); seek(c.start + +row.dataset.rel + 0.01); };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.value = original; inp.blur(); }
    };
    inp.onblur = async () => {
      const text = inp.value.trim().replace(/\s+/g, ' ');
      if (text === original) return;
      try {
        const seg = await api(`/api/projects/${S.project.id}/transcript/words`, {
          method: 'PUT', body: { start: +row.dataset.s, end: +row.dataset.e, text },
        });
        const segs = S.project.transcript.segments;
        const k = segs.findIndex((x) => x.start === seg.start);
        if (k >= 0) segs[k] = seg;
        S.trVersion++;
        S.dirty = true;
        renderTranscript();
        renderCaptionEditor();
        const again = $('capList').querySelector(`.caprow[data-i="${row.dataset.i}"]`);
        if (again) { again.classList.add('saved'); setTimeout(() => again.classList.remove('saved'), 900); }
      } catch (e) { toast(e.message, true); inp.value = original; }
    };
  });
}

function highlightCaptionRow() {
  const c = selClip();
  if (!c || $('capEdit').hidden || !$('capEdit').open) return;
  const t = video.currentTime - c.start;
  const rows = [...$('capList').querySelectorAll('.caprow')];
  let cur = null;
  for (const r of rows) if (t >= +r.dataset.rel - 0.01) cur = r;
  rows.forEach((r) => r.classList.toggle('now', r === cur));
}

function renderRender() {
  const c = selClip();
  if (!c) return;
  const r = c.render || {};
  const st = $('rStatus');
  const btn = $('renderBtn');
  const dir = S.project.output_dir;
  $('saveDir').innerHTML = dir
    ? `Saves to <b title="${esc(dir)}">${esc(dir.replace(/^\/Users\/[^/]+/, '~'))}</b> · <button class="link" data-act="change">Change</button> · <button class="link" data-act="open">Open folder</button>`
    : `You'll be asked where to save the first time you render. <button class="link" data-act="change">Choose now</button>`;
  btn.disabled = r.status === 'queued' || r.status === 'rendering';
  btn.textContent = r.status === 'done' ? 'Render again' : 'Render short';
  if (r.status === 'queued' || r.status === 'rendering') {
    st.innerHTML = `${r.status === 'queued' ? 'Queued' : 'Rendering'}… ${Math.round((r.progress || 0) * 100)}%<div class="bar"><i style="width:${(r.progress || 0) * 100}%"></i></div>`;
  } else if (r.status === 'done') {
    const url = `/media/${S.project.id}/render/${c.id}`;
    st.innerHTML = `✓ Saved as <b>${esc(r.file)}</b> · <a href="${url}" target="_blank">Watch</a><div class="dim mono" style="margin-top:4px;font-size:11px">1080×1920 H.264 — works for Shorts, Reels and TikTok</div>`;
  } else if (r.status === 'error') {
    st.innerHTML = `<span class="err">Render failed: ${esc(r.error)}</span>`;
  } else st.innerHTML = '';
}

// ---------- template grid with live thumbnails ----------
let thumbToken = 0;
async function renderTemplates() {
  const c = selClip();
  const grid = $('tplGrid');
  const token = ++thumbToken;
  grid.innerHTML = allTemplates().map((t) => `
    <button class="tpl ${t.id === c.template_id ? 'on' : ''}" data-id="${t.id}" title="${esc(t.look || t.name)}">
      <canvas width="216" height="384"></canvas><span>${esc(t.name)}${t.builtin === false ? '<em class="own">yours</em>' : ''}</span>
    </button>`).join('');
  grid.querySelectorAll('.tpl').forEach((el) => { el.onclick = () => setTemplate(el.dataset.id); });
  for (const el of grid.querySelectorAll('.tpl')) {
    if (token !== thumbToken) return;
    const tpl = el.dataset.id === c.template_id ? effective(c) : normalize(getTemplate(el.dataset.id));
    await drawThumb(el.querySelector('canvas'), tpl, c);
  }
}

async function drawThumb(canvas, tpl, clip) {
  const assets = await resolveAssets(tpl, S.brand);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  const frame = video.readyState >= 2 ? video : null;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (tpl.bg.type === 'blur') drawBlurBase(ctx, tpl, frame, video.videoWidth, video.videoHeight);
  drawUnder(ctx, tpl, S.project.source, assets);
  drawVideoFrame(ctx, tpl, S.project.source, frame, video.videoWidth, video.videoHeight);
  drawOver(ctx, tpl, S.project.source, assets, S.brand, clip.title || S.project.name);
}

async function setTemplate(id) {
  const c = selClip();
  if (!c || c.template_id === id) return;
  const keep = layoutOnly(c.overrides);
  const dropped = JSON.stringify(c.overrides || {}) !== JSON.stringify(keep);
  await patchClip(c.id, { template_id: id, overrides: keep });
  if (dropped) toast('Switched template. Your positions and sizes were kept; colour and style tweaks were cleared.');
}

// ---------- design tab ----------
function renderDesign() {
  const c = selClip();
  if (!c) return;
  const base = getTemplate(c.template_id);
  const tpl = effective(c);
  const own = base.builtin === false;
  $('tplName').value = own ? base.name : `${base.name} (my version)`;
  $('updateTpl').hidden = !own;
  $('deleteTpl').hidden = !own;
  renderDesignForm($('designForm'), tpl, {
    onChange: (path, value, rerender) => {
      applyOverride(path, value);
      if (rerender || path === 'bg.type') renderDesign();
    },
    onUploadImage: () => pickBgImage(false),
  });
}

// ---------- design edits: this short or all shorts ----------
// Edits go to every short by default, so a caption you move stays moved on all
// of them. The switch above the preview limits them to the selected short.
S.applyAll = (() => { try { return localStorage.getItem('sm.applyAll') !== '0'; } catch { return true; } })();
const unsaved = new Set(); // clip ids whose overrides changed but aren't saved yet

function editTargets() {
  const c = selClip();
  if (!c) return [];
  return S.applyAll ? S.project.clips : [c];
}

function delPath(obj, path) {
  const keys = path.split('.');
  const parents = [];
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (!o?.[k] || typeof o[k] !== 'object') return; parents.push([o, k]); o = o[k]; }
  delete o[keys[keys.length - 1]];
  for (const [p, k] of parents.reverse()) if (!Object.keys(p[k]).length) delete p[k];
}

// value === undefined removes the tweak (back to the template's value).
function applyOverride(path, value) {
  for (const c of editTargets()) {
    c.overrides = c.overrides || {};
    if (value === undefined) delPath(c.overrides, path);
    else if (path.startsWith('bg.stops')) {
      // arrays replace wholesale in deepMerge, so edit a full copy of the stops
      const stops = clone(effective(c).bg.stops);
      while (stops.length < 3) stops.push(stops[stops.length - 1] || '#000000');
      stops[+path.split('.')[2]] = value;
      setPath(c.overrides, 'bg.stops', stops);
    } else setPath(c.overrides, path, value);
    unsaved.add(c.id);
  }
  S.dirty = true;
  saveOverrides();
}

const saveOverrides = debounce(() => {
  for (const id of unsaved) {
    const c = clipById(id);
    if (c) api(`/api/projects/${S.project.id}/clips/${id}`, { method: 'PATCH', body: { overrides: c.overrides } });
  }
  unsaved.clear();
  thumbsLater();
}, 500);

// Position/size/spacing tweaks: kept when a short switches template or a new short is made.
const LAYOUT_KEY = /^(title|channel|links|captions|video)\.(y|size|lineHeight|width)$/;
function layoutOnly(over) {
  const out = {};
  for (const [g, v] of Object.entries(over || {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const [k, x] of Object.entries(v)) if (LAYOUT_KEY.test(`${g}.${k}`)) setPath(out, `${g}.${k}`, x);
  }
  return out;
}

function renderApplySeg() {
  const seg = $('applySeg');
  seg.hidden = !S.project || S.project.clips.length < 2;
  seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'all') === S.applyAll));
}
const thumbsLater = debounce(() => renderTemplates(), 800);

async function saveTemplate(asNew) {
  const c = selClip();
  if (!c) return;
  const base = getTemplate(c.template_id);
  const tpl = effective(c);
  tpl.name = $('tplName').value.trim() || 'My template';
  tpl.look = tpl.look || 'custom template';
  if (asNew || base.builtin !== false) delete tpl.id; else tpl.id = base.id;
  const saved = await api('/api/templates', { method: 'POST', body: tpl });
  S.custom = await api('/api/templates');
  await patchClip(c.id, { template_id: saved.id, overrides: {} });
  toast(`Saved template “${saved.name}”`);
}

async function pickBgImage(makeNew) {
  const inp = $('bgFile');
  inp.value = '';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    try {
      const { url } = await uploadFile('/api/assets', file, 'file');
      const c = selClip();
      if (makeNew) {
        const tpl = deepMerge(effective(c), { bg: { type: 'image', image: url, tint: 'rgba(0,0,0,0)', pattern: 'none', vignette: 0 } });
        delete tpl.id;
        tpl.name = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'My background';
        tpl.look = 'custom background image';
        const saved = await api('/api/templates', { method: 'POST', body: tpl });
        S.custom = await api('/api/templates');
        await patchClip(c.id, { template_id: saved.id, overrides: {} });
        switchTab('design');
        toast('Template created. Move the video box and text to fit your image.');
      } else {
        c.overrides = deepMerge(c.overrides || {}, { bg: { type: 'image', image: url } });
        await patchClip(c.id, { overrides: c.overrides });
      }
    } catch (e) { toast(e.message, true); }
  };
  inp.click();
}

// ---------- post text tab ----------
const PLATFORMS = [
  { id: 'youtube', name: 'YouTube Shorts', max: 180, titleMax: 100, descMax: 5000 },
  { id: 'instagram', name: 'Instagram Reels', max: 180, descMax: 2200 },
  { id: 'tiktok', name: 'TikTok', max: 600, descMax: 4000 },
];
function renderPost() {
  const c = selClip();
  const dur = c.end - c.start;
  $('postForm').innerHTML = PLATFORMS.map((p) => {
    const cp = c.copy?.[p.id] || {};
    return `<div class="platform" data-p="${p.id}">
      <h4>${p.name}<span class="lim ${dur > p.max ? 'warn' : ''}">${Math.round(dur)}s / max ${p.max / 60} min</span></h4>
      ${p.titleMax ? `<label class="field">Title<input data-f="title" maxlength="${p.titleMax}" value="${esc(cp.title || '')}"></label>` : ''}
      <label class="field">${p.id === 'youtube' ? 'Description' : 'Caption'}<textarea data-f="description" rows="3" maxlength="${p.descMax}">${esc(cp.description || '')}</textarea></label>
      <label class="field">Hashtags<input data-f="hashtags" value="${esc(cp.hashtags || '')}" placeholder="#shorts"></label>
      <button class="small copy">Copy all</button>
    </div>`;
  }).join('');
  $('postForm').querySelectorAll('.platform').forEach((el) => {
    const pid = el.dataset.p;
    const save = debounce(() => {
      const fields = {};
      el.querySelectorAll('[data-f]').forEach((i) => { fields[i.dataset.f] = i.value; });
      c.copy = { ...(c.copy || {}), [pid]: fields };
      api(`/api/projects/${S.project.id}/clips/${c.id}`, { method: 'PATCH', body: { copy: { [pid]: fields } } });
    }, 500);
    el.querySelectorAll('[data-f]').forEach((i) => { i.oninput = save; });
    el.querySelector('.copy').onclick = () => {
      const v = (f) => el.querySelector(`[data-f=${f}]`)?.value || '';
      navigator.clipboard.writeText([v('title'), v('description'), v('hashtags')].filter(Boolean).join('\n\n'));
      toast('Copied');
    };
  });
}

// ---------------- clip actions ----------------
async function patchClip(id, body) {
  const updated = await api(`/api/projects/${S.project.id}/clips/${id}`, { method: 'PATCH', body });
  const i = S.project.clips.findIndex((c) => c.id === id);
  if (i >= 0) S.project.clips[i] = { ...S.project.clips[i], ...updated };
  renderClips(); renderTimeline(); renderInspector(); highlightTranscript(); refreshStageEdit();
  S.dirty = true;
  return updated;
}

async function addClip(body) {
  // a new short starts with the layout of the one you're on (all tweaks if it's the same template)
  const src = selClip() || S.project.clips[S.project.clips.length - 1];
  if (src && !body.overrides) body.overrides = src.template_id === body.template_id ? clone(src.overrides || {}) : layoutOnly(src.overrides);
  if (!body.caption_source && syncedLyrics(S.project.lyrics).length && S.project.transcript?.status !== 'done') body.caption_source = 'lyrics';
  const clip = await api(`/api/projects/${S.project.id}/clips`, { method: 'POST', body });
  S.project.clips.push(clip);
  selectClip(clip.id, true);
  return clip;
}

function defaultTemplateId() {
  return selClip()?.template_id || S.project.clips[S.project.clips.length - 1]?.template_id || 'blur-classic';
}

function sentenceEndAfter(t) {
  const segs = S.project.transcript?.segments || [];
  const seg = segs.find((s) => s.end >= t);
  return seg ? seg.end : t;
}

function newClipAt(start) {
  const dur = S.project.source.duration;
  let end = Math.min(dur, start + 30);
  if (S.project.transcript?.status === 'done') end = Math.min(dur, Math.max(start + 15, sentenceEndAfter(start + 25)));
  if (end - start < 1) start = Math.max(0, end - 30);
  const dup = sameMoment(start, end);
  if (dup && !confirm(`Short #${dup.n} already covers ${fmt(dup.clip.start, 0)}–${fmt(dup.clip.end, 0)}. Make another short of the same moment (for example in a different template)?`)) {
    selectClip(dup.clip.id, true);
    return null;
  }
  return addClip({ start, end, template_id: defaultTemplateId(), title: '' });
}

async function deleteClip(id) {
  await api(`/api/projects/${S.project.id}/clips/${id}`, { method: 'DELETE' });
  S.project.clips = S.project.clips.filter((c) => c.id !== id);
  if (S.selected === id) S.selected = S.project.clips[0]?.id || null;
  renderAll();
}

// Where finished videos go: asked once per video with a Finder folder picker.
async function chooseOutputDir() {
  toast('Pick a folder in the window that just opened (it may be behind this one)');
  try {
    const r = await api(`/api/projects/${S.project.id}/output-dir`, { method: 'POST', body: { choose: true } });
    if (r.cancelled) return false;
    S.project.output_dir = r.dir;
    renderRender();
    toast('Videos will be saved in ' + r.dir.replace(/^\/Users\/[^/]+/, '~'));
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

async function renderClip(clip, asked) {
  if (!asked && !S.project.output_dir && !(await chooseOutputDir())) return;
  if (clip.id === S.selected) {
    $('renderBtn').disabled = true;
    $('rStatus').textContent = 'Preparing layers and captions…';
  }
  try {
    const form = await buildRenderForm({ tpl: effective(clip), clip, project: S.project, brand: S.brand });
    await api(`/api/projects/${S.project.id}/clips/${clip.id}/render`, { method: 'POST', body: form });
    clip.render = { status: 'queued', progress: 0 };
    renderClips(); renderRender();
  } catch (e) { toast('Render failed: ' + e.message, true); renderRender(); }
}

// ---------------- video & preview ----------------
function seek(t) {
  video.currentTime = Math.max(0, Math.min(t, (S.project?.source.duration || 0) - 0.05));
  S.dirty = true;
}

const cache = { key: '', under: null, over: null, assets: null, building: '' };
const capCache = { key: '', chunks: [] };

function layerKey(tpl, clip) {
  return JSON.stringify([tpl, S.brand, clip.title || S.project.name, S.project.source.width, S.project.source.height]);
}

async function buildLayers(key, tpl, clip) {
  cache.building = key;
  const assets = await resolveAssets(tpl, S.brand);
  const under = newCanvas(), over = newCanvas();
  drawUnder(under.getContext('2d'), tpl, S.project.source, assets);
  drawOver(over.getContext('2d'), tpl, S.project.source, assets, S.brand, clip.title || S.project.name);
  if (cache.building !== key) return;
  Object.assign(cache, { key, under, over, assets, building: '' });
  S.dirty = true;
}

function loop() {
  requestAnimationFrame(loop);
  if (!S.project) return;
  const c = selClip();
  if (S.clipPlay && c && video.currentTime >= c.end) { video.pause(); S.clipPlay = false; seek(c.start); }
  const playing = !video.paused;
  $('playhead').style.left = `${(video.currentTime / (S.project.source.duration || 1)) * 100}%`;
  $('tc').textContent = fmt(video.currentTime);
  $('playBtn').innerHTML = playing ? '❚❚' : '▶';
  $('playClip').innerHTML = playing && S.clipPlay ? '❚❚' : '▶';
  if (!c || (!playing && !S.dirty)) return;
  S.dirty = false;
  if (playing && Math.random() < 0.1) { highlightTranscript(); highlightCaptionRow(); highlightLyrics(); }

  const tpl = effective(c);
  const key = layerKey(tpl, c);
  if (cache.key !== key && cache.building !== key) buildLayers(key, tpl, c);
  const frame = video.readyState >= 2 ? video : null;
  pctx.fillStyle = '#000'; pctx.fillRect(0, 0, W, H);
  if (tpl.bg.type === 'blur') drawBlurBase(pctx, tpl, frame, video.videoWidth, video.videoHeight);
  if (cache.under) pctx.drawImage(cache.under, 0, 0);
  drawVideoFrame(pctx, tpl, S.project.source, frame, video.videoWidth, video.videoHeight);
  if (cache.over) pctx.drawImage(cache.over, 0, 0);

  if (c.captions !== false) {
    const ck = JSON.stringify([c.start, c.end, tpl.captions.maxWords, c.caption_source, S.project.transcript?.status, S.trVersion, S.lyVersion]);
    if (capCache.key !== ck) { capCache.key = ck; capCache.chunks = clipChunks(S.project, c, tpl); }
    const t = video.currentTime - c.start;
    let cap = captionAt(capCache.chunks, t, tpl);
    if (!cap && !playing && capCache.chunks.length && (t < 0 || t > c.end - c.start)) cap = { chunk: capCache.chunks[0], active: 0 };
    if (cap) drawCaption(pctx, tpl, cap.chunk, cap.active);
  }
}

video.addEventListener('seeked', () => { S.dirty = true; highlightTranscript(); highlightCaptionRow(); highlightLyrics(); });
video.addEventListener('loadeddata', () => { S.dirty = true; if (selClip()) renderTemplates(); });

const SAFE = {
  youtube: [{ l: 'buttons', x: 86, y: 45, w: 14, h: 40 }, { l: 'title & channel', x: 0, y: 80, w: 86, h: 20 }],
  instagram: [{ l: 'top bar', x: 0, y: 0, w: 100, h: 8 }, { l: 'buttons', x: 86, y: 50, w: 14, h: 35 }, { l: 'caption', x: 0, y: 82, w: 86, h: 18 }],
  tiktok: [{ l: 'top tabs', x: 0, y: 0, w: 100, h: 8 }, { l: 'buttons', x: 85, y: 40, w: 15, h: 45 }, { l: 'caption', x: 0, y: 78, w: 85, h: 22 }],
};
function renderSafe() {
  $('safe').innerHTML = (SAFE[S.safe] || []).map((z) =>
    `<div style="left:${z.x}%;top:${z.y}%;width:${z.w}%;height:${z.h}%"><span>${z.l}</span></div>`).join('');
}

// ---------------- timeline interaction ----------------
function wireTimeline() {
  const tl = $('timeline');
  let drag = null;
  const timeAt = (e) => {
    const r = tl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.project.source.duration;
  };
  tl.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.h');
    const bar = e.target.closest('.tl-clip');
    if (h) {
      drag = { edge: h.dataset.h, clip: selClip() };
      tl.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (bar && bar.dataset.id !== S.selected) { selectClip(bar.dataset.id, false); }
    seek(timeAt(e));
    drag = { scrub: true };
    tl.setPointerCapture(e.pointerId);
  });
  tl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const t = timeAt(e);
    if (drag.scrub) { seek(t); return; }
    const c = drag.clip;
    if (drag.edge === 'start') c.start = Math.min(t, c.end - 1);
    else c.end = Math.max(t, c.start + 1);
    seek(drag.edge === 'start' ? c.start : c.end);
    renderTimeline();
    $('cStart').value = fmt(c.start); $('cEnd').value = fmt(c.end); $('cDur').textContent = `${(c.end - c.start).toFixed(1)}s`;
  });
  tl.addEventListener('pointerup', () => {
    if (drag?.clip) patchClip(drag.clip.id, { start: drag.clip.start, end: drag.clip.end });
    drag = null;
  });
}

function setEdge(edge) {
  const c = selClip();
  const t = video.currentTime;
  if (!c) { if (edge === 'start') newClipAt(t); return; }
  if (edge === 'start') patchClip(c.id, { start: t, end: c.end > t + 1 ? c.end : Math.min(S.project.source.duration, t + 30) });
  else if (t > c.start + 1) patchClip(c.id, { end: t });
  else toast('End must be after the start', true);
}

// ---------------- chat ----------------
function addMsg(role, text, extra) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role === 'assistant') el.innerHTML = esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  else el.textContent = text;
  if (extra) { const a = document.createElement('div'); a.className = 'applied'; a.textContent = extra; el.appendChild(a); }
  $('chatLog').appendChild(el);
  $('chatLog').scrollTop = 1e9;
  return el;
}

async function sendChat(text) {
  if (!S.project) { toast('Open a video first', true); return; }
  text = text.trim();
  if (!text) return;
  $('chat').hidden = false;
  S.chat.push({ role: 'user', content: text });
  addMsg('user', text);
  const thinking = addMsg('assistant thinking', 'Thinking');
  try {
    const r = await api('/api/chat', {
      method: 'POST',
      body: {
        project_id: S.project.id, selected: S.selected, messages: S.chat,
        templates: allTemplates().map((t) => ({ id: t.id, name: t.name, look: t.look })),
        design: designForAI(),
      },
    });
    thinking.remove();
    const applied = await applyActions(r.actions || []);
    S.chat.push({ role: 'assistant', content: r.reply + (applied.length ? `\n[applied: ${applied.join('; ')}]` : '') });
    addMsg('assistant', r.reply, applied.length ? 'Changed:\n• ' + applied.join('\n• ') : '');
  } catch (e) {
    thinking.remove();
    S.chat.pop();
    addMsg('error', e.message + ' — check AI & settings.');
  }
}

// ---------------- AI: design + channel edits ----------------
const DESIGN_FIELDS = new Map(SCHEMA.flatMap((g) => g.fields).filter((f) => f[2] !== 'image').map((f) => [f[0], f]));

// What the AI sees about the selected short's look: every editable value plus
// where each element ends up, and what overlaps.
function designForAI() {
  const c = selClip();
  if (!c) return null;
  const tpl = effective(c);
  const values = {};
  for (const [path] of DESIGN_FIELDS) values[path] = getPath(tpl, path) ?? null;
  let layout = null;
  try { layout = layoutBoxes(tpl, S.project.source, S.brand, c.title || S.project.name, clipChunks(S.project, c, tpl)); } catch { /* fonts not ready */ }
  return { clip_id: c.id, template: getTemplate(c.template_id).name, values, ...layout };
}

// One design change from the AI -> a safe value, or undefined to skip it.
function cleanDesignValue(path, v) {
  const f = DESIGN_FIELDS.get(path);
  if (!f) return undefined;
  const [, , type, opt] = f;
  if (type === 'range') { const n = Number(v); return Number.isFinite(n) ? Math.max(opt[0], Math.min(opt[1], n)) : undefined; }
  if (type === 'select') return opt.map(String).includes(String(v)) ? (typeof opt[0] === 'number' ? Number(v) : String(v)) : undefined;
  if (type === 'check') return typeof v === 'boolean' ? v : undefined;
  if (type === 'color' || type === 'stop') {
    if (v === '' || v === null) return type === 'color' ? '' : undefined;
    return typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/i.test(v.trim()) ? v.trim() : undefined;
  }
  if (type === 'text') return typeof v === 'string' ? v.slice(0, 40) : undefined;
  return undefined;
}

function applyDesign(c, changes) {
  const over = clone(c.overrides || {});
  const used = [];
  for (const [path, raw] of Object.entries(changes || {})) {
    const v = cleanDesignValue(path, raw);
    if (v === undefined) continue;
    if (path.startsWith('bg.stops')) {
      const stops = clone(deepMerge(normalize(getTemplate(c.template_id)), over).bg.stops);
      while (stops.length < 3) stops.push(stops[stops.length - 1] || '#000000');
      stops[+path.split('.')[2]] = v;
      setPath(over, 'bg.stops', stops);
    } else setPath(over, path, v);
    used.push(path);
  }
  return { over, used };
}

// Two shorts are "the same moment" when they share more than 20s, or most of the
// shorter one. Used to stop the AI (or a double click) making duplicates.
function sameMoment(start, end, ignoreId) {
  for (const [i, c] of S.project.clips.entries()) {
    if (c.id === ignoreId) continue;
    const shared = Math.min(end, c.end) - Math.max(start, c.start);
    const shorter = Math.min(end - start, c.end - c.start);
    if (shared > 20 || (shared > 0 && shared >= shorter * 0.6)) return { n: c.num ?? i + 1, clip: c };
  }
  return null;
}

// Validate and apply AI actions. Returns human-readable list of what changed.
async function applyActions(actions) {
  const done = [];
  const dur = S.project.source.duration;
  const tplIds = new Set(allTemplates().map((t) => t.id));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(dur, v)) : undefined);
  const label = (id) => { const i = S.project.clips.findIndex((c) => c.id === id); return `#${S.project.clips[i]?.num ?? i + 1}`; };
  for (const a of actions.slice(0, 20)) {
    try {
      if (a.type === 'add_clip') {
        const start = num(a.start), end = num(a.end);
        if (start === undefined || end === undefined || end - start < 1) { done.push('skipped a short with invalid times'); continue; }
        const dup = sameMoment(start, end);
        if (dup) { done.push(`skipped ${fmt(start, 0)}–${fmt(end, 0)}: it's the same moment as short #${dup.n}`); continue; }
        const body = { start, end, title: String(a.title || '').slice(0, 200), template_id: tplIds.has(a.template_id) ? a.template_id : defaultTemplateId() };
        if (a.caption_source === 'lyrics' || a.caption_source === 'transcript') body.caption_source = a.caption_source;
        const c = await addClip(body);
        done.push(`added short ${label(c.id)} ${fmt(start, 0)}–${fmt(end, 0)}${body.title ? ` “${body.title}”` : ''}`);
      } else if (a.type === 'update_clip') {
        const c = clipById(a.clip_id);
        if (!c) { done.push('skipped an edit for an unknown short'); continue; }
        const body = {};
        if (num(a.start) !== undefined) body.start = num(a.start);
        if (num(a.end) !== undefined) body.end = num(a.end);
        if ((body.end ?? c.end) - (body.start ?? c.start) < 1) { done.push(`skipped invalid times for ${label(c.id)}`); delete body.start; delete body.end; }
        if (typeof a.title === 'string') body.title = a.title.slice(0, 200);
        if (typeof a.captions === 'boolean') body.captions = a.captions;
        if (a.caption_source === 'lyrics' || a.caption_source === 'transcript') body.caption_source = a.caption_source;
        if (a.template_id !== undefined) {
          if (tplIds.has(a.template_id)) { body.template_id = a.template_id; body.overrides = {}; }
          else done.push(`ignored unknown template “${a.template_id}”`);
        }
        if (!Object.keys(body).length) continue;
        await patchClip(c.id, body);
        done.push(`updated ${label(c.id)}: ${Object.keys(body).filter((k) => k !== 'overrides').join(', ')}`);
      } else if (a.type === 'delete_clip') {
        const c = clipById(a.clip_id);
        if (!c) continue;
        const l = label(c.id);
        await deleteClip(c.id);
        done.push(`deleted short ${l}`);
      } else if (a.type === 'select_clip') {
        if (clipById(a.clip_id)) { selectClip(a.clip_id, true); done.push(`selected ${label(a.clip_id)}`); }
      } else if (a.type === 'set_copy') {
        const c = clipById(a.clip_id);
        if (!c || !['youtube', 'instagram', 'tiktok'].includes(a.platform)) continue;
        const fields = {};
        for (const f of ['title', 'description', 'hashtags']) if (typeof a[f] === 'string') fields[f] = a[f];
        await patchClip(c.id, { copy: { [a.platform]: fields } });
        done.push(`wrote ${a.platform} text for ${label(c.id)}`);
      } else if (a.type === 'set_design') {
        const targets = a.scope === 'all' ? S.project.clips : [clipById(a.clip_id) || selClip()].filter(Boolean);
        if (!targets.length) { done.push('no short to restyle'); continue; }
        let used = [];
        for (const c of targets) {
          const r = applyDesign(c, a.changes);
          if (!r.used.length) continue;
          used = r.used;
          await patchClip(c.id, { overrides: r.over });
        }
        const skipped = Object.keys(a.changes || {}).filter((k) => !used.includes(k));
        if (used.length) done.push(`restyled ${a.scope === 'all' ? 'all shorts' : label(targets[0].id)}: ${used.join(', ')}`);
        if (skipped.length) done.push(`ignored ${skipped.join(', ')}`);
        S.dirty = true; renderTemplates();
        if (!$('designForm').closest('.tab').hidden) renderDesign();
      } else if (a.type === 'set_brand') {
        const body = { ...S.brand };
        const changed = [];
        for (const k of ['channel', 'handle', 'cta']) if (typeof a[k] === 'string') { body[k] = a[k].slice(0, 80); changed.push(k); }
        if (Array.isArray(a.links)) { body.links = a.links.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 120)).slice(0, 3); changed.push('links'); }
        if (!changed.length) continue;
        S.brand = await api('/api/brand', { method: 'PUT', body });
        S.dirty = true; renderTemplates(); refreshStageEdit();
        done.push(`updated channel details: ${changed.join(', ')}`);
      } else if (a.type === 'render_clip') {
        const c = clipById(a.clip_id);
        if (!c) continue;
        await renderClip(c);
        done.push(`started rendering ${label(c.id)}`);
      }
    } catch (e) { done.push(`failed: ${a.type} (${e.message})`); }
  }
  return done;
}

// ---------------- polling ----------------
function needsPoll(p) {
  return p.status?.proxy === 'working' || p.transcript?.status === 'working' || p.lyrics_sync?.status === 'working' ||
    p.clips.some((c) => ['queued', 'rendering'].includes(c.render?.status));
}

async function poll() {
  const p = S.project;
  if (!p || !needsPoll(p) || document.hidden) {
    if (p?.transcript?.status === 'working') renderTranscript();
    return;
  }
  let fresh;
  try { fresh = await api(`/api/projects/${p.id}`); } catch { return; }
  if (S.project?.id !== fresh.id) return;
  const wasProxy = p.status?.proxy, wasTr = p.transcript?.status;
  p.status = fresh.status; p.proxy = fresh.proxy; p.transcript = fresh.transcript;
  autoState(fresh);
  for (const c of p.clips) {
    const f = fresh.clips.find((x) => x.id === c.id);
    if (f) c.render = f.render;
  }
  if (wasProxy !== p.status?.proxy || p.status?.proxy === 'working') loadVideo();
  if (wasTr !== p.transcript?.status || p.transcript?.status === 'working') {
    renderTranscript(); renderInspector();
    if (wasTr === 'working' && p.transcript.status === 'done') toast('Transcript ready — captions are on. Try “AI: find best moments”.');
  }
  renderClips(); renderRender();
}

// ---------------- brand dialog ----------------
function openBrand() {
  const b = S.brand;
  $('bChannel').value = b.channel || '';
  $('bHandle').value = b.handle || '';
  $('bCta').value = b.cta || '';
  $('bLinks').value = (b.links || []).join('\n');
  let logo = b.logo || '';
  const showLogo = () => { $('logoPrev').style.backgroundImage = logo ? `url(${logo})` : ''; };
  showLogo();
  $('logoBtn').onclick = () => $('logoFile').click();
  $('logoClear').onclick = () => { logo = ''; showLogo(); };
  $('logoFile').onchange = async () => {
    const f = $('logoFile').files[0];
    if (!f) return;
    try { logo = (await uploadFile('/api/assets', f, 'file')).url; showLogo(); } catch (e) { toast(e.message, true); }
  };
  $('bSave').onclick = async (e) => {
    e.preventDefault();
    S.brand = await api('/api/brand', {
      method: 'PUT',
      body: { channel: $('bChannel').value, handle: $('bHandle').value, cta: $('bCta').value, logo, links: $('bLinks').value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 3) },
    });
    $('brandDlg').close();
    toast('Channel details saved');
    refreshStageEdit();
    if (S.project) { S.dirty = true; renderTemplates(); }
  };
  $('brandDlg').showModal();
}

function switchTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.inspector .tab').forEach((t) => { t.hidden = t.dataset.tab !== name; });
}

// ---------------- static wiring ----------------
function wireStatic() {
  $('goHome').onclick = () => showHome();
  const drop = $('drop');
  $('fileInput').onchange = (e) => handleFile(e.target.files[0]);
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  $('playBtn').onclick = () => { S.clipPlay = false; video.paused ? video.play() : video.pause(); };
  $('playClip').onclick = () => {
    const c = selClip();
    if (!c) return;
    if (!video.paused && S.clipPlay) { video.pause(); S.clipPlay = false; return; }
    if (video.currentTime < c.start || video.currentTime >= c.end - 0.1) seek(c.start);
    S.clipPlay = true; video.play();
  };
  $('setIn').onclick = () => setEdge('start');
  $('setOut').onclick = () => setEdge('end');
  $('newClip').onclick = () => newClipAt(video.currentTime);
  $('aiSuggest').onclick = () => {
    const timed = S.project?.transcript?.status === 'done' || syncedLyrics(S.project?.lyrics).length > 0;
    const have = S.project?.clips.length || 0;
    sendChat(!timed ? 'There is no transcript or synced lyrics yet. What should I do to get AI-picked moments?'
      : have ? `Find up to 5 NEW moments for shorts that the ${have} existing shorts don't already cover (20-60s each, strong hook, complete thought). Add them with punchy titles. If the good moments are all taken, say so instead of repeating one.`
        : 'Find the 5 best moments in this video for shorts (20-60s each, strong hook, complete thought). Add them as shorts with punchy titles and pick a fitting template.');
  };
  $('renderAll').onclick = async () => {
    const todo = S.project.clips.filter((c) => !['queued', 'rendering'].includes(c.render?.status));
    if (!todo.length) { toast('Nothing to render'); return; }
    if (!S.project.output_dir && !(await chooseOutputDir())) return;
    toast(`Rendering ${todo.length} short${todo.length > 1 ? 's' : ''}…`);
    for (const c of todo) await renderClip(c, true);
  };
  $('transcribeBtn').onclick = async () => {
    try {
      await api(`/api/projects/${S.project.id}/transcribe`, { method: 'POST' });
      S.project.transcript = { status: 'working', started: Date.now() / 1000 };
      renderTranscript();
    } catch (e) { toast(e.message, true); }
  };
  $('trSearch').oninput = debounce(renderTranscript, 200);
  $('renderBtn').onclick = () => { const c = selClip(); if (c) renderClip(c); };

  $('cTitle').oninput = debounce(() => { const c = selClip(); if (c) patchClip(c.id, { title: $('cTitle').value }); }, 500);
  $('cCaptions').onchange = () => { const c = selClip(); if (c) patchClip(c.id, { captions: $('cCaptions').checked }); };
  const timeInput = (id, key) => {
    $(id).onchange = () => {
      const c = selClip(); const t = parseTime($(id).value);
      if (!c || t === null) { renderInspector(); return; }
      patchClip(c.id, { [key]: t }).catch((e) => { toast(e.message, true); renderInspector(); });
    };
  };
  timeInput('cStart', 'start'); timeInput('cEnd', 'end');

  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
  $('safeSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      S.safe = b.dataset.safe;
      $('safeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      renderSafe();
    };
  });

  $('saveTpl').onclick = () => saveTemplate(true);
  $('updateTpl').onclick = () => saveTemplate(false);
  $('resetTpl').onclick = () => { const c = selClip(); if (c) patchClip(c.id, { overrides: {} }); };
  $('deleteTpl').onclick = async () => {
    const c = selClip(); const base = getTemplate(c.template_id);
    if (!confirm(`Delete template “${base.name}”?`)) return;
    await api(`/api/templates/${base.id}`, { method: 'DELETE' });
    S.custom = await api('/api/templates');
    for (const x of S.project.clips) if (x.template_id === base.id) await patchClip(x.id, { template_id: 'midnight', overrides: {} });
    renderInspector();
  };
  $('exportTpl').onclick = () => {
    const c = selClip(); if (!c) return;
    const tpl = effective(c); tpl.name = $('tplName').value || tpl.name; delete tpl.id;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' }));
    a.download = `${(tpl.name || 'template').replace(/[^\w-]+/g, '_')}.json`;
    a.click();
  };
  $('uploadBgBtn').onclick = () => { if (selClip()) pickBgImage(true); };
  $('importTplBtn').onclick = () => $('tplFile').click();
  $('tplFile').onchange = async () => {
    const f = $('tplFile').files[0];
    if (!f) return;
    try {
      const tpl = JSON.parse(await f.text());
      delete tpl.id;
      tpl.name = tpl.name || f.name.replace(/\.json$/, '');
      const saved = await api('/api/templates', { method: 'POST', body: tpl });
      S.custom = await api('/api/templates');
      const c = selClip();
      if (c) await patchClip(c.id, { template_id: saved.id, overrides: {} });
      toast(`Imported “${saved.name}”`);
    } catch (e) { toast('Not a valid template file', true); }
    $('tplFile').value = '';
  };
  $('aiCopy').onclick = () => sendChat('Write the post text (title where relevant, description/caption, hashtags) for YouTube Shorts, Instagram Reels and TikTok for the selected short. Match each platform\'s style.');

  $('openBrand').onclick = openBrand;
  $('openSettings').onclick = () => openSettings(async () => { $('chatModel').textContent = await activeConnectionLabel(); });
  $('toggleChat').onclick = async () => {
    $('chat').hidden = !$('chat').hidden;
    if (!$('chat').hidden) { $('chatModel').textContent = await activeConnectionLabel(); $('chatText').focus(); }
  };
  $('closeChat').onclick = () => { $('chat').hidden = true; };
  $('chatForm').onsubmit = (e) => { e.preventDefault(); const t = $('chatText').value; $('chatText').value = ''; sendChat(t); };
  $('chatText').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } };
  $('chatQuick').querySelectorAll('button').forEach((b) => { b.onclick = () => sendChat(b.textContent); });

  wireTimeline();
  initLyrics({
    S, video, seek,
    changed: () => { S.lyVersion++; S.dirty = true; updateCapNote(); },
  });
  initStageEdit({
    S, selClip, effective, apply: applyOverride,
    onChange: (done) => {
      S.dirty = true;
      saveOverrides();
      if (done && !$('designForm').closest('.tab').hidden) renderDesign();
    },
    editTitle: (v, id) => { if (clipById(id)) patchClip(id, { title: v }); },
    editBrand: () => openBrand(),
    editCaption: () => {
      const c = selClip();
      if (!c) return;
      if (c.caption_source === 'lyrics') { focusLyricAt(video.currentTime); return; }
      if (S.project.transcript?.status !== 'done') { toast('No transcript yet. Press Transcribe, or switch this short to your lyrics.'); return; }
      switchTab('short');
      const box = $('capEdit');
      box.open = true;
      renderCaptionEditor();
      const t = video.currentTime - c.start;
      const rows = [...$('capList').querySelectorAll('.caprow')];
      let cur = rows[0];
      for (const r of rows) if (t >= +r.dataset.rel - 0.01) cur = r;
      cur?.scrollIntoView({ block: 'center' });
      cur?.querySelector('input')?.focus();
    },
  });
  window.addEventListener('resize', refreshStageEdit);
  $('saveDir').addEventListener('click', async (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'change') chooseOutputDir();
    if (act === 'open') { try { await api(`/api/projects/${S.project.id}/output-dir/open`, { method: 'POST' }); } catch (err) { toast(err.message, true); } }
  });
  $('applySeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      S.applyAll = b.dataset.v === 'all';
      try { localStorage.setItem('sm.applyAll', S.applyAll ? '1' : '0'); } catch { /* private mode */ }
      renderApplySeg(); refreshStageEdit();
      toast(S.applyAll ? 'Moves and style changes now apply to all shorts' : 'Changes now apply to the selected short only');
    };
  });
  $('capSrc').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { const c = selClip(); if (c) patchClip(c.id, { caption_source: b.dataset.v }); };
  });

  document.addEventListener('keydown', (e) => {
    if (S.project && !e.target.closest?.('input, textarea, dialog') && lyricsKey(e)) return;
    if (!S.project || e.target.closest?.('input, textarea, select, dialog') || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); $('playBtn').click(); }
    else if (k === 'i') setEdge('start');
    else if (k === 'o') setEdge('end');
    else if (k === 'arrowleft') seek(video.currentTime - (e.shiftKey ? 5 : 1));
    else if (k === 'arrowright') seek(video.currentTime + (e.shiftKey ? 5 : 1));
    else if ((k === 'delete' || k === 'backspace') && S.selected) {
      if (confirm('Delete this short?')) deleteClip(S.selected);
    }
  });
}

boot();
