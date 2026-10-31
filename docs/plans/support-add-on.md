# Support add-on — plan

Status: **PLAN ONLY. No code.** Pricing and shape are decided; the open
questions at the end are not.

A paid support offering modelled on AWS Support but priced against this
platform's own tiers, where a case is a message thread between the tenant org
and the system org.

---

## Decisions already taken

These were settled before this document and are not open for re-litigation
here; they are recorded because each one removes work.

1. **A paid add-on, available at every tier** — not a tier benefit. It is sold
   to `developer` through `enterprise` alike.
2. **Response targets are STATED, not ENFORCED.** No breach records, no
   alerting, no SLA metrics, no escalation machinery. The targets are published
   in the docs and shown when a case is opened. This removes most of what an
   AWS-style support system would otherwise cost to build.
3. **Support does NOT read into the tenant's org.** No pipeline, build, log or
   registry access. The tenant attaches whatever the case needs. This is the
   most load-bearing decision in the document: it keeps the feature entirely
   clear of the impersonation-consent machinery, and it means a tenant's
   exposure is exactly the files they chose to upload.

---

## START HERE: support already ships, and it is FREE

This is the single most important fact in the document, and it reframes the
work. The first draft of this plan described building a support path. One
exists:

- `POST /messages/support` (`api/message/src/routes/create-message.ts`) — the
  recipient is FORCED server-side, so a forged `recipientOrgId` is discarded
  rather than honoured.
- `ContactSupportCard` on the Help page, which mounts `ComposeModal` in support
  mode so the recipient is not a choice.
- The payload already carries `subject`, `content`, **`priority`** and
  **`attachmentIds`**, validated by the same `MessageCreateSchema` an ordinary
  send uses.
- Recipient resolution goes through `getPrimarySupportAlias()` /
  `resolveRecipientAlias()`, so the system org is addressed by alias.

**It is gated on `requirePermission('messages:read')` and nothing else.** Every
signed-in user on every tier — including free `developer` — can message support
today, with priority and attachments.

So this project is NOT "build support". It is:

1. decide what the paid add-on buys that the free path does not, and
2. decide what happens to the free path.

Point 2 is a product decision with no safe default. Paywalling an existing free
capability takes something away from current users. The options are to leave
the free path untouched and sell *case semantics* on top (recommended), to
restrict the free path to lower priorities, or to close it — in descending
order of how much goodwill it costs.

**Nothing in this plan should ship until point 2 is answered.**

## What the add-on would actually add

Given the above, the genuinely new surface is small:

| New | Not new |
|---|---|
| Billing bundles + combo | Sending a message to support |
| Case semantics: status, severity ladder, case ID | Priority (exists), attachments (exist) |
| Published response targets | Threading (`threadId` exists) |
| The entitlement gate, if any | Recipient forcing, alias resolution |

| Need | What it uses today |
|---|---|
| A case as a conversation | `messages` — `threadId`, `recipientOrgId`, `recipientUserId`, `messageType` |
| Tenant supplies files | `message_attachments` — `filename`, `contentType`, `sizeBytes`, `orgId`, `messageId` |
| Paid at every tier | `BundleConfig.features` — bundles grant feature flags INDEPENDENTLY of tier |
| Entitlement math | `effectiveEntitlements(tier, addons, bundles)` returns the union of granted features |
| A support identity | `'support'` already exists in the ecosystem role list |

The `features`-on-a-bundle mechanism is why "paid add-on for all tiers" is the
model's default rather than a special case. Compare `compliance_advanced`,
which deliberately required Team+ via a capability carve — support needs no
such carve, so it should not have one.

---

## Pricing

### The house rules, which this follows rather than reinvents

Extracted from `api/billing/src/config/billing-config.ts`, not assumed:

- Tiers: `developer` $0 · `pro` $39 · `team` $79 · `business` $249 ·
  `enterprise` $899 (monthly).
- Annual is uniformly **10× monthly** — two months free.
- **Every combo is exactly 30% off** the sum of its members. Verified against
  all five existing combos: analytics $90→$63, compliance $129.80→$90.86,
  insights $60→$42, throughput $35.97→$25.18, scale $31.98→$22.39. Each
  lands on 0.70.

A sixth discount rate would be a new rule to explain. Do not introduce one.

### Recommended bundles

| Bundle | Monthly | Annual | Stated target |
|---|---|---|---|
| `support_standard` | **$29.90** | $299.00 | Business hours, next business day |
| `support_premium` | **$99.90** | $999.00 | 24×7, severity-based (1h for Sev-1) |

