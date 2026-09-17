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
  on(event: 'error', cb: (err: unknown) => void): void;
  duplicate(): RedisPubSubClient;
  quit(): Promise<unknown>;
}

/**
 * The relay channel for one service. Every replica of a service shares it, and
 * no other service does: an SSE subject (an org id, a build requestId) only has
 * meaning inside the service whose clients subscribed to it, so a shared channel
 * made every service's pods parse — and re-emit to same-named subjects — every
 * other service's frames. `requestId` rides in the message body rather than the
 * channel name so each pod SUBSCRIBES exactly once on startup — no per-subject
 * subscribe/unsubscribe churn as clients come and go.
 */
export function sseRelayChannel(serviceName: string): string {
  return `sse:relay:${serviceName}`;
}

/** Backoff bounds for the startup SUBSCRIBE retry. */
const SUBSCRIBE_RETRY_MIN_MS = 500;
const SUBSCRIBE_RETRY_MAX_MS = 30_000;

/**
 * Redis-backed relay. Uses the given client for PUBLISH and a `duplicate()` for
 * SUBSCRIBE (ioredis forbids mixing subscribe with normal commands on one
 * connection). Publish is fire-and-forget with a swallowed rejection; a subscribe
 * handler that throws is isolated so one bad frame can't kill the subscriber.
 */
export function createRedisSSERelay(publisher: RedisPubSubClient, channel: string): SSERelay {
  const subscriber = publisher.duplicate();
  // A duplicated ioredis connection doesn't inherit the publisher's listeners;
  // without its own, a dropped connection is an unhandled 'error' that crashes Node.
  subscriber.on('error', (err) => {
    logger.warn('SSE relay subscriber connection error', { channel, error: err instanceof Error ? err.message : String(err) });
  });
  let closed = false;

  return {
    publish(msg) {
      if (closed) return;
      // Fire-and-forget: never await, never surface a rejection to the caller.
      void Promise.resolve(publisher.publish(channel, JSON.stringify(msg))).catch((err) => {
        logger.warn('SSE relay publish failed', { error: err instanceof Error ? err.message : String(err) });
      });
    },
    subscribe(handler) {
      subscriber.on('message', (received, message) => {
        if (received !== channel) return;
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
      // Retry until subscribed: at startup the connection usually isn't up yet,
      // and giving up after one attempt left the pod on local-only delivery for
      // its whole life. Once subscribed, ioredis re-subscribes after reconnects.
      let delayMs = SUBSCRIBE_RETRY_MIN_MS;
      const attempt = (): void => {
        if (closed) return;
        void Promise.resolve(subscriber.subscribe(channel)).then(
          () => logger.info('SSE relay subscribed', { channel }),
          (err) => {
            logger.warn('SSE relay subscribe failed; retrying (local-only delivery meanwhile)', {
              retryInMs: delayMs, error: err instanceof Error ? err.message : String(err),
            });
            setTimeout(attempt, delayMs).unref?.();
            delayMs = Math.min(delayMs * 2, SUBSCRIBE_RETRY_MAX_MS);
          },
        );
      };
      attempt();
    },
    async close() {
      closed = true;
      await Promise.allSettled([publisher.quit(), subscriber.quit()]);
    },
  };
}

/**
 * Build a Redis-backed SSE relay from the shared env Redis, on this service's
 * own channel (`SERVICE_NAME`). Returns null when Redis isn't configured so the
 * caller keeps local-only delivery.
 */
export function createEnvRedisSSERelay(serviceName: string = process.env.SERVICE_NAME || 'api'): SSERelay | null {
  const client = createEnvRedisClient<RedisPubSubClient>('sse-relay');
  if (!client) return null;
  const channel = sseRelayChannel(serviceName);
  logger.info('Redis SSE relay initialized (cross-pod fan-out enabled)', { channel });
  return createRedisSSERelay(client, channel);
}
