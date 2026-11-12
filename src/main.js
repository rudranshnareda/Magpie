const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage, nativeTheme, shell, dialog, powerMonitor, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const engine = require('./engine');
const providers = require('./providers');
const store = require('./store');
const vault = require('./vault');
const sysinfo = require('./sysinfo');
const win32 = require('./win32');
const updater = require('./updater');
const lens = require('./lens');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.js');
const UI = (f) => path.join(__dirname, 'ui', f);
const startHidden = process.argv.includes('--hidden');

let mainWin = null;
let tray = null;
let askBtn = null;
let askBtnTimer = null;
let quitting = false;
let currentHotkey = null;
let hookRunning = false;
let lastFire = 0;
const quickCtx = new Map(); // BrowserWindow -> { app, shot, selection, parent, title, entryId, job }

// Optional timing trace for diagnosing slowness: set MAGPIE_TRACE to a file path. Off by default.
let T0 = 0;
const trace = (label) => {
  if (!process.env.MAGPIE_TRACE) return;
  try { fs.appendFileSync(process.env.MAGPIE_TRACE, `${Date.now() - T0}\t${label}\n`); } catch {}
};

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const titleFor = (question, selection) => vault.safe((question || selection || 'untitled').slice(0, 60));
const dark = () => nativeTheme.shouldUseDarkColors;

// Windows 11 gets real Mica/Acrylic; older Windows gets a solid colour that matches the theme.
const hasMaterial = () => process.platform === 'win32' && parseInt(os.release().split('.')[2], 10) >= 22621;
const material = (kind) => (hasMaterial() ? { backgroundMaterial: kind, backgroundColor: '#00000000' } : { backgroundColor: dark() ? '#1c1c1e' : '#f5f5f7' });

// ---------------------------------------------------------------- main (library) window
function showMain(tab) {
  if (!mainWin || mainWin.isDestroyed()) {
    // Native title bar on purpose: Windows drops the Mica material (window goes black) after maximize/restore
    // when the title bar is custom-drawn (titleBarStyle: 'hidden'). Mica still paints through a native one.
    mainWin = new BrowserWindow({
      width: 1120, height: 760, minWidth: 860, minHeight: 560, title: 'Magpie', icon: ICON, show: false,
      ...material('mica'),
      webPreferences: { preload: PRELOAD, contextIsolation: true },
    });
    mainWin.loadFile(UI('main.html'));
    mainWin.once('ready-to-show', () => mainWin.show());
    mainWin.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        mainWin.hide();
      }
    });
  } else {
    mainWin.show();
    mainWin.focus();
  }
  if (tab) mainWin.webContents.send('goto', tab);
}
const notifyHistory = () => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send('history:changed');

// ---------------------------------------------------------------- quick (prompt + answer) window
const QUICK_W = 640;
const engineLabel = (cfg) => (cfg.model ? `${cfg.label} · ${cfg.model}` : cfg.label);

