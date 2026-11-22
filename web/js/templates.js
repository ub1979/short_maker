// Built-in templates. Coordinates are in the 1080x1920 output frame.
// Any field left out falls back to BASE (see normalize()).

export const FONTS = [
  'Montserrat', 'Anton', 'Bebas Neue', 'Archivo Black', 'DM Serif Display', 'Playfair Display',
  'Poppins', 'Space Mono', 'Oswald', 'Syne', 'Caveat', 'Rubik Mono One',
];

export const BASE = {
  look: '',
  bg: {
    type: 'solid', // solid | gradient | blur | image
    color: '#000000',
    stops: ['#111111', '#333333'],
    angle: 180,
    image: '',
    tint: 'rgba(0,0,0,0)',
    pattern: 'none', // none | dots | grid | lines | grain
    patternColor: 'rgba(255,255,255,0.08)',
    vignette: 0,
    blur: { sigma: 14, brightness: -0.12 },
  },
  video: { y: 900, width: 1080, radius: 0, border: 0, borderColor: '#ffffff', shadow: 0, hardShadow: 0, shadowColor: 'rgba(0,0,0,0.55)' },
  title: { show: true, y: 410, font: 'Montserrat', size: 74, weight: 800, color: '#ffffff', upper: false, box: '', boxText: '', maxWidth: 940, lineHeight: 1.12, glow: '', prefix: '', align: 'center' },
  channel: { show: true, y: 215, font: 'Montserrat', size: 40, weight: 700, color: '#ffffff', handleColor: 'rgba(255,255,255,0.65)', logo: true, logoSize: 92, logoRing: '' },
  links: { show: true, y: 1405, font: 'Montserrat', size: 34, weight: 600, color: '#ffffff', box: 'rgba(255,255,255,0.12)', cta: true },
  captions: { y: 1300, font: 'Montserrat', size: 66, weight: 900, color: '#ffffff', active: '#FFD400', stroke: '#000000', strokeWidth: 10, box: '', upper: true, maxWords: 3, lineHeight: 1.15 },
  accents: [],
};

