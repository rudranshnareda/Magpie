// Settings + history, stored as JSON in the app's userData folder.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('./providers');

const DEFAULTS = {
  hotkey: 'Control+Alt+R',
  showAskButton: true,
  vaultPath: path.join(os.homedir(), 'Magpie-Vault'),
  openAtLogin: false,
  autoUpdateCheck: true, // once a day, ask GitHub whether a newer release exists (never installs by itself)
  lastUpdateCheck: 0,
  provider: 'groq', // free and answers in under a second
  providers: {}, // id -> { model, baseUrl, command, verified }
  modelCache: {}, // id -> { ts, list }: the provider's live model list
  secrets: {}, // id -> encrypted API key (never sent to the UI)
  log: {
    enabled: true, // master switch: keep a history at all
    selectedText: true, // store the text you selected
    appName: true, // which application you were in
    windowTitle: true, // title of that window (tab title, document name...)
    screenshot: 'off', // 'off' | 'window' | 'screen'
  },
};

const dir = () => app.getPath('userData');
const settingsFile = () => path.join(dir(), 'settings.json');
const historyFile = () => path.join(dir(), 'history.json');
const shotsDir = () => {
  const d = path.join(dir(), 'screenshots');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

let settings = null;
let history = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getSettings() {
  if (!settings) {
    const saved = readJson(settingsFile(), null);
    const legacy = saved ? {} : readJson(path.join(os.homedir(), '.magpie.json'), {});
    const base = saved || {};
    settings = {
      ...DEFAULTS,
      ...(legacy.vault ? { vaultPath: legacy.vault } : {}),
      ...(legacy.hotkey ? { hotkey: legacy.hotkey } : {}),
      ...base,
      providers: { ...(base.providers || {}) },
      secrets: { ...(base.secrets || {}) },
      modelCache: { ...(base.modelCache || {}) },
      log: { ...DEFAULTS.log, ...(base.log || {}) },
    };
    // v0.2 stored a single "model" for Claude Code
    if (base.model && !settings.providers['claude-cli']) settings.providers['claude-cli'] = { model: base.model };
    delete settings.model;
  }
  return settings;
}
function setSettings(patch) {
  const cur = getSettings();
  const next = { ...cur, ...patch, log: { ...cur.log, ...(patch.log || {}) }, providers: { ...cur.providers } };
  delete next.secrets; // secrets only change through setSecret
  next.secrets = cur.secrets;
  next.modelCache = cur.modelCache; // the cache only changes through setModelCache
  for (const [id, vals] of Object.entries(patch.providers || {})) next.providers[id] = { ...(cur.providers[id] || {}), ...vals };
  settings = next;
  writeJson(settingsFile(), settings);
  return settings;
}

function setModelCache(id, list) {
  const s = getSettings();
  s.modelCache[id] = { ts: Date.now(), list };
  writeJson(settingsFile(), s);
}
const getModelCache = (id) => getSettings().modelCache[id] || null;

// ---- API keys: encrypted with Windows DPAPI via Electron's safeStorage --------------------
function setSecret(id, value) {
  const s = getSettings();
  if (!value) delete s.secrets[id];
  else if (safeStorage.isEncryptionAvailable()) s.secrets[id] = 'enc:' + safeStorage.encryptString(value).toString('base64');
  else s.secrets[id] = 'b64:' + Buffer.from(value).toString('base64');
  writeJson(settingsFile(), s);
}
function getSecret(id) {
  const v = getSettings().secrets[id];
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('b64:')) return Buffer.from(v.slice(4), 'base64').toString('utf8');
  } catch {}
  return '';
}
const secretsApi = { get: getSecret };
const currentProvider = (id) => providers.resolve(getSettings(), secretsApi, id);

// What the settings UI may see: everything except the keys themselves.
function publicSettings() {
  const s = getSettings();
  const { secrets, ...rest } = s;
  return { ...rest, keySet: Object.fromEntries(Object.keys(secrets).map((k) => [k, true])) };
}

// ---- history ------------------------------------------------------------------------------
function getHistory() {
  if (!history) history = readJson(historyFile(), []);
  return history;
}
const flush = () => writeJson(historyFile(), getHistory());

function addEntry(entry) {
  const h = getHistory();
  h.unshift(entry);
  if (h.length > 5000) h.length = 5000;
  flush();
  return entry;
}
function updateEntry(id, patch) {
  const e = getHistory().find((x) => x.id === id);
  if (e) {
    Object.assign(e, patch);
    flush();
  }
  return e;
}
function deleteEntry(id) {
  const h = getHistory();
  const i = h.findIndex((x) => x.id === id);
  if (i >= 0) {
    const [e] = h.splice(i, 1);
    if (e.shot) fs.rmSync(path.join(shotsDir(), e.shot), { force: true });
    flush();
  }
}
function clearHistory() {
  const h = getHistory();
  h.length = 0;
  fs.rmSync(shotsDir(), { recursive: true, force: true });
  flush();
}

module.exports = {
  getSettings, setSettings, publicSettings, setSecret, currentProvider, setModelCache, getModelCache,
  getHistory, addEntry, updateEntry, deleteEntry, clearHistory, shotsDir,
};
