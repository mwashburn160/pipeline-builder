// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin-ecosystem notification contract (docs/plans/plugin-ecosystem.md
 * §5b), shared by the sender (the plugin service's enqueue API and digest
 * dispatcher) and the relay (platform `POST /internal/notify-email`).
 *
 * Recipients travel as RULES, never as lists: platform resolves each
 * {@link EcosystemRecipientSpec} against its user/Role directory AT SEND TIME,
 * so a digest that flushes tomorrow reaches tomorrow's moderators, the plugin
 * service never handles an email address or a membership list, and a publisher
 * can never learn who installed their plugin (the relay mails each recipient
 * individually — no shared To: line).
 */

/** A §5b event number. */
export type EcosystemNotificationEventId =
  | 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6' | 'N7' | 'N8' | 'N9' | 'N10'
  | 'N11' | 'N12' | 'N13' | 'N14' | 'N15' | 'N16' | 'N17' | 'N18' | 'N19' | 'N20'
  | 'N21' | 'N22' | 'N23' | 'N24' | 'N25' | 'N26' | 'N27' | 'N28' | 'N29';

/** A delivery channel. In-app is the source of truth; email is the courtesy copy. */
export type EcosystemNotificationChannel = 'in_app' | 'email';

/** A per-user EMAIL opt-out key (§5b "Preferences"). In-app is never optional. */
export type EcosystemEmailPreference =
  | 'ecosystem.reviews.email'
  | 'ecosystem.upgrades.email'
  | 'ecosystem.installs.email'
  | 'ecosystem.moderationDigest.email';

/** The field each preference key is stored under in the user's per-org
 *  `notifications.ecosystem` preferences (platform `UserPreferences`). */
export const ECOSYSTEM_EMAIL_PREFERENCE_FIELDS: Readonly<Record<EcosystemEmailPreference, EcosystemEmailPreferenceField>> = {
  'ecosystem.reviews.email': 'reviewsEmail',
  'ecosystem.upgrades.email': 'upgradesEmail',
  'ecosystem.installs.email': 'installsEmail',
  'ecosystem.moderationDigest.email': 'moderationDigestEmail',
};

/** Stored field names of the ecosystem email preferences (all default `true`). */
export type EcosystemEmailPreferenceField = 'reviewsEmail' | 'upgradesEmail' | 'installsEmail' | 'moderationDigestEmail';

/** Every stored ecosystem email-preference field. */
export const ECOSYSTEM_EMAIL_PREFERENCE_FIELD_NAMES: readonly EcosystemEmailPreferenceField[] =
  Object.values(ECOSYSTEM_EMAIL_PREFERENCE_FIELDS);

/** How often a batched email is flushed (§5b timing column). */
export type EcosystemDigestCadence = 'hourly' | 'daily' | 'weekly';

/** One event's delivery rules. */
export interface EcosystemEventSpec {
  /** One-line description (docs, logs). */
  description: string;
  /** Channels the event is delivered on. */
  channels: readonly EcosystemNotificationChannel[];
  /**
   * Email opt-out key, or `null` when the email is TRANSACTIONAL / security
   * (§5b: N1, N3–N5, N7–N10, N18–N23, N25, N28, N29 can't be turned off).
   */
  preference: EcosystemEmailPreference | null;
  /** When the email is batched rather than immediate, its cadence. */
  digest?: EcosystemDigestCadence;
  /** Allowed to address a raw email (the anonymous SUBMITTER, §4) — only the
   *  transactional submission notices. */
  allowsAddress?: boolean;
}

