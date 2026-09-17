// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Durable, at-least-once event backbone (Redis Streams).
 *
 * The platform's cross-service signalling today is point-to-point HTTP plus
 * polling reconcilers plus an IN-PROCESS best-effort emitter ({@link entityEvents}).
 * There is no durable bus, so a signal produced on one pod is either delivered
 * synchronously over HTTP (coupling + retry-storm risk) or lost if the consumer
 * is momentarily down (the reconcilers exist to paper over exactly that).
 *
 * This is that missing bus, as a reusable primitive:
 *  - **publish(topic, payload)** → `XADD` onto a bounded (`MAXLEN ~`) per-topic
 *    stream. Durable across restarts, shared by all replicas.
 *  - **subscribe({topic, group, consumer, handler})** → a `XREADGROUP` consumer
 *    on its OWN connection (`duplicate()`), so a blocking read never delays a
 *    publish. Consumer GROUPS give at-least-once: each group gets every message
 *    once, a message stays pending until the handler `XACK`s it, and `XAUTOCLAIM`
 *    reclaims messages stranded by a crashed consumer. A message that has been
 *    delivered `maxDeliveries` times without an ack is moved to a dead-letter
 *    stream (`evt:<topic>:dlq`) and acked, so a poison message can't redeliver
 *    forever. Multiple groups on one topic = independent fan-out.
 *
 * FAIL-SAFE + OPT-IN, exactly like the audit spool: {@link createEnvRedisDurableEventBus}
 * returns `null` when Redis isn't configured, so a service without it simply
 * doesn't use the bus (keeps today's behavior). A publish failure is dropped-with-
 * -metric, never thrown; a handler throw leaves the message un-acked for redelivery.
 *
 */

import { createEnvRedisClient } from './env-redis.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('durable-event-bus');

/** A delivered event: its stream id, topic, publish time, and decoded payload. */
export interface EventEnvelope<T = unknown> {
  /** Redis Stream entry id (`<ms>-<seq>`) — also the idempotency handle. */
  id: string;
  topic: string;
  /**
   * When the event was published (the Redis server time embedded in the stream
   * id). A redelivery keeps its ORIGINAL publish time, so a consumer applying
   * last-writer-wins state (e.g. an entitlement sync) can order events by it
   * instead of by delivery time and refuse to let a stale retry overwrite a
   * newer state.
   */
  publishedAt: Date;
  payload: T;
}

export interface SubscribeOptions<T = unknown> {
  /** Topic (stream) to consume. */
  topic: string;
  /** Consumer group — one delivery per group; distinct groups fan out. */
  group: string;
  /** This consumer's id within the group (e.g. `${service}-${pid}`). */
  consumer: string;
  /** Async handler. Resolves ⇒ the message is acked; throws ⇒ left pending for redelivery. */
  handler: (env: EventEnvelope<T>) => Promise<void>;
  /** Max messages per read (default 16). */
  batchSize?: number;
  /** XREADGROUP block time in ms (default 5000). */
  blockMs?: number;
  /** A pending message idle this long (ms) is reclaimed from a dead consumer (default 60000). */
  minIdleMs?: number;
  /**
   * Deliveries after which an un-acked message is dead-lettered to
   * `evt:<topic>:dlq` and acked instead of being redelivered again (default 10).
   */
  maxDeliveries?: number;
}

export interface EventSubscription {
  /** Stop the consumer loop. Resolves once the in-flight read returns. */
  stop(): Promise<void>;
}

export interface DurableEventBus {
  /** Publish a payload to a topic. Returns the stream id, or null on failure (dropped, never throws). */
  publish<T>(topic: string, payload: T): Promise<string | null>;
  /** Start a consumer-group reader for a topic. Fire-and-forget loop; call `stop()` to end it. */
  subscribe<T>(opts: SubscribeOptions<T>): EventSubscription;
}

/**
 * The subset of ioredis' Stream API the bus uses. Kept minimal so a test can
 * supply an in-memory fake and so merely importing this never hard-depends on
 * ioredis (constructed via the shared env helper).
 */
export interface RedisStreamClient {
  xadd(key: string, ...args: (string | number)[]): Promise<string | null>;
  xgroup(...args: (string | number)[]): Promise<unknown>;
  xreadgroup(...args: (string | number)[]): Promise<unknown>;
  xack(key: string, group: string, ...ids: string[]): Promise<number>;
  xautoclaim(...args: (string | number)[]): Promise<unknown>;
  xpending(key: string, group: string, ...args: (string | number)[]): Promise<unknown>;
  xrange(key: string, start: string, end: string, ...args: (string | number)[]): Promise<unknown>;
  /** A new connection with the same options — each subscriber reads on its own. */
  duplicate(): RedisStreamClient;
  quit?(): Promise<unknown>;
  on?(event: 'error', cb: (err: unknown) => void): unknown;
}

