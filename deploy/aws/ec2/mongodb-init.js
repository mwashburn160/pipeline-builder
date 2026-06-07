// Root user is created by MONGO_INITDB_ROOT_USERNAME / MONGO_INITDB_ROOT_PASSWORD
// env vars on the official mongo image, so we don't need db.createUser here.
disableTelemetry();

// Org → team hierarchy (org-team-hierarchy proposal, phase 1).
// `parentOrgId` makes an organization a "team" nested under a parent org
// (null = root). Mongoose (platform/src/models/organization.ts) is the schema
// source of truth and declares this index via `index: true`; we also create it
// here so a fresh DB has it before the platform service first connects.
// Idempotent — createIndex is a no-op if the index already exists.
db.getSiblingDB('platform').organizations.createIndex({ parentOrgId: 1 });

// First-class Groups RBAC (Administrators/Developers; + Superadmins for the
// system org). Schema source of truth: platform/src/models/group.ts +
// group-membership.ts; mirrored here so a fresh DB has these indexes before the
// platform service first connects.
db.getSiblingDB('platform').groups.createIndex({ organizationId: 1, name: 1 }, { unique: true });
db.getSiblingDB('platform').group_memberships.createIndex({ userId: 1, groupId: 1 }, { unique: true });
db.getSiblingDB('platform').group_memberships.createIndex({ organizationId: 1, userId: 1 });