/** The §5b event table, as data. */
export const ECOSYSTEM_NOTIFICATION_EVENTS: Readonly<Record<EcosystemNotificationEventId, EcosystemEventSpec>> = {
  N1: { description: 'Anonymous submission received (magic link)', channels: ['email'], preference: null, allowsAddress: true },
  N2: { description: 'Submission verified, entered the moderation queue', channels: ['in_app', 'email'], preference: 'ecosystem.moderationDigest.email', digest: 'daily' },
  N3: { description: 'Submission failed automated gates', channels: ['email'], preference: null, allowsAddress: true },
  N4: { description: 'Submission approved or rejected', channels: ['email'], preference: null, allowsAddress: true },
  N5: { description: 'Submission claimed by an account', channels: ['in_app', 'email'], preference: null },
  N6: { description: 'Verified-publisher application submitted', channels: ['in_app', 'email'], preference: 'ecosystem.moderationDigest.email', digest: 'daily' },
  N7: { description: 'Verified application approved or rejected', channels: ['in_app', 'email'], preference: null },
  N8: { description: 'Moderation action on a listing (suspend, yank, takedown)', channels: ['in_app', 'email'], preference: null },
  N9: { description: 'Ownership transfer requested', channels: ['in_app', 'email'], preference: null },
  N10: { description: 'Ownership transfer accepted, declined, approved or rejected', channels: ['in_app', 'email'], preference: null },
  N11: { description: 'Install requested (policy requires approval)', channels: ['in_app', 'email'], preference: 'ecosystem.installs.email' },
  N12: { description: 'Install approved or denied', channels: ['in_app', 'email'], preference: 'ecosystem.installs.email' },
  N13: { description: 'New version available within an install\'s policy', channels: ['in_app', 'email'], preference: 'ecosystem.upgrades.email', digest: 'weekly' },
  N14: { description: 'Listing deprecated or unmaintained', channels: ['in_app', 'email'], preference: 'ecosystem.upgrades.email' },
  N15: { description: 'New or edited review on a listing', channels: ['in_app', 'email'], preference: 'ecosystem.reviews.email', digest: 'hourly' },
  N16: { description: 'Publisher replied to your review', channels: ['in_app', 'email'], preference: 'ecosystem.reviews.email' },
  N17: { description: 'Review held (reports, burst, filter)', channels: ['in_app', 'email'], preference: 'ecosystem.moderationDigest.email', digest: 'daily' },
  N18: { description: 'Your review was removed', channels: ['in_app', 'email'], preference: null },
  N19: { description: 'Review flagged as a security issue', channels: ['in_app', 'email'], preference: null },
  N20: { description: 'Advisory draft auto-created (CVE rescan)', channels: ['in_app', 'email'], preference: null },
  N21: { description: 'Advisory published or withdrawn', channels: ['in_app', 'email'], preference: null },
  N22: { description: 'Moderation SLA breach', channels: ['email'], preference: null },
  N23: { description: 'Added to or removed from the Ecosystem Manager role', channels: ['in_app', 'email'], preference: null },
  N24: { description: 'Publish request submitted', channels: ['in_app', 'email'], preference: 'ecosystem.moderationDigest.email', digest: 'daily' },
  N25: { description: 'Publish request approved or rejected', channels: ['in_app', 'email'], preference: null },
  N26: { description: 'Listing or version paused by its publisher', channels: ['in_app'], preference: 'ecosystem.upgrades.email' },
  N27: { description: 'Installed listing auto-updated within its range', channels: ['in_app', 'email'], preference: 'ecosystem.upgrades.email', digest: 'weekly' },
  N28: { description: 'A request needs a second approval', channels: ['in_app', 'email'], preference: null },
  N29: { description: 'Plan change affects publishing', channels: ['in_app', 'email'], preference: null },
};

/** Whether `value` is a §5b event number. */
export function isEcosystemNotificationEvent(value: unknown): value is EcosystemNotificationEventId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ECOSYSTEM_NOTIFICATION_EVENTS, value);
}

/** Org-local permissions an {@link EcosystemRecipientSpec} `org_permission` rule may name. */
export type EcosystemOrgRecipientPermission = 'publishers:manage' | 'plugin_installs:manage';
/** System-org permissions a `moderators` rule may name. */
export type EcosystemModeratorPermission = 'plugins:moderate' | 'publishers:verify';

/**
 * A recipient RULE (§5b "Recipient rules"), resolved by platform at send time:
 *
 *  - `user` — one user (Requester, Review author, the affected user of N23).
 *    `orgId` picks the inbox; defaults to the user's last active org.
 *  - `org_permission` — active members of `orgId` holding `permission`
 *    (Publisher managers = `publishers:manage`, Org approvers =
 *    `plugin_installs:manage`). With `inheritFromRoot`, a team with no holders
 *    falls back to its root org's holders; with none anywhere, the org's owners.
 *  - `moderators` — the system org's holders of `permission` (the Ecosystem
 *    Manager role), minus anyone with a conflict of interest (members of
 *    `excludeMembersOfOrgId`, or the listed users); superadmins when empty.
 *  - `superadmins` — every platform superadmin.
 *  - `address` — a raw address; only the anonymous SUBMITTER notices (N1, N3,
 *    N4), whose recipient has no account.
 */
export type EcosystemRecipientSpec =
  | { kind: 'user'; userId: string; orgId?: string }
  | { kind: 'org_permission'; orgId: string; permission: EcosystemOrgRecipientPermission; inheritFromRoot?: boolean }
  | { kind: 'moderators'; permission: EcosystemModeratorPermission; excludeMembersOfOrgId?: string; excludeUserIds?: string[] }
  | { kind: 'superadmins' }
  | { kind: 'address'; email: string };