const DEFAULT_MAXLEN = 10_000;
const DEFAULT_BATCH = 16;
const DEFAULT_BLOCK_MS = 5_000;
const DEFAULT_MIN_IDLE_MS = 60_000;
const DEFAULT_MAX_DELIVERIES = 10;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function streamKey(topic: string): string {
  return `evt:${topic}`;
}

/** Dead-letter stream for a topic. */
export function deadLetterStreamKey(topic: string): string {
  return `evt:${topic}:dlq`;
}

/** Publish time from a stream id (`<ms>-<seq>`); epoch 0 for an unparseable id. */
function publishedAtFromId(id: string): Date {
  const ms = Number(id.split('-')[0]);
  return new Date(Number.isFinite(ms) ? ms : 0);
}

/** True when the error is Redis' "group already exists" (idempotent create). */
function isBusyGroup(err: unknown): boolean {
  return errMsg(err).includes('BUSYGROUP');
}

/**
 * Parse the nested array shape XREADGROUP / XAUTOCLAIM return into flat envelopes.
 * XREADGROUP: `[[streamKey, [[id, [f, v, ...]], ...]]]`.
 * XAUTOCLAIM: `[nextCursor, [[id, [f, v, ...]], ...], deletedIds]`.
 * We store the JSON payload under a single field `d`.
 */
function parseEntries<T>(topic: string, entries: unknown): EventEnvelope<T>[] {
  const out: EventEnvelope<T>[] = [];
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const id = String(entry[0]);
    const fields = entry[1];
    if (!Array.isArray(fields)) continue;
    // fields is [name, value, name, value, ...]; find 'd'.
    let raw: string | undefined;
    for (let i = 0; i + 1 < fields.length; i += 2) {
      if (String(fields[i]) === 'd') { raw = String(fields[i + 1]); break; }
    }
    // A missing `d` field (an entry not written by publish()) OR a corrupt JSON
    // payload both yield an undefined-payload envelope so `deliver()` ACKs it —
    // a poison message must never wedge the group by staying perpetually pending.
    const publishedAt = publishedAtFromId(id);
    if (raw === undefined) {
      out.push({ id, topic, publishedAt, payload: undefined as unknown as T });
      continue;
    }
    try {
      out.push({ id, topic, publishedAt, payload: JSON.parse(raw) as T });
    } catch {
      out.push({ id, topic, publishedAt, payload: undefined as unknown as T });
    }
  }
  return out;
}

