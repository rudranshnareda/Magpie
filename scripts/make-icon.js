// Generates assets/icon.png (256px): night tile with three iridescent feathers.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const N = 256;
const px = Buffer.alloc(N * N * 4);
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const night = hex('#0B0D12');
const feathers = [
  { c: [96, 150], a: 92, b: 24, ang: -0.95, col: hex('#3FBF9A') },
  { c: [128, 132], a: 100, b: 26, ang: -0.95, col: hex('#4FB2F0') },
  { c: [162, 114], a: 92, b: 24, ang: -0.95, col: hex('#6E8BFF') },
];
const clamp = (v) => Math.max(0, Math.min(1, v));

function tileAlpha(x, y) {
  const r = 58;
  const cx = Math.min(Math.max(x, r), N - r);
  const cy = Math.min(Math.max(y, r), N - r);
  const d = Math.hypot(x - cx, y - cy);
  return clamp(r - d + 0.5);
}
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let [R, G, B] = night;
    // soft aurora glow
    const glow = clamp(1 - Math.hypot(x - 190, y - 60) / 170) * 0.28;
    R += (110 - R) * glow;
    G += (139 - G) * glow;
    B += (255 - B) * glow;
    for (const f of feathers) {
      const dx = x - f.c[0], dy = y - f.c[1];
      const xr = dx * Math.cos(f.ang) + dy * Math.sin(f.ang);
      const yr = -dx * Math.sin(f.ang) + dy * Math.cos(f.ang);
      const d = Math.hypot(xr / f.a, yr / f.b);
      const al = clamp((1 - d) * f.b * 0.5 + 0.5) * 0.92;
      R += (f.col[0] - R) * al;
      G += (f.col[1] - G) * al;
      B += (f.col[2] - B) * al;
    }
    // white breast
    const bd = Math.hypot(x - 98, y - 176);
    const ba = clamp((34 - bd) * 0.5 + 0.5) * 0.95;
    R += (244 - R) * ba;
    G += (246 - G) * ba;
    B += (251 - B) * ba;
    const i = (y * N + x) * 4;
    px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = Math.round(tileAlpha(x, y) * 255);
  }
}

// --- minimal PNG encoder ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png);
console.log('wrote', path.join(out, 'icon.png'), png.length, 'bytes');
