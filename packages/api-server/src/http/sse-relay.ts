// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger, createEnvRedisClient } from '@pipeline-builder/api-core';
import type { SSEPayload } from './sse-connection-manager.js';

const logger = createLogger('sse-relay');

/**
 * A relayed SSE frame. `origin` is the id of the SSEManager instance that
 * published it, so the publishing pod can ignore its own echo (it already wrote
 * the frame to its local clients before publishing). `kind` distinguishes a
 * per-subject `send` (carries `requestId`) from a `broadcast` (no subject —
 * every pod re-emits to ALL of its local clients).
 */
export interface SSERelayMessage {
  origin: string;
  kind: 'send' | 'broadcast';
  /** Present for `send`; the stream subject the payload targets. */
  requestId?: string;
  payload: SSEPayload;
}

/**
 * Cross-pod fan-out bus for SSE frames.
 *
 * Under multiple replicas the producer of a log frame (e.g. a plugin build
 * worker on pod A) and the consumer (a browser EventSource on pod B) are on
 * DIFFERENT pods. The in-process client map only reaches the producer's own
 * pod, so B's stream would silently miss frames. The relay closes that: every
 * pod SUBSCRIBES once on startup and re-emits received frames to its LOCAL
 * clients, while `send()`/`broadcast()` PUBLISH to the bus (in addition to
 * writing locally). The origin tag prevents a pod from double-delivering its own
 * frame when it receives its own publish back.
 *
 * All methods are best-effort / fail-safe: a bus outage must degrade to
 * local-only delivery (today's single-replica behavior), never crash the stream.
 */
export interface SSERelay {
  /** Fire-and-forget publish of a frame to every subscribed pod. Never throws. */
  publish(msg: SSERelayMessage): void;
  /** Subscribe this pod's re-emit handler. Called once on manager construction. */
  subscribe(handler: (msg: SSERelayMessage) => void): void;
  /** Tear down the underlying connection(s). */
  close(): Promise<void>;
}

/**
 * Minimal ioredis pub/sub surface the Redis relay needs. `subscribe` requires a
 * DEDICATED connection (a subscribed ioredis client can't run other commands),
 * so the relay `duplicate()`s the publisher for the subscriber side.
 */
export interface RedisPubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: 'message', cb: (channel: string, message: string) => void): void;
  duplicate(): RedisPubSubClient;
  quit(): Promise<unknown>;
}

/**
 * Single channel carrying every relayed frame. `requestId` rides in the message
 * body rather than the channel name so each pod SUBSCRIBES exactly once on
 * startup — no per-subject subscribe/unsubscribe churn as clients come and go.
 */
const RELAY_CHANNEL = 'sse:relay';

/**
 * Redis-backed relay. Uses the given client for PUBLISH and a `duplicate()` for
 * SUBSCRIBE (ioredis forbids mixing subscribe with normal commands on one
 * connection). Publish is fire-and-forget with a swallowed rejection; a subscribe
 * handler that throws is isolated so one bad frame can't kill the subscriber.
 */
export function createRedisSSERelay(publisher: RedisPubSubClient): SSERelay {
  const subscriber = publisher.duplicate();
  let closed = false;

  return {
    publish(msg) {
      if (closed) return;
      // Fire-and-forget: never await, never surface a rejection to the caller.
      void Promise.resolve(publisher.publish(RELAY_CHANNEL, JSON.stringify(msg))).catch((err) => {
        logger.warn('SSE relay publish failed', { error: err instanceof Error ? err.message : String(err) });
      });
    },
    subscribe(handler) {
      subscriber.on('message', (channel, message) => {
        if (channel !== RELAY_CHANNEL) return;
        let parsed: SSERelayMessage;
        try {
          parsed = JSON.parse(message) as SSERelayMessage;
        } catch (err) {
          logger.warn('SSE relay received unparseable frame', { error: err instanceof Error ? err.message : String(err) });
          return;
        }
        try {
          handler(parsed);
        } catch (err) {
          logger.warn('SSE relay handler threw', { error: err instanceof Error ? err.message : String(err) });
        }
      });
      void Promise.resolve(subscriber.subscribe(RELAY_CHANNEL)).catch((err) => {
        logger.warn('SSE relay subscribe failed — falling back to local-only delivery', { error: err instanceof Error ? err.message : String(err) });
      });
    },
    async close() {
      closed = true;
      await Promise.allSettled([publisher.quit(), subscriber.quit()]);
    },
  };
}

/**
 * Build a Redis-backed SSE relay from the shared env Redis (same wiring as the
 * SSE ticket store / rate-limiter / audit-spool). Returns null when Redis isn't
 * configured so the caller keeps local-only delivery. Never throws.
 */
export function createEnvRedisSSERelay(): SSERelay | null {
  const client = createEnvRedisClient<RedisPubSubClient>('sse-relay');
  if (!client) return null;
  logger.info('Redis SSE relay initialized (cross-pod fan-out enabled)');
  return createRedisSSERelay(client);
}
