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

### But it is MESSAGING, not TICKETING

The first revision of this plan listed threading under "already exists". That
is true of the messages system and FALSE of the support path, which is the only
one that matters here. Checked in source:

- **`POST /messages/support` never threads.** It forces `recipientOrgId`,
  `recipientUserId`, `messageType: 'conversation'` and `channel`, and does
  **not** set or accept `threadId`. Every support send is a standalone root
  message, so two messages about one problem are two unrelated rows.
- **Replying needs a HIGHER permission than opening.** The support send is
  gated on `messages:read`; `POST /:id/reply` requires **`messages:write`**. A
  user who can open a support request may be unable to reply to the answer —
  and that is exactly the population `ContactSupportCard` serves, since it
  renders the compose form on the `!canWrite` branch.
- **There is no status field anywhere.** `messages` has no `status`,
  `archived` or equivalent column. Open/close does not exist in any form.

What DOES work: attachments on both legs (`MessageCreateSchema` and
`MessageReplySchema` both carry `attachmentIds`), and threading itself
(`POST /:id/reply` sets `threadId: id`; the reader walks `threadId ===
root.id`; `update-message.ts` has mark-thread-as-read).

| Capability | Today | Gap |
|---|---|---|
| Open a case | sends a message; no case identity | no case ID, no status |
| Close a case | **nothing** | no status column exists |
| View a case | a row in Messages | no case view |
| **View PER ORG** | **works** — see below | — |
| Attach files | **works**, open and reply | — |
| Conversation history | mechanism exists, support path does not use it | support sends are unthreaded |
| Reply to support | needs `messages:write` | openers only have `messages:read` |

### Per-org visibility already works — do not rebuild it

The support send sets **`recipientUserId: undefined`**, so the row is ORG-WIDE
rather than targeted at the sender. `core/query-filters.ts` is explicit that
the per-user rung *"fails CLOSED when absent: no viewer means the per-user rung
matches NOTHING, never everything"* — with no per-user value on the row, that
rung does not restrict it.

So an org ADMIN can already see their organization's support messages, not
just their own, carried by `orgId` on the row plus `readBy[orgId]` for
per-participant read state. **Org-level tenancy is existing behaviour, not
work.** This narrows the tenant half of B2 considerably.

### But the inbox is BUILT on unthreaded roots

`findInboxPaginated` filters on **`threadId: null` — root messages only**.
Support sends are already unthreaded roots, so today they list as a flat run of
disconnected rows, one per send. Reply once and the reply LEAVES the inbox view
(it now has a `threadId`), surfacing only inside a thread reader the support
path never populates.

This is a sequencing problem, not just a missing feature: threading the support
path without changing the inbox query would make existing support messages
**disappear from the list**. Whatever introduces `threadId` on support sends has
to land together with an inbox that groups by thread, plus a decision about
already-sent messages.

**So the real deliverable of `support_standard` is "turn messages into
tickets", not "add a response target".** Price it accordingly; the response
target is the smaller half.

### The project, restated

Decide what the paid add-on buys that the free path does not, decide what
happens to the free path, and build the ticketing both sides are missing.

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

### B4. Openers cannot reply

`POST /messages/support` is gated on `messages:read`. `POST /:id/reply`
requires `messages:write`. `ContactSupportCard` deliberately renders for users
WITHOUT write — so the people the support form is built for can open a request
and then be unable to answer the reply.

Any ticketing work has to resolve this, and the resolution is a permission
decision, not a UI one. Either the reply path gains a support-scoped carve-out
(reply to a thread you opened, in your own org) or support cases stop being
ordinary messages. The first is narrower and preferred.

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
| **Staff queue, status, assignment (B2)** | Priority, **attachments on open AND reply** |
| **Case identity: case ID, status, open/close** | Threading *as a mechanism* — but NOT on the support path |
| **Threading the support path** (it is unthreaded today) | Recipient forcing, alias resolution |
| **A reply path openers can actually use** (see B4) | `message_attachments` storage |
| Case view, for the tenant | `'support'` role in the ecosystem role list |
| Severity ladder + published response targets | |

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

## Gap matrix — what is missing, from both sides

The `messages` table carries: `id, orgId, createdBy/At, updatedBy/At, threadId,
recipientOrgId, recipientUserId, messageType, channel, subject, content,
priority, readBy, isActive, deletedAt/By, purgeAfter, editedAt, isDefault`.

Roughly half of what a ticket needs is already there — identity, threading,
priority, per-participant read state, soft-delete with `purgeAfter`, and
attachments. **What is entirely absent is the WORKFLOW axis**: status,
assignee, internal-vs-external visibility, resolution.

That is a coherent boundary, and it frames the real structural choice (below).

### Working already — do not rebuild

- **Both orgs can see the case.** `api/query-builders.ts:293` — *"Messages are
  visible to the sender org (orgId) OR the recipient org (recipientOrgId)"*. So
  the system org genuinely does receive inbound cases and can search across all
  of them. This is the backbone a queue would be built on.
- Org-wide visibility for the tenant (`recipientUserId: undefined`).
- Attachments on open AND reply.
- Search (`InboxFilters.search`), per-participant read state (`readBy[orgId]`),
  requester identity (`createdBy`).

