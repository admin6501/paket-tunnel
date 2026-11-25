// Generate a PNG QR locally in the Worker; no credential is sent to a QR service.
import QRCode from 'qrcode/lib/core/qrcode.js';

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const nameBytes = new TextEncoder().encode(name);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(nameBytes, 4); out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export async function qrPng(text) {
  if (!text || new TextEncoder().encode(text).length > 2048) throw new Error('کانفیگ برای ساخت QR بیش از حد طولانی است.');
  let qr;
  try { qr = QRCode.create(text, { errorCorrectionLevel: 'L' }); }
  catch { throw new Error('ساخت QR برای این کانفیگ ممکن نیست.'); }
  const scale = 4, quiet = 4, width = (qr.modules.size + quiet * 2) * scale;
  const stride = width + 1, raw = new Uint8Array(stride * width);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const qx = Math.floor(x / scale) - quiet, qy = Math.floor(y / scale) - quiet;
      const black = qx >= 0 && qy >= 0 && qx < qr.modules.size && qy < qr.modules.size && qr.modules.get(qy, qx);
      raw[y * stride + x + 1] = black ? 0 : 255;
    }
  }
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, width); header[8] = 8; header[9] = 0;
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  return new Blob([new Uint8Array([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())], {type:'image/png'});
}
