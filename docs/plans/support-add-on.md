# Support add-on — plan

Status: **PLAN ONLY. No code.** Pricing is settled. The operational half is
not, and three blockers below must be answered before anything ships.

A paid support offering modelled on AWS Support but priced against this
platform's own tiers, where a case is a message thread between the tenant org
and the system org.

> **Revision note.** The first draft of this plan designed the customer-facing
> surface and skipped the queue behind it. That was the wrong order: the staff
> side determines whether any response target is honest. This revision leads
> with it and demotes pricing.

---

## Decisions already taken

Recorded because each one removes work.

1. **A paid add-on, available at every tier** — not a tier benefit.
2. **Response targets are STATED, not ENFORCED.** No breach records, alerting,
   SLA metrics or escalation. They are published and shown when a case opens.
3. **Support does NOT read into the tenant's org.** No pipeline, build, log or
   registry access; the tenant attaches what the case needs. This is the most
   load-bearing decision here — it keeps the feature clear of the
   impersonation-consent machinery entirely, and a tenant's exposure is exactly
   the files they chose to upload.

---

## START HERE: support already ships, and it is FREE

This reframes the whole project. A support path exists today:

- `POST /messages/support` (`api/message/src/routes/create-message.ts`) — the
  recipient is FORCED server-side, so a forged `recipientOrgId` is discarded
  rather than honoured.
- `ContactSupportCard` on the Help page, mounting `ComposeModal` in support
  mode so the recipient is not a choice.
- The payload already carries `subject`, `content`, **`priority`** and
  **`attachmentIds`**, validated by the same `MessageCreateSchema` an ordinary
  send uses.
- Recipient resolution runs through `getPrimarySupportAlias()` /
  `resolveRecipientAlias()`.

**It is gated on `requirePermission('messages:read')` and nothing else.** Every
signed-in user on every tier — free `developer` included — can message support
today, with priority and attachments.

So this is not "build support". It is: decide what the paid add-on buys that
the free path does not, and decide what happens to the free path.

---

## Blockers — answer these before any code

### B1. The pricing page already promises support, and it disagrees with the code

`billing-config.ts:64` lists **"Community support"** as a `developer` perk.
But the free path is *direct messaging to the system org*, not a community
forum. The copy and the behaviour already contradict each other.

Layering a paid tier on top of an unexamined contradiction makes it worse.
**Produce a reconciliation first**: for each of `developer / pro / team /
business / enterprise`, what support is promised in the plan copy, what the
code actually permits, and what it should be after the add-on exists.

### B2. There is no staff side at all

`recipientOrgId = system org` does not complete the loop. A search of
`frontend/src/pages` finds **zero** support surfaces. Inbound support messages
land in the system org's ordinary inbox with **no queue, no triage, no
assignment, no ownership and no status**.

Selling a response-time promise against an undifferentiated inbox is the single
largest risk in this plan, and it is also where most of the real work is.
Minimum viable staff side:

- a queue filtered to `messageType = 'support_case'` across all tenant orgs,
- case status and an owner,
- ordering by severity and age.

**No response target should be published until this exists**, because without
it nobody can see what is waiting.

### B3. Paywalling a free capability has no safe default

Current users can message support for nothing. Options, in descending order of
goodwill retained:

1. **Leave the free path untouched; sell case semantics on top** (recommended)
   — free users keep ad-hoc messaging, paying customers get cases with
   severity, status, tracked response targets and history.
2. **Restrict the free path by priority** — free users may open `normal` only.
3. **Close the free path** — maximum revenue capture, maximum ill will, and it
   directly contradicts the "Community support" promise in B1.

---

## What the add-on actually adds

Given the above, the genuinely new surface is small — and mostly operational.

| New | Already exists |
|---|---|
| Billing bundles + combo | Sending a message to support |
| **Staff queue, status, assignment (B2)** | Priority, attachments, threading |
| Case semantics: case ID, severity ladder | Recipient forcing, alias resolution |
| Published response targets | `message_attachments` storage |
| The entitlement gate, if any | `'support'` role in the ecosystem role list |

### Primitives it builds on

`messages` (`threadId`, `recipientOrgId`, `recipientUserId`, `messageType`),
`message_attachments` (`filename`, `contentType`, `sizeBytes`, `orgId`),
`BundleConfig.features` (bundles grant feature flags INDEPENDENTLY of tier),
and `effectiveEntitlements(tier, addons, bundles)` which returns the union of
granted features.

That last one is why "paid add-on at every tier" is the model's default rather
than a special case. Compare `compliance_advanced`, which deliberately required
Team+ via a capability carve — support needs no such carve.

---

## Pricing

Settled, and it follows the house rules rather than inventing any.

### House rules, extracted from `billing-config.ts` — not assumed

- Tiers: `developer` $0 · `pro` $39 · `team` $79 · `business` $249 ·
  `enterprise` $899 monthly.
- Annual is uniformly **10× monthly** (two months free).
- **Every combo is exactly 30% off** the sum of its members. Verified against
  all five: analytics $90→$63, compliance $129.80→$90.86, insights $60→$42,
  throughput $35.97→$25.18, scale $31.98→$22.39. Each lands on 0.70.