**Why exactly these numbers.** They reuse the `compliance_standard` /
`compliance_advanced` ladder — identical price points, identical ~3.3× step.
That ladder is already live and already explained to customers, so this needs
no separate justification.

They also sit almost exactly on AWS's own floors, which matters because the
model is explicitly AWS-shaped: **AWS Developer Support is $29/mo**, **AWS
Business is $100/mo** (or 10% of spend). $29.90 / $99.90 reads as deliberately
comparable rather than arbitrary.

Proportionality check: $29.90 is 77% of a Pro plan — high in isolation, but
AWS Developer Support is similarly disproportionate for small accounts, and
`developer` is free so any attach there is pure margin. At Enterprise ($899),
premium support is **11% of plan**, almost precisely AWS's 10% Business rate.

### Recommended combo

| Combo | Members | Sum | 30% off |
|---|---|---|---|
| `assured_delivery` | `compliance_standard` + `support_standard` | $59.80 | **$41.86/mo** · $418.60/yr |

Lead with this one. Both members are entry-priced, the story is clean —
*evidence, plus someone to ask about it* — and $41.86 is an easy yes beside a
$39 Pro plan.

A premium rung (`compliance_standard` + `compliance_advanced` +
`support_premium` → $229.70 → $160.79/mo) is possible but **overlaps
`compliance_suite`**, and `warnOnNonDiscountCombos` already exists to catch
combos that do not actually discount. Ship one combo, measure, then decide.

---

## Shape of the implementation

**Billing.** One new bundle entry per level in `billing-config.ts`:
`stackable: false`, `grants: {}` (support changes no quota), `features:
['support']` / `['support_premium']`, tiers `ALL`. One new combo in
`loadComboDiscounts`.

**Messaging.** `MESSAGE_TYPES` is `['announcement', 'conversation']` today; add
`'support_case'`. A case is then a thread with `recipientOrgId` = the system
org — routing the schema already performs. Severity is a field on the opening
message.

**Entitlement.** Opening a CASE requires the `support` feature. Sending an
ordinary support MESSAGE stays on `messages:read`, unless the decision above
says otherwise. Reading, replying and attaching follow the existing message
permissions either way.

---

## The one place the compliance pattern does NOT fit

`compliance_advanced` declares `requires: ['compliance_standard']` because the
two stack — advanced content is additive to standard content.

**Support levels do not stack.** Premium replaces standard; nobody should hold
both. `BundleConfig` has `stackable` and `requires`, but there is no mutual
exclusion concept.

Two options:

- **Make `support_premium` standalone** (no `requires`). Simple, but a customer
  can buy both and pay $129.80 for one level of service. That is a billing
  complaint waiting to happen.
- **Add mutual exclusion to `BundleConfig`** and enforce it in
  `effectiveEntitlements` — alongside the `stackable` and `maxQuantity`
  invariants it already enforces in the canonical math rather than at the
  purchase route.

Recommended: the second. It is the only part of this plan that is not pure
config, and it is small.

---

## Open questions — NOT decided

**Attachment limits.** `sizeBytes` exists, but a support case invites build
logs and SBOMs, far larger than today's attachments. Max size per file, count
per case, total per org, and retention all need deciding. Note the quota model
is per-period FLOW, not stock (`QUOTA_RESET_DAYS`), which does not naturally
express "total storage currently held" — so this may not fit the existing
quota types without thought.

**Who at the system org may read a case.** The `'support'` role exists but is
unused for this. It needs the same deliberate scoping the Ecosystem Manager
role received: a case will contain customer logs, and sooner or later a secret
a tenant pasted by accident. Decide whether cases are readable by all system-org
staff or only by holders of a specific role, and whether reads are audited.

**What happens when the add-on lapses.** Open cases, and read access to closed
ones. The suggestion is that existing threads stay readable and no new cases
may be opened — but this is a product call, and it is far easier to decide now
than to retrofit once customers have history.

**Severity definitions.** The targets above are placeholders. Sev-1 through
Sev-4 need written definitions, because without enforcement the definitions are
the entire product promise.

**Severity vs the existing `priority`.** Messages already carry a
`MessagePriority`. Either severity reuses it or it is a second, parallel
concept on the same row — and two ranking fields on one message is how support
queues become ambiguous. Decide which before adding a field.

---

## Explicitly out of scope

- SLA enforcement of any kind (decision 2).
- Any support read-path into tenant resources (decision 3).
- Phone or chat channels. Cases are message threads.
- Per-seat support pricing. The add-on is per-org.
