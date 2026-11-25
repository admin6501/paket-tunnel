export const UPLOAD_SETTINGS = 'website_upload_limits';
export const MIN_IMAGE_KIB = 128;
export const MAX_IMAGE_KIB = 5120;
export const MAX_TICKET_IMAGES = 4;
const defaults = { receiptKiB: 2048, ticketKiB: 2048 };

export function parseUploadLimits(value) {
  const { receiptKiB, ticketKiB } = value ?? {};
  return [receiptKiB, ticketKiB].every(size => Number.isInteger(size) && size >= MIN_IMAGE_KIB && size <= MAX_IMAGE_KIB)
    ? { receiptKiB, ticketKiB } : null;
}

export async function readUploadLimits(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key=?').bind(UPLOAD_SETTINGS).first();
  try { return parseUploadLimits(JSON.parse(row?.value ?? 'null')) ?? defaults; }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; return defaults; }
}

export function isJPEG(bytes) {
  return bytes?.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}

export const imageIdPattern = /^[a-f0-9]{32}$/;

export function privateJPEG(bytes) {
  return new Response(bytes, { headers: {
    'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  } });
}
