// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An in-memory stand-in for the `MfaRecoveryCodes` collection that implements
 * only the (few, exact) query shapes `services/recovery-codes-service.ts` uses —
 * including the conditional upsert and the positional spend, whose atomicity is
 * the point of those shapes.
 */

export interface RecoveryEntry { hash: string; usedAt: Date | null }
export interface RecoveryDoc {
  userId: string;
  codes: RecoveryEntry[];
  generatedAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
}

/** A `.select().lean()` / thenable chain over a fixed value, as mongoose returns. */
const chainable = <T>(value: T) => {
  const self: Record<string, unknown> = {};
  self.select = () => self;
  self.lean = async () => value;
  self.then = (res: (v: T) => unknown) => Promise.resolve(value).then(res);
  return self as never;
};

export function createFakeRecoveryCodes() {
  const docs: RecoveryDoc[] = [];

  /** Matches `{ userId }` plus an optional `codes: { $elemMatch: {...} }`;
   *  returns the document and the index of the matching element. */
  function find(filter: Record<string, unknown>): { doc: RecoveryDoc; index: number } | null {
    for (const doc of docs) {
      if (filter.userId !== undefined && doc.userId !== String(filter.userId)) continue;
      let index = -1;
      if (filter.codes !== undefined) {
        const want = (filter.codes as { $elemMatch: { hash?: string; usedAt?: null } }).$elemMatch;
        index = doc.codes.findIndex((c) => (want.hash === undefined || c.hash === want.hash) && !c.usedAt);
        if (index < 0) continue;
      }
      return { doc, index };
    }
    return null;
  }

  function apply(doc: RecoveryDoc, update: Record<string, unknown>, index: number): void {
    for (const [k, v] of Object.entries((update.$set ?? {}) as Record<string, unknown>)) {
      if (k === 'codes.$.usedAt') doc.codes[index].usedAt = v as Date;
      else (doc as unknown as Record<string, unknown>)[k] = v;
    }
    for (const [k, v] of Object.entries((update.$inc ?? {}) as Record<string, number>)) {
      (doc as unknown as Record<string, number>)[k] = ((doc as unknown as Record<string, number>)[k] ?? 0) + v;
    }
  }

  const model = {
    findOne: (f: Record<string, unknown>) => chainable(find(f)?.doc ?? null),
    exists: async (f: Record<string, unknown>) => (find(f) ? { _id: 'x' } : null),
    updateOne: async (f: Record<string, unknown>, update: Record<string, unknown>, opts: { upsert?: boolean } = {}) => {
      const found = find(f);
      if (found) {
        apply(found.doc, update, found.index);
        return { modifiedCount: 1, upsertedCount: 0 };
      }
      if (!opts.upsert) return { modifiedCount: 0, upsertedCount: 0 };
      const created: RecoveryDoc = {
        userId: String(f.userId),
        codes: [],
        generatedAt: new Date(),
        failedAttempts: 0,
        lockedUntil: null,
        ...((update.$setOnInsert ?? {}) as Partial<RecoveryDoc>),
      };
      created.userId = String(f.userId);
      apply(created, { $set: update.$set ?? {} }, -1);
      docs.push(created);
      return { modifiedCount: 0, upsertedCount: 1 };
    },
    findOneAndUpdate: (f: Record<string, unknown>, update: Record<string, unknown>) => {
      const found = find(f);
      if (!found) return chainable(null);
      apply(found.doc, update, found.index);
      return chainable(found.doc);
    },
    deleteOne: async (f: Record<string, unknown>) => {
      const found = find(f);
      if (!found) return { deletedCount: 0 };
      docs.splice(docs.indexOf(found.doc), 1);
      return { deletedCount: 1 };
    },
  };

  return {
    model,
    docs,
    /** The stored set for `userId`, as the collection holds it. */
    of: (userId: string) => docs.find((d) => d.userId === userId),
    reset: () => { docs.splice(0, docs.length); },
  };
}
