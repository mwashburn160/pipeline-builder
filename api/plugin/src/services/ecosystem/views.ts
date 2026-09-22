// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Row → API view mappers for the ecosystem routes (the shapes the frontend
 * and CLI read). Pure.
 */

import { REQUEST_SLA_HOURS } from '@pipeline-builder/api-core';
import type {
  EcosystemAutoApprovalRule,
  PluginListing,
  PluginListingVersion,
  PluginPublishRequest,
  PluginStats,
  Publisher,
} from '@pipeline-builder/pipeline-data';

import { decisionNeedsStepUp, needsTwoPerson, requiredDecisionPermission } from './policy.js';
import { iso, roundTo } from './util.js';


export function publisherView(p: Publisher) {
  return {
    id: p.id,
    handle: p.handle,
    displayName: p.displayName,
    description: p.description,
    homepageUrl: p.homepageUrl,
    tier: p.tier,
    verifiedAt: iso(p.verifiedAt),
    verifiedGraceUntil: iso(p.verifiedGraceUntil),
    termsVersion: p.termsVersion,
    termsAcceptedAt: iso(p.termsAcceptedAt),
    suspendedAt: iso(p.suspendedAt),
    suspendReason: p.suspendReason,
    ownerOrgId: p.ownerOrgId,
    healthScore: p.healthScore ?? null,
    successRate30d: p.successRate30d ?? null,
    createdAt: iso(p.createdAt)!,
    updatedAt: iso(p.updatedAt)!,
  };
}
export type PublisherView = ReturnType<typeof publisherView>;

export function versionView(v: PluginListingVersion) {
  return {
    id: v.id,
    version: v.version,
    imageDigest: v.imageDigest,
    imageRepository: v.imageRepository,
    breaking: v.breaking,
    pausedAt: iso(v.pausedAt),
    yankedAt: iso(v.yankedAt),
    yankReason: v.yankReason,
    deprecatedAt: iso(v.deprecatedAt),
    deprecationMessage: v.deprecationMessage,
    vulnCritical: v.vulnCritical,
    vulnHigh: v.vulnHigh,
    scannedAt: iso(v.scannedAt),
    baseImageCreatedAt: iso(v.baseImageCreatedAt),
    publishedAt: iso(v.publishedAt)!,
    changelog: v.changelog,
  };
}

export function listingView(
  l: PluginListing,
  publisher: Pick<Publisher, 'handle' | 'tier'> | null,
  extra: {
    versions?: PluginListingVersion[];
    openRequests?: number;
    stats?: Pick<PluginStats, 'healthScore' | 'healthBreakdown'> | null;
  } = {},
) {
  return {
    id: l.id,
    publisherId: l.publisherId,
    publisherHandle: publisher?.handle ?? '',
    publisherTier: publisher?.tier ?? 'community',
    name: l.name,
    category: l.category,
    summary: l.summary,
    description: l.description,
    license: l.license,
    homepageUrl: l.homepageUrl,
    sourceUrl: l.sourceUrl,
    icon: l.icon ?? null,
    keywords: l.keywords ?? [],
    state: l.state,
    pausedAt: iso(l.pausedAt),
    featured: l.featured,
    latestVersion: l.latestVersion,
    createdAt: iso(l.createdAt)!,
    updatedAt: iso(l.updatedAt)!,
    ...(extra.versions ? { versions: extra.versions.map(versionView) } : {}),
    ...(extra.openRequests !== undefined ? { openRequests: extra.openRequests } : {}),
    ...(extra.stats !== undefined ? {
      healthScore: extra.stats?.healthScore === null || extra.stats?.healthScore === undefined ? null : Math.round(extra.stats.healthScore),
      healthBreakdown: extra.stats?.healthBreakdown ?? null,
    } : {}),
  };
}
export type ListingView = ReturnType<typeof listingView>;

/** A request payload as the API returns it: a claim's claimant email hash stays server-side. */
function publicPayload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const { claimantEmailHash: _hash, ...rest } = payload ?? {};
  return rest;
}

export function requestView(
  r: PluginPublishRequest,
  publisher: Pick<Publisher, 'handle' | 'tier'> | null,
  listingName: string | null,
) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    lane: r.lane,
    publisherId: r.publisherId,
    publisherHandle: publisher?.handle ?? '',
    publisherTier: publisher?.tier ?? 'community',
    listingId: r.listingId,
    listingName: listingName ?? (typeof r.payload?.name === 'string' ? r.payload.name : null),
    pluginId: r.pluginId,
    version: r.version,
    digest: r.digest,
    payload: publicPayload(r.payload),
    submittedBy: r.submittedBy,
    submittedOrgId: r.submittedOrgId,
    submittedAt: iso(r.createdAt)!,
    firstApprovedBy: r.firstApprovedBy,
    secondApprovedBy: r.secondApprovedBy,
    decidedBy: r.decidedBy,
    decidedAt: iso(r.decidedAt),
    reason: r.reason,
    autoRuleId: r.autoRuleId,
    securityFixAdvisoryId: r.securityFixAdvisoryId,
  };
}
export type RequestView = ReturnType<typeof requestView>;

/** A queue row for the Ecosystem console: the request plus SLA and decision rules for THIS caller. */
export function queueItemView(
  r: PluginPublishRequest,
  publisher: Pick<Publisher, 'handle' | 'tier'> | null,
  listingName: string | null,
  conflict: { conflict: boolean; reason: string | null },
  now: Date = new Date(),
) {
  const ageHours = Math.max(0, (now.getTime() - new Date(r.createdAt).getTime()) / 3_600_000);
  const slaHours = REQUEST_SLA_HOURS[r.lane] ?? REQUEST_SLA_HOURS.standard;
  const open = r.status === 'pending' || r.status === 'pending_second_approval';
  return {
    ...requestView(r, publisher, listingName),
    ageHours: roundTo(ageHours, 1),
    slaHours,
    slaBreached: open && ageHours > slaHours,
    requiresTwoPerson: needsTwoPerson(r.kind, publisher?.tier ?? 'community'),
    requiresStepUp: decisionNeedsStepUp(r.kind),
    requiredPermission: requiredDecisionPermission(r.kind, r.payload),
    conflictOfInterest: conflict.conflict,
    conflictReason: conflict.reason,
  };
}
export type QueueItemView = ReturnType<typeof queueItemView>;

export function ruleView(r: EcosystemAutoApprovalRule, extra: { approvedToday: number; flagDisabled: boolean }) {
  const conditions = (r.conditions ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    conditions,
    createdBy: r.createdBy,
    approvedBy: r.approvedBy,
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    pendingChange: r.pendingChange ?? null,
    seeded: typeof conditions.seeded === 'string',
    approvedToday: extra.approvedToday,
    flagDisabled: extra.flagDisabled,
  };
}
