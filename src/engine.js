// Talks to whichever AI backend the user picked. explain() always returns { promise, cancel }.
const { spawn } = require('child_process');
const os = require('os');

const SYSTEM = `You are Magpie, a quick-explainer that appears in a small floating window next to what the reader is reading.
Answer the reader's question, or explain the passage they selected, for someone smart who is new to the topic.
Rules: plain language, no preamble, no closing offer. Lead with the direct answer or a one-sentence definition,
then 3-6 short lines of what matters. Keep it under 180 words.
You MUST wrap 2-4 technical terms the reader may not know in [[double brackets]]
(e.g. "uses [[photolithography]] to etch the chip"), every time, so they become clickable.
Use the already-known terms and the parent trail (if given) to avoid re-explaining and to stay in context.`;

const TRANSLATE_SYSTEM = `You are Magpie's translator. Translate the text the reader gives you.
Rules: output only the translation, keeping the line breaks and lists of the original. No preamble, no notes,
no quotation marks around it. Then add one final line: (Translated from <source language>)`;

// `withImage`: the snip itself is attached to the request (the provider can look at images).
function buildPrompt({ question = '', selection = '', trail = [], known = [], app = null, from = null, snip = null }, withImage = false) {
  let p = '';
  if (app && (app.process || app.title)) p += `The reader is currently in (background only, not the topic): ${[app.process, app.title].filter(Boolean).join(' - ')}\n`;
  if (trail.length) p += `Parent trail (what the reader came from): ${trail.join(' > ')}\n`;
  if (known.length) p += `Terms the reader already knows (do not explain): ${known.slice(-200).join(', ')}\n`;
  p += '\n';
  if (snip) {
    p += `The reader drew around part of their screen${withImage ? ' (the image is attached)' : ''}.\n`;
    if (snip.ocr) p += `Text read from it by OCR (it may contain misread letters: read past them, never point them out):\n"""\n${String(snip.ocr).slice(0, 6000)}\n"""\n`;
    p += question ? `Their question about it: ${question}` : 'Explain what it shows.';
  } else if (from && (from.answer || from.question)) {
    // a term clicked inside an earlier answer: explain it as used there
    p += `The reader was reading an explanation`;
    if (from.question || from.selection) p += ` of "${String(from.question || from.selection).slice(0, 300)}"`;
    if (from.answer) p += `:\n"""\n${String(from.answer).slice(0, 3000)}\n"""\n`;
    else p += '.\n';
    p += `They clicked the term "${question}" in it. Explain what "${question}" means in that context.`;
  } else if (selection && question) p += `The reader selected this passage:\n"""\n${selection}\n"""\nTheir question about it: ${question}`;
  else if (selection) p += `Explain this passage the reader selected:\n"""\n${selection}\n"""`;
  else p += question;
  return p;
}

function buildTranslatePrompt({ snip = null, selection = '', target = 'English' }) {
  const text = (snip && snip.ocr) || selection;
  const otherwise = target === 'English' ? 'reply with one short line saying it is already in English' : 'translate it into English instead';
  return `Translate this into ${target}. If it is already in ${target}, ${otherwise}.\n"""\n${String(text).slice(0, 8000)}\n"""`;
}

// ================================================================== Claude Code (warm spare)
// Starting `claude` costs ~3.5 s. So when the user presses the hotkey we start one early and
// park it waiting for stdin; by the time they hit Enter it is ready.
const spares = new Map(); // model -> { child, timer }

const claudeArgs = (model) => [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
  '--model', model, '--system-prompt', SYSTEM, '--tools', '',
  '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
];
const spawnClaude = (model) => {
  const child = spawn('claude', claudeArgs(model), { cwd: os.tmpdir(), windowsHide: true });
  child.on('error', () => {});
  return child;
};
const alive = (c) => c && c.exitCode === null && !c.killed;

