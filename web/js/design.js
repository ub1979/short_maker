// Template editor form: a schema of fields mapped to template paths.
import { FONTS } from './templates.js';

const WEIGHTS = ['400', '600', '700', '800', '900'];

export const SCHEMA = [
  { group: 'Background', open: true, fields: [
    ['bg.type', 'Type', 'select', ['solid', 'gradient', 'blur', 'image']],
    ['bg.color', 'Color', 'color'],
    ['bg.stops.0', 'Gradient color 1', 'stop'],
    ['bg.stops.1', 'Gradient color 2', 'stop'],
    ['bg.stops.2', 'Gradient color 3', 'stop'],
    ['bg.angle', 'Gradient angle', 'range', [0, 360, 5]],
    ['bg.image', 'Background image', 'image'],
    ['bg.tint', 'Tint overlay', 'color'],
    ['bg.pattern', 'Pattern', 'select', ['none', 'dots', 'grid', 'lines', 'grain']],
    ['bg.patternColor', 'Pattern color', 'color'],
    ['bg.vignette', 'Vignette', 'range', [0, 1, 0.05]],
    ['bg.blur.sigma', 'Blur amount', 'range', [4, 30, 1]],
    ['bg.blur.brightness', 'Blur brightness', 'range', [-0.5, 0.2, 0.01]],
  ] },
  { group: 'Video box', open: true, fields: [
    ['video.y', 'Vertical position', 'range', [300, 1620, 2]],
    ['video.width', 'Width', 'range', [500, 1080, 2]],
    ['video.radius', 'Corner radius', 'range', [0, 90, 1]],
    ['video.border', 'Border', 'range', [0, 24, 1]],
    ['video.borderColor', 'Border color', 'color'],
    ['video.shadow', 'Soft shadow', 'range', [0, 120, 2]],
    ['video.hardShadow', 'Hard shadow', 'range', [0, 40, 1]],
    ['video.shadowColor', 'Shadow color', 'color'],
  ] },
  { group: 'Title', fields: [
    ['title.show', 'Show title', 'check'],
    ['title.upper', 'UPPERCASE', 'check'],
    ['title.y', 'Vertical position', 'range', [60, 1860, 2]],
    ['title.size', 'Size', 'range', [28, 170, 1]],
    ['title.lineHeight', 'Line spacing', 'range', [0.8, 2.2, 0.05]],
    ['title.font', 'Font', 'select', FONTS],
    ['title.weight', 'Weight', 'select', WEIGHTS],
    ['title.color', 'Color', 'color'],
    ['title.box', 'Box behind text', 'color'],
    ['title.glow', 'Glow / shadow', 'color'],
    ['title.prefix', 'Prefix', 'text'],
  ] },
  { group: 'Channel (logo, name, handle)', fields: [
    ['channel.show', 'Show channel', 'check'],
    ['channel.logo', 'Show logo', 'check'],
    ['channel.y', 'Vertical position', 'range', [60, 1860, 2]],
    ['channel.size', 'Size', 'range', [20, 90, 1]],
    ['channel.logoSize', 'Logo size', 'range', [40, 200, 2]],
    ['channel.font', 'Font', 'select', FONTS],
    ['channel.color', 'Name color', 'color'],
    ['channel.handleColor', 'Handle color', 'color'],
    ['channel.logoRing', 'Logo ring', 'color'],
  ] },
  { group: 'Links & call to action', fields: [
    ['links.show', 'Show links', 'check'],
    ['links.cta', 'Show call to action', 'check'],
    ['links.y', 'Vertical position', 'range', [60, 1860, 2]],
    ['links.size', 'Size', 'range', [18, 70, 1]],
    ['links.font', 'Font', 'select', FONTS],
    ['links.color', 'Text color', 'color'],
    ['links.box', 'Pill color', 'color'],
  ] },
  { group: 'Captions', fields: [
    ['captions.y', 'Vertical position', 'range', [100, 1820, 2]],
    ['captions.size', 'Size', 'range', [30, 130, 1]],
    ['captions.lineHeight', 'Line spacing', 'range', [0.8, 2.5, 0.05]],
    ['captions.maxWords', 'Words at a time', 'range', [1, 7, 1]],
    ['captions.font', 'Font', 'select', FONTS],
    ['captions.weight', 'Weight', 'select', WEIGHTS],
    ['captions.upper', 'UPPERCASE', 'check'],
    ['captions.color', 'Text color', 'color'],
    ['captions.active', 'Highlight spoken word', 'color'],
    ['captions.stroke', 'Outline color', 'color'],
    ['captions.strokeWidth', 'Outline width', 'range', [0, 20, 1]],
    ['captions.box', 'Box behind text', 'color'],
  ] },
];

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  });
  o[keys[keys.length - 1]] = value;
}

