export async function api(url, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, init);
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw new Error(data?.detail || `Request failed (${r.status})`);
  return data;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg, bad = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, bad ? 5000 : 2600);
}

export function fmt(sec, dec = 1) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`;
}

// Accepts "75", "1:15", "01:15.5", "1:02:03"
export function parseTime(str) {
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Upload with progress (fetch has no upload progress).
export function uploadFile(url, file, field, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData();
    fd.append(field, file);
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* empty */ }
      if (xhr.status >= 400) reject(new Error(data?.detail || 'Upload failed')); else resolve(data);
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(fd);
  });
}
