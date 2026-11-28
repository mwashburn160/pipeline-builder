// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Forward 127.0.0.1:<port> inside the Playwright container to the app on the
 * Docker host, so the browser still loads it from `http://localhost:<port>` —
 * the same origin the app runs at everywhere else (cookies, CSP, Next's dev
 * origin check).
 *
 *   node tcp-forward.mjs <port> <target-host>
 */
import net from 'node:net';

const [port = '3311', host = 'host.docker.internal'] = process.argv.slice(2);
net.createServer((client) => {
  const upstream = net.connect(Number(port), host);
  client.pipe(upstream).pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close);
  upstream.on('error', close);
}).listen(Number(port), '127.0.0.1', () => console.log(`forwarding 127.0.0.1:${port} -> ${host}:${port}`));
