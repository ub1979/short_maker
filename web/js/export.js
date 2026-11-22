// Build the PNG layers for one short and send them to the server for ffmpeg.
import { normalize } from './templates.js';
import {
  W, H, newCanvas, resolveAssets, drawUnder, drawOver, drawMask, videoBox,
  clipChunks, captionStates, drawCaption,
} from './render.js';

const toBlob = (canvas) => new Promise((res) => canvas.toBlob(res, 'image/png'));

export async function buildRenderForm({ tpl, clip, project, brand }) {
  const t = normalize(tpl);
  const meta = project.source;
  const assets = await resolveAssets(t, brand);
  const form = new FormData();

  const under = newCanvas();
  drawUnder(under.getContext('2d'), t, meta, assets);
  form.append('under', await toBlob(under), 'under.png');

  const over = newCanvas();
  drawOver(over.getContext('2d'), t, meta, assets, brand, clip.title || project.name);
  form.append('over', await toBlob(over), 'over.png');

  const box = videoBox(t, meta);
  if (t.video.radius > 0) {
    const mask = newCanvas(box.w, box.h);
    drawMask(mask.getContext('2d'), t, meta);
    form.append('mask', await toBlob(mask), 'mask.png');
  }

  const captions = [];
  {
    const chunks = clipChunks(project, clip, t);
    const states = captionStates(chunks, t);
    const measure = newCanvas(8, 8).getContext('2d');
    for (const [i, st] of states.entries()) {
      const bounds = drawCaption(measure, t, st.chunk, st.active, 0, 0);
      const x = Math.max(0, bounds.x), y = Math.max(0, bounds.y);
      const c = newCanvas(Math.min(W - x, bounds.w), Math.min(H - y, bounds.h));
      drawCaption(c.getContext('2d'), t, st.chunk, st.active, x, y);
      form.append(`cap_${i}`, await toBlob(c), `cap_${i}.png`);
      captions.push({ start: +st.start.toFixed(3), end: +st.end.toFixed(3), x, y });
    }
  }

  form.append('layout', JSON.stringify({
    bg: t.bg.type === 'blur' ? 'blur' : 'flat',
    blur: t.bg.blur,
    video: box,
    captions,
  }));
  return form;
}
