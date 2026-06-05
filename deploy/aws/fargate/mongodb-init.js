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