### Missing — ORGANIZATION side

| Gap | Why it matters |
|---|---|
| Close / resolve | No status column. A tenant cannot say "this is sorted" |
| Reply (B4) | Openers hold `messages:read`; replying needs `messages:write` |
| Conversation history | Support sends never set `threadId` |
| Change severity after opening | `priority` is set once at send; nothing updates it |
| See the response target on the case | The promise is not attached to the thing it is about |
| Satisfaction / feedback | No CSAT anywhere — support would be sold with no quality signal |
| Export case history | Compliance customers will ask; there is no case-scoped export |

### Missing — SUPPORT side

| Gap | Why it matters |
|---|---|
| Queue / triage view (B2) | Zero support surfaces exist |
| Assignment / ownership | No `assignedTo`. Two engineers can answer the same case |
| Status | Same missing column. No "waiting on customer" |
| **Internal notes** | **Decide first** — see below |
| **The org's tier and add-on** | **Decide first** — see below |
| Case volume / ageing metrics | SLA enforcement is out of scope, but OPERATIONAL visibility is a different thing: nobody can see a backlog forming |
| Canned responses | Low priority, but it is what makes volume survivable |

### Two to decide BEFORE building the queue

**Internal notes.** Every message in a thread is visible to both participants;
there is no way to annotate a case privately. This is a DATA-MODEL decision,
not a UI one — either a visibility flag on `messages` or notes on a separate
table. Decide before the queue exists, because retrofitting privacy onto a
thread everyone can already read is how things leak. Expect staff to work
around its absence in Slack, leaving the case record incomplete.

**Tier and add-on visible on the case.** Support cannot currently tell a free
`developer` from a `support_premium` customer while triaging — the entitlement
lives in billing, not on the case. This is the one capability that makes a paid
add-on OPERABLE: the decision was that targets are not enforced in software,
which means they are enforced by humans, and humans need to see who is paying.

### Case identity — there is no case ID today

`messages.id` is `uuid('id').primaryKey().defaultRandom()`, so a unique id is
created **per MESSAGE, not per case**. Two consequences:

1. **Because support sends are unthreaded, every send is its own "case".** A
   customer who writes twice about one problem produces two UUIDs with nothing
   linking them. No identifier means *this case* rather than *this message*.
2. **There is no human-usable case number.** Checked across the schema and the
   SQL: no sequence, no `nextval`, no serial, no nanoid, no short-id — all 36
   tables use a bare random UUID. That is a sound house convention for internal
   entities, but a support case is the one thing customers quote back: in an
   email subject, on a call, in an escalation. `3f2a9b1c-…` is not that.

**The canonical case ID should be the thread root's UUID.** The convention
already exists — the reader walks `threadId === root.id`, and
`update-message.ts` uses `updated.threadId ?? updated.id` for exactly this
"root is the identity" idea. So case identity falls out of threading the
support path rather than being a new concept.

**A human-readable display number IS new**, and needs a generator this repo
does not have. The choice matters:

| Scheme | Example | Trade-off |
|---|---|---|
| Per-org sequence | `ACME-1042` | Leaks nothing; needs per-org counters |
| Global sequence | `#10042` | Simplest; DISCLOSES total case volume to every customer |
| Random short code | `K7QX-2M` | Leaks nothing, no counters; not ordered, so "is this newer?" is unanswerable |

Recommended: per-org sequence. The volume disclosure in a global sequence is a
real commercial leak, and ordering is worth more than the simplicity.

**This sharpens the dependency chain**: no threading → no case identity → no
case number → no way for a customer to reference a case or for support to track
one. Same root cause as the conversation-history gap, which makes threading the
support path the FIRST build step rather than one of several.

Note that a case ID is also what a CSAT survey, a case export and an audit
record would each key on — three gaps in the matrix above quietly depend on it.

### The structural choice this implies

Either a **`support_cases` table** joined to the thread, or a **workflow column
group added to `messages`**. Recommended: the former. It keeps ticket concerns
(status, assignee, resolution, internal notes) out of a table that also carries
announcements and ordinary conversations, and it leaves the existing inbox
queries untouched.

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

**Org hierarchy — narrowed.** Visibility WITHIN one org is already solved (see
"Per-org visibility" above), so the remaining question is only about the
ENTITLEMENT across a root and its teams: does support bought at the root cover
child teams, and can a team open cases against the root's add-on? The partially
pooled quota model makes this a real question rather than an obvious one, but
it is a billing question now, not a messaging one.

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

**Case lifecycle.** NET-NEW on both sides — there is no status column to build
on. States, who may transition them (tenant, staff, or both), what closes a
case, whether a closed case can reopen, and whether closing is a message in the
thread or a field on it.

**"Business hours" is undefined.** Whose timezone, which holidays. With no
enforcement, the definition IS the product promise.

---

## Explicitly out of scope

- SLA enforcement of any kind (decision 2).
- Any support read-path into tenant resources (decision 3).
- Phone or chat channels. Cases are message threads.
- Per-seat support pricing. The add-on is per-org.
