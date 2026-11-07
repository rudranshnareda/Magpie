// Things Magpie can look at: the focused app, the current selection, a screenshot.
const { clipboard, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const TERMINALS = new Set(['windowsterminal', 'powershell', 'pwsh', 'cmd', 'conhost', 'wezterm-gui', 'alacritty', 'mintty', 'bash', 'wsl', 'wslhost']);

// ---- persistent PowerShell helper -------------------------------------------------
let helper = null;
let queue = [];
let buf = '';

function startHelper() {
  if (helper) return;
  const script = path.join(__dirname, 'helper.ps1').replace('app.asar', 'app.asar.unpacked');
  helper = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
  helper.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'ready') continue;
      const next = queue.shift();
      if (next) next(line);
    }
  });
  helper.on('close', () => {
    helper = null;
    queue.forEach((r) => r(''));
    queue = [];
  });
}
function ask(cmd, timeout = 3000) {
  startHelper();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(''), timeout);
    queue.push((line) => {
      clearTimeout(t);
      resolve(line);
    });
    helper.stdin.write(cmd + '\n');
  });
}
function stopHelper() {
  try {
    helper?.kill();
  } catch {}
}

// ---- public API -------------------------------------------------------------------
async function activeWindow() {
  try {
    return JSON.parse(await ask('info'));
  } catch {
    return { process: '', title: '' };
  }
}

// Copies whatever is selected in the focused app, then restores the clipboard.
// Never sends Ctrl+C into a terminal (it would interrupt a running command).
async function captureSelection(app) {
  const info = app || (await activeWindow());
  if (TERMINALS.has((info.process || '').toLowerCase())) return '';
  const prev = clipboard.readText();
  clipboard.writeText('');
  await ask('copy');
  await new Promise((r) => setTimeout(r, 120));
  const sel = clipboard.readText().trim();
  clipboard.writeText(prev);
  return sel;
}

async function screenshot(mode, windowTitle, id) {
  if (mode !== 'window' && mode !== 'screen') return null;
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const w = Math.min(1920, Math.round(d.size.width * d.scaleFactor));
    const h = Math.round((w * d.size.height) / d.size.width);
    const sources = await desktopCapturer.getSources({ types: mode === 'window' ? ['window', 'screen'] : ['screen'], thumbnailSize: { width: w, height: h } });
    let src = null;
    if (mode === 'window' && windowTitle) src = sources.find((s) => s.id.startsWith('window:') && s.name === windowTitle);
    if (!src) src = sources.find((s) => s.display_id === String(d.id) && s.id.startsWith('screen:')) || sources.find((s) => s.id.startsWith('screen:'));
    if (!src || src.thumbnail.isEmpty()) return null;
    const file = `${id}.jpg`;
    fs.writeFileSync(path.join(store.shotsDir(), file), src.thumbnail.toJPEG(72));
    return file;
  } catch {
    return null;
  }
}

module.exports = { startHelper, stopHelper, activeWindow, captureSelection, screenshot };
