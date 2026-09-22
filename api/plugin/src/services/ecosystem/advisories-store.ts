// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Data access for security advisories and their delivery ledger. Elevated,
 * like store.ts: the advisory tables are instance-wide and the ledger is
 * written for other orgs; the advisory service owns every authorization
 * decision.
 */

import {
  isUniqueViolation,
  schema,
  type AdvisoryState,
  type PluginAdvisory,
  type PluginAdvisoryInsert,
} from '@pipeline-builder/pipeline-data';
import { and, desc, eq, gte, inArray, type SQL } from 'drizzle-orm';

import { elevated } from './store.js';
import { first } from './util.js';

type Advisory = PluginAdvisory;

const A = () => schema.pluginAdvisory;
const D = () => schema.pluginAdvisoryDelivery;

export const advisoryStore = {
  byId: (id: string): Promise<Advisory | null> =>
    elevated(async (tx) => first(await tx.select().from(A()).where(eq(A().id, id)))),
  list: (filter: { listingId?: string; publisherId?: string; states?: AdvisoryState[]; publishedSince?: Date; limit?: number } = {}): Promise<Advisory[]> =>
    elevated(async (tx) => {
      const where: SQL[] = [];
      if (filter.listingId) where.push(eq(A().listingId, filter.listingId));
      if (filter.publisherId) where.push(eq(A().publisherId, filter.publisherId));
      if (filter.states?.length) where.push(inArray(A().state, filter.states));
      if (filter.publishedSince) where.push(gte(A().publishedAt, filter.publishedSince));
      return tx.select().from(A()).where(and(...where)).orderBy(desc(A().createdAt)).limit(filter.limit ?? 500);
    }),
  insert: (values: PluginAdvisoryInsert): Promise<Advisory> =>
    elevated(async (tx) => (await tx.insert(A()).values(values).returning())[0] as Advisory),
  /** Update, but only from `fromState` (the optimistic lock on publish / withdraw / edit). */
  transition: (id: string, fromState: AdvisoryState, patch: Partial<PluginAdvisoryInsert>): Promise<Advisory | null> =>
    elevated(async (tx) => first(await tx.update(A()).set({ ...patch, updatedAt: new Date() })
      .where(and(eq(A().id, id), eq(A().state, fromState))).returning())),
  remove: (id: string): Promise<void> =>
    elevated(async (tx) => { await tx.delete(A()).where(eq(A().id, id)); }),
};

export const deliveryStore = {
  /** The orgs already told about `advisoryId`. */
  orgsFor: (advisoryId: string): Promise<string[]> =>
    elevated(async (tx) => (await tx.select().from(D()).where(eq(D().advisoryId, advisoryId))).map((r) => r.orgId)),
  /** Record that `orgIds` were told (a duplicate from a racing retry is harmless). */
  record: async (advisoryId: string, orgIds: readonly string[]): Promise<void> => {
    // One transaction per row: a unique violation aborts only its own.
    for (const orgId of orgIds) {
      try {
        await elevated(async (tx) => { await tx.insert(D()).values({ advisoryId, orgId }); });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  },
};

