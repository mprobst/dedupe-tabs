/**
 * A local HTTP server for the end-to-end tests, so tabs have real http URLs.
 *
 *  /<anything>           a page titled with its path
 *  /redirect?to=<url>    302 redirect to <url>
 *  /opener?href=<url>    a page with a target=_blank link (#link) to <url> and
 *                        a button (#popup) that does window.open('') and then
 *                        navigates the new window to <url>, like some web apps
 *                        do for links.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type TestServer = {
  /** The server's origin, e.g. `http://127.0.0.1:1234`. */
  base: string;
  /** The absolute URL of `path` (including any query or fragment) on this server. */
  url: (path: string) => string;
  close(): Promise<void>;
};

export async function startServer(): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: url.searchParams.get('to') ?? '/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (url.pathname === '/opener') {
      const href = JSON.stringify(url.searchParams.get('href'));
      res.end(`<title>opener</title>
        <a id="link" target="_blank" href=${href}>link</a>
        <button id="popup" onclick="const w = window.open(''); w.location.href = ${href.replace(/"/g, '&quot;')};">popup</button>`);
      return;
    }
    res.end(`<title>${url.pathname}</title><p>${url.pathname}${url.search}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    url: (path) => base + path,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
