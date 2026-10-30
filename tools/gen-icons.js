'use strict';
// Generate icon-192.png / icon-512.png: green→blue gradient rounded square + white circle + green phone dot.
// Pure Node (zlib) PNG encoder — no dependencies.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.19; // corner radius
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 4;
      // rounded-corner mask
      const cx = Math.min(x, size - 1 - x), cy = Math.min(y, size - 1 - y);
      const inCorner = cx < r && cy < r;
      const dx = r - cx, dy = r - cy;
      const inside = !inCorner || (dx * dx + dy * dy) <= r * r;
      // diagonal gradient green -> blue
      const t = (x + y) / (2 * size);
      let R = Math.round(0x0e + (0x25 - 0x0e) * t);
      let G = Math.round(0x9f + (0x63 - 0x9f) * t);
      let B = Math.round(0x6e + (0xeb - 0x6e) * t);
      let A = inside ? 255 : 0;
      // white circle (the "A" stand-in: a bold white disc with green core reads well at small sizes)
      const ccx = size / 2, ccy = size / 2, cr = size * 0.30;
      const ddx = x - ccx, ddy = y - ccy, dd = Math.sqrt(ddx * ddx + ddy * ddy);
      if (inside && dd <= cr) { R = 255; G = 255; B = 255; }
      if (inside && dd <= cr * 0.45) { R = 0x0e; G = 0x9f; B = 0x6e; }
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = A;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const s of [192, 512]) {
  const p = path.join(__dirname, '..', 'public', 'icon-' + s + '.png');
  fs.writeFileSync(p, makePng(s));
  console.log('wrote', p);
}
