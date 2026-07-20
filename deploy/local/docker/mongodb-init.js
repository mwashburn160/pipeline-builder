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

// Single-source RBAC Roles (built-in Admin/Member; + Super Admin for the
// system org). A Role is a named permission set; a user is granted one via a
// RoleAssignment. Schema source of truth: platform/src/models/role.ts +
// role-assignment.ts; mirrored here so a fresh DB has these indexes before the
// platform service first connects.
db.getSiblingDB('platform').roles.createIndex({ organizationId: 1, name: 1 }, { unique: true });
db.getSiblingDB('platform').role_assignments.createIndex({ userId: 1, roleId: 1 }, { unique: true });
db.getSiblingDB('platform').role_assignments.createIndex({ organizationId: 1, userId: 1 });

// Per-tier SEAT enforcement (tier restructure: developer/pro/team/enterprise).
// Seats are a tier LIMIT (org.quotas.seats), not a tracked counter — the
// platform service enforces them live at invite time by counting active org
// members in `userorganizations` against the limit. Schema source of truth:
// platform/src/models/user-organization.ts (declares the compound index whose
// { organizationId } prefix backs the seat count); mirrored here so a fresh DB
// has it before the platform service first connects. Idempotent.
db.getSiblingDB('platform').userorganizations.createIndex({ organizationId: 1, isActive: 1, role: 1 });