function prewarmClaude(model) {
  const cur = spares.get(model);
  if (cur && alive(cur.child)) {
    clearTimeout(cur.timer);
    cur.timer = setTimeout(() => dropSpare(model, cur), 90000);
    return;
  }
  const entry = { child: spawnClaude(model), timer: null };
  entry.timer = setTimeout(() => dropSpare(model, entry), 90000);
  entry.child.on('close', () => spares.get(model) === entry && spares.delete(model));
  spares.set(model, entry);
}
function dropSpare(model, entry) {
  if (spares.get(model) === entry) spares.delete(model);
  clearTimeout(entry.timer);
  try { entry.child.kill(); } catch {}
}
function takeClaude(model) {
  const e = spares.get(model);
  if (e && alive(e.child)) {
    clearTimeout(e.timer);
    spares.delete(model);
    return e.child;
  }
  return spawnClaude(model);
}

function viaClaude(prompt, onDelta, cfg) {
  const model = cfg.model || 'haiku';
  const child = takeClaude(model);
  let full = '', buf = '', err = '', done = false, cancelled = false, timer;
  const promise = new Promise((resolve, reject) => {
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      setTimeout(() => { try { child.kill(); } catch {} }, 300);
      fn(v);
    };
    timer = setTimeout(() => finish(reject, new Error('No response after 60 seconds.')), 60000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const delta = ev.type === 'stream_event' && ev.event?.delta?.type === 'text_delta' ? ev.event.delta.text : null;
        if (delta) { full += delta; onDelta(delta); }
        else if (ev.type === 'result') {
          if (ev.is_error) return finish(reject, new Error(String(ev.result || 'Claude Code returned an error').slice(0, 400)));
          if (!full && typeof ev.result === 'string') { full = ev.result; onDelta(ev.result); }
          return finish(resolve, full);
        }
      }
    });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => finish(reject, new Error(`Could not start "claude": ${e.message}. Is Claude Code installed and on PATH?`)));
    child.on('close', (code) => {
      if (cancelled) return finish(resolve, null);
      if (full) return finish(resolve, full);
      finish(reject, new Error(err.trim().slice(0, 400) || `claude exited with code ${code}`));
    });
  });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
  return { promise, cancel: () => { cancelled = true; try { child.kill(); } catch {} } };
}

// ================================================================== other command-line apps
const SAFE_MODEL = /^[\w.\-:/@]+$/;
function viaCommand(commandLine, stdinText, onDelta) {
  if (!commandLine || /[\r\n]/.test(commandLine)) {
    return { promise: Promise.reject(new Error('Set the command in Settings.')), cancel() {} };
  }
  const child = spawn(commandLine, { shell: true, cwd: os.tmpdir(), windowsHide: true });
  child.stdout.setEncoding('utf8');
  let full = '', err = '', cancelled = false;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('No response after 90 seconds.')); }, 90000);
    child.stdout.on('data', (t) => { full += t; onDelta(t); });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (cancelled) return resolve(null);
      if (code === 0 || full.trim()) return resolve(full);
      reject(new Error(err.trim().slice(-400) || `Command exited with code ${code}`));
    });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(stdinText);
  return { promise, cancel: () => { cancelled = true; try { child.kill(); } catch {} } };
}
const modelFlag = (cfg) => {
  if (!cfg.model) return '';
  if (!SAFE_MODEL.test(cfg.model)) throw new Error('Model name has unsupported characters.');
  return ` -m ${cfg.model}`;
};

// ================================================================== HTTP APIs (streamed)
function viaHttp(run, onDelta) {
  const ac = new AbortController();
  let cancelled = false;
  const timer = setTimeout(() => ac.abort(), 60000);
  const promise = (async () => {
    let full = '';
    try {
      await run(ac.signal, (t) => { full += t; onDelta(t); });
      return full;
    } catch (e) {
      if (cancelled) return null;
      if (e.name === 'AbortError') throw new Error('No response after 60 seconds.');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  })();
  return { promise, cancel: () => { cancelled = true; ac.abort(); } };
}
async function sse(url, init, signal, onEvent) {
  const res = await fetch(url, { ...init, signal });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${t ? ': ' + t.slice(0, 300) : ''}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(d); } catch { continue; }
      onEvent(ev);
    }
  }
}
const needKey = (cfg) => {
  if (!cfg.noKey && !cfg.apiKey) throw new Error(`No API key set for ${cfg.label}. Add it in Settings.`);
};
const needModel = (cfg) => {
  if (!cfg.model) throw new Error(`Choose a model for ${cfg.label} in Settings.`);
};

