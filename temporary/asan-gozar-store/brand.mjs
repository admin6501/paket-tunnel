export const BRAND_KEY = 'website_brand';
export const DEFAULT_BRAND = 'آسان‌گذر';
const brandWords = /\{brand\}|آسان[\u200c\p{Zs}]?گذر/gu;

export function validBrandName(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim().replace(/\p{Zs}+/gu, ' ');
  return [...name].length <= 60 && /[\p{L}\p{N}]/u.test(name) &&
    /^[\p{L}\p{N}\p{M}\p{P} \u200c]+$/u.test(name) && !/[{}<>]/u.test(name) ? name : null;
}

export async function readBrand(db) {
  const row = await db.prepare('SELECT value FROM settings WHERE key=?').bind(BRAND_KEY).first();
  return validBrandName(row?.value) || DEFAULT_BRAND;
}

export const brandText = (text, replacement) => text.replace(brandWords, () => replacement);
