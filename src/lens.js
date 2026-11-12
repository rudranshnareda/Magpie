// "Search with Google Lens": uploads the snip to Google Lens the same way the Lens website does, then opens the
// results page in the default browser. Only ever runs when the user picks that action.
const UPLOAD = 'https://lens.google.com/v3/upload';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Returns the results URL. Throws if Google didn't answer with one.
async function upload(png) {
  const form = new FormData();
  form.append('encoded_image', new Blob([png], { type: 'image/png' }), 'snip.png');
  const res = await fetch(`${UPLOAD}?ep=ccm&re=dcsp&s=4&st=${Date.now()}`, {
    method: 'POST', body: form, redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000),
  });
  const to = res.headers.get('location') || '';
  // only ever open a Google results page, whatever the server sends
  if (res.status >= 300 && res.status < 400 && /^https:\/\/(www|lens)\.google\.com\//.test(to)) return to;
  throw new Error(`Google Lens answered ${res.status}`);
}

module.exports = { upload };
