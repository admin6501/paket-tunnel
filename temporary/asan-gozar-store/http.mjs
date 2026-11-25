import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { isWebShopPath } from './shop-api.js';

export async function listenForWebShop(handler, env, port) {
  const server = createServer({ requestTimeout: 15_000 }, async (req, res) => {
    try {
      const url = new URL(req.url, env.WEB_SHOP_ORIGIN);
      if (url.origin !== env.WEB_SHOP_ORIGIN || !(isWebShopPath(url.pathname) || env.WEB_STORE_PAGES?.has(url.pathname))) {
        res.writeHead(404).end();
        return;
      }
      const forwarded = req.headers['x-real-ip'];
      const ip = typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      const method = req.method;
      const request = new Request(url, {
        method, headers,
        ...(!['GET','HEAD'].includes(method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const response = await handler(request, { ...env, WEB_SHOP_IP: ip });
      for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('Set-Cookie', cookies);
      res.statusCode = response.status;
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'})
        .end(JSON.stringify({error:'نتیجهٔ درخواست نامشخص است. وضعیت سفارش را بررسی کنید.'}));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
