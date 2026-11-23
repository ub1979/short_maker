// "My lyrics": your own caption lines with tap-to-sync timing.
// Lines are stored on the video (project.lyrics.lines) in source seconds.
import { api, esc, toast, fmt, parseTime, debounce } from './util.js';
import { syncedLyrics, isSectionLabel } from './render.js';

const $ = (id) => document.getElementById(id);
let ctx;          // { S, video, seek, changed }
const sync = { active: false, idx: 0, history: [] };

const lines = () => (ctx.S.project ? (ctx.S.project.lyrics ||= { lines: [] }).lines : []);

export function initLyrics(c) {
  ctx = c;
  $('srcTabs').querySelectorAll('button').forEach((b) => { b.onclick = () => showSource(b.dataset.src); });
  $('lyPaste').onclick = openPaste;
  $('lyCancel').onclick = closePaste;
  $('lyApply').onclick = applyPaste;
  $('lyBig').onclick = () => setBig(!$('lyPasteBox').classList.contains('big'));
  $('lyText').addEventListener('input', countLines);
  $('lyText').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if ($('lyPasteBox').classList.contains('big')) setBig(false); else closePaste(); }
  });
  $('lySync').onclick = () => { if (sync.active) { lyricsStopButton(); stopSync(); } else startSync(); };
  $('lyTap').onclick = tap;
  $('lyImport').onclick = () => $('lyFile').click();
  $('lyFile').onchange = importFile;
  $('lyExport').onclick = exportLrc;
  $('lyAuto').onclick = startAuto;
}

// ---------- auto-sync (Whisper + alignment on the server) ----------
async function startAuto() {
  const all = lines();
  if (!all.length) { openPaste(); toast('Paste your lyrics first'); return; }
  if (sync.active) stopSync();
  const mine = (l) => Number.isFinite(l.start) && !l.est && !l.heard;
  if (all.every(mine)) {
    if (!confirm('You timed every line yourself. Re-time them all from the audio?')) return;
    all.forEach((l) => { l.start = null; l.end = null; });
  }
  // lines you timed yourself are kept and used as anchors; auto-sync's own times are redone
  all.forEach((l) => { if (!mine(l)) { l.start = null; l.end = null; delete l.est; delete l.heard; } });
  try {
    await api(`/api/projects/${ctx.S.project.id}/lyrics`, { method: 'PUT', body: { lines: all } });
    ctx.S.project.lyrics_sync = await api(`/api/projects/${ctx.S.project.id}/lyrics/autosync`, { method: 'POST' });
    autoState();
  } catch (e) { toast(e.message, true); }
}

// Called on load and by the poller with the latest project.
export function autoState(fresh) {
  const p = ctx.S.project;
  const was = p.lyrics_sync?.status;
  if (fresh) {
    p.lyrics_sync = fresh.lyrics_sync;
    if (was === 'working' && fresh.lyrics_sync?.status !== 'working') {
      p.lyrics = fresh.lyrics || { lines: [] };
      const r = fresh.lyrics_sync || {};
      if (r.status === 'done') {
        const parts = [r.engine === 'whisper' ? `${r.heard} of ${r.total} lines heard in the song` : `${r.heard} of ${r.total} lines timed from the audio`];
        if (r.estimated) parts.push(`${r.estimated} placed between them (grey times, check these)`);
        if (r.kept) parts.push(`${r.kept} of your own times kept`);
        if (r.labels) parts.push(`${r.labels} section label${r.labels > 1 ? 's' : ''} like [Chorus] skipped`);
        toast(parts.join(' · '));
      } else if (r.status === 'error') toast(r.error, true);
      ctx.changed();
      updateCount();
      const list = $('lyList');
      if (list.contains(document.activeElement)) document.activeElement.blur();
      renderLyrics();
    }
  }
  const working = p.lyrics_sync?.status === 'working';
  $('lyAutoBar').hidden = !working;
  for (const id of ['lyAuto', 'lySync', 'lyPaste', 'lyImport']) $(id).disabled = working;
  $('lyList').classList.toggle('busy', working);
}

