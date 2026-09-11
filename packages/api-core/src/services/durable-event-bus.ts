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
 *  - **subscribe({topic, group, consumer, handler})** → a `XREADGROUP` consumer.
 *    Consumer GROUPS give at-least-once: each group gets every message once, a
 *    message stays pending until the handler `XACK`s it, and `XAUTOCLAIM`
 *    reclaims messages stranded by a crashed consumer. Multiple groups on one
 *    topic = independent fan-out (e.g. quota-sync AND audit both react).
 *
 * FAIL-SAFE + OPT-IN, exactly like the audit spool: {@link createEnvRedisDurableEventBus}
 * returns `null` when Redis isn't configured, so a service without it simply
 * doesn't use the bus (keeps today's behavior). A publish failure is dropped-with-
 * -metric, never thrown; a handler throw leaves the message un-acked for redelivery.
 *
 * Migrating a specific reconciler (e.g. billing→quota entitlement sync) onto this
 * is deliberately follow-on work — this lands the backbone + an additive entity-
 * event bridge; the reconcilers stay as the belt-and-suspenders backstop until a
 * flow is fully cut over.
 */

import { createEnvRedisClient } from './env-redis.js';
import type { EntityEvent, EntityEventSubscriber } from './entity-events.js';
import { createLogger } from '../utils/logger.js';
import { emitCounter } from '../utils/metric-emitter.js';

const logger = createLogger('durable-event-bus');

/** A delivered event: its stream id, topic, and decoded payload. */
export interface EventEnvelope<T = unknown> {
  /** Redis Stream entry id (`<ms>-<seq>`) — also the idempotency handle. */
  id: string;
  topic: string;
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
}

const DEFAULT_MAXLEN = 10_000;
const DEFAULT_BATCH = 16;
const DEFAULT_BLOCK_MS = 5_000;
const DEFAULT_MIN_IDLE_MS = 60_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function streamKey(topic: string): string {
  return `evt:${topic}`;
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
    if (raw === undefined) {
      out.push({ id, topic, payload: undefined as unknown as T });
      continue;
    }
    try {
      out.push({ id, topic, payload: JSON.parse(raw) as T });
    } catch {
      out.push({ id, topic, payload: undefined as unknown as T });
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
      const batch = Math.max(1, subOpts.batchSize ?? DEFAULT_BATCH);
      const blockMs = Math.max(0, subOpts.blockMs ?? DEFAULT_BLOCK_MS);
      const minIdle = Math.max(0, subOpts.minIdleMs ?? DEFAULT_MIN_IDLE_MS);

      let stopped = false;
      let started = false;

      const deliver = async (envs: EventEnvelope<T>[]): Promise<void> => {
        for (const env of envs) {
          try {
            if (env.payload !== undefined) await handler(env);
            // Ack on success OR on an undefined (corrupt) payload — a poison
            // message must not block the group forever.
            await redis.xack(key, group, env.id);
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

      const ensureGroup = async (): Promise<void> => {
        try {
          // MKSTREAM so the stream need not exist yet; '$' = only new messages.
          await redis.xgroup('CREATE', key, group, '$', 'MKSTREAM');
        } catch (err) {
          if (!isBusyGroup(err)) {
            logger.warn('Event bus group create failed', { topic, group, error: errMsg(err) });
          }
        }
      };

      const loop = async (): Promise<void> => {
        await ensureGroup();
        while (!stopped) {
          try {
            // 1) Reclaim messages stranded by a crashed consumer in this group.
            const claimed = await redis.xautoclaim(key, group, consumer, minIdle, '0', 'COUNT', batch);
            // XAUTOCLAIM reply: [nextCursor, entries, deletedIds]
            if (Array.isArray(claimed) && claimed.length >= 2) {
              await deliver(parseEntries<T>(topic, claimed[1]));
            }
            if (stopped) break;

            // 2) Read new, never-delivered messages for this group ('>').
            const res = await redis.xreadgroup(
              'GROUP', group, consumer, 'COUNT', batch, 'BLOCK', blockMs, 'STREAMS', key, '>',
            );
            // XREADGROUP reply: [[streamKey, entries]] | null (on block timeout)
            if (Array.isArray(res) && res.length > 0 && Array.isArray(res[0]) && res[0].length >= 2) {
              await deliver(parseEntries<T>(topic, res[0][1]));
            }
          } catch (err) {
            if (stopped) break;
            logger.warn('Event bus consumer loop error; backing off', { topic, group, error: errMsg(err) });
            // Back off so a persistent Redis error doesn't hot-spin.
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      };

      let loopPromise = Promise.resolve();
      if (!started) {
        started = true;
        loopPromise = loop();
        logger.info('Event bus consumer started', { topic, group, consumer });
      }

      return {
        async stop(): Promise<void> {
          stopped = true;
          // Await the in-flight read/handler so a caller (e.g. a service shutting
          // down its DB) doesn't race a message still being processed. Bounded by
          // the XREADGROUP BLOCK window. Never rejects — the loop swallows errors.
          await loopPromise.catch(() => undefined);
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

// ---------------------------------------------------------------------------
// Entity-event bridge (additive, opt-in)
//
// Lets a service give its in-process {@link entityEvents} emitter a DURABLE,
// cross-pod delivery leg WITHOUT changing existing behavior: register the
// returned subscriber and every entity mutation is ALSO published to the bus.
// A consumer elsewhere (`bus.subscribe`) then reacts at-least-once across pods
// and restarts. The in-process subscribers keep firing exactly as before, so
// this is purely additive — no double-processing unless a service intentionally
// runs a bus consumer for the same reaction. Kept here (not in entity-events.ts)
// so that module stays infrastructure-free per its own contract.
// ---------------------------------------------------------------------------

/** Topic the entity-event bridge publishes to. */
export const ENTITY_EVENT_TOPIC = 'entity-events';

/**
 * An {@link EntityEventSubscriber} that forwards each entity event to the durable
 * bus. `bus.publish` is fail-safe (drops-with-metric, never throws), matching the
 * emitter's fire-and-forget contract. Note `EntityEvent.timestamp` (a Date)
 * serializes to an ISO string on the wire — a consumer re-hydrates as needed.
 */
export function createEntityEventBusPublisher(bus: DurableEventBus): EntityEventSubscriber {
  return {
    async onEntityEvent(event: EntityEvent): Promise<void> {
      await bus.publish(ENTITY_EVENT_TOPIC, event);
    },
  };
}
