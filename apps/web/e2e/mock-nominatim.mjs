// A stand-in for OpenStreetMap Nominatim's /search, for end-to-end tests: every address gets
// a stable point around Lima, except ones mentioning "nowhere".
import { createServer } from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';

const port = Number(process.env.PORT ?? 3200);
createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/status') return res.end('ok');
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  let h = 0;
  for (const ch of q) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const body = q.includes('nowhere')
    ? []
    : [
        {
          lat: String(-12.05 - (h % 1000) / 20000),
          lon: String(-77.04 - (h % 997) / 20000),
          addresstype: 'house',
        },
      ];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}).listen(port);