/** The body of an ecosystem send through platform's notify relay. */
export interface EcosystemNotifyRequest {
  event: EcosystemNotificationEventId;
  recipients: EcosystemRecipientSpec[];
  subject: string;
  /** Plain-text body (email body and in-app content). */
  text: string;
  /** Subset of the event's channels to deliver on (default: all of them). The
   *  digest dispatcher sends `['email']` because in-app went out at enqueue. */
  channels?: EcosystemNotificationChannel[];
  /** Deliver the email even to users who opted out — for an event whose
   *  normally-optional email is mandatory in this instance (N24 yank, advisory
   *  and security-fix requests). */
  mandatory?: boolean;
}

/** Hard caps, matching the message service's own limits. */
export const ECOSYSTEM_NOTIFY_SUBJECT_MAX = 500;
export const ECOSYSTEM_NOTIFY_TEXT_MAX = 10000;
const MAX_RECIPIENT_RULES = 50;

const ORG_PERMISSIONS: readonly string[] = ['publishers:manage', 'plugin_installs:manage'];
const MODERATOR_PERMISSIONS: readonly string[] = ['plugins:moderate', 'publishers:verify'];
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function nonEmptyString(v: unknown, max = 255): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function parseRecipient(raw: unknown, spec: EcosystemEventSpec): EcosystemRecipientSpec | string {
  if (!raw || typeof raw !== 'object') return 'each recipient must be an object';
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case 'user':
      if (!nonEmptyString(r.userId)) return 'user recipient needs userId';
      if (r.orgId !== undefined && !nonEmptyString(r.orgId)) return 'user recipient orgId must be a string';
      return { kind: 'user', userId: r.userId, ...(r.orgId ? { orgId: r.orgId as string } : {}) };
    case 'org_permission':
      if (!nonEmptyString(r.orgId)) return 'org_permission recipient needs orgId';
      if (typeof r.permission !== 'string' || !ORG_PERMISSIONS.includes(r.permission)) return 'org_permission recipient names an unsupported permission';
      return {
        kind: 'org_permission',
        orgId: r.orgId,
        permission: r.permission as EcosystemOrgRecipientPermission,
        ...(r.inheritFromRoot === true ? { inheritFromRoot: true } : {}),
      };
    case 'moderators': {
      if (typeof r.permission !== 'string' || !MODERATOR_PERMISSIONS.includes(r.permission)) return 'moderators recipient names an unsupported permission';
      if (r.excludeMembersOfOrgId !== undefined && !nonEmptyString(r.excludeMembersOfOrgId)) return 'excludeMembersOfOrgId must be a string';
      const exclude = r.excludeUserIds;
      if (exclude !== undefined && (!Array.isArray(exclude) || !exclude.every((u) => nonEmptyString(u)))) return 'excludeUserIds must be an array of ids';
      return {
        kind: 'moderators',
        permission: r.permission as EcosystemModeratorPermission,
        ...(r.excludeMembersOfOrgId ? { excludeMembersOfOrgId: r.excludeMembersOfOrgId as string } : {}),
        ...(exclude ? { excludeUserIds: exclude as string[] } : {}),
      };
    }
    case 'superadmins':
      return { kind: 'superadmins' };
    case 'address':
      if (!spec.allowsAddress) return 'address recipients are only allowed for anonymous-submission notices';
      if (!nonEmptyString(r.email, 320) || !EMAIL_SHAPE.test(r.email)) return 'address recipient needs a valid email';
      return { kind: 'address', email: r.email.trim().toLowerCase() };
    default:
      return 'unknown recipient kind';
  }
}

/**
 * Validate an {@link EcosystemNotifyRequest}. Returns the normalized request,
 * or an error string (the relay's 400). Pure, so both the sender (fail at
 * enqueue, not at 09:00 tomorrow) and the relay use the same rules.
 */
