// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `initSSEStream` must report a client disconnect for a POST stream whose JSON
 * body was parsed before the stream starts (the AI generate routes). On Node 24
 * the request's 'close' fires as soon as the body is consumed — before the
 * listener is attached — so a `req.on('close')` detector never fired.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import express from 'express';
import { initSSEStream } from '../src/helpers/sse-helpers.js';

let server: http.Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function start(handler: express.RequestHandler): Promise<number> {
  const app = express();
  app.use(express.json());
  app.post('/stream', handler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server!.once('listening', () => r()));
  return (server.address() as AddressInfo).port;
}

const waitFor = async (cond: () => boolean, ms = 2_000) => {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
};

describe('initSSEStream abort detection', () => {
  it('is not aborted while the client is connected, and is aborted after it disconnects (POST with a parsed body)', async () => {
    let sse: { aborted: () => boolean } | undefined;
    let abortedWhileConnected: boolean | undefined;
    const port = await start((req, res) => {
      // Body was fully read by express.json() before the stream begins.
      expect(req.body).toEqual({ prompt: 'hi' });
      sse = initSSEStream(req, res, 60_000);
      res.write('data: {}\n\n');
    });

    const clientReq = http.request({ host: '127.0.0.1', port, path: '/stream', method: 'POST', headers: { 'content-type': 'application/json' } });
    await new Promise<void>((resolve) => {
      clientReq.on('response', (resp) => {
        resp.once('data', () => {
          abortedWhileConnected = sse!.aborted();
          clientReq.destroy(); // client goes away mid-stream
          resolve();
        });
      });
      clientReq.on('error', () => undefined);
      clientReq.end(JSON.stringify({ prompt: 'hi' }));
    });

    expect(abortedWhileConnected).toBe(false);
    await waitFor(() => sse!.aborted());
    expect(sse!.aborted()).toBe(true);
  });

  it('a stream the server ends normally is not reported as aborted', async () => {
    let sse: { aborted: () => boolean } | undefined;
    let closed = false;
    const port = await start((req, res) => {
      sse = initSSEStream(req, res, 60_000);
      res.on('close', () => { closed = true; });
      res.end('data: done\n\n');
    });
    const resp = await fetch(`http://127.0.0.1:${port}/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    await resp.text();
    await waitFor(() => closed);
    expect(sse!.aborted()).toBe(false);
  });
});

describe('initSSEStream writer', () => {
  it('send writes JSON frames and done writes the final event then [DONE]', async () => {
    const port = await start((req, res) => {
      const sse = initSSEStream(req, res, 60_000);
      sse.send({ type: 'token', data: 'a' });
      sse.done({ type: 'done' });
      res.end();
    });
    const resp = await fetch(`http://127.0.0.1:${port}/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    expect(await resp.text()).toBe('data: {"type":"token","data":"a"}\n\ndata: {"type":"done"}\n\ndata: [DONE]\n\n');
  });

  it('writes nothing after the client disconnects', () => {
    let onClose: () => void = () => undefined;
    const write = jest.fn();
    const res = {
      setHeader: jest.fn(),
      setTimeout: jest.fn(),
      flushHeaders: jest.fn(),
      write,
      writableFinished: false,
      on: (_e: string, cb: () => void) => { onClose = cb; },
    };
    const sse = initSSEStream({} as never, res as never, 1000);
    onClose();
    expect(sse.signal.aborted).toBe(true);
    sse.send({ type: 'x' });
    sse.done();
    expect(write).not.toHaveBeenCalled();
  });
});
