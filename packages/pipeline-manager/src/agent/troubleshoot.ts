// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic known-issue matcher for deploy failures. This is the structured,
 * safe complement to the LLM diagnosis: it recognizes well-known CloudFormation /
 * deploy signatures and maps them to a concrete cause + suggestion, and — for a
 * few — a param fix the executor can re-apply for a gated retry. Pattern matching
 * on output is a script's job, not the model's; the LLM only adds free-form
 * diagnosis on top.
 */

export interface KnownIssue {
  readonly id: string;
  /** Plain-English root cause. */
  readonly cause: string;
  /** Concrete next step. */
  readonly suggestion: string;
  /** Whether a re-run can plausibly resolve it (deploy scripts are idempotent). */
  readonly retryable: boolean;
  /** A param the executor can set, then re-run automatically (gated). */
  readonly paramFix?: { readonly key: string; readonly value: unknown };
}

const RULES: ReadonlyArray<{ readonly match: RegExp; readonly issue: KnownIssue }> = [
  {
    // SES identity already verified in this account/region → reuse it.
    // CFN phrasings vary: "Email identity … already exists", "SesEmailIdentity … AlreadyExists".
    match: /(?:email\s*identity|ses[\s\S]{0,40}?identity|:identity\/)[\s\S]{0,160}?(?:already exists|AlreadyExists)/i,
    issue: {
      id: 'ses-identity-exists',
      cause: 'The SES email identity for this domain already exists in the account/region.',
      suggestion: 'Reuse it with --skip-ses-identity instead of creating a new one.',
      retryable: true,
      paramFix: { key: 'noCreateSesIdentity', value: true },
    },
  },
  {
    // A prior failed attempt left the stack un-updatable.
    match: /ROLLBACK_COMPLETE|is in ROLLBACK_COMPLETE state and can not be updated/i,
    issue: {
      id: 'stack-rollback-complete',
      cause: 'A previous attempt left the stack in ROLLBACK_COMPLETE — CloudFormation cannot update a stack in that state.',
      suggestion: 'Delete the failed stack, then re-run. For ec2: `aws cloudformation delete-stack --stack-name <name>`. For eks (eksctl-managed stacks): `eksctl delete cluster --name <cluster>` (or `provision --target eks --teardown`). Destructive — not auto-applied.',
      retryable: false,
    },
  },
  {
    match: /toomanyrequests|rate.?limit|HTTP 429|denied: requested access to the resource is denied/i,
    issue: {
      id: 'ghcr-rate-limit',
      cause: 'ghcr.io anonymous pulls are rate-limited (60/hr) and tripped mid-deploy.',
      suggestion: 'Pass --ghcr-token <GitHub PAT with read:packages>, then re-run.',
      retryable: false, // needs a token value the agent does not hold
    },
  },
  {
    match: /ses:SendEmail|FromAddress|MessageRejected|Email address (?:is )?not verified/i,
    issue: {
      id: 'ses-from-mismatch',
      cause: 'SES rejected the sender — the From address is not verified or not covered by the identity.',
      suggestion: 'Make sure --email-from is on the verified domain; in the SES sandbox, verify the recipient too.',
      retryable: false,
    },
  },
  {
    match: /ExpiredToken|InvalidClientTokenId|Unable to locate credentials|security token.*invalid|AuthFailure/i,
    issue: {
      id: 'aws-credentials',
      cause: 'AWS credentials are missing or expired.',
      suggestion: 'Refresh credentials (aws configure / AWS_PROFILE / SSO login), then re-run.',
      retryable: false,
    },
  },
  {
    match: /(?:HostedZone|hosted zone)[\s\S]{0,80}?(?:not found|NoSuchHostedZone|does not exist)/i,
    issue: {
      id: 'hosted-zone-not-found',
      cause: 'The Route 53 hosted zone could not be found.',
      suggestion: 'Check --hosted-zone-id is the PUBLIC zone ID authoritative for --domain.',
      retryable: false,
    },
  },
  {
    match: /Certificate[\s\S]{0,80}?(?:failed|timed out|PENDING_VALIDATION)|CertificateValidation.*(?:FAILED|timed out)/i,
    issue: {
      id: 'acm-validation',
      cause: 'The ACM certificate did not validate in time — DNS validation needs the CNAME in the hosted zone, and propagation can take several minutes.',
      suggestion: 'Confirm --hosted-zone-id matches --domain, then re-run to resume once DNS propagates.',
      retryable: true, // a plain re-run can resume
    },
  },
];

/** Return every known issue whose signature appears in the failure output. */
export function matchIssues(failureText: string): KnownIssue[] {
  return RULES.filter((r) => r.match.test(failureText)).map((r) => r.issue);
}

/**
 * Post-deploy guidance to print after a successful deploy that enabled SES.
 * Surfaces the two things the operator must act on (async DKIM, the sandbox).
 */
export function sesPostDeployGuidance(): string[] {
  return [
    'DKIM verification is ASYNCHRONOUS (minutes–hours) — check SES console → Verified identities.',
    'New SES accounts are SANDBOXED: you can only send to verified recipients (200/day) until you request production access. To smoke-test in sandbox, verify a REAL recipient — never admin@internal.',
    'Bounces/complaints publish to the stack\'s SNS topic — subscribe to it (or pass --alert-email next time) to get warned before SES throttles you.',
  ];
}
