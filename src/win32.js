// Direct calls into Windows (user32 / kernel32) for the steps that must be instant when the shortcut is pressed:
// which window is in front, sending Ctrl+C, and giving the popup the keyboard. Each call takes microseconds.
// (A PowerShell helper used to do this; right after a laptop wakes up it could take seconds.)
// If this fails to load for any reason, sysinfo.js falls back to the PowerShell helper.
const path = require('path');

let api = null;
try {
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    const k = koffi.load('kernel32.dll');
    api = {
      GetForegroundWindow: u.func('intptr_t __stdcall GetForegroundWindow()'),
      GetWindowTextW: u.func('int __stdcall GetWindowTextW(intptr_t hWnd, void *buf, int max)'),
      GetWindowThreadProcessId: u.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)'),
      AttachThreadInput: u.func('int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)'),
      SetForegroundWindow: u.func('int __stdcall SetForegroundWindow(intptr_t hWnd)'),
      BringWindowToTop: u.func('int __stdcall BringWindowToTop(intptr_t hWnd)'),
      ShowWindow: u.func('int __stdcall ShowWindow(intptr_t hWnd, int cmd)'),
      IsHungAppWindow: u.func('int __stdcall IsHungAppWindow(intptr_t hWnd)'),
      keybd_event: u.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)'),
      GetAsyncKeyState: u.func('int16_t __stdcall GetAsyncKeyState(int vk)'),
      GetKeyState: u.func('int16_t __stdcall GetKeyState(int vk)'),
      MapVirtualKeyW: u.func('uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t mapType)'),
      GetCurrentThreadId: k.func('uint32_t __stdcall GetCurrentThreadId()'),
      OpenProcess: k.func('intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
      QueryFullProcessImageNameW: k.func('int __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, void *buf, _Inout_ uint32_t *size)'),
      CloseHandle: k.func('int __stdcall CloseHandle(intptr_t h)'),
    };
  }
} catch {
  api = null;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const KEYEVENTF_KEYUP = 0x2;
const VK_CONTROL = 0x11;
const VK_C = 0x43;
const SW_SHOW = 5;

// Electron gives window handles as a Buffer; Windows wants a number.
const hwndOf = (buf) => Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));

function foreground() {
  const hwnd = api.GetForegroundWindow();
  const tbuf = Buffer.alloc(1024);
  const n = api.GetWindowTextW(hwnd, tbuf, 512);
  const pid = [0];
  api.GetWindowThreadProcessId(hwnd, pid);
  let processName = '';
  const ph = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]);
  if (ph) {
    const nbuf = Buffer.alloc(2048);
    const size = [1024];
    if (api.QueryFullProcessImageNameW(ph, 0, nbuf, size)) processName = path.win32.basename(nbuf.toString('utf16le', 0, size[0] * 2)).replace(/\.exe$/i, '');
    api.CloseHandle(ph);
  }
  return { process: processName, title: tbuf.toString('utf16le', 0, Math.max(0, n) * 2) };
}

// ---- Ctrl+C that is safe in every kind of app ----------------------------------------------------------------
// Two traps, both hit in testing:
//  * Modern apps (the new Notepad, WinUI) check whether Ctrl is down at the moment they handle the C key. A plain
//    instant Ctrl-down / C / Ctrl-up sequence has already released Ctrl by then, so they type "c" over the selection.
//  * WScript's SendKeys copies correctly but flips NumLock.
// So Ctrl is held until the app has *actually handled* the C key. We briefly share the app's keyboard state
// (AttachThreadInput) and watch it take Ctrl down, then C down, then C up; only then is Ctrl released. That works
// however slow the app is. The lock keys are never touched, and nothing is sent to an app Windows reports as hung.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyEvent = (vk, up) => api.keybd_event(vk, api.MapVirtualKeyW(vk, 0) & 0xff, up ? KEYEVENTF_KEYUP : 0, 0);
async function sendCopySafely() {
  const fg = api.GetForegroundWindow();
  if (!fg || api.IsHungAppWindow(fg)) return false;
  const tid = api.GetWindowThreadProcessId(fg, [0]);
  const me = api.GetCurrentThreadId();
  const attached = !!(tid && tid !== me && api.AttachThreadInput(me, tid, 1));
  // While attached, GetKeyState shows the keys as the app has processed them so far.
  const appSees = async (vk, down) => {
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      if (((api.GetKeyState(vk) & 0x8000) !== 0) === down) return true;
      await sleep(2);
    }
    return false;
  };
  try {
    keyEvent(VK_CONTROL, false);
    if (attached) await appSees(VK_CONTROL, true); else await sleep(30);
    keyEvent(VK_C, false);
    if (attached) await appSees(VK_C, true); else await sleep(30);
    keyEvent(VK_C, true);
    if (attached) await appSees(VK_C, false); else await sleep(150); // C-up handled => the C key was fully handled
  } finally {
    keyEvent(VK_CONTROL, true);
    if (attached) api.AttachThreadInput(me, tid, 0);
  }
  return true;
}

// Windows won't let a background app take the keyboard. Briefly joining the input queue of the window that has it
// makes the request count as coming from the foreground. Skipped if the window already has the keyboard (doing it
// anyway can make it lose focus), and never attaches to a hung app.
function focusWindow(hwnd) {
  const fg = api.GetForegroundWindow();
  if (fg === hwnd) return true;
  const fgThread = fg ? api.GetWindowThreadProcessId(fg, [0]) : 0;
  const me = api.GetCurrentThreadId();
  let attached = false;
  if (fgThread && fgThread !== me && !api.IsHungAppWindow(fg)) attached = !!api.AttachThreadInput(me, fgThread, 1);
  api.ShowWindow(hwnd, SW_SHOW);
  api.BringWindowToTop(hwnd);
  const ok = !!api.SetForegroundWindow(hwnd);
  if (attached) api.AttachThreadInput(me, fgThread, 0);
  return ok;
}

// Is any of these keys physically down right now? Asked straight from Windows, so it is correct even when the input
// hook's events haven't arrived yet (or the hook has been removed).
const anyDown = (vks) => vks.some((vk) => (api.GetAsyncKeyState(vk) & 0x8000) !== 0);

module.exports = { available: !!api, foreground, focusWindow, hwndOf, anyDown, sendCopySafely };