/** Build a durable event bus over a Redis Streams client. */
export function createRedisDurableEventBus(
  redis: RedisStreamClient,
  opts: { maxLen?: number } = {},
): DurableEventBus {
  const maxLen = Math.max(1, opts.maxLen ?? DEFAULT_MAXLEN);

  return {
    async publish<T>(topic: string, payload: T): Promise<string | null> {
      const key = streamKey(topic);
      try {
        // MAXLEN ~ <n> bounds the stream approximately (cheap); `*` = server id.
        const id = await redis.xadd(key, 'MAXLEN', '~', maxLen, '*', 'd', JSON.stringify(payload));
        emitCounter('event_bus_published_total', { topic });
        return id;
      } catch (err) {
        emitCounter('event_bus_publish_failed_total', { topic });
        logger.warn('Event bus publish failed (event dropped)', { topic, error: errMsg(err) });
        return null;
      }
    },

    subscribe<T>(subOpts: SubscribeOptions<T>): EventSubscription {
      const { topic, group, consumer, handler } = subOpts;
      const key = streamKey(topic);
      const dlqKey = deadLetterStreamKey(topic);
      const batch = Math.max(1, subOpts.batchSize ?? DEFAULT_BATCH);
      const blockMs = Math.max(0, subOpts.blockMs ?? DEFAULT_BLOCK_MS);
      const minIdle = Math.max(0, subOpts.minIdleMs ?? DEFAULT_MIN_IDLE_MS);
      const maxDeliveries = Math.max(1, subOpts.maxDeliveries ?? DEFAULT_MAX_DELIVERIES);

      // `XREADGROUP BLOCK` holds its connection for up to `blockMs`; on the
      // shared client every publish queued behind it. Read on a dedicated one.
      const reader = redis.duplicate();
      // A duplicated ioredis connection doesn't inherit listeners; without one a
      // connection error is an unhandled 'error' event that crashes the process.
      reader.on?.('error', (err) => logger.warn('Event bus reader connection error', { topic, group, error: errMsg(err) }));

      let stopped = false;

      const deliver = async (envs: EventEnvelope<T>[]): Promise<void> => {
        for (const env of envs) {
          try {
            if (env.payload !== undefined) await handler(env);
            // Ack on success OR on an undefined (corrupt) payload — a poison
            // message must not block the group forever.
            await reader.xack(key, group, env.id);
            emitCounter('event_bus_delivered_total', { topic, group });
          } catch (err) {
            // Leave it pending (no XACK) — XAUTOCLAIM redelivers it after minIdle.
            emitCounter('event_bus_handler_failed_total', { topic, group });
            logger.warn('Event handler failed; leaving message pending for redelivery', {
              topic, group, id: env.id, error: errMsg(err),
            });
          }
        }
      };

      /**
       * Move every idle pending message that has already been delivered
       * `maxDeliveries` times to the dead-letter stream and ack it. The entry
       * keeps its payload plus where it came from, so an operator can inspect or
       * replay it. If copying fails the message is left pending (retried next
       * pass) — it is never acked without being preserved.
       */
      const deadLetterExhausted = async (): Promise<void> => {
        const pending = await reader.xpending(key, group, 'IDLE', minIdle, '-', '+', batch);
        if (!Array.isArray(pending)) return;
        for (const p of pending) {
          if (!Array.isArray(p) || p.length < 4) continue;
          const id = String(p[0]);
          const deliveries = Number(p[3]);
          if (!(deliveries >= maxDeliveries)) continue;
          const entries = await reader.xrange(key, id, id);
          const fields = Array.isArray(entries) && Array.isArray(entries[0]) && Array.isArray(entries[0][1]) ? entries[0][1] : [];
          let raw = '';
          for (let i = 0; i + 1 < fields.length; i += 2) {
            if (String(fields[i]) === 'd') { raw = String(fields[i + 1]); break; }
          }
          await reader.xadd(
            dlqKey, 'MAXLEN', '~', maxLen, '*',
            'd', raw, 'sourceId', id, 'group', group, 'deliveries', deliveries,
          );
          await reader.xack(key, group, id);
          emitCounter('event_bus_dead_lettered_total', { topic, group });
          logger.error('Event exceeded max deliveries; moved to dead-letter stream', {
            topic, group, id, deliveries, deadLetterStream: dlqKey,
          });
        }
      };

      // The consumer group must exist before XREADGROUP can succeed. Creating it
      // is retried inside the loop: at startup the client may not have connected
      // yet, and a single failed attempt used to leave the consumer reading a
      // group that was never created — forever.
      let groupReady = false;
      const ensureGroup = async (): Promise<void> => {
        try {
          // MKSTREAM so the stream need not exist yet; '$' = only new messages.
          await reader.xgroup('CREATE', key, group, '$', 'MKSTREAM');
          groupReady = true;
        } catch (err) {
          if (!isBusyGroup(err)) throw err;
          groupReady = true;
        }
      };

      const loop = async (): Promise<void> => {
        while (!stopped) {
          try {
            if (!groupReady) await ensureGroup();
            // 1) Dead-letter messages that have exhausted their deliveries, then
            //    reclaim the rest stranded by a failed/crashed consumer.
            await deadLetterExhausted();
            const claimed = await reader.xautoclaim(key, group, consumer, minIdle, '0', 'COUNT', batch);
            // XAUTOCLAIM reply: [nextCursor, entries, deletedIds]
            if (Array.isArray(claimed) && claimed.length >= 2) {
              await deliver(parseEntries<T>(topic, claimed[1]));
            }
            if (stopped) break;

            // 2) Read new, never-delivered messages for this group ('>').
            const res = await reader.xreadgroup(
              'GROUP', group, consumer, 'COUNT', batch, 'BLOCK', blockMs, 'STREAMS', key, '>',
            );
            // XREADGROUP reply: [[streamKey, entries]] | null (on block timeout)
            if (Array.isArray(res) && res.length > 0 && Array.isArray(res[0]) && res[0].length >= 2) {
              await deliver(parseEntries<T>(topic, res[0][1]));
            }
          } catch (err) {
            if (stopped) break;
            // The stream or group was deleted out from under us — recreate it.
            if (/NOGROUP/i.test(errMsg(err))) groupReady = false;
            logger.warn('Event bus consumer loop error; backing off', { topic, group, error: errMsg(err) });
            // Back off so a persistent Redis error doesn't hot-spin.
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      };

      const loopPromise = loop();
      logger.info('Event bus consumer started', { topic, group, consumer, maxDeliveries });

      return {
        async stop(): Promise<void> {
          stopped = true;
          // Await the in-flight read/handler so a caller (e.g. a service shutting
          // down its DB) doesn't race a message still being processed. Bounded by
          // the XREADGROUP BLOCK window. Never rejects — the loop swallows errors.
          await loopPromise.catch(() => undefined);
          await Promise.resolve(reader.quit?.()).catch(() => undefined);
        },
      };
    },
  };
}

/**
 * Build a durable event bus from the ambient Redis env via the shared
 * `createEnvRedisClient`. Returns `null` when Redis is not configured — the
 * caller then runs without a bus (today's HTTP/reconciler behavior), never
 * crashing. Opt in with a single boot line where a service wants durable events.
 */
export function createEnvRedisDurableEventBus(opts: { maxLen?: number } = {}): DurableEventBus | null {
  const inst = createEnvRedisClient<RedisStreamClient>('event-bus');
  if (!inst) return null;
  logger.info('Redis durable event bus initialized');
  return createRedisDurableEventBus(inst, opts);
}