export function showSource(which) {
  $('srcTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.src === which));
  const ly = which === 'lyrics';
  $('lyrics').hidden = !ly;
  $('transcript').hidden = ly;
  $('trSearch').hidden = ly;
  $('transcribeBtn').hidden = ly;
  if (ly) renderLyrics();
  else if (sync.active) stopSync();
}

export function resetLyricsView() {
  if (sync.active) stopSync();
  closePaste();
  updateCount();
  showSource('transcript');
}

function updateCount() {
  const all = lines();
  const synced = all.filter((l) => Number.isFinite(l.start)).length;
  $('lyCount').textContent = all.length ? `${synced}/${all.length}` : '';
}

const save = debounce(async () => {
  try {
    const r = await api(`/api/projects/${ctx.S.project.id}/lyrics`, { method: 'PUT', body: { lines: lines() } });
    ctx.S.project.lyrics.updated = r.updated;
  } catch (e) { toast('Could not save lyrics: ' + e.message, true); }
}, 400);

function changed(rerender = true) {
  updateCount();
  ctx.changed();
  save();
  if (rerender) renderLyrics();
}

// ---------- list ----------
export function renderLyrics() {
  if ($('lyrics').hidden) return;
  const list = $('lyList');
  if (list.contains(document.activeElement) && !sync.active) return; // keep the cursor while typing
  const all = lines();
  if (!all.length) {
    list.innerHTML = `<div class="ly-empty">No lyrics yet. Press <b>Paste / edit text</b>, put in your lines, then use <b>Tap to sync</b>: play the video and press Space as each line starts. You can also import a timed <b>.lrc</b> or <b>.srt</b> file.</div>`;
    updateCount();
    return;
  }
  list.innerHTML = all.map((l, i) => `
    <div class="lyrow ${sync.active && i === sync.idx ? 'next' : ''} ${l.est ? 'est' : ''}" data-i="${i}">
      <input class="t" value="${Number.isFinite(l.start) ? fmt(l.start) : ''}" placeholder="--:--" title="${l.est ? 'Guessed: auto-sync could not hear this line. Check it, or press the target button at the right moment.' : 'Start time. Click the text to jump there.'}">
      <input class="txt" dir="auto" value="${esc(l.text)}">
      <button class="here" title="Set start to the playhead">&#8982;</button>
      <button class="del" title="Delete line">&#10005;</button>
    </div>`).join('') + '<button class="small ly-add" id="lyAdd">+ Add line</button>';
  list.querySelectorAll('.lyrow').forEach((row) => {
    const i = +row.dataset.i;
    const [t, txt] = row.querySelectorAll('input');
    t.onchange = () => {
      const v = t.value.trim() === '' ? null : parseTime(t.value);
      if (v === null && t.value.trim() !== '') { toast('Use a time like 1:23.5', true); renderLyrics(); return; }
      all[i].start = v === null ? null : Math.max(0, Math.min(v, ctx.S.project.source.duration));
      all[i].end = null; delete all[i].est; delete all[i].heard;
      changed();
    };
    txt.onfocus = () => { if (Number.isFinite(all[i].start) && ctx.video.paused) ctx.seek(all[i].start); };
    txt.oninput = () => { all[i].text = txt.value; changed(false); };
    txt.onkeydown = (e) => {
      if (e.key === 'Enter') { // split / new line below, like a text editor
        e.preventDefault();
        const pos = txt.selectionStart;
        const before = txt.value.slice(0, pos).trim(), after = txt.value.slice(pos).trim();
        all[i].text = before || all[i].text;
        all.splice(i + 1, 0, { text: after || '', start: null, end: null });
        changed();
        $('lyList').querySelectorAll('.lyrow .txt')[i + 1]?.focus();
      }
    };
    txt.onblur = () => {
      if (!txt.value.trim()) { all.splice(i, 1); changed(); }
    };
    row.querySelector('.here').onclick = () => { all[i].start = +ctx.video.currentTime.toFixed(2); all[i].end = null; delete all[i].est; delete all[i].heard; changed(); };
    row.querySelector('.del').onclick = () => { all.splice(i, 1); changed(); };
  });
  $('lyAdd').onclick = () => {
    all.push({ text: '', start: null, end: null });
    renderLyrics();
    const inputs = $('lyList').querySelectorAll('.lyrow .txt');
    inputs[inputs.length - 1]?.focus();
  };
  updateCount();
  highlightLyrics();
}

export function highlightLyrics() {
  if (!ctx?.S.project || $('lyrics').hidden) return;
  const t = ctx.video.currentTime;
  const synced = syncedLyrics(ctx.S.project.lyrics);
  let cur = null;
  for (const l of synced) if (t >= l.start) cur = l;
  $('lyList').querySelectorAll('.lyrow').forEach((row) => {
    const l = lines()[+row.dataset.i];
    row.classList.toggle('now', !!cur && l === cur);
  });
}

// ---------- paste ----------
function openPaste() {
  $('lyText').value = lines().map((l) => l.text).join('\n');
  $('lyPasteBox').hidden = false;
  countLines();
  $('lyText').focus();
}

function closePaste() {
  $('lyPasteBox').classList.remove('big');
  $('lyBig').innerHTML = '&#10530; Big editor';
  $('lyPasteBox').hidden = true;
}

// Big editor: the same box, enlarged over the whole window, so long lyrics are easy to read and trim.
function setBig(on) {
  $('lyPasteBox').classList.toggle('big', on);
  $('lyBig').innerHTML = on ? '&#10529; Smaller' : '&#10530; Big editor';
  $('lyText').focus();
}

function countLines() {
  const n = $('lyText').value.split('\n').filter((x) => x.trim()).length;
  $('lyLines').textContent = n ? `${n} line${n > 1 ? 's' : ''}` : '';
}

function applyPaste() {
  const old = lines();
  const all = $('lyText').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const fresh = all.filter((t) => !isSectionLabel(t)); // "[Verse 2]", "Chorus:" aren't sung
  const dropped = all.length - fresh.length;
  // keep timings of lines that didn't change (matched in order)
  let j = 0;
  const next = fresh.map((text) => {
    for (let k = j; k < Math.min(old.length, j + 8); k++) {
      if (old[k].text === text) { j = k + 1; return { ...old[k] }; }
    }
    return { text, start: null, end: null };
  });
  ctx.S.project.lyrics.lines = next;
  closePaste();
  changed();
  const unsynced = next.filter((l) => !Number.isFinite(l.start)).length;
  const note = dropped ? ` Removed ${dropped} section label${dropped > 1 ? 's' : ''} like [Chorus], since they aren't sung.` : '';
  toast((unsynced ? `${next.length} lines. ${unsynced} need timing — press Auto-sync or Tap to sync.` : `${next.length} lines saved.`) + note);
}

// ---------- tap to sync ----------
function startSync() {
  const all = lines();
  if (!all.length) { openPaste(); toast('Paste your lyrics first'); return; }
  // start from the first line without a time, or from the top
  let idx = all.findIndex((l) => !Number.isFinite(l.start) && !isSectionLabel(l.text));
  if (idx < 0) idx = all.findIndex((l) => l.est); // after auto-sync: fix the guessed lines
  if (idx < 0) idx = 0;
  if (idx === 0) {
    const c = ctx.S.project.clips.find((x) => x.id === ctx.S.selected);
    if (ctx.video.currentTime > 1 && !confirm('Start syncing from line 1 at the current playhead position? (Cancel to go back to the start of the video.)')) ctx.seek(c ? c.start : 0);
  } else if (Number.isFinite(all[idx - 1]?.start)) {
    ctx.seek(Math.max(0, all[idx - 1].start - 1));
  }
  sync.active = true; sync.idx = idx; sync.history = [];
  ctx.S.clipPlay = false;
  $('lySyncBar').hidden = false;
  $('lySync').textContent = '■ Stop syncing';
  $('lySync').classList.add('stop');
  document.activeElement?.blur?.();
  ctx.video.play();
  renderLyrics();
  scrollToNext();
}

function stopSync() {
  sync.active = false;
  ctx.video.pause();
  $('lySyncBar').hidden = true;
  $('lySync').innerHTML = '&#9679; Tap to sync';
  $('lySync').classList.remove('stop');
  renderLyrics();
}

function tap() {
  const all = lines();
  if (!sync.active || sync.idx >= all.length) return;
  const t = +ctx.video.currentTime.toFixed(2);
  sync.history.push({ idx: sync.idx, prev: { ...all[sync.idx] } });
  all[sync.idx].start = t;
  all[sync.idx].end = null;
  delete all[sync.idx].est; delete all[sync.idx].heard;
  sync.idx++;
  while (sync.idx < all.length && isSectionLabel(all[sync.idx].text)) sync.idx++; // labels aren't sung
  changed();
  scrollToNext();
  if (sync.idx >= all.length) {
    toast('All lines synced. Press Stop when the last line ends.');
    // let the last line run until the user stops; its end is set then
    sync.waitEnd = true;
  }
}

function undoTap() {
  const h = sync.history.pop();
  if (!h) return;
  lines()[h.idx] = h.prev;
  sync.idx = h.idx;
  sync.waitEnd = false;
  ctx.seek(Math.max(0, (lines()[h.idx - 1]?.start ?? ctx.video.currentTime - 3)));
  changed();
  scrollToNext();
}

function scrollToNext() {
  $('lyList').querySelector('.lyrow.next')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Called from the global key handler; returns true if it used the key.
export function lyricsKey(e) {
  if (!sync.active) return false;
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tap(); return true; }
  if (e.key === 'Backspace') { e.preventDefault(); undoTap(); return true; }
  if (e.key === 'Escape') {
    e.preventDefault();
    const all = lines();
    if (sync.waitEnd && all.length) { all[all.length - 1].end = +ctx.video.currentTime.toFixed(2); sync.waitEnd = false; changed(); }
    stopSync();
    return true;
  }
  return false;
}

export function lyricsStopButton() {
  // pressing Stop after the last tap ends the final line at the playhead
  const all = lines();
  if (sync.waitEnd && all.length) { all[all.length - 1].end = +ctx.video.currentTime.toFixed(2); sync.waitEnd = false; changed(); }
}

// ---------- import / export ----------
const ts = (h, m, s, ms) => (+h || 0) * 3600 + (+m) * 60 + (+s) + (ms ? +`0.${ms}` : 0);

export function parseLrc(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
    for (const t of tags) out.push({ text: words, start: ts(0, t[1], t[2], t[3]), end: null });
  }
  out.sort((a, b) => a.start - b.start);
  // an empty timed line in LRC marks where the previous line ends
  const res = [];
  for (const l of out) {
    if (!l.text) { if (res.length) res[res.length - 1].end = l.start; continue; }
    res.push(l);
  }
  return res;
}