A sixth discount rate would be a new rule to explain. Do not introduce one.

### Bundles

| Bundle | Monthly | Annual | Stated target |
|---|---|---|---|
| `support_standard` | **$29.90** | $299.00 | Business hours, next business day |
| `support_premium` | **$99.90** | $999.00 | 24×7, severity-based (1h for Sev-1) |

Reuses the `compliance_standard` / `compliance_advanced` ladder — identical
price points, identical ~3.3× step, already live and already explained to
customers. It also lands on AWS's own floors (**$29** Developer, **$100**
Business), which matters for an explicitly AWS-shaped model.

Proportionality: $29.90 is 77% of a Pro plan — high in isolation, but AWS
Developer Support is similarly disproportionate for small accounts, and
`developer` is free so any attach there is pure margin. At Enterprise ($899),
premium is **11% of plan**, almost exactly AWS's 10% Business rate.

### Combo

| Combo | Members | Sum | 30% off |
|---|---|---|---|
| `assured_delivery` | `compliance_standard` + `support_standard` | $59.80 | **$41.86/mo** · $418.60/yr |

Lead with this. Both members are entry-priced and the story is clean —
*evidence, plus someone to ask about it*.

A premium rung (`compliance_standard` + `compliance_advanced` +
`support_premium` → $229.70 → $160.79/mo) **overlaps `compliance_suite`**, and
`warnOnNonDiscountCombos` exists to catch combos that do not discount. Ship
one, measure, then decide.

### Two catalog details that bite

**`unlimited` is excluded from `ALL`.** `ALL = [...STANDARD_TIERS]` and
`STANDARD_TIERS = VALID_TIERS.filter(t => t !== 'unlimited')`, so an
`unlimited` org cannot buy the bundle. But `unlimited` is documented as getting
every feature, so it may receive the `support` flag by inheritance anyway. That
is probably correct for an internal tier — **decide it explicitly** rather than
inherit it by accident.

**Support levels do NOT stack.** `compliance_advanced` declares
`requires: ['compliance_standard']` because its content is additive. Premium
support *replaces* standard; nobody should hold both. `BundleConfig` has
`stackable` and `requires` but **no mutual exclusion**. Left standalone, a
customer can buy both and pay $129.80 for one level of service. Recommended:
add mutual exclusion to the canonical math in `effectiveEntitlements`, beside
the `stackable` and `maxQuantity` invariants it already enforces. This is the
only non-config change in the pricing section.

---

## Open questions — NOT decided

**Severity does not fit the existing field.** `MESSAGE_PRIORITIES` is
`['normal', 'high', 'urgent']` — **three** levels, already exposed on the free
path. An AWS-style Sev-1..4 ladder is four. Either severity maps lossily onto
three, or a second ranking field joins `priority` on the same row — and two
ranking fields on one message is how a support queue becomes ambiguous.

**Adding a message type is not one line.** `MESSAGE_TYPES` is
`['announcement', 'conversation']`, but `notification-channels.ts:43` carries
its OWN narrowed union `messageType: 'announcement' | 'conversation'`. Add
`'support_case'` to the vocabulary without updating that, and replies silently
fail to notify.

**Org hierarchy.** Root/team orgs with partially pooled quota. Does support
bought at the root cover child teams? Can a team open cases against the root's
add-on? The pooled model makes this a real question, not an obvious one.

**Attachment limits.** `sizeBytes` exists, but a support case invites build
logs and SBOMs, far larger than today's attachments. Max per file, count per
case, total per org, retention. Note the quota model is per-period FLOW
(`QUOTA_RESET_DAYS`), which does not express "storage currently held" — this
may not fit the existing quota types without thought.

**Inbound file risk, in BOTH directions.** Outward: a case will eventually
contain a secret a tenant pasted by accident. Inward — and this was missed in
the first draft — tenants upload arbitrary files **into the system org**, to be
opened by staff. That is an untrusted-input ingestion path from every tenant.
Plugin images are scanned; nothing scans these.

**Who at the system org may read a case.** The `'support'` role exists but is
unused for this. It needs the scoping the Ecosystem Manager role received, and
a decision on whether reads are audited.

**Reply notification.** When support replies, how does the tenant learn? The
notification system with verified external addresses exists and is unwired for
this (see the `notification-channels` note above).

**What happens when the add-on lapses.** Open cases, and read access to closed
ones. Suggestion: existing threads stay readable, no new cases. A product call,
far easier now than retrofitted once customers have history.

**Case lifecycle.** States, who transitions them, what closes a case, and
whether a closed case can reopen.

**"Business hours" is undefined.** Whose timezone, which holidays. With no
enforcement, the definition IS the product promise.

---

## Explicitly out of scope

- SLA enforcement of any kind (decision 2).
- Any support read-path into tenant resources (decision 3).
- Phone or chat channels. Cases are message threads.
- Per-seat support pricing. The add-on is per-org.
