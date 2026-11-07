// In-app updates. Asks GitHub for the latest release, downloads the installer, verifies its SHA-256,
// then runs it silently. Nothing is downloaded or installed until the user clicks "Update now".
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'rudranshnareda/Magpie';
// Test hooks (never set in normal use): point at another feed, pretend to be another version, skip the real install.
const feedUrl = () => process.env.MAGPIE_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
const currentVersion = () => process.env.MAGPIE_FAKE_VERSION || app.getVersion();
const tmpDir = () => path.join(os.tmpdir(), 'Magpie-update');
const HEADERS = { 'user-agent': 'Magpie-updater', accept: 'application/vnd.github+json' };

const parts = (v) => String(v).replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

let found = null; // details of the newer release, if there is one
let ready = null; // path of a downloaded and verified installer

async function check() {
  let res;
  try {
    res = await fetch(feedUrl(), { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('Could not reach GitHub. Check your internet connection.');
  }
  if (res.status === 404) throw new Error('No releases found.');
  if (!res.ok) throw new Error(`GitHub answered with an error (${res.status}). Try again later.`);
  const j = await res.json();
  const latest = String(j.tag_name || '').replace(/^v/i, '');
  const asset = (j.assets || []).find((a) => /^Magpie-Setup-.+\.exe$/i.test(a.name));
  // Prefer GitHub's own digest of the uploaded file; fall back to the checksum printed in the release notes.
  let sha256 = '';
  if (asset && typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) sha256 = asset.digest.slice(7).toLowerCase();
  else {
    const m = String(j.body || '').match(/SHA-256:?\**\s*`?([0-9a-f]{64})/i);
    if (m) sha256 = m[1].toLowerCase();
  }
  if (latest && asset && isNewer(latest, currentVersion())) {
    found = { latest, assetName: asset.name, assetUrl: asset.browser_download_url, size: asset.size || 0, sha256, url: j.html_url || '' };
    if (ready && !ready.includes(asset.name)) ready = null;
  } else {
    found = null;
    ready = null;
  }
  return state();
}

async function download(onProgress) {
  if (!found) throw new Error('Check for updates first.');
  if (!found.sha256) throw new Error('This release has no checksum, so Magpie cannot verify it. Download it from the release page instead.');
  fs.rmSync(tmpDir(), { recursive: true, force: true });
  fs.mkdirSync(tmpDir(), { recursive: true });
  const file = path.join(tmpDir(), found.assetName);
  let res;
  try {
    res = await fetch(found.assetUrl, { headers: { 'user-agent': 'Magpie-updater' }, redirect: 'follow' });
  } catch {
    throw new Error('Could not download the update. Check your internet connection.');
  }
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || found.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let got = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
      got += value.length;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      onProgress?.(got, total);
    }
  } catch {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw new Error('The download was interrupted. Try again.');
  }
  await new Promise((r) => out.end(r));
  if (hash.digest('hex') !== found.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error('The downloaded file did not match its checksum, so it was discarded and not run.');
  }
  ready = file;
  return file;
}

async function install() {
  if (!ready || !fs.existsSync(ready)) throw new Error('Download the update first.');
  if (process.env.MAGPIE_UPDATE_DRYRUN) return { dryRun: true, file: ready };
  if (!app.isPackaged) throw new Error('Updates install only in the installed app. When running from source, run the downloaded setup yourself.');
  // Same arguments electron-builder's own updater uses: silent, mark as an update, reopen the app afterwards.
  const child = spawn(ready, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const err = await new Promise((resolve) => {
    child.once('error', resolve);
    setTimeout(() => resolve(null), 700);
  });
  if (err) throw new Error(`Could not start the installer: ${err.message}`);
  return { dryRun: false, file: ready };
}

function state() {
  return { current: currentVersion(), available: !!found, ready: !!ready, ...(found || {}) };
}

module.exports = { check, download, install, state, isNewer, REPO };