// A hidden, fully loaded popup is kept ready, so the shortcut only has to SHOW it. Creating and loading a fresh
// window cost 150 to 200 ms every single time. A new spare is prepared right after each one is used.
let spare = null;
function createQuickWindow() {
  const win = new BrowserWindow({
    width: QUICK_W, height: 64, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false, icon: ICON,
    ...material('acrylic'),
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  let n = 0;
  const ready = new Promise((res) => {
    const one = () => ++n === 2 && res();
    win.once('ready-to-show', one);
    win.webContents.once('did-finish-load', one);
  });
  win.loadFile(UI('quick.html'));
  return { win, ready };
}
// A spare whose page process died would open as an empty box: replace it.
const spareUsable = () => spare && !spare.win.isDestroyed() && !spare.win.webContents.isCrashed();
const prepareSpare = () => {
  if (!spareUsable()) {
    if (spare && !spare.win.isDestroyed()) spare.win.destroy();
    spare = createQuickWindow();
  }
};
async function takeQuickWindow() {
  prepareSpare(); // normally already loaded; only the first second after launch has to wait
  const s = spare;
  spare = null;
  await s.ready;
  setTimeout(prepareSpare, 700); // next one, once this one is on screen
  return s.win;
}

// Positions are kept on multiples of 4: at 125% / 150% display scaling those land on whole screen pixels, so
// Windows doesn't round them (rounding is what let the popup creep up-left and widen).
const snap4 = (v) => Math.round(v / 4) * 4;
function placeFor(mode, offset) {
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt).workArea;
  if (mode === 'center') return { x: snap4(d.x + (d.width - QUICK_W) / 2), y: snap4(d.y + d.height * 0.2) };
  return {
    x: snap4(Math.min(Math.max(pt.x + 14 + offset, d.x), d.x + d.width - QUICK_W)),
    y: snap4(Math.min(Math.max(pt.y + 18 + offset, d.y), d.y + d.height - 180)),
  };
}

// Give the popup the keyboard. From another app Windows would leave the keyboard there (you'd have to click
// the box first), so we ask it properly (see helper.ps1). From inside Magpie a plain focus() is enough.
async function giveKeyboard(win, fromOtherApp) {
  if (win.isDestroyed()) return;
  if (fromOtherApp) await sysinfo.focusWindow(win.getNativeWindowHandle());
  if (win.isDestroyed()) return;
  win.focus();
  win.webContents.focus();
  win.webContents.send('focus-input');
}

// A screenshot that arrives after the popup opened: attach it to the question, or drop it if the popup is gone.
function attachShot(win, file) {
  if (!file) return;
  const ctx = quickCtx.get(win);
  if (!ctx) return fs.rmSync(path.join(store.shotsDir(), file), { force: true });
  if (ctx.entryId) {
    store.updateEntry(ctx.entryId, { shot: file });
    notifyHistory();
  } else ctx.shot = file;
}

// `late: true` (shortcut or Ask button, another app in front): the popup appears at once WITHOUT taking the
// keyboard, because the other app must still have it while we read the selection. gatherAndOpen finishes the job.
// `snip`: a region drawn with the snip shortcut ({ thumb, mode, ocr, img, ... }); `gather`: resolves once its text is read.
async function openQuick({ question = '', selection = '', app: appInfo = {}, shot = null, parent = null, from = null, mode = 'center', offset = 0, autoAsk = false, late = false, hold = null, snip = null, gather = null } = {}) {
  // after a snip our overlay just vanished, so Windows may think no app of ours is in front: always ask properly
  const fromOtherApp = !!snip || !BrowserWindow.getFocusedWindow();
  const { x, y } = placeFor(mode, offset);
  const win = await takeQuickWindow();
  trace('popup window ready');
  win.setBounds({ x, y, width: QUICK_W, height: 64 });
  let finishGather = () => {};
  const gathered = gather || (late ? new Promise((r) => (finishGather = r)) : Promise.resolve());
  const ctx = { app: appInfo, shot, selection, parent, from, title: titleFor(question, selection), entryId: null, job: null, tween: null, asked: false, gathered, finishGather, fromOtherApp, pos: { x, y }, answer: '', question, snip };
  quickCtx.set(win, ctx);
  // Where the popup should be. Only the user dragging it changes this; it is never read back from the window,
  // because at fractional display scaling every read-back is off by a pixel and the errors add up.
  win.on('will-move', (_, nb) => (ctx.pos = { x: nb.x, y: nb.y }));
  win.on('closed', () => {
    const c = quickCtx.get(win);
    c?.job?.cancel();
    c?.finishGather?.();
    clearInterval(c?.tween);
    // a screenshot that never got attached to a logged question is just clutter
    if (c?.shot) fs.rmSync(path.join(store.shotsDir(), c.shot), { force: true });
    quickCtx.delete(win);
  });
  const cfg = store.currentProvider();
  win.webContents.send('init', { question, selection, parent, autoAsk, app: appInfo, hasShot: !!shot, engine: engineLabel(cfg), snip: snip ? { thumb: snip.thumb, mode: snip.mode } : null });
  if (hold) {
    // whole-screen screenshots must be taken before the popup covers anything
    const f = await hold;
    if (f) {
      if (win.isDestroyed()) fs.rmSync(path.join(store.shotsDir(), f), { force: true });
      else ctx.shot = f;
    }
  }
  if (win.isDestroyed()) return win;
  if (late) {
    win.showInactive();
    trace('popup: shown (your app keeps the keyboard while the selection is read)');
  } else {
    win.show();
    await giveKeyboard(win, fromOtherApp);
    trace('popup: shown and focused');
  }
  return win;
}

// ---------------------------------------------------------------- hotkey / selection flows
// Modifier keys the input hook has seen go down (keycode -> when). Ctrl+C must not be sent while, say, Alt is still
// held, or the app would receive Ctrl+Alt+C.
const held = new Map();
let lastHookEventAt = 0; // any key or mouse event seen by the input hook
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Windows silently removes input hooks that respond too slowly (it happens when a laptop wakes up). If the hook has
// seen nothing for a while it may be dead, and what it last saw can't be trusted.
const hookAlive = () => hookRunning && Date.now() - lastHookEventAt < 3000;
const freshHeld = () => {
  const now = Date.now();
  for (const [k, t] of held) if (now - t > 3000) held.delete(k); // a modifier "held" for 3+ s is a missed key-up
  return held.size;
};
async function waitModifiersReleased() {
  if (!hookAlive()) return sleep(200); // can't see the keyboard: assume an ordinary key press
  for (let i = 0; i < 60 && freshHeld() > 0; i++) await sleep(10); // at most 0.6 s
}

// Before sending Ctrl+C into the user's app, every key of the shortcut must be let go: otherwise the app would get
// e.g. Ctrl+Alt+C, and a still-held M would start typing "m" once our Ctrl is released. Windows is asked directly.
// Returns false if keys are still down after 1.5 s; the selection is then skipped rather than risk stray keystrokes.
const MOD_VKS = [0x10, 0x11, 0x12, 0x5b, 0x5c]; // Shift, Ctrl, Alt, left Win, right Win
let hotkeyVk = null; // Windows key code of the shortcut's main key
async function waitKeysReleased() {
  if (!sysinfo.native) {
    await waitModifiersReleased();
    return true;
  }
  const vks = hotkeyVk != null ? [...MOD_VKS, hotkeyVk] : MOD_VKS;
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    if (!win32.anyDown(vks)) return true;
    await sleep(10);
  }
  return false;
}
function vkFor(accel) {
  const key = accel.split('+').pop();
  if (/^[A-Z0-9]$/.test(key)) return key.charCodeAt(0);
  const f = key.match(/^F(\d{1,2})$/);
  if (f) return 0x6f + Number(f[1]);
  return { Space: 0x20, Return: 0x0d, Tab: 0x09 }[key] ?? null;
}

