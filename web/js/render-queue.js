// Render panel: pops up when shorts are rendering and shows each one with a
// picture, a live bar, and where it was saved.
import { api, esc, toast } from './util.js';

let ctx = null;          // { project(), retry(clip), select(id) }
const batch = new Set(); // clip ids shown in the panel
const local = new Map(); // id -> 'waiting' | 'preparing' | {error}: before the server knows about it
let minimized = false;
let dismissedAt = 0;

export function initRenderQueue(c) {
  ctx = c;
  const el = document.createElement('div');
  el.id = 'rq';
  el.className = 'rq';
  el.hidden = true;
  document.body.appendChild(el);
  el.addEventListener('click', onClick);
}

// The user pressed Render all / Render short: show these clips from now on.
export function rqStart(ids) {
  if (!ids.length) return;
  if (!busy()) batch.clear(); // a new round: forget the finished one
  for (const id of ids) { batch.add(id); local.set(id, 'waiting'); }
  minimized = false;
  dismissedAt = 0;
  rqUpdate();
}
export function rqPreparing(id) { local.set(id, 'preparing'); rqUpdate(); }
export function rqPosted(id) { local.delete(id); rqUpdate(); }
export function rqFailed(id, msg) { local.set(id, { error: msg }); rqUpdate(); }

export function rqBusy() { return busy(); }

function busy() {
  const p = ctx?.project();
  if (!p) return false;
  return [...batch].some((id) => {
    const st = state(p.clips.find((c) => c.id === id));
    return st.kind === 'waiting' || st.kind === 'preparing' || st.kind === 'queued' || st.kind === 'rendering';
  });
}

function state(c) {
  if (!c) return { kind: 'gone' };
  const l = local.get(c.id);
  if (l === 'waiting' || l === 'preparing') return { kind: l, p: 0 };
  if (l && l.error) return { kind: 'error', error: l.error };
  const r = c.render || {};
  if (r.status === 'queued') return { kind: 'queued', p: 0 };
  if (r.status === 'rendering') return { kind: 'rendering', p: r.progress || 0 };
  if (r.status === 'done') return { kind: 'done', p: 1, file: r.file };
  if (r.status === 'error') return { kind: 'error', error: r.error };
  return { kind: 'waiting', p: 0 };
}

const LABEL = { waiting: 'Waiting', preparing: 'Preparing captions & layers…', queued: 'In line…', rendering: 'Rendering', done: 'Saved', error: 'Failed' };

export function rqUpdate() {
  const el = document.getElementById('rq');
  const p = ctx?.project();
  if (!el) return;
  // also pick up renders started some other way (e.g. by the AI chat)
  if (p) for (const c of p.clips) if (['queued', 'rendering'].includes(c.render?.status)) batch.add(c.id);
  const clips = p ? [...batch].map((id) => p.clips.find((c) => c.id === id)).filter(Boolean) : [];
  if (!clips.length || (dismissedAt && !busy())) { el.hidden = true; return; }
  el.hidden = false;
  const rows = clips.map((c) => ({ c, s: state(c) }));
  const done = rows.filter((r) => r.s.kind === 'done').length;
  const failed = rows.filter((r) => r.s.kind === 'error').length;
  const total = rows.length;
  const overall = rows.reduce((a, r) => a + (r.s.kind === 'error' ? 1 : r.s.p || 0), 0) / total;
  const running = done + failed < total;
  let dir = p.output_dir ? p.output_dir.replace(/^\/Users\/[^/]+/, '~') : '';
  if (dir.length > 38) dir = '…/' + dir.split('/').filter(Boolean).slice(-2).join('/'); // full path on hover
  const head = running
    ? `Rendering shorts <span class="mono">${done} of ${total} done</span>`
    : failed ? `${done} saved, ${failed} failed` : `All ${total} short${total > 1 ? 's' : ''} saved`;
  el.classList.toggle('min', minimized);
  el.classList.toggle('finished', !running);
  if (minimized) {
    el.innerHTML = `<button class="rq-pill" data-act="max">${running ? '<span class="spin"></span>' : '✓'}
      <span>${running ? `Rendering ${done}/${total}` : head}</span>
      <span class="rq-pbar"><i style="width:${(overall * 100).toFixed(1)}%"></i></span></button>`;
    return;
  }
  el.innerHTML = `
    <div class="rq-head">
      <div class="rq-title">${running ? '<span class="spin"></span>' : (failed ? '!' : '✓')} ${head}</div>
      <button class="rq-x" data-act="min" title="Shrink">–</button>
      ${running ? '' : '<button class="rq-x" data-act="close" title="Close">✕</button>'}
    </div>
    <div class="rq-total"><i style="width:${(overall * 100).toFixed(1)}%"></i></div>
    ${dir ? `<div class="rq-dir">Saving to <b title="${esc(p.output_dir)}">${esc(dir)}</b> · <button class="link" data-act="open">Open folder</button></div>` : ''}
    <div class="rq-list">${rows.map(({ c, s }) => row(p, c, s)).join('')}</div>`;
}

function row(p, c, s) {
  const v = c.render?.status === 'done' ? `r${Math.round(c.render.finished || 0)}` : `s${c.start}`;
  const pct = Math.round((s.p || 0) * 100);
  let line;
  if (s.kind === 'done') {
    line = `<span class="ok">✓ ${esc(s.file || 'Saved')}</span>
      <a class="link" href="/media/${p.id}/render/${c.id}" target="_blank">Watch</a>`;
  } else if (s.kind === 'error') {
    line = `<span class="err" title="${esc(s.error || '')}">Failed: ${esc((s.error || '').slice(0, 60))}</span>
      <button class="link" data-act="retry" data-id="${c.id}">Try again</button>`;
  } else {
    line = `<span>${LABEL[s.kind]}${s.kind === 'rendering' ? ` ${pct}%` : ''}</span>`;
  }
  return `<div class="rq-row ${s.kind}" data-id="${c.id}">
    <div class="rq-thumb"><img src="/media/${p.id}/thumb/${c.id}?v=${v}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      ${s.kind === 'done' ? '<span class="rq-badge">✓</span>' : ''}</div>
    <div class="rq-info">
      <div class="rq-name"><span class="mono">#${c.num ?? '?'}</span> ${esc(c.title || 'Untitled short')}</div>
      <div class="rq-st">${line}</div>
      <div class="rq-bar ${s.kind}"><i style="width:${s.kind === 'error' ? 100 : pct}%"></i></div>
    </div>
  </div>`;
}

async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) {
    const r = e.target.closest('.rq-row');
    if (r && !e.target.closest('a')) ctx.select(r.dataset.id);
    return;
  }
  const act = b.dataset.act;
  if (act === 'min') { minimized = true; rqUpdate(); }
  else if (act === 'max') { minimized = false; rqUpdate(); }
  else if (act === 'close') { dismissedAt = Date.now(); batch.clear(); local.clear(); rqUpdate(); }
  else if (act === 'open') {
    try { await api(`/api/projects/${ctx.project().id}/output-dir/open`, { method: 'POST' }); } catch (err) { toast(err.message, true); }
  } else if (act === 'retry') {
    const c = ctx.project().clips.find((x) => x.id === b.dataset.id);
    if (c) { rqStart([c.id]); ctx.retry(c); }
  }
}

// a different video was opened
export function rqReset() { batch.clear(); local.clear(); minimized = false; dismissedAt = 0; rqUpdate(); }
