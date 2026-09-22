// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** Labels and wording for anonymous plugin submissions. */
import { PROJECT_REPO_URL } from '@/lib/public-directory/links';
import type { SubmissionStatus } from '@/types/plugin-submissions';

type BadgeColor = 'green' | 'red' | 'gray' | 'blue' | 'purple' | 'yellow' | 'indigo';

/** The docs section a submitter should read (terms, what's checked, claiming). */
export const SUBMISSION_DOCS_URL = `${PROJECT_REPO_URL}/blob/main/docs/plugin-publishing.md#submitting-without-an-account`;

/** The publisher every approved submission is listed under. */
export const COMMUNITY_PUBLISHER = 'community';

export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  pending_verification: 'Waiting for email confirmation',
  pending_review: 'Checks and moderation in progress',
  publishing: 'Approved, being listed',
  gate_failed: 'Failed an automated check',
  approved: 'Approved and listed',
  rejected: 'Rejected',
  expired: 'Expired',
  claimed: 'Claimed by an account',
};

export const SUBMISSION_STATUS_COLORS: Record<SubmissionStatus, BadgeColor> = {
  pending_verification: 'yellow',
  pending_review: 'blue',
  publishing: 'blue',
  gate_failed: 'red',
  approved: 'green',
  rejected: 'red',
  expired: 'gray',
  claimed: 'purple',
};

/** One sentence on what happens next, per status. */
export const SUBMISSION_STATUS_NEXT: Record<SubmissionStatus, string> = {
  pending_verification: 'Open the link in the confirmation email to start the checks. Unconfirmed submissions are deleted after 30 days.',
  pending_review: 'The automated checks run first; a moderator then reviews the plugin, usually within two business days. You will get an email with the decision.',
  publishing: 'A moderator approved the plugin; it is being copied into the directory.',
  gate_failed: 'Fix the problems below and submit a new package. Nothing was listed.',
  approved: 'The plugin is in the directory with the Unverified tier. Create an account with the same email address to claim it.',
  rejected: 'A moderator declined the submission. The reason is below. Nothing was listed.',
  expired: 'The submission was not confirmed or reviewed within 30 days and was deleted.',
  claimed: 'An account with the submitting email address took over this listing. It is now managed from that account.',
};

/** Is the status still moving (worth polling)? */
export function isSubmissionInFlight(status: SubmissionStatus): boolean {
  return status === 'pending_verification' || status === 'pending_review' || status === 'publishing';
}

/** `/plugins/submit/status?token=…` — the bookmarkable status page. */
export function submissionStatusPath(statusToken: string): string {
  return `/plugins/submit/status?token=${encodeURIComponent(statusToken)}`;
}

/** The first query value of `token`, or null. */
export function tokenFromQuery(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim() ? value.trim() : null;
}
