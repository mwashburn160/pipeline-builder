// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-replica invalidation of the runner signing-key caches: plain Redis
 * PUBLISH / SUBSCRIBE on `RUNNER_KEY_INVALIDATION_CHANNEL` (every replica must
 * get every message, so not the Streams event bus), the same pattern as
 * api-core's `cache:invalidate`.
 *
 * Published after a key change COMMITS, fire-and-forget. A missed message is
 * caught by the signer cache's 60 s version poll. The subscriber re-SUBSCRIBEs
 * on every `ready` and asks for a full resync each time (messages may have been
 * missed while disconnected). Without Redis (one replica), a publish is
 * delivered in-process.
 */

import { hostname } from 'node:os';
import { createEnvRedisClient, createLogger, errorMessage } from '@pipeline-builder/api-core';
import { parseRunnerKeyInvalidation, RUNNER_KEY_INVALIDATION_CHANNEL, type RunnerKeyInvalidation } from '@pipeline-builder/api-core/pipeline-runners';

const logger = createLogger('runner-key-invalidation');

/** This process's replica id (the message `origin`). */
export const REPLICA_ID = `${hostname()}:${process.pid}`;

/** A message without its envelope fields. */
export type KeyInvalidationInput = { kind: 'keys'; orgIds: string[] } | { kind: 'pause'; paused: boolean };

export interface KeyInvalidationBus {
  /** Fire-and-forget; never throws. */
  publish(msg: KeyInvalidationInput): void;
  /** `onMessage` gets every message (this replica's own included); `onResync` fires on each (re)subscribe. */
  subscribe(onMessage: (msg: RunnerKeyInvalidation) => void, onResync: () => void): void;
}

/** Minimal ioredis surface. */
export interface PubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<unknown>;
  on(event: string, cb: (...args: any[]) => void): unknown;
  duplicate(): PubSubClient;
  status?: string;
}

function envelope(msg: KeyInvalidationInput, origin: string): RunnerKeyInvalidation {
  return msg.kind === 'keys'
    ? { v: 1, kind: 'keys', origin, orgIds: [...new Set(msg.orgIds.map((o) => o.toLowerCase()))] }
    : { v: 1, kind: 'pause', origin, paused: msg.paused };
}

/** The bus over Redis pub/sub. */
export function createRedisKeyInvalidationBus(publisher: PubSubClient, origin: string = REPLICA_ID): KeyInvalidationBus {
  const subscriber = publisher.duplicate();
  const handlers: Array<(m: RunnerKeyInvalidation) => void> = [];
  const resyncs: Array<() => void> = [];
  const doSubscribe = (): void => {
    void Promise.resolve(subscriber.subscribe(RUNNER_KEY_INVALIDATION_CHANNEL))
      .then(() => { for (const r of resyncs) { try { r(); } catch { /* isolated */ } } })
      .catch((err: unknown) => logger.warn('Runner key invalidation subscribe failed; will retry on reconnect', { error: errorMessage(err) }));
  };
  subscriber.on('message', (channel: string, raw: string) => {
    if (channel !== RUNNER_KEY_INVALIDATION_CHANNEL) return;
    const msg = parseRunnerKeyInvalidation(raw);
    if (!msg) return;
    for (const h of handlers) { try { h(msg); } catch { /* isolated */ } }
  });
  subscriber.on('ready', doSubscribe);
  subscriber.on('error', (e: unknown) => logger.warn('Runner key invalidation subscriber error', { error: errorMessage(e) }));
  if (subscriber.status === 'ready') doSubscribe();
  return {
    publish(msg) {
      void Promise.resolve()
        .then(() => publisher.publish(RUNNER_KEY_INVALIDATION_CHANNEL, JSON.stringify(envelope(msg, origin))))
        .catch((err: unknown) => logger.warn('Runner key invalidation publish failed (the 60 s version poll catches it)', { kind: msg.kind, error: errorMessage(err) }));
    },
    subscribe(onMessage, onResync) { handlers.push(onMessage); resyncs.push(onResync); },
  };
}

/** The bus for one process (no Redis): a publish reaches this process's own subscribers. */
export function createLocalKeyInvalidationBus(origin: string = REPLICA_ID): KeyInvalidationBus {
  const handlers: Array<(m: RunnerKeyInvalidation) => void> = [];
  return {
    publish(msg) {
      const m = envelope(msg, origin);
      queueMicrotask(() => { for (const h of handlers) { try { h(m); } catch { /* isolated */ } } });
    },
    subscribe(onMessage) { handlers.push(onMessage); },
  };
}

let envBus: KeyInvalidationBus | undefined;

/** The process-wide bus: Redis when configured, else in-process. */
export function keyInvalidationBus(): KeyInvalidationBus {
  if (!envBus) {
    const client = createEnvRedisClient<PubSubClient>('runner-key-invalidation');
    envBus = client ? createRedisKeyInvalidationBus(client) : createLocalKeyInvalidationBus();
  }
  return envBus;
}

/** Tests: replace (or reset with undefined) the process bus. */
export function setKeyInvalidationBusForTesting(bus: KeyInvalidationBus | undefined): void { envBus = bus; }
