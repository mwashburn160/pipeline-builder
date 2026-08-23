// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import crypto from 'crypto';
import { promises as dns } from 'dns';
import { Types, isValidObjectId } from 'mongoose';
import { createLogger } from '@pipeline-builder/api-core';
import { OrgDomain, JoinRequest, Organization, UserOrganization, User, type OrgDomainDocument, type DomainJoinMode } from '../models/index.js';
import { withMongoTransaction } from '../utils/mongo-tx.js';
import { resolveOrgLineage } from '../helpers/org-hierarchy.js';
import { emailDomain } from '../helpers/sso-enforcement.js';
import { seatCapacityAvailable, seatCapacityStillWithinCap, userHasSeatInAccount } from '../helpers/seats.js';
import { toOrgId } from '../helpers/org-id.js';
import { ensureBaselineRole } from './roles-service.js';

const logger = createLogger('org-domain-service');

/** Domain error codes — thrown by the service and mapped to HTTP statuses in the
 *  controller error maps. (JOIN_MEMBERSHIP_REVOKED below is internal-only — it's
 *  caught inside this module and never reaches a controller.) */
export const DOMAIN_TAKEN = 'DOMAIN_TAKEN';
export const DOMAIN_NOT_FOUND = 'DOMAIN_NOT_FOUND';
export const DOMAIN_NOT_VERIFIED = 'DOMAIN_NOT_VERIFIED';
export const DOMAIN_VERIFY_FAILED = 'DOMAIN_VERIFY_FAILED';
export const DOMAIN_NOT_ENTITLED = 'DOMAIN_NOT_ENTITLED';
export const DOMAIN_LIMIT = 'DOMAIN_LIMIT';
export const DOMAIN_PUBLIC = 'DOMAIN_PUBLIC';
export const JOIN_NOT_ELIGIBLE = 'JOIN_NOT_ELIGIBLE';
export const JOIN_SEAT_LIMIT = 'JOIN_SEAT_LIMIT';
export const JOIN_REQUEST_NOT_FOUND = 'JOIN_REQUEST_NOT_FOUND';
/** Internal control-flow only (auto-join hit an admin-revoked membership → the
 *  caller downgrades to a request). Never mapped to an HTTP status. */
const JOIN_MEMBERSHIP_REVOKED = 'JOIN_MEMBERSHIP_REVOKED';

/** Max domains an org may register (abuse / squatting bound). */
const MAX_DOMAINS_PER_ORG = 20;
/** Bound on the ownership DNS lookup so a slow/hostile resolver can't hang the request. */
const DNS_TIMEOUT_MS = 4000;
/** Well-known consumer/freemail domains that must never be usable for domain-join
 *  (a shared mailbox provider isn't an "org"). Defense-in-depth beyond DNS proof. */
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
  'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'pm.me',
]);

/** DNS TXT record the admin publishes to prove domain ownership. Exported so the
 *  controller's admin-facing "publish this record" instructions can't drift from
 *  what verification actually checks. */
export const VERIFY_RECORD_HOST = (domain: string) => `_pipeline-builder-verify.${domain}`;
export const VERIFY_RECORD_VALUE = (token: string) => `pb-verify=${token}`;

/** Tiers entitled to offer domain-based join (mirrors how `sso` is gated —
 *  Team/Enterprise; `unlimited` is the billing-off / system tier). Pooled at the
 *  account root like every other entitlement. */
async function isDomainJoinEntitled(orgId: string): Promise<boolean> {
  const { rootOrgId } = await resolveOrgLineage(orgId);
  const root = await Organization.findById(toOrgId(rootOrgId)).select('tier deletedAt').lean();
  if (!root || (root as { deletedAt?: Date | null }).deletedAt) return false;
  return ['team', 'enterprise', 'unlimited'].includes((root as { tier: string }).tier);
}

export interface DiscoverableOrg {
  orgId: string;
  orgName: string;
  autoJoin: DomainJoinMode;
}