export const BUILTIN = [
  {
    id: 'midnight', name: 'Midnight', look: 'pure black, clean white bold text, yellow word highlight',
    bg: { type: 'solid', color: '#000000' },
  },
  {
    id: 'blur-classic', name: 'Blur Classic', look: 'blurred video fills the background, big Anton title',
    bg: { type: 'blur', tint: 'rgba(0,0,0,0.25)', blur: { sigma: 14, brightness: -0.12 } },
    title: { font: 'Anton', size: 92, weight: 400, upper: true, glow: 'rgba(0,0,0,0.7)' },
    captions: { font: 'Anton', weight: 400, size: 76, active: '#00E5FF' },
  },
  {
    id: 'frosted-card', name: 'Frosted Card', look: 'soft blurred background, rounded floating video card, white title pill',
    bg: { type: 'blur', tint: 'rgba(255,255,255,0.10)', blur: { sigma: 18, brightness: -0.04 } },
    video: { width: 960, radius: 40, shadow: 60 },
    title: { font: 'Poppins', weight: 800, size: 62, color: '#111111', box: '#ffffff' },
    channel: { font: 'Poppins' },
    links: { font: 'Poppins', box: 'rgba(255,255,255,0.85)', color: '#111111' },
    captions: { font: 'Poppins', weight: 800, active: '#FF4D8D' },
  },
  {
    id: 'sunset', name: 'Sunset Pop', look: 'warm orange-pink gradient, tall Bebas Neue letters',
    bg: { type: 'gradient', stops: ['#ff9a3c', '#ff3d6e', '#7a1f5c'], angle: 165, pattern: 'grain', patternColor: 'rgba(255,255,255,0.06)' },
    video: { width: 980, radius: 28, shadow: 50, shadowColor: 'rgba(80,0,30,0.55)' },
    title: { font: 'Bebas Neue', weight: 400, size: 118, lineHeight: 0.98 },
    channel: { font: 'Bebas Neue', weight: 400, size: 50, handleColor: 'rgba(255,255,255,0.8)' },
    links: { font: 'Bebas Neue', weight: 400, size: 44, box: 'rgba(0,0,0,0.18)' },
    captions: { font: 'Bebas Neue', weight: 400, size: 92, active: '#FFE45C', strokeWidth: 8 },
  },
  {
    id: 'ocean', name: 'Deep Ocean', look: 'navy-teal gradient with a dot pattern, elegant serif title',
    bg: { type: 'gradient', stops: ['#031b2e', '#0a4a63', '#04121f'], angle: 180, pattern: 'dots', patternColor: 'rgba(120,220,255,0.10)' },
    video: { radius: 0, border: 0 },
    title: { font: 'DM Serif Display', weight: 400, size: 86, color: '#e8f6ff' },
    channel: { font: 'DM Serif Display', weight: 400, size: 44 },
    captions: { active: '#5ef2d6' },
  },
  {
    id: 'neon-grid', name: 'Neon Grid', look: 'dark synthwave grid, magenta border, glowing cyan title',
    bg: { type: 'solid', color: '#07020f', pattern: 'grid', patternColor: 'rgba(255,43,214,0.16)', vignette: 0.6 },
    video: { width: 1000, border: 5, borderColor: '#ff2bd6', shadow: 40, shadowColor: 'rgba(255,43,214,0.6)' },
    title: { font: 'Syne', weight: 800, size: 78, color: '#00f0ff', upper: true, glow: 'rgba(0,240,255,0.8)' },
    channel: { font: 'Syne', weight: 800, color: '#ff2bd6', handleColor: 'rgba(0,240,255,0.8)', logoRing: '#ff2bd6' },
    links: { font: 'Syne', weight: 800, color: '#00f0ff', box: 'rgba(255,43,214,0.15)' },
    captions: { font: 'Syne', weight: 800, active: '#ff2bd6', stroke: '#07020f' },
    accents: [{ type: 'bar', x: 340, y: 572, w: 400, h: 6, color: '#00f0ff' }],
  },
  {
    id: 'editorial', name: 'Editorial Paper', look: 'cream paper, black serif headline, red accent, magazine feel',
    bg: { type: 'solid', color: '#f2ece0', pattern: 'grain', patternColor: 'rgba(60,40,20,0.07)' },
    video: { width: 960, radius: 6, border: 6, borderColor: '#141414' },
    title: { font: 'DM Serif Display', weight: 400, size: 88, color: '#141414' },
    channel: { font: 'DM Serif Display', weight: 400, color: '#141414', handleColor: '#ff4a1c' },
    links: { font: 'Montserrat', color: '#f2ece0', box: '#141414' },
    captions: { font: 'Montserrat', weight: 800, color: '#f2ece0', active: '#ff4a1c', stroke: '', strokeWidth: 0, box: '#141414', upper: false, size: 58 },
    accents: [{ type: 'bar', x: 470, y: 584, w: 140, h: 8, color: '#ff4a1c' }],
  },
  {
    id: 'mint-brutal', name: 'Mint Brutal', look: 'mint background, thick black border, hard offset shadow',
    bg: { type: 'solid', color: '#b9f5d8' },
    video: { width: 960, border: 8, borderColor: '#111111', hardShadow: 22, shadowColor: '#111111' },
    title: { font: 'Archivo Black', weight: 400, size: 74, color: '#111111', box: '#ffffff' },
    channel: { font: 'Archivo Black', weight: 400, color: '#111111', handleColor: 'rgba(0,0,0,0.6)', logoRing: '#111111' },
    links: { font: 'Archivo Black', weight: 400, color: '#111111', box: '#ffffff' },
    captions: { font: 'Archivo Black', weight: 400, color: '#111111', stroke: '#ffffff', strokeWidth: 10, active: '#ff3d7f' },
  },
  {
    id: 'podcast', name: 'Podcast Studio', look: 'warm dark brown, amber Oswald title, cozy studio feel',
    bg: { type: 'gradient', stops: ['#2e1a10', '#140b06'], angle: 180, vignette: 0.5 },
    video: { width: 1000, radius: 18, border: 3, borderColor: '#ff9f43', shadow: 40 },
    title: { font: 'Oswald', weight: 700, size: 84, color: '#f5d7a1', upper: true },
    channel: { font: 'Oswald', weight: 600, size: 44, color: '#f5d7a1', handleColor: '#ff9f43', logoRing: '#ff9f43' },
    links: { font: 'Oswald', weight: 600, color: '#f5d7a1', box: 'rgba(255,159,67,0.15)' },
    captions: { font: 'Oswald', weight: 700, size: 74, active: '#ff9f43' },
  },
  {
    id: 'terminal', name: 'Terminal', look: 'black hacker terminal, green monospace, scanlines',
    bg: { type: 'solid', color: '#050a06', pattern: 'lines', patternColor: 'rgba(57,255,122,0.05)' },
    video: { width: 1000, border: 3, borderColor: '#39ff7a' },
    title: { font: 'Space Mono', weight: 700, size: 60, color: '#39ff7a', prefix: '> ', glow: 'rgba(57,255,122,0.5)' },
    channel: { font: 'Space Mono', weight: 700, size: 36, color: '#39ff7a', handleColor: 'rgba(57,255,122,0.6)', logoRing: '#39ff7a' },
    links: { font: 'Space Mono', weight: 700, size: 30, color: '#39ff7a', box: 'rgba(57,255,122,0.08)' },
    captions: { font: 'Space Mono', weight: 700, size: 56, color: '#39ff7a', active: '#ffffff', stroke: '#050a06', upper: false },
  },
  {
    id: 'gold-luxe', name: 'Gold Luxe', look: 'black and gold, Playfair serif, fine gold lines, premium',
    bg: { type: 'gradient', stops: ['#000000', '#1b1408', '#000000'], angle: 180 },
    video: { width: 1000, border: 2, borderColor: '#e9c46a' },
    title: { font: 'Playfair Display', weight: 900, size: 80, color: '#e9c46a' },
    channel: { font: 'Playfair Display', weight: 700, color: '#e9c46a', handleColor: 'rgba(233,196,106,0.65)', logoRing: '#e9c46a' },
    links: { font: 'Playfair Display', weight: 700, color: '#e9c46a', box: 'rgba(233,196,106,0.10)' },
    captions: { font: 'Playfair Display', weight: 900, active: '#e9c46a', upper: false },
    accents: [
      { type: 'bar', x: 140, y: 588, w: 800, h: 2, color: '#e9c46a' },
      { type: 'bar', x: 140, y: 1212, w: 800, h: 2, color: '#e9c46a' },
    ],
  },
  {
    id: 'bubblegum', name: 'Bubblegum', look: 'hot pink, white rounded frame, playful black title box',
    bg: { type: 'solid', color: '#ff7eb6', pattern: 'dots', patternColor: 'rgba(255,255,255,0.22)' },
    video: { width: 960, radius: 44, border: 8, borderColor: '#ffffff', shadow: 30, shadowColor: 'rgba(120,0,60,0.4)' },
    title: { font: 'Poppins', weight: 800, size: 66, color: '#ffffff', box: '#111111' },
    channel: { font: 'Poppins', weight: 800, logoRing: '#ffffff' },
    links: { font: 'Poppins', weight: 800, box: '#111111' },
    captions: { font: 'Poppins', weight: 800, active: '#fff35c' },
  },
  {
    id: 'blur-spotlight', name: 'Blur Spotlight', look: 'dark blurred background with vignette, huge lime captions',
    bg: { type: 'blur', tint: 'rgba(0,0,0,0.15)', vignette: 0.8, blur: { sigma: 20, brightness: -0.25 } },
    title: { font: 'Montserrat', weight: 900, size: 80, upper: true },
    captions: { size: 84, active: '#a3ff12', strokeWidth: 12 },
  },
  {
    id: 'split-tone', name: 'Split Tone', look: 'two-tone black top and red bottom, bold Anton',
    bg: { type: 'gradient', stops: [['#111111', 0], ['#111111', 0.5], ['#e63946', 0.5], ['#e63946', 1]], angle: 180 },
    title: { font: 'Anton', weight: 400, size: 96, upper: true },
    channel: { font: 'Anton', weight: 400, size: 46 },
    links: { font: 'Anton', weight: 400, size: 40, box: 'rgba(0,0,0,0.25)' },
    captions: { font: 'Anton', weight: 400, size: 80, active: '#ffd60a', stroke: '#111111' },
  },
];

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function normalize(tpl) {
  return deepMerge(BASE, tpl || {});
}

export function clone(x) { return JSON.parse(JSON.stringify(x)); }
