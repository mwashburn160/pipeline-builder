// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import mongoose from 'mongoose';
import UserOrganization from '../src/models/user-organization';

/**
 * Tests for the UserOrganization Mongoose model.
 *
 * These validate schema defaults, enum constraints, and index definitions
 * without requiring a live MongoDB connection.
 */

describe('UserOrganization model', () => {
  // ---------------------------------------------------------------------------
  // Schema defaults
  // ---------------------------------------------------------------------------

  it('should default role to "member"', () => {
    const doc = new UserOrganization({
      userId: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(),
    });
    expect(doc.role).toBe('member');
  });

  it('should default isActive to true', () => {
    const doc = new UserOrganization({
      userId: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(),
    });
    expect(doc.isActive).toBe(true);
  });

  it('should set joinedAt to a date by default', () => {
    const before = Date.now();
    const doc = new UserOrganization({
      userId: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(),
    });
    expect(doc.joinedAt).toBeInstanceOf(Date);
    expect(doc.joinedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  // ---------------------------------------------------------------------------
  // Explicit values
  // ---------------------------------------------------------------------------

  it('should accept owner role', () => {
    const doc = new UserOrganization({
      userId: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(),
      role: 'owner',
    });
    expect(doc.role).toBe('owner');
  });

  it('should accept admin role', () => {
    const doc = new UserOrganization({
      userId: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(),
      role: 'admin',
    });
    expect(doc.role).toBe('admin');
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  it('should reject invalid role values', async () => {
    const doc = new UserOrganization({
      userId: new mongoose.Types.ObjectId(),
      organizationId: new mongoose.Types.ObjectId(),
      role: 'superadmin',
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.role).toBeDefined();
  });

  it('should require userId', async () => {
    const doc = new UserOrganization({
      organizationId: new mongoose.Types.ObjectId(),
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.userId).toBeDefined();
  });

  it('should require organizationId', async () => {
    const doc = new UserOrganization({
      userId: new mongoose.Types.ObjectId(),
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors.organizationId).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Indexes
  // ---------------------------------------------------------------------------

  it('should define a compound unique index on (userId, organizationId)', () => {
    const schema = UserOrganization.schema;
    const indexes = schema.indexes();
    const compoundIndex = indexes.find(
      ([fields]: [Record<string, number>, ...unknown[]]) =>
        fields && fields.userId === 1 && fields.organizationId === 1,
    );
    expect(compoundIndex).toBeDefined();
    expect(compoundIndex![1]).toHaveProperty('unique', true);
  });
});