class OrgDomainService {
  /** Whether the org's account tier may use domain-based join. Exposed so the
   *  controller can 403 the admin write paths before doing work. */
  isEntitled(orgId: string): Promise<boolean> {
    return isDomainJoinEntitled(orgId);
  }

  /**
   * Register a domain for an org (unverified) + mint a DNS verification token.
   * Gated on entitlement (so non-paying tiers can't squat), a per-org cap, and a
   * freemail denylist. Uniqueness is enforced only among VERIFIED domains: many
   * orgs may hold an unverified claim, but a domain another org has already
   * VERIFIED is a hard conflict (`DOMAIN_TAKEN`).
   */
  async addDomain(orgId: string, rawDomain: string, userId: string): Promise<OrgDomainDocument> {
    const domain = rawDomain.trim().toLowerCase();
    if (FREEMAIL_DOMAINS.has(domain)) throw new Error(DOMAIN_PUBLIC);
    // Entitlement at registration time (not just at setDomainMode) so a free-tier
    // account can't register domains purely to block other tenants.
    if (!(await isDomainJoinEntitled(orgId))) throw new Error(DOMAIN_NOT_ENTITLED);

    // Same-org idempotency.
    const mine = await OrgDomain.findOne({ orgId, domain });
    if (mine) return mine;

    // Another org has already VERIFIED (proven ownership of) this domain.
    const verifiedElsewhere = await OrgDomain.findOne({ domain, verified: true });
    if (verifiedElsewhere) throw new Error(DOMAIN_TAKEN);

    const count = await OrgDomain.countDocuments({ orgId });
    if (count >= MAX_DOMAINS_PER_ORG) throw new Error(DOMAIN_LIMIT);

    const verificationToken = crypto.randomBytes(16).toString('hex');
    try {
      return await OrgDomain.create({ orgId, domain, verificationToken, autoJoin: 'off', createdBy: userId });
    } catch (err) {
      // Concurrent add of the same (orgId, domain) races past the `mine` check and
      // hits the unique index — return the row the winner created (idempotent).
      if ((err as { code?: number }).code === 11000) {
        const existing = await OrgDomain.findOne({ orgId, domain });
        if (existing) return existing;
      }
      throw err;
    }
  }

  listDomains(orgId: string): Promise<OrgDomainDocument[]> {
    return OrgDomain.find({ orgId }).sort({ createdAt: -1 });
  }

