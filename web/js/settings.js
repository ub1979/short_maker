// AI connections dialog (Appling-style: CLI sign-in, Ollama, OpenAI-compatible, Anthropic API).
import { api, toast, esc } from './util.js';

const ENGINES = {
  'claude-cli': 'Claude Code (signed in)',
  codex: 'Codex CLI (signed in)',
  ollama: 'Ollama (local)',
  'openai-compatible': 'OpenAI-compatible API',
  anthropic: 'Anthropic API',
};

let settings = null;

export async function openSettings(onSaved) {
  settings = await api('/api/settings');
  const dlg = document.getElementById('settingsDlg');
  document.getElementById('whisperModel').value = settings.whisper_model;
  draw();
  document.getElementById('addConn').onclick = () => {
    settings.connections.push({ id: 'c' + Math.random().toString(36).slice(2, 8), name: 'New connection', engine: 'openai-compatible', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY', model: '' });
    draw();
  };
  document.getElementById('sSave').onclick = async (e) => {
    e.preventDefault();
    collect();
    settings.whisper_model = document.getElementById('whisperModel').value;
    settings = await api('/api/settings', { method: 'PUT', body: settings });
    toast('Settings saved');
    dlg.close();
    onSaved?.(settings);
  };
  dlg.showModal();
}

function collect() {
  document.querySelectorAll('#connList .conn').forEach((el, i) => {
    const c = settings.connections[i];
    el.querySelectorAll('[data-k]').forEach((inp) => { c[inp.dataset.k] = inp.value.trim(); });
    if (el.querySelector('.radio input').checked) settings.active_connection = c.id;
  });
}

function draw() {
  const root = document.getElementById('connList');
  root.innerHTML = '';
  settings.connections.forEach((c, i) => {
    const el = document.createElement('div');
    const api_ = ['ollama', 'openai-compatible', 'anthropic'].includes(c.engine);
    el.className = 'conn' + (settings.active_connection === c.id ? ' active' : '');
    el.innerHTML = `
      <label class="radio" title="Use this one for chat"><input type="radio" name="activeConn" ${settings.active_connection === c.id ? 'checked' : ''}></label>
      <label class="field">Name<input data-k="name" value="${esc(c.name || '')}"></label>
      <label class="field">Type<select data-k="engine">${Object.entries(ENGINES).map(([k, v]) => `<option value="${k}" ${k === c.engine ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <span></span>
      <label class="field">Model<input data-k="model" list="models-${i}" value="${esc(c.model || '')}" placeholder="${c.engine === 'codex' ? 'CLI default' : 'pick or type'}"><datalist id="models-${i}"></datalist></label>
      ${api_ ? `<label class="field">Server URL<input data-k="base_url" value="${esc(c.base_url || '')}" placeholder="default"></label>` : '<span></span>'}
      ${api_ ? `<span></span><label class="field">API key env variable<input data-k="api_key_env" value="${esc(c.api_key_env || '')}" placeholder="${c.engine === 'ollama' ? 'not needed' : 'OPENAI_API_KEY'}"></label><span></span>` : ''}
      <div class="row">
        <button type="button" class="small" data-act="models">Refresh models</button>
        <button type="button" class="small" data-act="test">Test</button>
        <button type="button" class="small danger" data-act="del">Remove</button>
        <span class="status"></span>
      </div>`;
    const status = el.querySelector('.status');
    const current = () => {
      const o = { ...c };
      el.querySelectorAll('[data-k]').forEach((inp) => { o[inp.dataset.k] = inp.value.trim(); });
      return o;
    };
    el.querySelector('.radio input').onchange = () => { collect(); draw(); };
    el.querySelector('[data-k=engine]').onchange = () => { collect(); draw(); };
    el.querySelector('[data-act=models]').onclick = async () => {
      status.className = 'status'; status.textContent = 'Checking…';
      try {
        const r = await api('/api/connections/discover', { method: 'POST', body: { connection: current() } });
        el.querySelector('datalist').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
        status.className = 'status ' + (r.ok ? 'ok' : 'bad'); status.textContent = r.message;
      } catch (e) { status.className = 'status bad'; status.textContent = e.message; }
    };
    el.querySelector('[data-act=test]').onclick = async () => {
      status.className = 'status'; status.textContent = 'Asking the model…';
      try {
        const r = await api('/api/connections/test', { method: 'POST', body: { connection: current() } });
        status.className = 'status ' + (r.ok ? 'ok' : 'bad');
        status.textContent = (r.ok ? '✓ ' : '✗ ') + r.message + ` (${(r.ms / 1000).toFixed(1)}s)`;
      } catch (e) { status.className = 'status bad'; status.textContent = e.message; }
    };
    el.querySelector('[data-act=del]').onclick = () => { collect(); settings.connections.splice(i, 1); draw(); };
    root.appendChild(el);
    el.querySelector('[data-act=models]').click();
  });
}

export async function activeConnectionLabel() {
  const s = await api('/api/settings');
  const c = s.connections.find((x) => x.id === s.active_connection);
  return c ? `${c.name}${c.model ? ' · ' + c.model : ''}` : 'no AI connected';
}
