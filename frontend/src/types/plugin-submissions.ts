// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Anonymous public plugin submissions (docs/plans/plugin-ecosystem.md §4, W5).
 * Mirrors the plugin service's `/public/plugin-submissions` API, which nginx
 * exposes as `/api/public/plugin-submissions`. No endpoint ever returns the
 * submitter's email.
 */

import type { PluginInspectField } from './index';

/**
 * A submission's lifecycle. `pending_review` covers both "automated gates
 * running" and "waiting for a moderator".
 */
export type SubmissionStatus =
  | 'pending_verification'
  | 'pending_review'
  | 'gate_failed'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'claimed';

/** `GET /public/plugin-submissions/challenge`: a proof-of-work puzzle. */
export interface SubmissionChallenge {
  /** Opaque, signed by the server. The client hashes it as given. */
  challenge: string;
  /** Leading zero BITS the SHA-256 must have. */
  difficulty: number;
  expiresAt: string;
}

/** The `pow` part of inspect/submit: the solved puzzle. */
export interface ProofOfWorkSolution {
  challenge: string;
  /** A decimal string. */
  nonce: string;
}

/** One automated check. Only the id, pass/fail and a short message are public. */
export interface SubmissionGate {
  id: string;
  ok: boolean;
  message: string;
}

export type HeuristicSeverity = 'high' | 'medium' | 'low';

/** One heuristics finding (api-core `scanPluginSourceHeuristics`). */
export interface HeuristicFinding {
  id: string;
  severity: HeuristicSeverity;
  path: string;
  line: number | null;
  excerpt: string;
}

/** A Dockerfile or spec lint result. */
export interface SubmissionLintIssue {
  /** The lint rule, when the linter names one. */
  rule: string | null;
  message: string;
  severity: 'error' | 'warning';
  /** The file the issue is in (`Dockerfile`, `plugin-spec.yaml`), when known. */
  path: string | null;
  line: number | null;
}

/** `POST /public/plugin-submissions/inspect`: a dry run over the zip. Nothing is stored. */
export interface SubmissionInspectResult {
  /** The spec summary. `smokeTest`: is one declared (null = not reported). */
  plugin: { name: string; version: string; pluginType: string | null; buildType: string | null; smokeTest: boolean | null };
  /** Every descriptive catalog field with where its value came from (§3.1a). */
  fields: PluginInspectField[];
  lint: SubmissionLintIssue[];
  /** A preview of the heuristics gate (no excerpts). A `high` finding fails the submission. */
  heuristics: HeuristicFinding[];
  /**
   * The name check (E9). Inspect never sees the email, so a name already used
   * by a community listing reads as taken here and is judged again at submit.
   */
  nameCheck: SubmissionGate | null;
}

/** `POST /public/plugin-submissions` (202). */
export interface SubmissionCreated {
  id: string;
  status: SubmissionStatus;
}

/** `POST /public/plugin-submissions/verify`. */
export interface SubmissionVerified {
  id: string;
  status: SubmissionStatus;
  /** Opens the status page. Returned only here and in the emails. */
  statusToken: string | null;
}

/** `GET /public/plugin-submissions/status?token=`. */
export interface SubmissionStatusView {
  id: string;
  name: string;
  version: string;
  status: SubmissionStatus;
  submittedAt?: string;
  reason?: string | null;
  gates?: SubmissionGate[];
  listing?: { publisher: string; name: string } | null;
}

/**
 * What the Ecosystem console shows for a `submission` request, beside the
 * normal §3.0.2 review diff (`GET /plugins/ecosystem/requests/:id` → `submission`).
 */
export interface SubmissionModerationView {
  id: string;
  name: string | null;
  version: string | null;
  status: SubmissionStatus;
  /** True when the name isn't listed under `community` yet. */
  newListing: boolean;
  /** Every gate from the gate report. */
  gates: SubmissionGate[];
  /** Every heuristics finding, including `medium` ones only moderators see. */
  heuristics: HeuristicFinding[];
  /** The SBOM of the quarantine image (a console download link). */
  sbomUrl: string | null;
  /** The vulnerability scan report of the quarantine image. */
  scanUrl: string | null;
  /** `quarantine/<id>@sha256:…`, pullable only by moderation tooling. */
  quarantineImage: string | null;
  /** The quarantine image's vulnerability counts (null = not scanned). */
  vuln: { critical: number | null; high: number | null; medium: number | null; low: number | null; scannedAt: string | null } | null;
  submittedAt: string;
  verifiedAt: string | null;
}