  /**
   * Resolve the ownership TXT record for `domain` with a bounded timeout and
   * report whether it contains `pb-verify=<token>`. Returns `true` on match,
   * `false` when the lookup SUCCEEDS but the record is absent/changed, and
   * `null` on a DNS error (transient — the caller decides). Clears the race
   * timer so it can't accumulate across the sweep's many sequential checks.
   */
  private async checkDnsToken(domain: string, token: string): Promise<boolean | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const records = await Promise.race([
        dns.resolveTxt(VERIFY_RECORD_HOST(domain)),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('DNS_TIMEOUT')), DNS_TIMEOUT_MS); }),
      ]);
      const want = VERIFY_RECORD_VALUE(token);
      return records.some((chunks) => chunks.join('').trim() === want);
    } catch (err) {
      logger.info('Domain TXT lookup failed', { domain, error: String(err) });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Confirm domain ownership by resolving the DNS TXT record. On success marks
   *  the domain verified (retaining the token for the re-verify sweep). */
  async verifyDomain(orgId: string, domainId: string): Promise<OrgDomainDocument> {
    if (!isValidObjectId(domainId)) throw new Error(DOMAIN_NOT_FOUND);
    const doc = await OrgDomain.findOne({ _id: domainId, orgId });
    if (!doc) throw new Error(DOMAIN_NOT_FOUND);
    if (doc.verified) return doc;

    // Re-check no other org has verified it since registration (race with a
    // concurrent verify) — the partial-unique index is the hard backstop.
    const verifiedElsewhere = await OrgDomain.findOne({ domain: doc.domain, verified: true, orgId: { $ne: orgId } });
    if (verifiedElsewhere) throw new Error(DOMAIN_TAKEN);

    // Both a DNS error (null) and a genuine no-match (false) fail verification.
    if (!(await this.checkDnsToken(doc.domain, doc.verificationToken))) throw new Error(DOMAIN_VERIFY_FAILED);

    doc.verified = true;
    doc.verifiedAt = new Date();
    try {
      await doc.save();
    } catch (err) {
      // Lost a concurrent verify race for the same domain (partial-unique index) —
      // surface as a clean 409 rather than a raw 500.
      if ((err as { code?: number }).code === 11000) throw new Error(DOMAIN_TAKEN);
      throw err;
    }
    // Evict every other org's now-losing UNVERIFIED claim on this domain (first
    // to verify wins) so their dashboards don't imply a pending claim they can't win.
    await OrgDomain.deleteMany({ domain: doc.domain, verified: false, orgId: { $ne: orgId } });
    return doc;
  }

  /**
   * Periodic sweep: re-check verified domains whose last verification is older
   * than `staleMs`. Only un-verifies on a DEFINITIVE failure — the TXT lookup
   * SUCCEEDS but the token record is gone/changed (owner removed it / domain
   * transferred). A DNS error (network/timeout) is treated as transient and
   * skipped, so a blip never disables a legitimate org's join. Un-verifying
   * disables discovery (findDiscoverable requires `verified:true`), forces
   * `off`, and frees the domain for re-registration. Returns counts for logging.
   */
  async reverifyStaleDomains(staleMs: number, limit = 200): Promise<{ checked: number; unverified: number }> {
    const cutoff = new Date(Date.now() - staleMs);
    const stale = await OrgDomain.find({
      verified: true,
      $or: [{ verifiedAt: { $lt: cutoff } }, { verifiedAt: { $exists: false } }],
    }).limit(limit);

    let unverified = 0;
    for (const doc of stale) {
      const ok = await this.checkDnsToken(doc.domain, doc.verificationToken);
      if (ok === null) continue; // transient DNS failure — leave for the next sweep
      if (ok) {
        doc.verifiedAt = new Date(); // reset the clock
        await doc.save();
        continue;
      }
      // Definitive failure — the proof record is gone. Disable + free the domain.
      doc.verified = false;
      doc.autoJoin = 'off';
      await doc.save();
      await this.cancelPendingRequestsForDomain(doc.orgId, doc.domain);
      unverified++;
      logger.warn('Domain re-verification failed — un-verified', { orgId: doc.orgId, domain: doc.domain });
    }
    return { checked: stale.length, unverified };
  }

  /** Set the discovery mode. Any non-`off` mode requires the domain to be
   *  verified AND the account to be entitled. */
  async setDomainMode(orgId: string, domainId: string, mode: DomainJoinMode): Promise<OrgDomainDocument> {
    if (!isValidObjectId(domainId)) throw new Error(DOMAIN_NOT_FOUND);
    const doc = await OrgDomain.findOne({ _id: domainId, orgId });
    if (!doc) throw new Error(DOMAIN_NOT_FOUND);
    if (mode !== 'off') {
      if (!doc.verified) throw new Error(DOMAIN_NOT_VERIFIED);
      if (!(await isDomainJoinEntitled(orgId))) throw new Error(DOMAIN_NOT_ENTITLED);
    }
    doc.autoJoin = mode;
    await doc.save();
    // Turning discovery off strands any pending requests from this domain — deny them.
    if (mode === 'off') await this.cancelPendingRequestsForDomain(orgId, doc.domain);
    return doc;
  }

  async deleteDomain(orgId: string, domainId: string): Promise<boolean> {
    if (!isValidObjectId(domainId)) throw new Error(DOMAIN_NOT_FOUND);
    const doc = await OrgDomain.findOne({ _id: domainId, orgId });
    if (!doc) throw new Error(DOMAIN_NOT_FOUND);
    await OrgDomain.deleteOne({ _id: domainId, orgId });
    // Deny any pending requests that came from this now-removed domain.
    await this.cancelPendingRequestsForDomain(orgId, doc.domain);
    return true;
  }

  /** Email an org's active owners/admins that a domain-join request arrived.
   *  Fire-and-forget: never throws, never blocks the join. emailService is
   *  lazy-imported so its config/nodemailer deps stay out of the static graph. */
  async notifyAdminsOfRequest(orgId: string, requesterEmail: string): Promise<void> {
    try {
      const [org, admins] = await Promise.all([
        Organization.findById(toOrgId(orgId)).select('name').lean(),
        UserOrganization.find({ organizationId: orgId, isActive: true, role: { $in: ['owner', 'admin'] } }).select('userId').lean(),
      ]);
      if (!org || admins.length === 0) return;
      const users = await User.find({ _id: { $in: admins.map((a) => a.userId) } }).select('email').lean();
      const emails = users.map((u) => (u as { email: string }).email).filter(Boolean);
      const orgName = (org as { name: string }).name;
      const { emailService } = await import('../utils/email.js');
      await emailService.sendJoinRequestReceived(emails, orgName, requesterEmail);
      // In-app: one TARGETED message per admin (recipientUserId) — NOT an org-wide
      // message, which would broadcast the requester's email to every member.
      const { sendInAppNotification } = await import('../helpers/in-app-notify.js');
      await Promise.all(admins.map((a) => sendInAppNotification({
        recipientOrgId: orgId,
        recipientUserId: String((a as { userId: unknown }).userId),
        subject: `New request to join ${orgName}`,
        content: `${requesterEmail} has requested to join ${orgName}. Review it in Settings → Domain-based join.`,
      })));
    } catch (err) {
      logger.warn('Join-request admin notification failed', { orgId, error: String(err) });
    }
  }

  /** Notify the requester (email + in-app) of the approve/deny decision.
   *  Fire-and-forget. The in-app message lands in the requester's home org inbox
   *  targeted to them. */
  async notifyDecision(userId: string, userEmail: string, orgId: string, approved: boolean): Promise<void> {
    try {
      const org = await Organization.findById(toOrgId(orgId)).select('name').lean();
      if (!org) return;
      const orgName = (org as { name: string }).name;
      const { emailService } = await import('../utils/email.js');
      await emailService.sendJoinRequestDecision(userEmail, orgName, approved);
      // In-app: to the requester's home org, targeted to them.
      const requester = await User.findById(userId).select('lastActiveOrgId').lean();
      const homeOrg = (requester as { lastActiveOrgId?: string } | null)?.lastActiveOrgId;
      if (homeOrg) {
        const { sendInAppNotification } = await import('../helpers/in-app-notify.js');
        await sendInAppNotification({
          recipientOrgId: homeOrg,
          recipientUserId: userId,
          subject: approved ? `You’ve been added to ${orgName}` : `Your request to join ${orgName} was declined`,
          content: approved
            ? `Your request to join ${orgName} was approved — switch to it from the org menu.`
            : `Your request to join ${orgName} was declined.`,
        });
      }
    } catch (err) {
      logger.warn('Join-decision notification failed', { orgId, error: String(err) });
    }
  }

  /** Clear pending join requests for `orgId` whose email is on `domain` — used
   *  when the domain is removed / set `off` / auto-un-verified so they can't be
   *  approved after discovery is disabled. DELETES them (rather than marking
   *  `denied`) so a SYSTEM-initiated cancellation is NOT sticky: if the domain
   *  is re-enabled the user can request again. `denied` is reserved for an
   *  explicit admin rejection in `decideJoinRequest`, which IS sticky. */
  private async cancelPendingRequestsForDomain(orgId: string, domain: string): Promise<void> {
    const suffix = new RegExp(`@${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    await JoinRequest.deleteMany({ orgId, status: 'pending', email: suffix });
  }

  /**
   * Orgs a signing-up user could join based on their VERIFIED email domain.
   * Only verified, non-`off`, entitled domains are returned — an unverified or
   * off-mode domain never surfaces, so this can't be used to enumerate tenants.
   * Caller must have already confirmed the user's email is provider-verified.
   */
  async findDiscoverableOrgsByEmail(email: string): Promise<DiscoverableOrg[]> {
    const domain = emailDomain(email);
    if (!domain) return [];
    const domains = await OrgDomain.find({ domain, verified: true, autoJoin: { $ne: 'off' } }).lean();
    if (domains.length === 0) return [];

    // Batch the candidate-org lookups into one query (verified-domain uniqueness
    // usually bounds this to a single row, but don't rely on that) + memoize the
    // per-org entitlement so a repeated orgId doesn't re-run the lineage lookup.
    const orgs = await Organization.find({ _id: { $in: domains.map((d) => toOrgId(d.orgId)) } })
      .select('name deletedAt').lean();
    const orgById = new Map(orgs.map((o) => [String((o as { _id: unknown })._id), o as { name: string; deletedAt?: Date | null }]));
    const entitledById = new Map<string, boolean>();

    const out: DiscoverableOrg[] = [];
    for (const d of domains) {
      const org = orgById.get(String(d.orgId));
      if (!org || org.deletedAt) continue;
      let entitled = entitledById.get(d.orgId);
      if (entitled === undefined) { entitled = await isDomainJoinEntitled(d.orgId); entitledById.set(d.orgId, entitled); }
      if (!entitled) continue;
      out.push({ orgId: d.orgId, orgName: org.name, autoJoin: d.autoJoin });
    }
    return out;
  }

  /**
   * Act on a user's choice to join `orgId` discovered by domain. Re-validates
   * eligibility server-side (never trust the client): the org must expose a
   * verified, entitled domain matching the user's verified email. For `auto`
   * mode the membership is created immediately (seat-checked); for `request`
   * mode a pending JoinRequest is upserted for admin approval.
   */
  async requestOrAutoJoin(
    user: { _id: Types.ObjectId; email: string },
    orgId: string,
  ): Promise<{ joined: boolean; status: 'joined' | 'requested' | 'already-member' | 'denied' }> {
    const eligible = (await this.findDiscoverableOrgsByEmail(user.email)).find((o) => o.orgId === orgId);
    if (!eligible) throw new Error(JOIN_NOT_ELIGIBLE);

    const already = await UserOrganization.findOne({ userId: user._id, organizationId: orgId, isActive: true }).lean();
    if (already) return { joined: false, status: 'already-member' };

    // A prior DENIAL is sticky — the user cannot self-reopen it (anti-spam / anti-
    // harassment). Surface the denied state rather than silently re-queuing.
    const prior = await JoinRequest.findOne({ orgId, userId: user._id }).lean();
    if (prior && (prior as { status?: string }).status === 'denied') {
      return { joined: false, status: 'denied' };
    }

    if (eligible.autoJoin === 'auto') {
      try {
        await this.createMembership(orgId, user._id, { allowReactivate: false });
        return { joined: true, status: 'joined' };
      } catch (err) {
        // An admin had removed this user — never silently auto-reactivate; fall
        // back to a request so an admin re-approves the rejoin.
        if ((err as Error).message !== JOIN_MEMBERSHIP_REVOKED) throw err;
      }
    }

    // `request` mode (or an auto-join that fell back). `prior` is absent or
    // pending here (denied returned above), so this is idempotent.
    await JoinRequest.updateOne(
      { orgId, userId: user._id },
      { $set: { email: user.email.toLowerCase(), status: 'pending' }, $unset: { decidedBy: '', decidedAt: '' } },
      { upsert: true },
    );
    void this.notifyAdminsOfRequest(orgId, user.email); // fire-and-forget
    return { joined: false, status: 'requested' };
  }

  listJoinRequests(orgId: string, status: 'pending' | 'approved' | 'denied' = 'pending') {
    return JoinRequest.find({ orgId, status }).sort({ createdAt: -1 }).lean();
  }

  /** Approve (→ create membership) or deny a pending join request. */
  async decideJoinRequest(
    orgId: string,
    requestId: string,
    decision: 'approve' | 'deny',
    deciderId: string,
  ): Promise<{ userId: string; status: 'approved' | 'denied' }> {
    if (!isValidObjectId(requestId)) throw new Error(JOIN_REQUEST_NOT_FOUND);
    const reqDoc = await JoinRequest.findOne({ _id: requestId, orgId });
    if (!reqDoc || reqDoc.status !== 'pending') throw new Error(JOIN_REQUEST_NOT_FOUND);

    if (decision === 'approve') {
      // Re-validate at DECISION time — the domain may have been set `off`/deleted
      // or the tier downgraded since the request was filed, and the email must
      // still be on a discoverable domain for this org.
      const stillEligible = (await this.findDiscoverableOrgsByEmail(reqDoc.email)).some((o) => o.orgId === orgId);
      if (!stillEligible) throw new Error(JOIN_NOT_ELIGIBLE);
      const alreadyMember = await UserOrganization.findOne({ userId: reqDoc.userId, organizationId: orgId, isActive: true }).lean();
      // Admin explicitly approved → reactivation of a prior membership is allowed.
      if (!alreadyMember) await this.createMembership(orgId, reqDoc.userId, { allowReactivate: true });
    }
    reqDoc.status = decision === 'approve' ? 'approved' : 'denied';
    reqDoc.decidedBy = new Types.ObjectId(deciderId);
    reqDoc.decidedAt = new Date();
    await reqDoc.save();
    void this.notifyDecision(String(reqDoc.userId), reqDoc.email, orgId, decision === 'approve'); // fire-and-forget
    return { userId: String(reqDoc.userId), status: reqDoc.status };
  }

  /**
   * Create (or admin-reactivate) a seat-checked `member` membership + baseline
   * Member Role in one tx. Mirrors the add-member seat pattern: skip the check
   * for a user who already holds a seat in the account, else reserve-then-recheck
   * (pre + post-write) so concurrent joins can't race past the seat cap.
   *
   * `allowReactivate: false` (auto-join) THROWS `JOIN_MEMBERSHIP_REVOKED` when a
   * DEACTIVATED membership exists (an admin removed the user) so the caller can
   * downgrade to a request; `true` (admin approval) resets it to a clean member.
   */
  private async createMembership(orgId: string, userId: Types.ObjectId, opts: { allowReactivate: boolean }): Promise<void> {
    await withMongoTransaction(async (session) => {
      const alreadyHasSeat = await userHasSeatInAccount(userId, orgId, session);
      if (!alreadyHasSeat && !(await seatCapacityAvailable(orgId, 1, session))) throw new Error(JOIN_SEAT_LIMIT);

      const existing = await UserOrganization.findOne({ userId, organizationId: orgId }).session(session);
      if (existing) {
        if (existing.isActive) return; // already an active member
        if (!opts.allowReactivate) throw new Error(JOIN_MEMBERSHIP_REVOKED);
        // Admin-approved reactivation: reset to a clean member (drop any stale
        // elevated role) and re-seed the baseline Member role.
        existing.isActive = true;
        existing.role = 'member';
        await existing.save({ session });
        await ensureBaselineRole(userId, toOrgId(orgId), session);
      } else {
        await UserOrganization.create([{ userId, organizationId: orgId, role: 'member' }], { session });
        await ensureBaselineRole(userId, toOrgId(orgId), session);
      }

      // Post-write re-check: distinct concurrent inserts don't write-conflict, so
      // both pre-checks could pass; re-count now the membership is committed.
      if (!alreadyHasSeat && !(await seatCapacityStillWithinCap(orgId, session))) throw new Error(JOIN_SEAT_LIMIT);
    });
  }
}

export const orgDomainService = new OrgDomainService();
