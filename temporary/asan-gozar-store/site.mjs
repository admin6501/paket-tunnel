import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_BRAND, readBrand } from './brand.mjs';

const names = ['index.html', 'account.html', 'prices.html', 'services.html', 'network.html',
  'status.html', 'faq.html', 'contact.html', 'favicon.svg', 'app.webmanifest'];
const appLinks = `<link rel="manifest" href="/app.webmanifest">
  <link rel="apple-touch-icon" href="/app-icon-180.png">
  <script src="/app-install.js?v=1" defer></script>`;
const escapeMarkup = value => value.replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const firstLetter = /[\p{L}\p{N}]\p{M}*/u;
const organizationTag = '<!-- store-organization -->';

export function loadStorePages(directory) {
  const pages = new Map();
  for (const name of names) {
    const content = readFileSync(resolve(directory, name), 'utf8');
    const templateSha = createHash('sha256').update(content).digest('hex');
    pages.set('/' + name, { content, templateSha });
  }
  pages.set('/', pages.get('/index.html'));
  return pages;
}

export async function webStorePage(request, page, env) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const name = await readBrand(env.DB);
  const pathname = new URL(request.url).pathname;
  const headers = { 'Cache-Control': 'no-store', 'X-Store-Template-SHA256': page.templateSha };
  if (pathname === '/app.webmanifest') {
    const manifest = { ...JSON.parse(page.content), name, short_name: name };
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(manifest), {
      headers: { ...headers, 'Content-Type': 'application/manifest+json; charset=utf-8' },
    });
  }
  const escaped = escapeMarkup(name);
  const mark = escapeMarkup(name.match(firstLetter)[0].toLocaleUpperCase());
  const svg = pathname === '/favicon.svg';
  const markup = page.content.replaceAll(DEFAULT_BRAND, () => escaped)
    .replaceAll('https://asan-gozar.ir/', () => env.WEB_SHOP_ORIGIN + '/')
    .replaceAll('<span class="logo-mark" aria-hidden="true">آ</span>', () => `<span class="logo-mark" aria-hidden="true">${mark}</span>`)
    .replace('<!-- store-mark -->آ', () => mark);
  const organization = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Organization', name, url: env.WEB_SHOP_ORIGIN + '/',
  }).replaceAll('<', '\\u003c');
  const body = svg ? markup : markup.replace(organizationTag, () => `<script type="application/ld+json">${organization}</script>`)
    .replace('<head>', () => `<head>\n  ${appLinks}`);
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: {
      'Content-Type': svg ? 'image/svg+xml; charset=utf-8' : 'text/html; charset=utf-8',
      ...headers,
    },
  });
}