async function gatherAndOpen(mode) {
  const s = store.getSettings();
  engine.prewarm(store.currentProvider()); // start the slow part now; it finishes while you type
  if (BrowserWindow.getFocusedWindow()) {
    // one of our own windows is in front: there is nothing outside to read
    await openQuick({ mode });
    return;
  }
  const id = newId();
  const wantShot = s.log.enabled ? s.log.screenshot : 'off';
  const screenShot = wantShot === 'screen' ? sysinfo.screenshot('screen', '', id) : null; // runs alongside everything below
  const opened = openQuick({ mode, late: true, hold: screenShot });
  // Read the focused app and its selection while that app still has the keyboard.
  const read = (async () => {
    const free = await waitKeysReleased();
    trace(free ? 'keys released' : 'keys still held after 1.5 s: selection skipped');
    const app = await sysinfo.activeWindow();
    trace('focused app identified');
    const sel = free ? await sysinfo.captureSelection(app) : '';
    trace('selection read');
    return { app, sel };
  })();
  const [win, got] = await Promise.all([opened, read]);
  const ctx = quickCtx.get(win);
  if (!ctx || win.isDestroyed()) return; // closed before we finished: nothing left to do
  ctx.app = got.app;
  ctx.selection = got.sel;
  ctx.title = titleFor('', got.sel);
  if (got.sel) win.webContents.send('selection', { selection: got.sel, hasShot: wantShot !== 'off' });
  ctx.finishGather();
  // an active-window screenshot does not need to hold anything up
  if (wantShot === 'window') sysinfo.screenshot('window', got.app.title, id).then((f) => attachShot(win, f));
  await giveKeyboard(win, true);
  trace('popup: keyboard focus handed over');
}

// Both the OS shortcut and the AltGr fallback end up here.
// Holding the shortcut down makes Windows repeat it (after ~0.5 s, then every ~33 ms). Each repeat used to count as
// a new press, and a second press closes an unused prompt, so a slightly long press opened and then closed it.
let hotkeyMainCode = null; // input-hook keycode of the shortcut's main key (M in Ctrl+M), if known
let mainReleasedSinceFire = true;
function fireHotkey() {
  const now = Date.now();
  const since = now - lastFire;
  lastFire = now; // updated by repeats too, so a held key keeps being recognised as the same press
  const canSeeKeys = (sysinfo.native && hotkeyVk != null) || (hookAlive() && hotkeyMainCode !== null);
  if (canSeeKeys) {
    if (!mainReleasedSinceFire && since < 3000) return; // the key hasn't been let go since the last press
  } else if (since < 1100) return; // can't see the keyboard: anything this soon is a repeat
  mainReleasedSinceFire = false;
  watchRelease();
  T0 = now;
  trace('hotkey fired');
  setTimeout(checkHookHealth, 400);
  toggleAsk();
}

// Notice when the shortcut's main key is let go (asked from Windows; the input hook reports it too when alive).
let releaseTimer = null;
function watchRelease() {
  clearInterval(releaseTimer);
  if (!sysinfo.native || hotkeyVk == null) return;
  releaseTimer = setInterval(() => {
    if (!win32.anyDown([hotkeyVk])) {
      mainReleasedSinceFire = true;
      clearInterval(releaseTimer);
    }
  }, 25);
}

// After a shortcut press, a working input hook must have seen keys go down. If it saw nothing, Windows has removed
// it: put it back (otherwise the Ask button stops appearing and key tracking goes stale).
function checkHookHealth() {
  if (hookRunning && Date.now() - lastHookEventAt > 1500) restartHook('it stopped seeing keys');
}
// Windows can silently remove the input hook at any time (typically around sleep, or when the PC is very busy), and
// then the Ask button simply never appears again. Checking only when the shortcut is pressed wasn't enough, so this
// also compares, every few seconds, the last input Windows saw with the last event the hook saw.
let lastWatchdogRestart = 0;
function watchHook() {
  if (!hookRunning || !sysinfo.native) return;
  const since = win32.msSinceInput();
  if (since == null) return;
  const lastInputAt = Date.now() - since;
  // input arrived well after the hook last heard anything (rate-limited: input to an app running as administrator
  // never reaches the hook, which would otherwise mean a restart every few seconds)
  if (lastInputAt - lastHookEventAt > 2000 && Date.now() - lastWatchdogRestart > 15000) {
    lastWatchdogRestart = Date.now();
    restartHook('it missed recent input');
  }
}
let hook = null;
function restartHook(reason) {
  if (!hook) return;
  trace('input hook restarted: ' + reason);
  try { hook.stop(); } catch {}
  held.clear();
  try {
    hook.start();
    hookRunning = true;
    lastHookEventAt = Date.now();
  } catch {
    hookRunning = false;
  }
}

// Input-hook keycode for the shortcut's main key, so we can see when it is let go.
function mainKeyCode(accel) {
  try {
    const K = require('uiohook-napi').UiohookKey;
    const key = accel.split('+').pop();
    if (/^[A-Z0-9]$/.test(key) || /^F\d{1,2}$/.test(key)) return K[key] ?? null;
    return { Space: K.Space, Return: K.Enter, Tab: K.Tab }[key] ?? null;
  } catch {
    return null;
  }
}

// Spotlight behaviour: if a prompt is already open and you haven't asked yet, the shortcut closes it.
function toggleAsk() {
  const idle = [...quickCtx].filter(([w, c]) => !c.asked && !w.isDestroyed());
  if (idle.length) return idle.forEach(([w]) => w.close());
  gatherAndOpen('center');
}

// On keyboards with an AltGr key, pressing Right Alt + M reaches Windows as Ctrl+Alt+M, which a plain
// "Alt+M" shortcut never matches. This watches the raw keys so Right Alt works too.
let altGrKey = null;
function setAltGrFallback(accel) {
  altGrKey = null;
  const parts = accel.split('+');
  if (!parts.includes('Alt') || parts.includes('Control')) return;
  try {
    const K = require('uiohook-napi').UiohookKey;
    const code = K[parts[parts.length - 1]];
    if (code) altGrKey = { code, ctrlRight: K.CtrlRight, altRight: K.AltRight };
  } catch {}
}

