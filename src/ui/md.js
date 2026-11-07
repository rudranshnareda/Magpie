// Tiny, safe markdown for answers: paragraphs, bullet lists, **bold**, `code`, and [[terms]] -> clickable.
function renderMd(raw) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[\[([^\]]+)\]\]/g, '<span class="dig" data-t="$1">$1</span>');
  let html = '', list = false, para = [];
  const flush = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  for (const line of String(raw).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (m) {
      flush();
      if (!list) { html += '<ul>'; list = true; }
      html += '<li>' + inline(m[1]) + '</li>';
    } else if (!line.trim()) {
      flush();
      if (list) { html += '</ul>'; list = false; }
    } else {
      if (list) { html += '</ul>'; list = false; }
      para.push(line.trim());
    }
  }
  flush();
  if (list) html += '</ul>';
  return html;
}
