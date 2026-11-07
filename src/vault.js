// Saves rabbithole nodes as Obsidian-compatible markdown with wikilinks.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const vaultDir = () => {
  const d = store.getSettings().vaultPath;
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const safe = (s) => String(s).replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';

function save({ title, body, parent }) {
  const dir = vaultDir();
  const name = safe(title);
  const file = path.join(dir, `${name}.md`);
  const links = [...new Set([...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]))];
  const fm = ['---', `parent: ${parent ? `"[[${safe(parent)}]]"` : 'null'}`, `created: ${new Date().toISOString()}`, 'tags: [magpie]', '---', ''];
  fs.writeFileSync(file, `${fm.join('\n')}# ${name}\n\n${body}\n${links.length ? `\n## Dig deeper\n${links.map((l) => `- [[${l}]]`).join('\n')}\n` : ''}`);
  if (parent) {
    const pf = path.join(dir, `${safe(parent)}.md`);
    if (fs.existsSync(pf)) {
      const t = fs.readFileSync(pf, 'utf8');
      if (!t.includes(`- Explored: [[${name}]]`)) fs.appendFileSync(pf, `\n- Explored: [[${name}]]\n`);
    }
  }
  return file;
}

// Known terms = titles of every saved note (you've already seen them).
function known() {
  try {
    return fs.readdirSync(vaultDir()).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

// Trail of ancestors, following `parent:` frontmatter.
function trail(title) {
  const dir = vaultDir();
  const out = [];
  let cur = title ? safe(title) : null;
  for (let i = 0; cur && i < 8; i++) {
    out.unshift(cur);
    try {
      const m = fs.readFileSync(path.join(dir, `${cur}.md`), 'utf8').match(/^parent: "\[\[(.+?)\]\]"/m);
      cur = m ? m[1] : null;
    } catch {
      break;
    }
  }
  return out;
}

module.exports = { save, known, trail, vaultDir, safe };