function registerHotkey(accel) {
  if (accel === currentSnipHotkey) return { ok: false, error: 'That is already the Snip shortcut. Pick a different one.' };
  const prev = currentHotkey;
  if (prev) globalShortcut.unregister(prev);
  let ok = false;
  try {
    ok = globalShortcut.register(accel, fireHotkey);
  } catch {
    ok = false;
  }
  if (ok) {
    currentHotkey = accel;
    setAltGrFallback(accel);
    hotkeyMainCode = mainKeyCode(accel);
    hotkeyVk = vkFor(accel);
    mainReleasedSinceFire = true;
    tray?.setToolTip(`Magpie (${accel.replace('Control', 'Ctrl')})`);
    return { ok: true };
  }
  if (prev) globalShortcut.register(prev, fireHotkey);
  const risky = /^Control\+Alt\+[A-Z0-9]$/.test(accel);
  return {
    ok: false,
    error: risky
      ? 'Ctrl+Alt+letter is how many keyboards type special characters (AltGr), so Windows won\'t share it. Try Alt+letter instead.'
      : 'Another app is already using that shortcut. Try a different one.',
  };
}

// ---------------------------------------------------------------- floating "Ask Magpie" button
const ASK_W = 140;
const ASK_H = 40;
function createAskButton() {
  askBtn = new BrowserWindow({
    width: ASK_W, height: ASK_H, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, resizable: false, show: false, hasShadow: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  askBtn.setAlwaysOnTop(true, 'screen-saver');
  askBtn.loadFile(UI('askbtn.html'));
  // If the button's page process dies, the window still "shows" but draws nothing. Build a fresh one.
  askBtn.webContents.on('render-process-gone', () => {
    if (quitting) return;
    trace('ask button page died: rebuilt');
    const dead = askBtn;
    askBtn = null;
    dead.destroy();
    createAskButton();
  });
}
function hideAskButton() {
  clearTimeout(askBtnTimer);
  if (askBtn && !askBtn.isDestroyed() && askBtn.isVisible()) askBtn.hide();
}
function showAskButton(px, py) {
  if (snipOpen) return;
  if (!askBtn || askBtn.isDestroyed() || askBtn.webContents.isCrashed()) {
    if (askBtn && !askBtn.isDestroyed()) askBtn.destroy();
    createAskButton(); // ready for the next selection
    return;
  }
  const dip = process.platform === 'win32' ? screen.screenToDipPoint({ x: px, y: py }) : { x: px, y: py };
  const d = screen.getDisplayNearestPoint(dip).workArea;
  // Size is always given, never read back: at 125% / 150% scaling each read-back-and-move added a pixel or two,
  // so the button grew wider every time it appeared (the same rounding that once made the popup widen).
  askBtn.setBounds({
    x: snap4(Math.min(Math.max(dip.x + 8, d.x), d.x + d.width - ASK_W)),
    y: snap4(Math.min(Math.max(dip.y + 16, d.y), d.y + d.height - ASK_H)),
    width: ASK_W,
    height: ASK_H,
  });
  askBtn.showInactive();
  engine.prewarm(store.currentProvider()); // they probably will click it
  clearTimeout(askBtnTimer);
  askBtnTimer = setTimeout(hideAskButton, 5000);
}
function startInputHooks() {
  try {
    const { uIOhook, UiohookKey: K } = require('uiohook-napi');
    hook = uIOhook;
    const mods = new Set([K.Ctrl, K.CtrlRight, K.Alt, K.AltRight, K.Shift, K.ShiftRight, K.Meta, K.MetaRight]);
    uIOhook.on('input', () => (lastHookEventAt = Date.now())); // every event, mouse moves included: the hook is alive
    uIOhook.on('keydown', (e) => {
      if (mods.has(e.keycode)) return void held.set(e.keycode, Date.now());
      if (altGrKey && e.keycode === altGrKey.code && held.has(altGrKey.altRight) && !held.has(altGrKey.ctrlRight)) fireHotkey();
    });
    uIOhook.on('keyup', (e) => {
      held.delete(e.keycode);
      if (e.keycode === hotkeyMainCode) mainReleasedSinceFire = true;
    });
    let down = null;
    uIOhook.on('mousedown', (e) => {
      down = { x: e.x, y: e.y, t: Date.now() };
      if (askBtn?.isVisible()) {
        const dip = process.platform === 'win32' ? screen.screenToDipPoint({ x: e.x, y: e.y }) : { x: e.x, y: e.y };
        const b = askBtn.getBounds();
        const inside = dip.x >= b.x && dip.x <= b.x + b.width && dip.y >= b.y && dip.y <= b.y + b.height;
        if (!inside) hideAskButton();
      }
    });
    uIOhook.on('mouseup', (e) => {
      if (e.button !== 1 || !down || !store.getSettings().showAskButton) return;
      const dist = Math.hypot(e.x - down.x, e.y - down.y);
      // A drag across text or a double/triple click. The limits used to be 12 px and 180 ms, which missed quick
      // drags over a short word, so the button seemed to appear only sometimes.
      const looksLikeSelection = (dist > 8 && Date.now() - down.t > 100) || e.clicks >= 2;
      down = null;
      if (!looksLikeSelection || BrowserWindow.getFocusedWindow()) return;
      showAskButton(e.x, e.y);
    });
    uIOhook.start();
    hookRunning = true;
    lastHookEventAt = Date.now();
    setInterval(watchHook, 4000);
  } catch (err) {
    console.error('Input hook unavailable; the Ask button is disabled, the hotkey still works.', err.message);
  }
}

// ---------------------------------------------------------------- snip: draw around anything on screen
// The snip shortcut freezes the screen under the cursor in a full-screen overlay (snip.html). You draw a loop
// (or drag a rectangle) and choose: Ask, Google Lens, Translate or Copy text. The overlay window is kept loaded
// and hidden, like the popup spare, so it appears at once.
let snipWin = null;
let snipReady = null;
let snipOpen = false;
let snipApp = null; // the app that was in front when the shortcut was pressed
let snipDrawn = null, snipPainted = null; // resolvers for the overlay's "picture drawn" / "on screen" replies
function createSnipWindow() {
  if (snipWin && !snipWin.isDestroyed()) return;
  const win = new BrowserWindow({
    show: false, frame: false, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, alwaysOnTop: true, hasShadow: false, backgroundColor: '#000000', title: 'Magpie snip',
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  snipReady = new Promise((r) => win.webContents.once('did-finish-load', r));
  win.loadFile(UI('snip.html'));
  // The very first time a window is shown, Windows and Chromium set up its drawing surfaces (~180 ms). Do that
  // now, off-screen, tiny and invisible, so the first real snip is as quick as every later one.
  snipReady.then(() => {
    if (win.isDestroyed() || snipOpen) return;
    win.setOpacity(0);
    win.setBounds({ x: -32000, y: -32000, width: 64, height: 64 });
    win.showInactive();
    setTimeout(() => !win.isDestroyed() && !snipOpen && win.hide(), 400);
  });
  win.on('blur', () => snipOpen && snipWin === win && cancelSnip()); // switched away (Alt+Tab, Win key): put the screen back
  win.webContents.on('render-process-gone', () => {
    if (quitting) return;
    if (snipWin === win) { snipWin = null; snipOpen = false; }
    win.destroy();
  });
  snipWin = win;
}
function cancelSnip() {
  snipOpen = false;
  snipDrawn?.();
  snipPainted?.();
  if (snipWin && !snipWin.isDestroyed()) {
    snipWin.hide();
    snipWin.webContents.send('snip:reset');
  }
}
async function toggleSnip() {
  if (snipOpen) return cancelSnip();
  createSnipWindow();
  hideAskButton();
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  snipApp = sysinfo.native ? win32.foreground() : await sysinfo.activeWindow();
  const shot = await sysinfo.captureDisplay(d); // before anything of ours is on screen
  trace('snip: screen captured');
  if (!shot) return;
  snipOpen = true;
  const win = snipWin;
  await snipReady;
  if (!snipOpen || win.isDestroyed()) return;
  // draw the picture while the window is still hidden, then show it see-through for a frame or two, so the
  // previous snip never flashes up
  await new Promise((r) => { snipDrawn = r; setTimeout(r, 500); win.webContents.send('snip:start', shot); });
  trace('snip: picture drawn');
  if (!snipOpen || win.isDestroyed()) return;
  win.setOpacity(0);
  win.setBounds(d.bounds);
  win.show();
  win.setBounds(d.bounds); // again: moving between displays with different scaling can resize it on the way
  await new Promise((r) => { snipPainted = r; setTimeout(r, 150); win.webContents.send('snip:shown'); });
  trace('snip: picture on screen');
  if (!snipOpen || win.isDestroyed()) return;
  win.setOpacity(1);
  await sysinfo.focusWindow(win.getNativeWindowHandle()); // the keyboard, for Esc and the action keys
  if (!snipOpen || win.isDestroyed()) return;
  win.focus();
  win.webContents.focus();
  trace('snip: overlay on screen');
}

// The language answers are translated into: the first language Windows is set to (by name, e.g. "English").
function systemLanguage() {
  try {
    const tag = (app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en').split('-')[0];
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || 'English';
  } catch {
    return 'English';
  }
}

// The image as sent to the AI: at most 1568 px on its long side (what the APIs accept without shrinking it
// themselves), as JPEG to keep the request small.
function snipImage(snip) {
  if (!snip.image) {
    let img = snip.img;
    const { width, height } = img.getSize();
    if (Math.max(width, height) > 1568) img = img.resize(width >= height ? { width: 1568, quality: 'best' } : { height: 1568, quality: 'best' });
    snip.image = { mime: 'image/jpeg', data: img.toJPEG(88).toString('base64') };
  }
  return snip.image;
}

async function openSnipQuick({ file, png, app: appInfo, mode }) {
  const img = nativeImage.createFromBuffer(png);
  const { width, height } = img.getSize();
  const k = Math.min(1, 480 / width, 112 / height); // the thumbnail is shown at half this size, so it stays sharp
  const thumb = img.resize({ width: Math.max(1, Math.round(width * k)), quality: 'best' }).toDataURL();
  const snip = { file, img, mode, thumb, ocr: '', image: null };
  // read the text while the popup appears; asking waits for it (see quick:ask)
  const reading = sysinfo.ocr(path.join(store.shotsDir(), file)).catch((err) => {
    trace('snip: text could not be read: ' + err.message);
    return '';
  });
  const gather = reading.then((text) => { snip.ocr = text; });
  const win = await openQuick({ shot: file, app: appInfo, snip, gather });
  trace('snip: popup open');
  await gather;
  trace('snip: text read');
  if (win.isDestroyed() || quickCtx.get(win)?.snip !== snip) return;
  if (mode === 'text' && snip.ocr) clipboard.writeText(snip.ocr);
  win.webContents.send('snip:ocr', { text: snip.ocr, copied: mode === 'text' && !!snip.ocr });
}

// Google Lens: upload and open the results. If that fails, the snip goes on the clipboard and Google Images opens,
// where Ctrl+V searches with it.
async function snipLens(png) {
  try {
    const url = await lens.upload(png);
    trace('snip: Google Lens results ready');
    await shell.openExternal(url);
  } catch (err) {
    trace('snip: Google Lens upload failed: ' + err.message);
    clipboard.writeImage(nativeImage.createFromBuffer(png));
    shell.openExternal('https://images.google.com/');
    if (Notification.isSupported()) {
      new Notification({ title: 'Google Lens upload didn\'t work', body: 'Your snip is on the clipboard. On Google Images, click the camera icon and press Ctrl+V.', icon: ICON }).show();
    }
  }
}

ipcMain.on('snip:drawn', () => { snipDrawn?.(); snipDrawn = null; });
ipcMain.on('snip:painted', () => { snipPainted?.(); snipPainted = null; });
ipcMain.on('snip:cancel', () => cancelSnip());
ipcMain.on('snip:action', (_, { action, png }) => {
  const appInfo = snipApp || {};
  cancelSnip();
  if (!png || !['ask', 'lens', 'translate', 'text'].includes(action)) return;
  const buf = Buffer.from(png);
  T0 = Date.now();
  trace('snip: ' + action);
  if (action === 'lens') return void snipLens(buf); // nothing is kept on disk for a Lens search
  const file = newId() + '.png';
  fs.writeFileSync(path.join(store.shotsDir(), file), buf);
  openSnipQuick({ file, png: buf, app: appInfo, mode: action });
});

// The snip shortcut. Holding it makes Windows repeat it; one press must open (or close) the overlay only once.
let currentSnipHotkey = null;
let snipVk = null;
let snipKeyDown = false;
let snipKeyTimer = null;
function fireSnip() {
  if (snipKeyDown) return;
  snipKeyDown = true;
  clearInterval(snipKeyTimer);
  if (sysinfo.native && snipVk != null) {
    snipKeyTimer = setInterval(() => {
      if (!win32.anyDown([snipVk])) {
        snipKeyDown = false;
        clearInterval(snipKeyTimer);
      }
    }, 25);
  } else snipKeyTimer = setTimeout(() => (snipKeyDown = false), 700);
  T0 = Date.now();
  trace('snip shortcut fired');
  toggleSnip();
}
function registerSnipHotkey(accel) {
  if (accel === currentHotkey) return { ok: false, error: 'That is already the Ask shortcut. Pick a different one.' };
  const prev = currentSnipHotkey;
  if (prev) globalShortcut.unregister(prev);
  let ok = false;
  try {
    ok = globalShortcut.register(accel, fireSnip);
  } catch {
    ok = false;
  }
  if (ok) {
    currentSnipHotkey = accel;
    snipVk = vkFor(accel);
    return { ok: true };
  }
  if (prev) globalShortcut.register(prev, fireSnip);
  return {
    ok: false,
    error: /^Control\+Alt\+[A-Z0-9]$/.test(accel)
      ? 'Windows or another app won\'t let Magpie use that shortcut (on some keyboards Ctrl+Alt+letter types a special character). Try another.'
      : 'Another app is already using that shortcut. Try a different one.',
  };
}

// ---------------------------------------------------------------- IPC: quick window
ipcMain.on('quick:ask', async (e, { question, mode }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const ctx = quickCtx.get(win);
  if (!ctx) return;
  ctx.asked = true;
  // asked before the selection (or the snip's text) was read: wait for it
  await Promise.race([ctx.gathered, new Promise((r) => setTimeout(r, ctx.snip ? 15000 : 3000))]);
  if (!quickCtx.has(win) || e.sender.isDestroyed()) return;
  const s = store.getSettings();
  const cfg = store.currentProvider();
  ctx.job?.cancel();
  ctx.asked = true;
  const translate = mode === 'translate';
  ctx.title = ctx.snip ? titleFor(translate ? '' : question, ctx.snip.ocr || 'Snip') : titleFor(question, ctx.selection);
  ctx.question = question;
  const sender = e.sender;
  const job = engine.explain(
    {
      question, selection: ctx.selection, trail: vault.trail(ctx.parent), known: vault.known(),
      // a clicked term: the answer it came from is the context, not the app you happen to be in
      from: ctx.from && question === ctx.from.term ? ctx.from : null,
      // only share what the user has switched on in Settings
      app: ctx.from ? {} : { process: s.log.appName ? ctx.app.process : '', title: s.log.windowTitle ? ctx.app.title : '' },
      snip: ctx.snip ? { image: snipImage(ctx.snip), ocr: ctx.snip.ocr } : null,
      mode: translate ? 'translate' : undefined,
      target: systemLanguage(),
    },
    (c) => !sender.isDestroyed() && sender.send('delta', c),
    cfg
  );
  ctx.job = job;
  job.promise
    .then((answer) => {
      if (answer === null || sender.isDestroyed()) return;
      ctx.answer = answer;
      if (s.log.enabled) {
        const entry = store.addEntry({
          // a snip translation is listed by its text, not as yet another "Translate"
          id: newId(), ts: Date.now(), question: translate && ctx.snip ? `Translate: ${(ctx.snip.ocr || '').replace(/\s+/g, ' ').slice(0, 60)}` : question, selection: s.log.selectedText ? ctx.selection || ctx.snip?.ocr || '' : '',
          answer, app: s.log.appName ? ctx.app.process || '' : '', title: s.log.windowTitle ? ctx.app.title || '' : '',
          shot: ctx.shot || null, parent: ctx.parent || null, model: engineLabel(cfg), saved: null,
        });
        ctx.shot = null; // the screenshot belongs to the first entry only
        ctx.entryId = entry.id;
        notifyHistory();
      }
      sender.send('done');
    })
    .catch((err) => !sender.isDestroyed() && sender.send('error', err.message));
});
ipcMain.handle('quick:save', (e, { body }) => {
  const ctx = quickCtx.get(BrowserWindow.fromWebContents(e.sender));
  if (!ctx) return null;
  const file = vault.save({ title: ctx.title, body, parent: ctx.parent });
  if (ctx.entryId) {
    store.updateEntry(ctx.entryId, { saved: file });
    notifyHistory();
  }
  return file;
});
// Smoothly grow/shrink the window to fit its content.
ipcMain.on('quick:resize', (e, target) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const ctx = quickCtx.get(win);
  if (!win || !ctx) return;
  const b0 = win.getBounds();
  const d = screen.getDisplayMatching(b0).workArea;
  const to = Math.round(Math.min(Math.max(target, 48), d.height - 40));
  clearInterval(ctx.tween);
  const from = b0.height;
  if (from === to) return;
  const t0 = Date.now(), dur = 160;
  ctx.tween = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(ctx.tween);
    const p = Math.min(1, (Date.now() - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const h = Math.round(from + (to - from) * eased);
    // position and width come from ctx, never from getBounds() (see openQuick)
    win.setBounds({ x: ctx.pos.x, y: Math.max(d.y, Math.min(ctx.pos.y, d.y + d.height - h - 8)), width: QUICK_W, height: h });
    if (p >= 1) clearInterval(ctx.tween);
  }, 12);
});
ipcMain.on('quick:dismiss', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('quick:clearSel', (e) => {
  const ctx = quickCtx.get(BrowserWindow.fromWebContents(e.sender));
  if (!ctx) return;
  ctx.selection = '';
  if (ctx.snip) {
    // the snip is gone from the question, so it isn't kept as this question's screenshot either
    if (ctx.shot === ctx.snip.file) {
      fs.rmSync(path.join(store.shotsDir(), ctx.shot), { force: true });
      ctx.shot = null;
    }
    ctx.snip = null;
  }
});
ipcMain.on('quick:dig', (e, { term }) => {
  const ctx = quickCtx.get(BrowserWindow.fromWebContents(e.sender));
  const from = ctx ? { term, question: ctx.question || ctx.title, selection: ctx.selection, answer: ctx.answer } : null;
  openQuick({ question: term, parent: ctx?.title || null, from, app: ctx?.app || {}, mode: 'cursor', offset: 28, autoAsk: true });
});
ipcMain.on('app:openSettings', () => showMain('settings'));
ipcMain.on('askbtn:click', async () => {
  T0 = Date.now();
  trace('Ask button clicked');
  hideAskButton();
  await new Promise((r) => setTimeout(r, 40));
  gatherAndOpen('cursor');
});

// ---------------------------------------------------------------- IPC: library window
const shotUrl = (e) => {
  if (!e.shot) return null;
  const f = path.join(store.shotsDir(), e.shot);
  return fs.existsSync(f) ? pathToFileURL(f).href : null;
};
ipcMain.handle('history:list', () => store.getHistory().map((e) => ({ ...e, shotUrl: shotUrl(e) })));
ipcMain.handle('history:delete', (_, id) => {
  store.deleteEntry(id);
});
ipcMain.handle('history:clear', () => store.clearHistory());
ipcMain.handle('history:save', (_, id) => {
  const e = store.getHistory().find((x) => x.id === id);
  if (!e) return null;
  const file = vault.save({ title: titleFor(e.question, e.selection), body: e.answer, parent: e.parent });
  store.updateEntry(id, { saved: file });
  return file;
});
ipcMain.on('history:dig', (_, { term, id }) => {
  const e = store.getHistory().find((x) => x.id === id);
  const from = e ? { term, question: e.question, selection: e.selection, answer: e.answer } : null;
  openQuick({ question: term, parent: e ? titleFor(e.question, e.selection) : null, from, mode: 'center', autoAsk: true });
});
ipcMain.on('history:ask', () => gatherAndOpen('center'));
ipcMain.on('shell:reveal', (_, file) => file && shell.showItemInFolder(file));

ipcMain.handle('settings:get', () => store.publicSettings());
ipcMain.handle('settings:set', (_, patch) => {
  delete patch.secrets;
  delete patch.modelCache;
  // changing the model, address or command means the last successful Test no longer applies
  for (const vals of Object.values(patch.providers || {})) {
    if (('model' in vals || 'baseUrl' in vals || 'command' in vals) && !('verified' in vals)) vals.verified = false;
  }
  store.setSettings(patch);
  if ('openAtLogin' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!patch.openAtLogin, args: ['--hidden'] });
  return store.publicSettings();
});
ipcMain.handle('settings:hotkey', (_, accel) => {
  const r = registerHotkey(accel);
  if (r.ok) store.setSettings({ hotkey: accel });
  return r;
});
ipcMain.handle('settings:snipHotkey', (_, accel) => {
  const r = registerSnipHotkey(accel);
  if (r.ok) store.setSettings({ snipHotkey: accel });
  return r;
});
ipcMain.handle('settings:pickVault', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: store.getSettings().vaultPath });
  if (r.canceled || !r.filePaths[0]) return null;
  return store.setSettings({ vaultPath: r.filePaths[0] }).vaultPath;
});
ipcMain.on('settings:openVault', () => shell.openPath(vault.vaultDir()));

ipcMain.handle('provider:registry', () => providers.publicRegistry());
ipcMain.handle('provider:setKey', (_, { id, key }) => {
  store.setSecret(id, (key || '').trim());
  store.setSettings({ providers: { [id]: { verified: false } } }); // a new key has not been tested yet
  return store.publicSettings();
});
ipcMain.handle('provider:test', async (_, id) => {
  const r = await engine.test(store.currentProvider(id));
  store.setSettings({ providers: { [id]: { verified: !!r.ok } } }); // remembered so the guide can show "Ready"
  return r;
});
// Live model list from the provider, cached for a day so Settings opens instantly. `force` re-fetches.
ipcMain.handle('provider:models', async (_, { id, force } = {}) => {
  const cache = store.getModelCache(id);
  if (!force && cache && Date.now() - cache.ts < 24 * 3600 * 1000) return { ok: true, models: cache.list, source: 'cache', ts: cache.ts };
  const r = await engine.listModels(store.currentProvider(id));
  if (r.ok && r.models.length) {
    store.setModelCache(id, r.models);
    return { ok: true, models: r.models, source: 'live', ts: Date.now() };
  }
  return { ok: r.ok, models: cache ? cache.list : [], source: cache ? 'cache' : 'builtin', ts: cache ? cache.ts : 0, error: r.error };
});
// Open a provider's sign-up page. Only the address stored in our own registry can be opened.
ipcMain.on('guide:open', (_, id) => {
  const url = providers.byId(id).guide?.url;
  if (url && url.startsWith('https://')) shell.openExternal(url);
});

// ---------------------------------------------------------------- updates
function announceUpdate() {
  const s = updater.state();
  tray?.setToolTip(s.available ? `Magpie: version ${s.latest} is available` : `Magpie (${currentHotkey ? currentHotkey.replace('Control', 'Ctrl') : ''})`);
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:changed');
}
async function runUpdateCheck() {
  try {
    await updater.check();
    store.setSettings({ lastUpdateCheck: Date.now() });
    announceUpdate();
    return { ok: true, ...updater.state() };
  } catch (err) {
    return { ok: false, error: err.message, ...updater.state() };
  }
}
ipcMain.handle('update:check', () => runUpdateCheck());
ipcMain.handle('update:state', () => updater.state());
ipcMain.handle('update:download', async (e) => {
  try {
    await updater.download((got, total) => !e.sender.isDestroyed() && e.sender.send('update:progress', { got, total }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('update:install', async () => {
  try {
    const r = await updater.install();
    if (!r.dryRun) setTimeout(() => app.quit(), 400); // the installer replaces our files, so we must not be running
    return { ok: true, dryRun: r.dryRun };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.on('update:notes', () => {
  const u = updater.state().url || '';
  if (u.startsWith(`https://github.com/${updater.REPO}/`)) shell.openExternal(u);
});

// Test-only controls (never available in normal use): simulate Windows silently removing the input hook.
if (process.env.MAGPIE_TEST_SEAMS) {
  ipcMain.handle('test:hook', (_, action) => {
    if (action === 'kill') { try { hook?.stop(); } catch {} } // hookRunning stays true, exactly like a silent removal
    if (action === 'stuckCtrl') held.set(29, Date.now()); // a Ctrl whose key-up was never seen
    return { hookRunning, msSinceHookEvent: Date.now() - lastHookEventAt, held: [...held.keys()], native: sysinfo.native };
  });
}

ipcMain.handle('app:status', () =>
  new Promise((resolve) => {
    execFile('claude', ['--version'], { windowsHide: true, timeout: 8000 }, (err, out) =>
      resolve({ claude: err ? null : out.trim(), version: app.getVersion(), packaged: app.isPackaged, hook: hookRunning, snipHotkey: currentSnipHotkey, dataDir: app.getPath('userData') })
    );
  })
);

// ---------------------------------------------------------------- app lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.setAppUserModelId('com.magpie.app');
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null); // no menu bar: otherwise pressing Alt steals the next key (breaks Alt+<key> shortcuts)
    nativeTheme.themeSource = 'system';
    sysinfo.warmUp(); // only the PowerShell fallback needs warming; the native path is instant
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
    tray.on('click', () => showMain());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Magpie', click: () => showMain() },
        { label: 'Ask a question', click: () => toggleAsk() },
        { label: 'Snip and search', click: () => toggleSnip() },
        { label: 'Open vault folder', click: () => shell.openPath(vault.vaultDir()) },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    );
    const r = registerHotkey(store.getSettings().hotkey);
    // If the default snip shortcut is already taken by another app, use the first free fallback (and save it, so
    // Settings shows the shortcut that really works). A shortcut the user picked is never changed.
    const snipAccel = store.getSettings().snipHotkey;
    if (!registerSnipHotkey(snipAccel).ok) {
      trace('snip shortcut unavailable: ' + snipAccel);
      if (snipAccel === store.DEFAULTS.snipHotkey) {
        const free = ['Alt+Shift+M', 'Control+Alt+N', 'Alt+Shift+S'].find((a) => registerSnipHotkey(a).ok);
        if (free) store.setSettings({ snipHotkey: free });
      }
    }
    createAskButton();
    startInputHooks();
    setTimeout(prepareSpare, 1500); // have the first popup loaded and waiting before the shortcut is first used
    setTimeout(createSnipWindow, 2500); // same for the snip overlay
    setTimeout(() => sysinfo.warmUp(), 2500);
    // After sleep or the lock screen Windows may have removed the input hook and missed key releases. Start fresh,
    // so the first shortcut after opening the laptop behaves like any other.
    const onWake = (why) => {
      held.clear();
      mainReleasedSinceFire = true;
      setTimeout(() => restartHook(why), 1000);
      setTimeout(prepareSpare, 1200);
      sysinfo.warmUp();
    };
    powerMonitor.on('resume', () => onWake('woke from sleep'));
    powerMonitor.on('unlock-screen', () => onWake('screen unlocked'));
    // Quiet once-a-day check. It only looks; installing always needs a click.
    setTimeout(() => {
      const s = store.getSettings();
      if (s.autoUpdateCheck !== false && Date.now() - (s.lastUpdateCheck || 0) > 20 * 3600 * 1000) runUpdateCheck();
    }, 12000);
    if (!startHidden || !r.ok) showMain(r.ok ? undefined : 'settings');
  });
  app.on('window-all-closed', () => {}); // keep running in the tray
  app.on('before-quit', () => {
    quitting = true;
    sysinfo.stopHelper();
    engine.shutdown();
    try {
      require('uiohook-napi').uIOhook.stop();
    } catch {}
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