export function parseSrt(text) {
  const out = [];
  const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})[^\n]*\n([\s\S]*?)(?:\n\s*\n|$)/g;
  for (const m of text.replace(/\r/g, '').matchAll(re)) {
    const body = m[9].replace(/<[^>]*>/g, '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ');
    if (body) out.push({ text: body, start: ts(m[1], m[2], m[3], m[4]), end: ts(m[5], m[6], m[7], m[8]) });
  }
  return out;
}

async function importFile() {
  const f = $('lyFile').files[0];
  $('lyFile').value = '';
  if (!f) return;
  const text = await f.text();
  let parsed = /-->/.test(text) ? parseSrt(text) : parseLrc(text);
  if (!parsed.length) parsed = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((t) => ({ text: t, start: null, end: null }));
  parsed = parsed.filter((l) => !isSectionLabel(l.text));
  if (!parsed.length) { toast('No lines found in that file', true); return; }
  if (lines().length && !confirm(`Replace your ${lines().length} current lines with ${parsed.length} lines from ${f.name}?`)) return;
  ctx.S.project.lyrics.lines = parsed;
  changed();
  const timed = parsed.filter((l) => Number.isFinite(l.start)).length;
  toast(`Imported ${parsed.length} lines${timed ? '' : ' (no timings — use Tap to sync)'}`);
}

function exportLrc() {
  const all = lines();
  if (!all.length) { toast('No lyrics to export'); return; }
  const tag = (t) => { const m = Math.floor(t / 60); return `[${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(2).padStart(5, '0')}]`; };
  const out = [];
  all.forEach((l) => {
    if (Number.isFinite(l.start)) out.push(tag(l.start) + l.text); else out.push(l.text);
    if (Number.isFinite(l.end)) out.push(tag(l.end));
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([out.join('\n') + '\n'], { type: 'text/plain' }));
  a.download = `${(ctx.S.project.name || 'lyrics').replace(/[^\w-]+/g, '_')}.lrc`;
  a.click();
}

// Double-click on a caption in the preview: jump to that lyric line and edit it.
export function focusLyricAt(t) {
  showSource('lyrics');
  closePaste();
  const all = lines();
  let idx = -1;
  all.forEach((l, i) => { if (Number.isFinite(l.start) && l.start <= t && (idx < 0 || l.start >= all[idx].start)) idx = i; });
  if (idx < 0) idx = 0;
  const row = $('lyList').querySelectorAll('.lyrow')[idx];
  row?.scrollIntoView({ block: 'center' });
  row?.querySelector('.txt')?.focus();
}
