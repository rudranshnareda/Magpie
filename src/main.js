const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage, nativeTheme, shell, dialog } = require('electron');
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
function openQuick({ question = '', selection = '', app: appInfo = {}, shot = null, parent = null, mode = 'center', offset = 0, autoAsk = false }) {
  const h = 64; // content-sized: the page reports its real height right after it loads
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt).workArea;
  let x, y;
  if (mode === 'center') {
    x = Math.round(d.x + (d.width - QUICK_W) / 2);
    y = Math.round(d.y + d.height * 0.2);
  } else {
    x = Math.min(Math.max(pt.x + 14 + offset, d.x), d.x + d.width - QUICK_W);
    y = Math.min(Math.max(pt.y + 18 + offset, d.y), d.y + d.height - 180);
  }
  const win = new BrowserWindow({
    width: QUICK_W, height: h, x, y, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, show: false, icon: ICON,
    ...material('acrylic'),
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(UI('quick.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  quickCtx.set(win, { app: appInfo, shot, selection, parent, title: titleFor(question, selection), entryId: null, job: null, tween: null, asked: false });
  win.webContents.once('did-finish-load', () => {
    const cfg = store.currentProvider();
    win.webContents.send('init', { question, selection, parent, autoAsk, app: appInfo, hasShot: !!shot, engine: engineLabel(cfg) });
  });
  win.on('closed', () => {
    const c = quickCtx.get(win);
    c?.job?.cancel();
    clearInterval(c?.tween);
    // a screenshot that never got attached to a logged question is just clutter
    if (c?.shot) fs.rmSync(path.join(store.shotsDir(), c.shot), { force: true });
    quickCtx.delete(win);
  });
  return win;
}
const engineLabel = (cfg) => (cfg.model ? `${cfg.label} · ${cfg.model}` : cfg.label);

// ---------------------------------------------------------------- hotkey / selection flows
const held = new Set();
async function waitModifiersReleased() {
  for (let i = 0; i < 40 && held.size > 0; i++) await new Promise((r) => setTimeout(r, 25));
  if (!hookRunning) await new Promise((r) => setTimeout(r, 350));
}

async function gatherAndOpen(mode) {
  const s = store.getSettings();
  engine.prewarm(store.currentProvider()); // start the slow part now; it finishes while you type
  const ownFocused = !!BrowserWindow.getFocusedWindow();
  await waitModifiersReleased();
  const appInfo = ownFocused ? { process: '', title: '' } : await sysinfo.activeWindow();
  const id = newId();
  const wantShot = s.log.enabled && !ownFocused ? s.log.screenshot : 'off';
  const [selection, shot] = await Promise.all([
    ownFocused ? '' : sysinfo.captureSelection(appInfo),
    sysinfo.screenshot(wantShot, appInfo.title, id),
  ]);
  openQuick({ selection, app: appInfo, shot, mode });
}

// Both the OS shortcut and the AltGr fallback end up here; never fire twice for one key press.
function fireHotkey() {
  if (Date.now() - lastFire < 500) return;
  lastFire = Date.now();
  toggleAsk();
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
function createAskButton() {
  askBtn = new BrowserWindow({
    width: 140, height: 40, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, resizable: false, show: false, hasShadow: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  askBtn.setAlwaysOnTop(true, 'screen-saver');
  askBtn.loadFile(UI('askbtn.html'));
}
function hideAskButton() {
  clearTimeout(askBtnTimer);
  if (askBtn && !askBtn.isDestroyed() && askBtn.isVisible()) askBtn.hide();
}
function showAskButton(px, py) {
  if (!askBtn || askBtn.isDestroyed()) return;
  const dip = process.platform === 'win32' ? screen.screenToDipPoint({ x: px, y: py }) : { x: px, y: py };
  const d = screen.getDisplayNearestPoint(dip).workArea;
  const b = askBtn.getBounds();
  askBtn.setPosition(Math.round(Math.min(Math.max(dip.x + 8, d.x), d.x + d.width - b.width)), Math.round(Math.min(Math.max(dip.y + 16, d.y), d.y + d.height - b.height)));
  askBtn.showInactive();
  engine.prewarm(store.currentProvider()); // they probably will click it
  clearTimeout(askBtnTimer);
  askBtnTimer = setTimeout(hideAskButton, 5000);
}
function startInputHooks() {
  try {
    const { uIOhook, UiohookKey: K } = require('uiohook-napi');
    const mods = new Set([K.Ctrl, K.CtrlRight, K.Alt, K.AltRight, K.Shift, K.ShiftRight, K.Meta, K.MetaRight]);
    uIOhook.on('keydown', (e) => {
      if (mods.has(e.keycode)) return held.add(e.keycode);
      if (altGrKey && e.keycode === altGrKey.code && held.has(altGrKey.altRight) && !held.has(altGrKey.ctrlRight)) fireHotkey();
    });
    uIOhook.on('keyup', (e) => held.delete(e.keycode));
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
      const looksLikeSelection = (dist > 12 && Date.now() - down.t > 180) || e.clicks >= 2;
      down = null;
      if (!looksLikeSelection || BrowserWindow.getFocusedWindow()) return;
      showAskButton(e.x, e.y);
    });
    uIOhook.start();
    hookRunning = true;
  } catch (err) {
    console.error('Input hook unavailable; the Ask button is disabled, the hotkey still works.', err.message);
  }
}

// ---------------------------------------------------------------- IPC: quick window
ipcMain.on('quick:ask', (e, { question }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const ctx = quickCtx.get(win);
  if (!ctx) return;
  const s = store.getSettings();
  const cfg = store.currentProvider();
  ctx.job?.cancel();
  ctx.asked = true;
  ctx.title = titleFor(question, ctx.selection);
  const sender = e.sender;
  const job = engine.explain(
    {
      question, selection: ctx.selection, trail: vault.trail(ctx.parent), known: vault.known(),
      // only share what the user has switched on in Settings
      app: { process: s.log.appName ? ctx.app.process : '', title: s.log.windowTitle ? ctx.app.title : '' },
    },
    (c) => !sender.isDestroyed() && sender.send('delta', c),
    cfg
  );
  ctx.job = job;
  job.promise
    .then((answer) => {
      if (answer === null || sender.isDestroyed()) return;
      if (s.log.enabled) {
        const entry = store.addEntry({
          id: newId(), ts: Date.now(), question, selection: s.log.selectedText ? ctx.selection : '',
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
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: Math.min(b.y, d.y + d.height - h - 8), width: b.width, height: h });
    if (p >= 1) clearInterval(ctx.tween);
  }, 12);
});
ipcMain.on('quick:dismiss', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('quick:clearSel', (e) => {
  const ctx = quickCtx.get(BrowserWindow.fromWebContents(e.sender));
  if (ctx) ctx.selection = '';
});
ipcMain.on('quick:dig', (e, { term }) => {
  const ctx = quickCtx.get(BrowserWindow.fromWebContents(e.sender));
  openQuick({ question: term, parent: ctx?.title || null, app: ctx?.app || {}, mode: 'cursor', offset: 28, autoAsk: true });
});
ipcMain.on('app:openSettings', () => showMain('settings'));
ipcMain.on('askbtn:click', async () => {
  hideAskButton();
  await new Promise((r) => setTimeout(r, 60));
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
  openQuick({ question: term, parent: e ? titleFor(e.question, e.selection) : null, mode: 'center', autoAsk: true });
});
ipcMain.on('history:ask', () => gatherAndOpen('center'));
ipcMain.on('shell:reveal', (_, file) => file && shell.showItemInFolder(file));

ipcMain.handle('settings:get', () => store.publicSettings());
ipcMain.handle('settings:set', (_, patch) => {
  delete patch.secrets;
  store.setSettings(patch);
  if ('openAtLogin' in patch && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!patch.openAtLogin, args: ['--hidden'] });
  return store.publicSettings();
});
ipcMain.handle('settings:hotkey', (_, accel) => {
  const r = registerHotkey(accel);
  if (r.ok) store.setSettings({ hotkey: accel });
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
  return store.publicSettings();
});
ipcMain.handle('provider:test', (_, id) => engine.test(store.currentProvider(id)));
ipcMain.handle('provider:models', (_, id) => engine.listOllama(store.currentProvider(id).baseUrl));

ipcMain.handle('app:status', () =>
  new Promise((resolve) => {
    execFile('claude', ['--version'], { windowsHide: true, timeout: 8000 }, (err, out) =>
      resolve({ claude: err ? null : out.trim(), version: app.getVersion(), packaged: app.isPackaged, hook: hookRunning, dataDir: app.getPath('userData') })
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
    sysinfo.startHelper();
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
    tray.on('click', () => showMain());
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Magpie', click: () => showMain() },
        { label: 'Ask a question', click: () => toggleAsk() },
        { label: 'Open vault folder', click: () => shell.openPath(vault.vaultDir()) },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    );
    const r = registerHotkey(store.getSettings().hotkey);
    createAskButton();
    startInputHooks();
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