export function parseEcosystemNotifyRequest(body: unknown): EcosystemNotifyRequest | string {
  if (!body || typeof body !== 'object') return 'body must be an object';
  const b = body as Record<string, unknown>;
  if (!isEcosystemNotificationEvent(b.event)) return 'event must be one of N1..N29';
  const spec = ECOSYSTEM_NOTIFICATION_EVENTS[b.event];
  if (!nonEmptyString(b.subject, ECOSYSTEM_NOTIFY_SUBJECT_MAX)) return `subject is required (max ${ECOSYSTEM_NOTIFY_SUBJECT_MAX})`;
  if (!nonEmptyString(b.text, ECOSYSTEM_NOTIFY_TEXT_MAX)) return `text is required (max ${ECOSYSTEM_NOTIFY_TEXT_MAX})`;
  if (!Array.isArray(b.recipients) || b.recipients.length === 0) return 'recipients must be a non-empty array';
  if (b.recipients.length > MAX_RECIPIENT_RULES) return `at most ${MAX_RECIPIENT_RULES} recipient rules`;
  const recipients: EcosystemRecipientSpec[] = [];
  for (const raw of b.recipients) {
    const parsed = parseRecipient(raw, spec);
    if (typeof parsed === 'string') return parsed;
    recipients.push(parsed);
  }
  let channels: EcosystemNotificationChannel[] | undefined;
  if (b.channels !== undefined) {
    if (!Array.isArray(b.channels) || b.channels.length === 0) return 'channels must be a non-empty array';
    const bad = b.channels.filter((c) => !spec.channels.includes(c as EcosystemNotificationChannel));
    if (bad.length > 0) return `event ${b.event} is not delivered on: ${bad.join(', ')}`;
    channels = [...new Set(b.channels as EcosystemNotificationChannel[])];
  }
  if (b.mandatory !== undefined && typeof b.mandatory !== 'boolean') return 'mandatory must be a boolean';
  return {
    event: b.event,
    recipients,
    subject: b.subject.trim(),
    text: b.text.trim(),
    ...(channels ? { channels } : {}),
    ...(b.mandatory === true ? { mandatory: true } : {}),
  };
}

/** The UTC hour digests flush at (§5b: "daily digest email (09:00 UTC)"). */
export const ECOSYSTEM_DIGEST_HOUR_UTC = 9;

/**
 * The next flush time for a digest cadence, strictly after `now`:
 * `hourly` → the next top of the hour; `daily` → the next 09:00 UTC;
 * `weekly` → the next Monday 09:00 UTC.
 */
export function nextEcosystemDigestTime(cadence: EcosystemDigestCadence, now: Date = new Date()): Date {
  const t = new Date(now.getTime());
  if (cadence === 'hourly') {
    t.setUTCMinutes(0, 0, 0);
    t.setUTCHours(t.getUTCHours() + 1);
    return t;
  }
  t.setUTCHours(ECOSYSTEM_DIGEST_HOUR_UTC, 0, 0, 0);
  if (t.getTime() <= now.getTime()) t.setUTCDate(t.getUTCDate() + 1);
  if (cadence === 'weekly') {
    // getUTCDay: 0 = Sunday … 1 = Monday.
    while (t.getUTCDay() !== 1) t.setUTCDate(t.getUTCDate() + 1);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** A rendered notice. */
export interface EcosystemNotificationContent {
  subject: string;
  text: string;
}

/**
 * N23 — someone was added to or removed from the system org's Ecosystem
 * Manager role (§5a.1). Sent to every superadmin and to the affected user;
 * transactional (no opt-out).
 */
export function renderEcosystemManagerChange(input: {
  /** The affected user's display name or email. */
  user: string;
  added: boolean;
  /** Who made the change (superadmins only can), when known. */
  actor?: string;
}): EcosystemNotificationContent {
  const verb = input.added ? 'added to' : 'removed from';
  const by = input.actor ? ` by ${input.actor}` : '';
  return {
    subject: `${input.user} was ${verb} the Ecosystem Manager role`,
    text: input.added
      ? `${input.user} was ${verb} the Ecosystem Manager role${by}. Ecosystem Managers decide publish requests, `
        + 'moderate submissions and reviews, verify publishers and publish advisories for the whole plugin ecosystem. '
        + 'The role works only from the system organization and requires a two-factor sign-in.'
      : `${input.user} was ${verb} the Ecosystem Manager role${by} and can no longer manage or approve anything in the plugin ecosystem.`,
  };
}

/**
 * Coalesce several queued notices into one digest email: a count-bearing
 * subject and one line per item (each item's subject), oldest first.
 */
export function renderEcosystemDigest(
  event: EcosystemNotificationEventId,
  items: readonly EcosystemNotificationContent[],
): EcosystemNotificationContent {
  if (items.length === 1) return items[0]!;
  const spec = ECOSYSTEM_NOTIFICATION_EVENTS[event];
  const cadence = spec.digest === 'hourly' ? 'Hourly' : spec.digest === 'weekly' ? 'Weekly' : 'Daily';
  return {
    subject: `${cadence} digest: ${items.length} × ${spec.description}`.slice(0, ECOSYSTEM_NOTIFY_SUBJECT_MAX),
    text: items.map((i) => `• ${i.subject}`).join('\n').slice(0, ECOSYSTEM_NOTIFY_TEXT_MAX),
  };
}