function viaOpenAI(prompt, onDelta, cfg, { system = SYSTEM, image = null } = {}) {
  needKey(cfg); needModel(cfg);
  if (!cfg.baseUrl) throw new Error('Set the base URL in Settings.');
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  return viaHttp((signal, emit) =>
    sse(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({
        model: cfg.model, stream: true, temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: image ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } }] : prompt },
        ],
      }),
    }, signal, (ev) => {
      if (ev.error) throw new Error(ev.error.message || 'API error');
      const t = ev.choices?.[0]?.delta?.content;
      if (t) emit(t);
    }), onDelta);
}
function viaAnthropic(prompt, onDelta, cfg, { system = SYSTEM, image = null } = {}) {
  needKey(cfg); needModel(cfg);
  return viaHttp((signal, emit) =>
    sse(`${(cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.model, max_tokens: 800, stream: true, system,
        messages: [{ role: 'user', content: image ? [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }, { type: 'text', text: prompt }] : prompt }],
      }),
    }, signal, (ev) => {
      if (ev.type === 'error') throw new Error(ev.error?.message || 'API error');
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit(ev.delta.text);
    }), onDelta);
}
function viaGemini(prompt, onDelta, cfg, { system = SYSTEM, image = null } = {}) {
  needKey(cfg); needModel(cfg);
  const url = `${(cfg.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`;
  return viaHttp((signal, emit) =>
    sse(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [...(image ? [{ inline_data: { mime_type: image.mime, data: image.data } }] : []), { text: prompt }] }],
      }),
    }, signal, (ev) => {
      if (ev.error) throw new Error(ev.error.message || 'API error');
      const t = (ev.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (t) emit(t);
    }), onDelta);
}

// ================================================================== public API
const failed = (e) => ({ promise: Promise.reject(e), cancel() {} });
const SEES_IMAGES = new Set(['openai', 'anthropic', 'gemini']); // providers that can be sent an image at all

function run(prompt, onDelta, cfg, { system, image }) {
  try {
    switch (cfg.type) {
      // Claude Code is pre-started with the usual instructions, so other instructions travel in the prompt
      case 'claude-cli': return viaClaude(system === SYSTEM ? prompt : `${system}\n\n${prompt}`, onDelta, cfg);
      case 'cli-gemini': return viaCommand(`${cfg.command || 'gemini'}${modelFlag(cfg)} -p "Follow the instructions in the input."`, `${system}\n\n${prompt}`, onDelta);
      case 'cli-codex': return viaCommand(`${cfg.command || 'codex'} exec --skip-git-repo-check -s read-only${modelFlag(cfg)} -`, `${system}\n\n${prompt}`, onDelta);
      case 'cli-custom': return viaCommand(cfg.command, `${system}\n\n${prompt}`, onDelta);
      case 'anthropic': return viaAnthropic(prompt, onDelta, cfg, { system, image });
      case 'gemini': return viaGemini(prompt, onDelta, cfg, { system, image });
      case 'openai': return viaOpenAI(prompt, onDelta, cfg, { system, image });
      default: return failed(new Error(`Unknown provider type: ${cfg.type}`));
    }
  } catch (e) {
    return failed(e);
  }
}

// A model that only reads text rejects a request with an image (Groq's gpt-oss, for example) with an error like
// "400 ... does not support image input". Then the question is asked again with just the text read from the snip.
const imageRefused = (msg) => /^4(00|04|13|15|22)\b/.test(msg) || /image|vision|multimodal|modalit/i.test(msg);
const noVision = (cfg) => new Error(`No text was found in the snip, and ${cfg.label}${cfg.model ? ` (${cfg.model})` : ''} can't look at images. In Settings, pick a model that can, for example Google Gemini API (free).`);

// input.snip: { image: { mime, data (base64) } | null, ocr: text read from it }.
// input.mode 'translate': translate the snip's text (or the selection) into input.target.
function explain(input, onDelta, cfg) {
  if (input.mode === 'translate') {
    if (!((input.snip && input.snip.ocr) || input.selection)) return failed(new Error('No text was found to translate.'));
    return run(buildTranslatePrompt(input), onDelta, cfg, { system: TRANSLATE_SYSTEM, image: null });
  }
  const snip = input.snip;
  const canSee = !!(snip && snip.image && SEES_IMAGES.has(cfg.type));
  if (snip && !canSee && !snip.ocr) return failed(noVision(cfg));
  if (!canSee) return run(buildPrompt(input, false), onDelta, cfg, { system: SYSTEM, image: null });

  let job, cancelled = false, emitted = false;
  const track = (t) => { emitted = true; onDelta(t); };
  job = run(buildPrompt(input, true), track, cfg, { system: SYSTEM, image: snip.image });
  const promise = job.promise.catch((e) => {
    if (cancelled || emitted || !imageRefused(String(e.message))) throw e;
    if (!snip.ocr) throw noVision(cfg);
    job = run(buildPrompt(input, false), track, cfg, { system: SYSTEM, image: null });
    return job.promise;
  });
  return { promise, cancel: () => { cancelled = true; job.cancel(); } };
}

// Start the slow part early (only Claude Code has one).
function prewarm(cfg) {
  if (cfg.type === 'claude-cli') prewarmClaude(cfg.model || 'haiku');
}

async function test(cfg) {
  const t0 = Date.now();
  let first = null;
  try {
    const job = explain({ question: 'Reply with the single word: OK' }, () => { if (first === null) first = Date.now() - t0; }, cfg);
    const timeout = new Promise((_, rej) => setTimeout(() => { job.cancel(); rej(new Error('Timed out after 45 seconds.')); }, 45000));
    const text = await Promise.race([job.promise, timeout]);
    return { ok: true, ms: Date.now() - t0, firstMs: first, text: String(text || '').trim().slice(0, 80) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- live model lists ---------------------------------------------------------------------
// New models appear on their own: once a key is saved we ask the provider what it offers right now.
// Things that are not chat models (speech, embeddings, safety classifiers, image models) are hidden.
const NOT_CHAT = /whisper|tts|orpheus|embed|guard|moderation|dall-e|imagen|image|transcri|audio|realtime|rerank|safeguard|speech|veo|lyria|aqa|^text-/i;

async function getJson(url, headers, what) {
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error(`Could not reach ${what}.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error('The API key was rejected. Check that it is correct and still active.');
  if (!res.ok) throw new Error(`${what} answered with an error (${res.status}).`);
  return res.json();
}
const tidy = (ids) => [...new Set(ids)].filter((id) => id && !NOT_CHAT.test(id)).sort((a, b) => a.localeCompare(b));

async function listModels(cfg) {
  try {
    switch (cfg.type) {
      case 'claude-cli':
        return { ok: true, models: ['haiku', 'sonnet', 'opus'] };
      case 'openai': {
        if (!cfg.baseUrl) throw new Error('Set the server address first.');
        needKey(cfg);
        const base = cfg.baseUrl.replace(/\/+$/, '');
        const h = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
        let j;
        try {
          j = await getJson(base + '/models', h, cfg.label);
        } catch (e) {
          if (cfg.id !== 'ollama') throw e;
          j = await getJson(base.replace(/\/v1$/, '') + '/api/tags', h, cfg.label); // older Ollama
          return { ok: true, models: tidy((j.models || []).map((m) => m.name)) };
        }
        return { ok: true, models: tidy((j.data || []).map((m) => m.id)) };
      }
      case 'anthropic': {
        needKey(cfg);
        const j = await getJson(`${(cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/models?limit=100`, { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }, cfg.label);
        return { ok: true, models: tidy((j.data || []).map((m) => m.id)) };
      }
      case 'gemini': {
        needKey(cfg);
        const j = await getJson(`${(cfg.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')}/v1beta/models?pageSize=200`, { 'x-goog-api-key': cfg.apiKey }, cfg.label);
        const ids = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
        return { ok: true, models: tidy(ids) };
      }
      default:
        return { ok: true, models: [] }; // command-line tools have no model list
    }
  } catch (e) {
    return { ok: false, models: [], error: e.message };
  }
}

function shutdown() {
  for (const [m, e] of [...spares]) dropSpare(m, e);
}

module.exports = { explain, prewarm, test, listModels, shutdown, SYSTEM, buildPrompt };
