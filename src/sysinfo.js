// Things Magpie can look at: the focused app, the current selection, a screenshot.
const { clipboard, desktopCapturer, screen, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const win32 = require('./win32');

// Native calls are the normal path; the PowerShell helper is only a fallback. MAGPIE_TEST_NO_NATIVE forces the
// fallback (tests only).
const native = win32.available && !process.env.MAGPIE_TEST_NO_NATIVE;

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
    if (native) return win32.foreground();
    return JSON.parse(await ask('info'));
  } catch {
    return { process: '', title: '' };
  }
}

// Give a Magpie window real keyboard focus even though another app is in front.
async function focusWindow(handleBuffer) {
  try {
    if (native) return void win32.focusWindow(win32.hwndOf(handleBuffer));
    await ask('focus ' + win32.hwndOf(handleBuffer), 1500);
  } catch {}
}

// Get the PowerShell helper (used for Ctrl+C) loaded and warm, so the first shortcut after startup or after the
// laptop wakes doesn't wait for it.
function warmUp() {
  ask('info').catch(() => {});
}

// Copies whatever is selected in the focused app, then restores the clipboard.
// Never sends Ctrl+C into a terminal (it would interrupt a running command).
async function captureSelection(app) {
  const info = app || (await activeWindow());
  if (TERMINALS.has((info.process || '').toLowerCase())) return '';
  const prev = clipboard.readText();
  clipboard.writeText('');
  if (native) {
    // Holds Ctrl until the app has handled C (see win32.js): no stray "c", and NumLock is never touched.
    if (!(await win32.sendCopySafely())) { clipboard.writeText(prev); return ''; }
  } else await ask('copy'); // fallback only (SendKeys)
  // Stop as soon as the text arrives (usually 10 to 40 ms) instead of always waiting a fixed 120 ms.
  // With nothing selected the clipboard stays empty, so give up after about 140 ms.
  let sel = '';
  for (let i = 0; i < 14 && !sel; i++) {
    await new Promise((r) => setTimeout(r, 10));
    sel = clipboard.readText().trim();
  }
  clipboard.writeText(prev);
  return sel;
}

// The whole screen under the cursor, straight from Windows. Fast enough (~40 ms) to take before the popup appears.
function nativeScreenJpeg(d) {
  const r = screen.dipToScreenRect(null, d.bounds); // physical pixels
  const px = win32.captureRect(r.x, r.y, r.width, r.height);
  if (!px) return null;
  let img = nativeImage.createFromBitmap(px, { width: r.width, height: r.height });
  if (r.width > 1920) img = img.resize({ width: 1920 });
  return img.isEmpty() ? null : img.toJPEG(72);
}

// Full-resolution pixels of one display, for the snip overlay: { width, height, data } with data in BGRA order.
async function captureDisplay(d) {
  if (native) {
    const r = screen.dipToScreenRect(null, d.bounds);
    const px = win32.captureRect(r.x, r.y, r.width, r.height);
    if (px) return { width: r.width, height: r.height, data: px };
  }
  try {
    const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    const sz = src.thumbnail.getSize();
    return { width: sz.width, height: sz.height, data: src.thumbnail.toBitmap() };
  } catch {
    return null;
  }
}

// Text in an image file, read by Windows' built-in OCR (offline). Snips are enlarged first: OCR misses words in
// screen-sized text (it skipped every spell-check-underlined word in a test), and reads it reliably at 3x.
async function ocr(file) {
  let input = file, temp = null;
  try {
    const img = nativeImage.createFromPath(file);
    const { width, height } = img.getSize();
    const k = width < 1200 && height < 900 ? 3 : width < 2000 && height < 1600 ? 2 : 1;
    if (width && k > 1) {
      temp = file.replace(/\.png$/i, '') + '.ocr.png';
      fs.writeFileSync(temp, img.resize({ width: width * k, quality: 'best' }).toPNG());
      input = temp;
    }
    const line = await ask('ocr ' + input, 15000);
    if (!line) throw new Error('Reading the text took too long.');
    const r = JSON.parse(line);
    if (r.error) throw new Error(r.error);
    return String(r.text || '').trim();
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
  }
}

async function screenshot(mode, windowTitle, id) {
  if (mode !== 'window' && mode !== 'screen') return null;
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (mode === 'screen' && native) {
      const jpg = nativeScreenJpeg(d);
      if (jpg) {
        const file = `${id}.jpg`;
        fs.writeFileSync(path.join(store.shotsDir(), file), jpg);
        return file;
      }
    }
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

module.exports = { startHelper, stopHelper, activeWindow, captureSelection, screenshot, captureDisplay, ocr, focusWindow, warmUp, native };