function toHex(c) {
  if (!c) return '#000000';
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + [...c.slice(1)].map((x) => x + x).join('');
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x));
    return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
  }
  return '#000000';
}

function relevant(path, tpl) {
  const type = tpl.bg.type;
  if (path === 'bg.color') return type === 'solid' || type === 'image';
  if (path.startsWith('bg.stops') || path === 'bg.angle') return type === 'gradient';
  if (path === 'bg.image') return type === 'image';
  if (path.startsWith('bg.blur')) return type === 'blur';
  return true;
}

// Render the form. onChange(path, value) is called for every edit.
export function renderDesignForm(root, tpl, { onChange, onUploadImage }) {
  const openState = new Map([...root.querySelectorAll('details')].map((d) => [d.dataset.g, d.open]));
  root.innerHTML = '';
  for (const g of SCHEMA) {
    const det = document.createElement('details');
    det.className = 'dgroup';
    det.dataset.g = g.group;
    det.open = openState.has(g.group) ? openState.get(g.group) : !!g.open;
    det.innerHTML = `<summary>${g.group}</summary><div class="dbody"></div>`;
    const body = det.querySelector('.dbody');
    for (const [path, label, type, opts] of g.fields) {
      if (!relevant(path, tpl)) continue;
      const value = getPath(tpl, path);
      const f = document.createElement('div');
      f.className = 'dfield' + (type === 'image' || type === 'text' ? ' full' : '');
      if (type === 'check') {
        f.innerHTML = `<label class="cb"><input type="checkbox"> ${label}</label>`;
        const cb = f.querySelector('input');
        cb.checked = !!value;
        cb.onchange = () => onChange(path, cb.checked);
      } else if (type === 'select') {
        f.innerHTML = `${label}<select>${opts.map((o) => `<option>${o}</option>`).join('')}</select>`;
        const s = f.querySelector('select');
        s.value = String(value);
        s.onchange = () => onChange(path, /^\d+$/.test(s.value) && path.endsWith('weight') ? +s.value : s.value, true);
      } else if (type === 'range') {
        const [min, max, step] = opts;
        f.innerHTML = `<span>${label} <b class="mono">${value}</b></span><input type="range" min="${min}" max="${max}" step="${step}">`;
        const r = f.querySelector('input'), b = f.querySelector('b');
        r.value = value ?? min;
        r.oninput = () => { b.textContent = r.value; onChange(path, +r.value); };
      } else if (type === 'color' || type === 'stop') {
        const raw = type === 'stop' && Array.isArray(value) ? value[0] : value;
        f.innerHTML = `${label}<div class="colorrow"><input type="color"><input type="text" placeholder="none"></div>`;
        const [pick, txt] = f.querySelectorAll('input');
        pick.value = toHex(raw);
        txt.value = raw || '';
        const emit = (c) => onChange(path, type === 'stop' && Array.isArray(value) ? [c, value[1]] : c);
        pick.oninput = () => { txt.value = pick.value; emit(pick.value); };
        txt.onchange = () => { if (txt.value) pick.value = toHex(txt.value); emit(txt.value.trim()); };
      } else if (type === 'text') {
        f.innerHTML = `${label}<input type="text">`;
        const t = f.querySelector('input');
        t.value = value || '';
        t.oninput = () => onChange(path, t.value);
      } else if (type === 'image') {
        f.innerHTML = `${label}<div class="colorrow"><button type="button" class="small">Upload image</button><span class="mono dim">${value ? value.split('/').pop() : 'none'}</span></div>`;
        f.querySelector('button').onclick = onUploadImage;
      }
      body.appendChild(f);
    }
    root.appendChild(det);
  }
}
