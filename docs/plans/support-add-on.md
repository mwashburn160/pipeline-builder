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

## Decisions taken


Recorded because each one removes work.

1. **A paid add-on, available at every tier** — not a tier benefit.
2. **Response targets are MEASURED, not INDEMNIFIED.** *(Amended — the original
   wording was "stated, not enforced: no breach records, alerting, SLA metrics
   or escalation", which the pricing model has since overtaken. Response time
   is now the axis being sold, so first-response measurement is a precondition
   of the sale — see Phase 2b.)* What stays out of scope is the **remedy**: no
   service credits, no automated escalation, no contractual breach record. We
   publish the target, show it on the case, and can always answer "did we hit
   it" — we just do not owe money when we miss.
3. **Support does NOT read into the tenant's org.** No pipeline, build, log or
   registry access; the tenant attaches what the case needs. This is the most
   load-bearing decision here — it keeps the feature clear of the
   impersonation-consent machinery entirely, and a tenant's exposure is exactly
   the files they chose to upload.

---

## Current state — what already ships, free


> **Read as present tense.** This section describes what exists **today**, which
> is what the plan must not rebuild. B3 closes the free path — so "it is free" is
> the starting condition, not the target state.

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

**Now narrowed by B3's decision.** Since support is included in no tier, the
reconciliation has a known answer: every tier's feature list must stop
promising support, starting with the `developer` "Community support" line at
`billing-config.ts:64`. That is a deletion across the tier copy plus the
pricing page and any public marketing, not a per-tier judgement call — and it
must land in the **same release** as the paywall, or the product charges for
something the plan copy still advertises as included.

### B2. There is a filtered inbox, not a queue

> **Corrected.** An earlier revision claimed "zero support surfaces", from a
> grep of `frontend/src/pages` — **a directory that does not exist**. Pages
> live at `frontend/pages`. The search returned nothing because the path was
> wrong, not because nothing was there. The claim was false and is replaced
> below. (`ContactSupportCard` is likewise mounted, at
> `pages/dashboard/help.tsx:118`, as `canMessage={can('messages:read')}`.)

What actually exists: `pages/dashboard/messages.tsx` (527 lines) has a
**`support` channel filter** (`type ChannelFilter = '' | 'support'`), tabs that
map to distinct server endpoints, and server-side narrowing of the active tab.
Combined with the sender-OR-recipient visibility predicate, system-org staff
can already list inbound support messages.

So the gap is narrower and more specific than "no staff side": it is a
**filtered inbox, not a queue**. Missing for triage:

- **status** — nothing distinguishes new from answered from resolved,
- **assignment / ownership** — two engineers can answer the same case,
- **ageing** — nothing surfaces what has been waiting longest,
- grouping by case rather than by message (blocked on threading).

**No response target should be published until ageing and status exist**,
because without them nobody can see what is waiting or whether it was
answered.

### B3. DECIDED — the free path closes

**Resolved: support is an add-on on every tier and is included in no tier.**
Of the three options this section previously listed, that is option 3 — the one
noted as maximum revenue capture and maximum ill will. It is the user's call and
it is settled; what follows is what it obliges, not a re-argument.

Mechanically it is now clean, because `supportContacts` has a tier base of **0
everywhere** (see Pricing): an org with no add-on has no contacts and cannot
open a case. The paywall is a quota check, not a special case.

Two consequences, both required work:

**1. No grandfathering.** Consistent with the standing forward-only rule, the
currently-free messaging path to the system org closes for everyone rather than
being preserved for existing orgs. Existing support threads are handled by the
Migration section; what ends is the ability to *start* one without the add-on.

**2. An unpaid channel is still required — this is a gap, not a reopening.**
Three things must reach us from an org with no support add-on, and none of them
is "support" in the product sense:

- **Security reports.** A vulnerability reporter is frequently not a paying
  customer and sometimes not a customer at all. Putting a paywall between a
  reporter and us is how a disclosure becomes a public one.
- **Billing disputes.** "I was charged wrongly" cannot require buying
  something. It is also the one case where the add-on may be exactly what is in
  dispute.
- **Account lockout.** "I cannot log in" cannot be gated behind a purchase
  made from inside the account.

These need a route that does not consult `supportContacts` — plausibly an
unauthenticated address or form rather than the in-app case path, which keeps
them out of the queue and out of the entitlement check entirely. **Decide the
shape in Phase 0**; shipping the paywall without it is the one version of this
decision that is actually dangerous rather than merely unpopular.

### B4. Openers cannot reply

`POST /messages/support` is gated on `messages:read`. `POST /:id/reply`
requires `messages:write`. `ContactSupportCard` deliberately renders for users
WITHOUT write — so the people the support form is built for can open a request
and then be unable to answer the reply.

Any ticketing work has to resolve this, and the resolution is a permission
decision, not a UI one. Either the reply path gains a support-scoped carve-out
(reply to a thread you opened, in your own org) or support cases stop being
ordinary messages. The first is narrower and preferred.

**DECIDED — a support-scoped reply route, and the precedent already exists.**
`POST /messages/support/attachments` is gated on `messages:read` for exactly
this reason (the person raising a case usually holds read, not write), so the
reply carve-out follows the same shape: a second mount sharing the handler,
gated on `messages:read`, scoped to the support channel.

**Who may reply is NOT "the author", and that correction matters.** The obvious
reading of "a thread you opened" admits only `createdBy`. But tenant-side
reassignment exists precisely so a case can change hands when its opener goes
on leave or leaves the company — and if the new owner cannot reply, **the
reassignment is cosmetic**. So the carve-out admits:

- the thread's **author** (`createdBy`), and
- the case's current **`tenant_contact`** (which reassignment sets), and
- anyone holding `messages:write`, who could already reply.

Deliberately NOT "any designated contact": that would need the cross-service
entitlement read on every reply, adding latency and a second degraded-mode
question to a path that has a local answer. Authorship and current ownership are
both on rows this service already has.

A legacy support thread with no case row has no `tenant_contact`, so it falls
back to author-or-writer — which is the behaviour those threads have today.

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

## Scope — everything missing, in one place

**This is the one authoritative list of what is missing.** Earlier revisions
spread it across four separate sections, which drifted apart (severity
re-ranking was simultaneously "deferred out of v1" and "required before premium
ships"). Anything not here is either decided above, sequenced below, or a
genuinely open question at the end.

Two groups: what the original surface audit found, and what selling a response
time per contact added.


The `messages` table carries: `id, orgId, createdBy/At, updatedBy/At, threadId,
recipientOrgId, recipientUserId, messageType, channel, subject, content,
priority, readBy, isActive, deletedAt/By, purgeAfter, editedAt, isDefault`.

Roughly half of what a ticket needs is already there — identity, threading,
priority, per-participant read state, soft-delete with `purgeAfter`, and
attachments. **What is entirely absent is the WORKFLOW axis**: status,
assignee, internal-vs-external visibility, resolution.

That is a coherent boundary, and it frames the real structural choice (below).

### Working already — do not rebuild

- **Both orgs can see the case.** `packages/pipeline-data/src/api/query-builders.ts:293` — *"Messages are
  visible to the sender org (orgId) OR the recipient org (recipientOrgId)"*. So
  the system org genuinely does receive inbound cases and can search across all
  of them. This is the backbone a queue would be built on.
- Org-wide visibility for the tenant (`recipientUserId: undefined`).
- Attachments on open AND reply — **at the data layer and in `ComposeModal`**,
  but NOT on the support path as first written. `ContactSupportCard` omitted
  `onUploadAttachment`, which hides the attach control, and the upload route was
  gated on `messages:write` while `POST /messages/support` is carved out to
  `messages:read` — so the one surface built for raising a case was the one that
  could not attach a build log to it. **FIXED**: `POST
  /messages/support/attachments` (same handler chain, `messages:read` gate),
  `uploadSupportAttachment`, and the prop wired. Download never needed work —
  `MessageAttachments.tsx` already does inline preview plus
  `triggerBlobDownload`, so a case view just mounts it.
- Search (`InboxFilters.search`), per-participant read state (`readBy[orgId]`),
  requester identity (`createdBy`).

### Missing — ORGANIZATION side

| Gap | Why it matters |
|---|---|
| Close / resolve | No status column. A tenant cannot say "this is sorted" |
| Reply (B4) | Openers hold `messages:read`; replying needs `messages:write` |
| Conversation history | Support sends never set `threadId` |
| Change severity after opening | `priority` is set once at send; nothing updates it |
| ~~See the response target on the case~~ | **DONE** — `responseTargetLabel` puts the target on the case chip, derived from the FROZEN `level`, so it stays truthful after a downgrade. An unrecognised level omits the phrase rather than borrowing another level's promise |
| Satisfaction / feedback | No CSAT anywhere — support would be sold with no quality signal |
| Export case history | Compliance customers will ask; there is no case-scoped export |

### Missing — SUPPORT side

| Gap | Why it matters |
|---|---|
| Queue / triage view (B2) | A `support` channel filter exists; status, ownership and ageing do not — see B2's correction |
| Assignment / ownership | No `assignedTo`. Two engineers can answer the same case. **Now Phase 2**, both sides — see Reassignment in the data model |
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


### Created by the response-time model

Ordered by severity.



### C1. There is no way to stop the clock — this breaks the product

Measured: the plan contains **zero** mention of pausing a response target.
"Waiting on customer" appears once, as a missing *status*, with no clock
implication.

A 24-hour first-response target is answerable. But every subsequent exchange
depends on the tenant, and a case where we reply in an hour and the tenant
answers four days later will look like a four-day case in any naive ageing
view. Without an explicit **awaiting-customer state that suspends the clock**:

- the ageing queue fills with cases we are not actually blocking,
- the metric that Phase 2b exists to produce reports a number nobody will
  accept,
- and the first dispute is argued over whose delay it was, with no record.

This is not a nicety at $99.99/contact for a one-hour target. **It belongs in
Phase 2b with the measurement**, because the measurement is wrong without it.
Decide also whether an un-answered awaiting-customer case auto-closes, and
after how long.

### C2. Severity is self-selected, and nothing stops everyone choosing Sev-1

The plan notes the *field* problem (three `MESSAGE_PRIORITIES` versus a Sev-1..4
ladder). It does not address the *governance* problem, which is larger:

- **No definitions.** Nothing says what Sev-1 means. "Production down" and
  "I am blocked" are not the same claim, and without a published table every
  tenant resolves the ambiguity in their own favour.
- **No re-ranking.** A tenant sets severity at open; staff cannot correct it
  (and "change severity after opening" is already deferred out of v1). So the
  tenant unilaterally sets the response target they are owed.
- **No audit of a change**, once it exists.

For a premium contact paying for 24×7 coverage, self-selected severity means
*every* case is one-hour. Either severity needs definitions plus a staff
downgrade path with an audit action, or the premium target must attach to
something the tenant cannot set. **Do not ship premium without one of the two.**

### C3. Every org member can read every case — including non-contacts

`packages/pipeline-data/src/api/query-builders.ts:293` makes a message visible to the **sender org or
recipient org**, and the plan lists tenant-side org-wide visibility under
"working already — do not rebuild". Under the contact model that becomes a
question the earlier design never had to ask: contacts are a **small paid
subset** of members, but visibility is still org-wide, so any member can read
every case those contacts opened.

That is probably wrong for exactly the cases B3 carved out — a billing dispute,
a security report, an account problem — and for anything a contact writes
expecting it to reach support rather than their colleagues. Needs a decision
between org-wide (today, simple, leaky) and **contacts-plus-author** (narrower,
and it is a case-level visibility column, not a reuse of the org predicate).

### C4. Contact lifecycle — partly answered

Contacts are people, and people leave. **Open cases now have an answer**: with
`tenant_contact` reassignable (see Reassignment in the data model), removing a
contact reassigns their open cases rather than orphaning them — by default to an
org admin, or explicitly as part of the removal.

Still unspecified: whether the paid slot frees immediately or at renewal, and
what happens to a designation when its holder moves to another team in the
subtree. The seat model has answers for members; contacts do not inherit them.

### C5. Deflection is the highest-leverage thing available, and it is already built

Measured: **zero** mentions of self-service deflection. Yet cost to serve is
now the entire economics of this add-on — and the repo already ships
`frontend/src/components/ask/AskPanel.tsx` and `AskHelpTopics.tsx` over a
generated help corpus.

Routing a question through Ask **before** the case form, with the help topics it
already surfaces, is the cheapest capability in this document: it reduces the
case volume that every price in the Pricing section is trying to cover, and the
component exists. Not building it means the per-contact price has to carry
volume we could have deflected. This is a v1 candidate, not a Phase 4 one.

### C6. Duplicates, and the incident that creates fifty of them

No mention of merging or linking duplicate cases, and none of platform-wide
incidents. One outage produces one case per affected org, each individually
answerable within its target. Without a way to recognise them as one event:

- the ageing queue reports a crisis as fifty unrelated cases,
- fifty engineers' worth of replies get written by hand,
- and the premium contacts' one-hour targets are all breached together, which
  is precisely when the measurement will be looked at.

A broadcast path to affected cases, or a parent/child link, is the minimum.
Note `announcement` already exists as a message type and may be most of it.

### C7. Smaller, but absent

- **Bulk staff operations** — zero mentions. Close, reassign or reply across a
  selection. Follows directly from gap 6.
- **Structured resource references.** Decision 3 keeps support out of tenant
  resources, which is right. But letting a tenant attach an *execution or build
  id* as a field rather than pasted prose costs nothing, grants no read access,
  and is the difference between triage and archaeology. Compatible with
  decision 3 as written.
- **Reopen semantics.** Listed as an open question; note the pricing
  consequence — if reopening restarts the response target, closing becomes a
  way to reset the clock.
- **Target visible against actual.** The plan shows the tenant their target.
  Showing the target *and* what we achieved is what makes the add-on feel
  bought rather than promised.

---

## Pricing — per support contact, by response time


**Revised.** An earlier version priced this at $2.99 / $7.99 / $14.99 per
*org seat*. That was too low, and correcting it changed the model rather than
just the number. Both the old figures and why they were wrong are kept below,
because the error is instructive.

### Why $2.99 was wrong — five distinct mistakes

1. **The anchor was a category error.** It came from AWS's $29 Developer and
   $100 Business *floors*, divided by a seat count. But those are per-account
   minimums under a model that charges a **percentage of spend**. Dividing a
   floor by seats produces a number with no meaning.
2. **Cost to serve is per case, not per seat.** One human reply is $15–40 of
   loaded engineer time. A 3-seat Team org paid **$8.97/mo** — less than a
   single reply. Every org that actually used support lost money, and the ones
   that never opened a case subsidised them. That is a bad business shaped
   like a good one.
3. **It priced support below the seat it attaches to.** The `seat` bundle is
   **$19.99**. Support at $2.99 asserted that answering a human is worth 15% of
   providing them a login, when human time is the most expensive input here.
4. **The volume discounts were decorative.** 30% off $2.99 saves **$0.90** per
   seat. A discount tier that saves under a dollar is not an incentive to
   consolidate; it is noise on an invoice.
5. **The ladder had no absolute separation.** $2.99 → $7.99 → $14.99 spans 5×
   but only **$12**. Three rungs $12 apart do not read as three different
   products, so nobody trades up.

### Correcting it exposed a structural error: seats is the wrong unit

Raising the base to $19.99 while keeping the quantity at *all org seats* gives
this, and it is indefensible:

| Org | Plan + seats | Standard @ $2.99 | Standard @ $19.99 |
|---|---|---|---|
| Team, 3 seats | $79.00 | $8.97 (11%) | $59.97 (**76%**) |
| Business, 8 | $249.00 | $21.53 (9%) | $143.93 (**58%**) |
| Enterprise, 15 | $899.00 | $35.88 (4%) | $239.88 (27%) |
| Enterprise + 85 seats | $2,598.15 | $209.30 (8%) | $1,399.30 (**54%**) |

Standard support cannot cost half the platform. The reason is simple and it
invalidates per-seat support pricing outright: **case volume does not scale with
seats.** A 100-seat org does not open 100× the cases of a 1-seat org — most
seats never open one. Per-seat pricing bills the 95 people who will never
contact support.

So **$19.99 is the right price and seats is the wrong unit.** Priced per
*support contact* — the people actually authorised to open cases — the same
orgs land where support should:

| Org | Contacts | Standard | % of plan | Premium | % of plan |
|---|---|---|---|---|---|
| Team | 1 | $19.99 | 25% | $99.99 | 127% |
| Business | 2 | $39.98 | 16% | $199.98 | 80% |
| Enterprise | 3 | $53.97 | 6% | $269.97 | 30% |
| Enterprise + 85 seats | 5 | $89.96 | 3.5% | $449.96 | 17% |

### This settles D-a vs D-b — they were never independent

The previous revision listed "derived from seats" (D-a) and "named contacts"
(D-b) as an open decision, and the price point as a separate one. **That was a
gap in the analysis.** $2.99 only works across all seats; $19.99 only works on
contacts. Choosing the price chooses the unit.

**D-b is adopted**, and it is better for two reasons beyond price:

- **It closes the silent-under-buying hole.** Under D-a the bundles granted no
  quota field, so quantity affected price only — a 50-seat org could buy one
  unit, hold the feature flag at `quantity: 1`, and nothing anywhere reported a
  problem. Under D-b the bundle grants a real quota field, so the quantity is
  **entitlement-bearing and capped by `effectiveEntitlements`**. The abuse case
  stops being silent and starts being impossible.
- **It keeps the existing purchase UI correct.** D-a needed a read-only
  quantity box, which `AddonGrid` has no concept of. D-b uses the editable
  typed-quantity control exactly as built.

### The ladder

| Bundle | First response | Hours | Urgent severity | Per contact / mo | / yr |
|---|---|---|---|---|---|
| `support_standard` | **2 business days** | Business hours | — | **$19.99** | $199.90 |
| `support_priority` | **next business day** | Business hours | — | **$49.99** | $499.90 |
| `support_premium` | **8 hours, any day** | **24×7 coverage** | **yes** | **$99.99** | $999.90 |
| *one-time incident* | per the level it is granted against | — | — | **not sold — granted** | — |

Offered to **all standard tiers**, per the decision in B3 — support is an
add-on everywhere and included in no tier.

`$99.99` for a single premium contact lands on **AWS Business's $100 floor**,
which is the right comparison: premium is priced on cost to serve, not as a
percentage of plan. That is why premium reads as 127% of a Team plan and is
still correct — a $79 customer wanting an 8-hour response at 3am is asking for
something that costs what it costs.

#### Why the targets are stated this way (revision, 2026-10-31)

The first ladder read **48 business hours / 24 business hours / no stated
number**, and it was wrong twice over.

**The business-hours unit flattered every target by about three times.** 48
business hours is six working days: a case raised at 17:01 on a Friday had its
target expire the *following Monday*, ten calendar days later. 24 business hours
is three working days, not one. A customer who does that arithmetic — or simply
lives through one Friday — feels misled, and a promise that produces that
feeling is worse than a slower one stated straight.

**And the top rung was the only one with no number.** Premium sold "24×7
coverage" and nothing measurable, so the ladder went blank on the single axis a
buyer compares, exactly where the price doubled. From the buyer's seat, paying
2× bought a wider window and *less* commitment, which made priority the
rational purchase. That is a claim problem, not a price problem.

So the targets are now stated in units the customer experiences, and they
improve monotonically on one clock: **two business days, then one, then eight
hours on a clock that does not stop for nights or weekends.** Premium now beats
priority *every day of the week* rather than only at weekends, which is what
carries the 2× step. Eight hours is deliberately not an hour-scale severity
promise: the platform has no pager integration anywhere, so an hour-scale
commitment would be sold against a rota that cannot be woken.

The wording lives in **one** place, `SUPPORT_RESPONSE_TARGETS` in api-core, and
is interpolated into the add-on catalog and the feature catalog. It is a
commitment that appears on the case chip, on the pricing page and in the alert
that fires when the desk misses it; those must not be able to disagree.

#### Premium also carries a capability, not just a clock

Differentiating on response time alone makes every comparison a pure
speed-versus-money judgement — the dimension buyers are worst at valuing before
they need it. So **`urgent` severity is admitted only at premium**
(`URGENT_SEVERITY_LEVELS`), which makes the top rung a thing you can *do*.

An `urgent` asked for below premium is **downgraded to `high`, never refused**:
the message always sends, because denying a support message over a label would
deny support. The sender is told, and `support_cases_total{action="severity_
downgraded"}` counts it — a demand signal rather than an error count, since
every increment is an org asking for the one thing only premium sells.

Staff re-ranking stays the escape hatch: a genuine emergency raised on a lower
level is ours to promote, which is the same governance split that stops a tenant
re-ranking after open (scope C2).

**No `availableForTiers` floor hack is needed any more.** The earlier draft
restricted premium to `SEAT_PACK_TIERS` to manufacture a 3-seat minimum,
because $14.99 was below cost. At $99.99 with a one-contact minimum, **the
floor is the unit price** — and that is what lets support be offered on every
tier, as directed.

### Volume curve, recut for the contact range

Contacts live in 1–20, not 1–100 like seats, so the `seat` bundle's curve
(≥5, ≥15, ≥40) barely engages. Recut:

| Contacts | Standard | Priority | Premium |
|---|---|---|---|
| 1 | $19.99 | $49.99 | $99.99 |
| 2 | $39.98 | $99.98 | $199.98 |
| 3 | −10% — $53.97 | −10% — $134.97 | −10% — $269.97 |
| 5 | −10% — $89.96 | −10% — $224.96 | −10% — $449.96 |
| 8 | −20% — $127.94 | −20% — $319.94 | −10% — $719.93 |
| 12 | −20% — $191.90 | −20% — $479.90 | −10% — $1,079.89 |
| 20 | −30% — $279.86 | −20% — $799.84 | −10% — $1,799.82 |

At these prices the discounts are real money (−20% on 8 standard contacts is
$32/mo), which is the point of having them.

**The curve flattens as the level rises, and support is the only family where it
does.** A volume break is justified when unit cost falls with scale — true of
capacity, where one more pipeline slot costs almost nothing, and false of
support, where cost per contact does not fall with the count but *rises* with
the coverage the level promises.

Run flat, the same percentage is five times the money at the top: a uniform
−30% at 20 contacts took premium from $1,999.80 to $1,399.86 a month, giving
away **$600/mo** to precisely the customers whose case volume the seven-day rota
has to absorb. So standard keeps the full curve (it is the attach-rate lever and
its marginal case is cheap), priority stops at −20%, and premium stops at
−10% — which cuts premium's give-away to a third without making the break
decorative.

The caps also bound the **annual stack**. Annual is 10× monthly (≈17% off) and
the volume percent comes off the annual price too, so the two multiply:
uncapped, 20 annual premium contacts landed **41.7% below** a year at monthly
list. Premium now stacks to 25%. Standard is deliberately allowed deeper — it
is the attach lever, and revenue at that discount is revenue that would mostly
not exist.

### The mechanism: a `supportContacts` quota field

`grants` keys are constrained to real `QuotaTierLimits` fields — a typo is a
compile error — so D-b needs one new field, **`supportContacts`**, with a tier
base of **0 on every tier**. Each bundle grants `{ supportContacts: 1 }` per
unit alongside its `features` flag.

This gives three things at once:

- **The paywall is a quota check, not a feature flag.** Base 0 everywhere means
  an org with no support add-on has zero contacts and cannot open a case. That
  IS B3's decision, enforced by the mechanism that already enforces seats.
- **Designation is capped** the way invites are capped against `seats` — the
  existing enforcement shape, including the pooled-subtree counting.
- **Quantity can no longer drift meaninglessly**, because it now grants
  something a reconciler can check.

Cost, measured: a `QuotaTierLimits` field appears in `quota-tiers.ts` (the
interface, six tier presets and the `QUOTA_TIER_*` env override — nine
occurrences for `listings`), the quota-admin editor presets in
`frontend/src/components/quotas/constants.ts`, `UsageCard.tsx`, and
`entitlement-sync.ts`. `frontend/test/quota-tier-presets.test.ts` guards the
presets by reading api-core **from source**, so it will catch an omission.
Contained, but four files and a guard test — not one line.

### Levels must still be mutually exclusive

Unchanged and now more necessary: each bundle grants `supportContacts`, so
holding `standard × 2` and `premium × 3` yields five contacts and **two
response levels**. `BundleConfig` has `stackable` and `requires` but **no
mutual exclusion**; add it to the canonical math in `effectiveEntitlements`
beside the `stackable` and `maxQuantity` invariants.

Note the subtlety D-b introduces: contacts *should* stack (that is the
quantity), while levels *must not*. So exclusion is per-level, not
per-bundle-set — one level, any number of contacts at that level.

### Combo

| Combo | Members | Sum | 30% off |
|---|---|---|---|
| `assured_delivery` | `compliance_standard` + `support_standard` @ **min 1 contact** | $49.89 | **$34.92/mo** · $349.20/yr |

The anchor drops from 3 to 1 because a contact is not a seat — one contact is a
real purchase. Per `minQuantities`' own contract, "the credit basis uses this
minimum, so extra units never inflate the discount": the 30% applies to the
first contact and contacts 2+ bill at list. Say so on the pricing page.

### `unlimited`

Simpler under D-b. `ALL = [...STANDARD_TIERS]` excludes `unlimited`, so an
`unlimited` org cannot purchase contacts — but contacts are now a *quota*, and
`unlimited`'s convention is `-1` on quota fields. Set `supportContacts: -1`
there and the question answers itself with no purchase path, consistent with
how every other quota treats that tier. Decide it explicitly all the same.

### Still load-bearing: the targets are not measured

Selling response time as the product axis means the number in the table is the
thing being paid for, and nothing measures first-response time today. At
$99.99/contact for a one-hour target this is sharper than before: the first
dispute is unanswerable without it. **Phase 2b gates Phase 3.** No service
credits are proposed, but "we owe you nothing" is not a reason to be unable to
tell whether we hit it.

---

## Data model

Earlier revisions decided *`support_cases` table versus workflow columns on
`messages`* and then never wrote the table, which left the retrofit-expensive
part of a decision labelled "expensive to retrofit" unspecified. This is that
specification, in the repo's drizzle conventions (`pgTable`, uuid primary key
with `defaultRandom()`, `varchar(255)` org ids, `text` actor ids, `timestamp`
with timezone, named `<table>_<cols>_idx` indexes).

`messages` keeps carrying the conversation. `support_cases` carries the
workflow axis that `messages` has no column for — status, assignee, resolution
— plus the clock. One row per case.

### `support_cases`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk `defaultRandom()` | Internal key |
| `thread_id` | `uuid` not null | The root `messages.id`. **The canonical case identity** — see Case identity |
| `org_id` | `varchar(255)` not null | The tenant. Never the system org |
| `display_number` | `integer` not null | Per-org, customer-quotable (`ACME-1042`) |
| `status` | `varchar(32)` not null | `open` / `awaiting_support` / `awaiting_customer` / `resolved` / `closed` |
| `severity` | `varchar(16)` not null | Set by the opener, re-rankable by staff (scope C2) |
| `level` | `varchar(32)` not null | The support level **held at open**, frozen onto the case |
| `assigned_to` | `text` | **Staff** owner — a system-org actor; null = unowned. Reassignable |
| `tenant_contact` | `text` | **Tenant** owner — the designated contact currently responsible. Reassignable. NOT `created_by` |
| `first_response_at` | `timestamp tz` | Null until staff first reply. The measured number |
| `awaiting_since` | `timestamp tz` | Set when status → `awaiting_customer`; the clock-pause anchor |
| `awaiting_total_seconds` | `integer` not null default 0 | Accumulated paused time, so ageing subtracts it |
| `closed_at` / `closed_by` | `timestamp tz` / `text` | Resolution |
| audit + soft-delete | | `created_by/at`, `updated_by/at`, `is_active`, `deleted_at/by`, `purge_after` — same shape as `messages` |

`awaiting_total_seconds` exists because scope C1 needs the clock to **stop**.
Storing an accumulator alongside the current anchor makes ageing a subtraction
rather than a replay of status history, and survives a case bouncing between
states several times.

`level` is frozen at open deliberately: a customer who downgrades mid-case
should still get the response they bought when they opened it, and the
alternative — resolving entitlement live — makes an already-open case change
its promise underneath the person waiting on it.

### Reassignment — two independent owners, and why `created_by` is not one

A case has **two** owners and they move independently: a staff owner
(`assigned_to`) and a tenant owner (`tenant_contact`). Both are reassignable;
neither is `created_by`.

**`created_by` stays immutable.** It is the audit fact of who opened the case,
on a hash-chained trail. Mutating it to express "someone else owns this now"
destroys the only record of who actually raised it — which is why tenant
ownership needs its own mutable column rather than reusing authorship. The two
answer different questions: *who raised this* never changes, *who is handling
it* must.

**Staff reassignment** (`assigned_to`): any system-org actor with the support
role may take, hand over or release a case. `null` is a legitimate value —
releasing to the unowned pool is how "I cannot take this" is expressed without
inventing a pseudo-assignee. No assignment-history table: the audit action
carries the history, and the trail is already tamper-evident.

**Tenant reassignment** (`tenant_contact`): hands a case to another contact when
the opener goes on leave, changes team or leaves the company. Two constraints:

- **The target must be a designated contact** (`support_contacts`). Handing a
  case to a non-contact would give responsibility to someone the org has not
  paid a seat for and — under C3's contacts-plus-author visibility — possibly
  someone who cannot even read it.
- **It does not widen visibility.** Under C3 every contact can already read the
  org's cases, so reassignment moves *responsibility and notification*, not
  access. Worth stating because the obvious assumption is the opposite.

**This resolves half of C4.** Contact lifecycle asked what happens to open cases
when a designated contact is deactivated or removed. With tenant reassignment
the answer is available rather than invented: on removal, their open cases are
reassigned — to an org admin by default, or explicitly during removal — instead
of orphaning. What remains open in C4 is whether the paid slot frees
immediately.

**Both are audit-worthy** and distinct: `support.case.assign` (staff, covering
assign / reassign / release) and `support.case.transfer` (tenant-side contact
handover). Each needs a `docs/audit-events.md` row and a
`docs/permission-contract.md` entry. A silent change of owner is how
accountability for a response target disappears.

**Bulk reassignment stays out of v1** (scope C7). One case at a time is enough
to make ownership real; reassigning a departing contact's twelve cases in one
action is a convenience that depends on the single-case path existing first.

### Indexes — including the one the success criteria promise

```ts
}, (table) => ({
  // THE queue query: every open case across ALL tenants, oldest first. The one
  // query shape with no org predicate to narrow it, so it is also the only one
  // that scans. Partial, because the queue never asks about closed cases —
  // which are most of the table within a month.
  queueIdx: index('support_case_queue_idx')
    .on(table.createdAt)
    .where(sql`status IN ('open', 'awaiting_support') AND deleted_at IS NULL`),
  // A tenant listing its own cases.
  orgStatusIdx: index('support_case_org_status_idx').on(table.orgId, table.status),
  // "What am I on the hook for" for one engineer.
  assigneeIdx: index('support_case_assigned_idx')
    .on(table.assignedTo, table.status)
    .where(sql`assigned_to IS NOT NULL`),
  // "my cases" for a tenant contact — the list a contact opens by default, and
  // the lookup that finds a departing contact's open cases to reassign.
  tenantContactIdx: index('support_case_tenant_contact_idx')
    .on(table.tenantContact, table.status)
    .where(sql`tenant_contact IS NOT NULL`),
  // Case identity, reached from a message.
  threadIdx: uniqueIndex('support_case_thread_uq').on(table.threadId),
  // The customer-quotable number must be unique per org, enforced not assumed.
  displayUq: uniqueIndex('support_case_org_number_uq')
    .on(table.orgId, table.displayNumber)
    .where(sql`deleted_at IS NULL`),
}));
```

The partial `queueIdx` follows the precedent already in `messages`
(`message_purge_idx` is partial on `deleted_at IS NOT NULL`), so this is the
house pattern rather than a new idea.

### The display-number counter

A per-org sequence needs somewhere to count. Postgres sequences are global and
cannot be per-org without one sequence per tenant, so:

`support_case_counters` — `org_id varchar(255)` primary key,
`next_number integer not null default 1`.

Allocate inside the same transaction as the case insert, with
`UPDATE … SET next_number = next_number + 1 RETURNING next_number` so the row
lock serialises concurrent opens in one org. **`support_case_org_number_uq` is
the backstop, not the mechanism** — if the counter is ever bypassed the insert
fails rather than issuing two cases the same number, which matters because that
number is the one thing customers quote back.

### One-time incidents — a consumable balance, BUILT

`subscription.supportIncidentBalance` (billing), with
`api/billing/src/helpers/support-incidents.ts` for grant / consume / refund /
read. 15 tests.

**Why not a quota.** The obvious implementation is wrong, and the reason is
worth keeping: every entry in `VALID_QUOTA_TYPES` is a per-period FLOW counter
reset on `QUOTA_RESET_DAYS` (default **3**), so an incident modelled as a quota
would be re-granted every three days — unlimited incidents sold as one. And
`supportContacts`, like `seats`, is a LIMIT that nothing decrements. Neither
expresses "a stock spent once", so this mirrors `creditBalanceCents`.

**A second door into the case product.** Opening a case normally needs a
designated contact, and `supportContacts` is 0 on every tier — so an org with no
add-on cannot open one. An incident bypasses that on purpose: it serves the
customer who needs a single answer and holds no subscription. The case-open
check is therefore **"has a contact seat OR can spend an incident"**, which
Phase 2 must implement as a disjunction rather than a contact check with an
exception bolted on.

**Consume is atomic by construction.** The `supportIncidentBalance: { $gte: 1 }`
precondition lives in the `findOneAndUpdate` FILTER, not in a prior read: two
concurrent case opens against a balance of 1 cannot both succeed. Read-then-write
would hand out a free case per race. The schema's `min: 0` is a backstop, not
the mechanism.

**Refund is deliberately separate from grant**, though the arithmetic is
identical — a concession and a "this was a duplicate" are different events and
want different audit actions. Collapsing them makes "how many incidents did we
give away" unanswerable.

**DECIDED: a concession instrument, not a SKU.** Incidents are granted, never
sold. The decision came out of trying to price one and finding the viable window
is empty:

- Monthly support **cancels freely** — `cancelAtPeriodEnd`, with no minimum term
  anywhere in billing. So an incident priced above a month of Standard ($19.99,
  unlimited cases) is **economically dominated**: a rational buyer subscribes for
  one month and cancels.
- Priced below $19.99 it **loses money on every use**, since one human reply is
  $15-40 of loaded engineer time and there is no subscription revenue to
  amortise against.

So the use is goodwill after an outage, a trial for a prospect evaluating
support, or a make-good for a missed response target — which is also what the
"coupon for a one-time incident" framing was actually reaching for.

A sellable per-incident SKU would need BOTH a one-off charge path (billing has
no invoice-item or one-off concept; bundles bill as recurring line items) AND a
reason not to be dominated — a minimum term on monthly support, or a service
level no tier offers. Neither is in scope.

**The grant/consume ROUTES are deferred to Phase 2** for two reasons: a billing
route is a five-contract change (route-table snapshot via
`compareRouteTableSnapshot`, a declared audit action, a permission gate, the
permission contract, route-permissions), and until the case-open path exists a
grant route would hand out incidents nothing can spend.

### Where the entitlement decision lives — SETTLED by measurement

The plan implicitly assumed cases ride the message service, which owns the
thread. The paywall cannot. Measured:

- **`supportContacts` is not a `QuotaType`** — absent from `VALID_QUOTA_TYPES`
  like `seats`, because it is a live cap compared against current usage, not a
  period counter. So `quotaService.check()` cannot answer it.
- **The effective limit is tier base + bundles**, which only billing computes —
  but billing already syncs it onto the root org's `quotas`, exactly as it syncs
  `seats`. That sync now carries `supportContacts` on the same leg.
- **`api/message` has no outbound client to any service.** Verified: zero
  service-to-service calls in it.

So **platform owns the decision**, in `platform/src/helpers/support-entitlement.ts`,
mirroring `seats.ts`: read the root's synced limit and feature flags, count live
contacts across the subtree, compare. Nothing cross-service on the hot path.

Two rules it encodes, both load-bearing:

- **A level flag with no allowance, or an allowance with no level, grants
  nothing.** The flag says WHAT response was bought; the allowance says HOW MANY
  people may invoke it. Granting on either alone hands out support nobody paid
  for, or a target nobody is entitled to claim. A half-synced account is a
  denial, not a guess.
- **`canOpenCase` is `used > 0`, not "within the cap".** An account AT its cap
  can still open cases — it just cannot nominate anybody else. Conflating the two
  would lock a fully-subscribed account out of support entirely.

**Consequence for Phase 2:** the case-open route belongs in platform, or the
message service gains its first outbound internal client (`GET
/internal/organization/:id/support-entitlement`). Either way the check cannot
live in the message service alone.

**Degraded mode, which needs deciding with it:** if that entitlement read is
unavailable, the support SEND should still work while NO case record and NO
response target are created. Fail-closed on the promise, fail-open on
reachability — refusing to accept a support message because the platform is
unreachable is wrong precisely when it matters, and the B3 carve-out already
requires an always-available channel.

### Org deletion — the cascade, which a ratchet caught

A schema-reflection test requires every Postgres table with an `org_id` to be in
platform's org-delete cascade, or it "orphans on org purge + is missing from the
GDPR export". All four support tables are now registered:

- `support_cases` **soft**-deletes — it carries `deleted_at` + `purge_after`, so
  it rides the retention sweep like any other tenant record.
- `support_contacts`, `support_case_counters`, `support_case_notes` **hard**-delete.

The notes are the reason to care. They are the one support table a tenant can
never read, so leaving them behind would orphan vendor-authored commentary about
a customer who has exercised their right to be deleted — and the GDPR export
would miss them too. The counter is dropped rather than preserved so a recreated
org restarts at case 1 instead of inheriting a stranger's sequence.

### `support_contacts`

The contact designation the pricing model bills for.

| Column | Type | Notes |
|---|---|---|
| `org_id` | `varchar(255)` not null | |
| `user_id` | `text` not null | Must be a member of the org or its subtree (open question) |
| `designated_by` / `_at` | `text` / `timestamp tz` | Who nominated them — audit-worthy |

`uniqueIndex('support_contact_org_user_uq').on(orgId, userId)`. The **count** is
capped against effective `supportContacts` at designation time, in the shape
seats are capped at invite time. Scope C4's lifecycle questions (holder leaves,
is deactivated, moves team) resolve against this table.

### Internal notes

Phase 0 decides flag-on-`messages` versus separate table. The data model
argues for **separate** (`support_case_notes`): a flag on `messages` means every
read path that forgets the predicate leaks an internal note to the tenant, and
the visibility predicate at
`packages/pipeline-data/src/api/query-builders.ts:293` is shared by every
message query. A separate table cannot leak by omission — it has to be joined
deliberately. That is the same reasoning scope C3 applies to case visibility.

---

## Sequencing


The document above is a gap list, not a build order. This is the order, and it
is forced by the dependency chain rather than chosen: **no threading → no case
identity → no case number → nothing for CSAT, export or audit to key on.**

### Phase 0 — decide (no code)

Decisions that are expensive to retrofit. None is a large piece of work; all
are hard to change later.

**Decided — carry into the build, do not re-litigate:**

- ~~**B3** — what happens to the free path.~~ **Support is an add-on on every
  tier, included in none.** The free path closes, with no grandfathering.
- ~~**D-a vs D-b** — derived from seats, or named contacts?~~ **Contacts.**
  Settled by the $19.99 price point, which is indefensible across all seats and
  correct per contact (see Pricing).

**Still open, and blocking:**

1. **The unpaid carve-out** — the route by which a security report, a billing
   dispute or an account lockout reaches us from an org with no add-on. Raised
   by B3's decision; shipping the paywall without it is the genuinely risky
   version of that decision.
2. **Internal notes** — flag on `messages`, or a separate table.
3. **`support_cases` table vs workflow columns on `messages`** (recommended:
   the table).
4. **Case-level visibility inside the tenant org** (scope C3) — org-wide
   as today, or contacts-plus-author? This is a column decision, so it belongs
   here rather than in Phase 2: retrofitting a narrower visibility onto cases
   that were already readable org-wide does not un-read them.
5. **Stand up the 24×7 rota.** *(DECIDED: premium's hours are 24×7. The
   alternative — revising premium to a business-hours target — was considered
   and rejected, so this is now a prerequisite to deliver, not a question to
   answer.)*

   It remains the only item that cannot be closed by writing code, and it is
   worth being plain about the gap it has to close: the promise is **stricter
   than the platform's own posture**. Its 175 `severity: critical` alert rules
   route to a Slack receiver (`critical-slack`) on a `repeat_interval: 4h`, and
   there is **no pager integration anywhere in the repo** — no PagerDuty,
   Opsgenie, VictorOps or xMatters. So a one-hour 24×7 commitment to a customer
   would be answered faster than the platform answers its own outage.

   Two things therefore gate SELLING premium, neither of them code:
   - a rota with real overnight coverage and an escalation path, and
   - a pager for the platform's own criticals, since support cannot credibly be
     the only thing awake.

   `SUPPORT_PREMIUM_ENABLED=false` withholds the SKU until both exist, which is
   why the catalog ships complete rather than being edited twice.

Also B1's reconciliation — now a known deletion rather than a judgement call,
since no tier includes support — and the "business hours" definition. Both are
writing, not engineering, and both must land with the paywall.

### Phase 1 — case identity

Thread the support path, introduce the case record, and **land the inbox change
in the same release**. This is a single phase precisely because splitting it
breaks things: adding `threadId` to support sends without a thread-grouping
inbox makes existing support messages vanish from a list that filters
`threadId: null`.

Includes the migration (below) and the per-org display number.

### Phase 2 — make it usable on both sides

- B4's reply carve-out — without it, openers still cannot answer.
- Status and close, tenant and staff.
- Tier/add-on shown on the case, so triage can see who is paying.
- A tenant case view.
- **Ownership on both sides** — `assigned_to` (staff take / hand over /
  release) and `tenant_contact` (contact handover), with their two audit
  actions. **Moved up from Phase 4**: without a staff owner two engineers
  answer the same case, and without a tenant owner a departing contact strands
  their open cases, which the contact model makes likely rather than rare.

### Phase 2b — measure first response (NEW — pulled out of Phase 4)

First-response timestamp per case, the ageing metric over it, and the
**awaiting-customer state that suspends the clock**. The third is not optional
with the other two: without it the metric counts the tenant's silence as our
delay, and reports a number no customer will accept (scope C1).

**This moved because the pricing model moved.** When the SKU was "standard vs
premium", measurement was an operational nicety. Now that the thing being sold
IS a response time, shipping the SKU without the measurement means the first
customer dispute is unanswerable. Phase 3 is gated on this.

### Phase 3 — sell it

Three per-contact bundles, the combo, the entitlement gate, published response
targets — **and the quantity decision from the Pricing section.**

Concretely, beyond the catalog entries:

1. **Mutual exclusion** among the three levels, in `effectiveEntitlements`
   (there is no such mechanism today — see Pricing).
2. **The `supportContacts` quota field** — interface, six tier presets at base
   0, the `QUOTA_TIER_*` env override, the quota-admin editor presets,
   `UsageCard` and `entitlement-sync`; plus designation capped against it in
   the seats-at-invite-time shape, including pooled-subtree counting.
3. **`availableForTiers = ALL`** (support sells on every tier), and
   `supportContacts: -1` for `unlimited`. No floor hack: the unit price is the
   floor.
4. **First stackable feature-granting bundle in the catalog.** Every existing
   one is `stackable: false`. The math in `effectiveEntitlements` already
   handles it correctly, but no test covers the combination, so add one.
5. **The env keys, in the same release as their consumers** — all four
   `.env.example` targets plus `docs/environment-variables.md` plus
   `generate:help`. The "no dead vars" ratchet means they cannot land earlier,
   and the parity ratchet means they cannot land in one target only. See the
   environment-variables subsection for the full list and for the
   `SUPPORT_ENABLED` requirement, which is not optional for self-hosted
   deployments.

**Deliberately late.** Every earlier phase improves support for everyone at no
charge; this one decides who pays. Shipping it first would mean selling a
promise the queue cannot yet keep — and now, one it cannot yet measure.

### Phase 4 — operate it

Volume metrics, canned responses, CSAT, case export, and **bulk** ownership
actions. (Ageing and first-response measurement moved up to Phase 2b — they
gate the sale. Single-case assignment moved up to Phase 2 — see there.)

### Relative size, and the two items with external lead time

Not estimates in days — relative weight, so the sequence can be reasoned about.

| Phase | Weight | Dominated by |
|---|---|---|
| 0 — decide | XS | Writing and four decisions. No code |
| 1 — case identity | **L** | Threading + the case record + the inbox change, all in one release because splitting them breaks the inbox |
| 2 — usable both sides | **L** | The case detail view, which does not exist in any form |
| 2b — measure | M | First-response + the pause clock. Small surface, exact arithmetic |
| 3 — sell it | M | Catalog + quota field + provider onboarding + doc/env updates across four targets |
| 4 — operate it | M | Independent pieces, each small, none blocking |

**Two items do not respond to engineering effort and should start first:**

1. **AWS Marketplace listing registration** — external approval, needed before
   Phase 3 can meter anything.
2. **~~The 24×7 rota~~ — DECIDED (2026-10-31): `SUPPORT_PREMIUM_ENABLED=true`.**
   Premium ships enabled, which is a commitment to staff it — and since premium
   was also decided to be a GLOBAL product, that means follow-the-sun coverage
   rather than one overnight shift.

   **The operational gap behind that commitment is unchanged and is now load
   bearing.** There is no pager integration anywhere in the repo; the platform's
   own 175 critical alert rules route to a Slack receiver on a 4h repeat. So the
   alert that warns of an imminent premium breach —
   `SupportPremiumFirstResponseAtRisk`, p90 > 6h against the sold 8 — travels
   through that same unpaged receiver. The thing meant to prevent a breach is
   itself only seen by whoever is watching Slack. **Follow-up: that one alert
   needs a route that actually wakes someone.** Everything else about the
   decision stands; this is the piece that has to exist for the 6h warning to be
   worth having.

   *Original note, retained for the reasoning:* a staffing decision. If the
   answer is "not yet",
   `SUPPORT_PREMIUM_ENABLED=false` ships the catalog complete and withholds
   only the SKU.

Everything else is ordinary work whose order is already fixed by the
dependencies above.

### Explicitly NOT in v1

Deferred rather than excluded — distinct from "Out of scope" below, which is
permanent: CSAT, canned responses, case export, email reply ingress, and
**bulk** staff operations.

**Corrected — single-case assignment is now in v1.** An earlier revision
deferred "assignment" wholesale. Ownership is what makes a response target
accountable to a person, on both sides: unowned staff-side means two engineers
answer the same case, and unowned tenant-side means a departing contact strands
their cases. Only the BULK form stays deferred.

**Corrected — severity re-ranking came back into v1.** An earlier revision
deferred "severity-change-after-open". scope C2 shows why that cannot
hold: the tenant sets severity at open, so deferring staff re-ranking lets the
tenant unilaterally choose the response target they are owed, and at
$99.99/contact for 24×7 coverage that is the whole premium SKU. v1 needs
published severity definitions **and** a staff re-rank path with an audit
action, or premium does not ship.

**Deflection is a v1 candidate, not a Phase 4 one** (scope C5). Cost
to serve is the economics of this add-on, `AskPanel` and `AskHelpTopics`
already exist over a generated help corpus, and routing the case form through
them reduces the volume every price here is covering.

---

## Cross-cutting obligations


This plan described a feature and said nothing about the obligations this repo
puts on one. Several are ENFORCED BY TESTS, so skipping them does not produce a
gap — it produces a red build.

### Audit events — enforced

`frontend/test/audit-action-parity.test.ts` asserts that **every declared audit
action appears in `docs/audit-events.md`**, reading declarations from
`packages/api-core/src/types/remote-audit-actions.ts`. Its own comment records
why: 22 of 164 actions had drifted out of the doc, each having shipped "with
tests, a route-table entry and a permission-contract row — every ratchet except
this one".

A support feature creates audit-worthy events, and the audit trail is
hash-chained, so this is not optional. The v1 set:

| Action | Emitted when |
|---|---|
| `support.case.open` | A contact raises a case |
| `support.case.reply` | Either side adds a message |
| `support.case.status` | Status changes, including close and reopen |
| `support.case.severity` | Staff re-rank a self-selected severity (scope C2) |
| `support.case.assign` | **Staff** owner set, changed or released to unowned |
| `support.case.transfer` | **Tenant** owner handed to another designated contact |
| `support.case.note` | Internal note added — never visible to the tenant |
| `support.case.read` | A system-org actor opens a tenant's case |
| `support.contact.designate` / `.revoke` | A member is made, or unmade, a paid support contact |

Two of these carry more weight than the rest. **`support.case.read`** is the
only record that someone at the vendor looked at a customer's data. And the two
ownership actions are what keep a response target accountable to a person: a
silent change of owner is exactly how accountability for a missed target
disappears, on either side.

Each action needs: the declaration, a row in `docs/audit-events.md`, a
`docs/permission-contract.md` entry, and a route-table entry.

### Docs — partly enforced

- `docs/*.md` feeds generated in-app help through an explicit manifest, with a
  SHA drift test (`npm run generate:help` from `frontend/`). A docs edit that
  is never regenerated fails the build.
- **`docs/billing-bundles.md`** and **`docs/billing-discounts.md`** describe the
  bundle and combo catalogue. Phase 3 changes both and must update them.
- **`docs/permissions.md`** / **`docs/permission-contract.md`** — the B4 reply
  carve-out is a permission change and belongs in both.
- A support topic itself: there is no user-facing documentation of how to raise
  a case, what the severities mean, or what the response targets are. With
  targets stated rather than enforced, **the doc IS the product promise**.

### Pricing surfaces beyond the config

`billing-config.ts` is not the only place pricing appears. Phase 3 must also
cover the plan/pricing UI, the tier feature lists (B1's "Community support"
line lives there), and any marketing copy on the public site.

**Good news, measured: the per-unit quantity UI already exists.**
`frontend/src/components/billing/AddonGrid.tsx` already does everything the
seat axis needs — typed exact-quantity entry (`:61`, deliberately replacing a
±1 stepper), `maxQuantity` clamping with the control disabled at the cap
(`:96`), `volumeTiers` rendering (`:113`), unit × quantity totals labelled
"before discounts" (`:117`), and a fat-finger confirm above a threshold
(`:19`). Per-seat support needs **no new billing UI**. This is the single
largest saving the seat-based model gets for free.

**And with contacts (D-b) it is reusable as-is.** The control is built around a
quantity the *customer* chooses, which is exactly what a contact count is. An
earlier draft of this plan considered deriving the quantity from seats, which
would have made support the first stackable pack needing a **read-only**
quantity box — a small but real frontend change that `AddonGrid` has no concept
of. Choosing contacts removed that work rather than scheduling it.

What is still new frontend work is **designating** the contacts — which
members may open cases, capped against `supportContacts`. That is a members-
page affordance, not a billing one.

### Environment variables — four enforced ratchets, zero plan coverage

Measured: the plan mentioned `.env` **zero** times and "variable" zero times.
This repo has one of its strictest contracts here, in
`test/deploy-contracts/test/env-contract.test.ts`:

1. **Key parity across all four targets** — `declares every key on every
   target, except the declared target-specific ones`. There are four
   `.env.example` files (`local/docker`, `local/minikube`, `aws/eks`,
   `aws/ec2`); a key added to one and not the rest fails, and a stale
   target-specific registration fails too.
2. **Every key documented** — `documents every active key in every template`,
   against `docs/environment-variables.md`, which then regenerates into
   `frontend/src/lib/help/generated/env-variables.ts` under the help SHA drift
   test.
3. **No dead vars** — every declared key must have a consumer in code. So env
   keys cannot be added ahead of the feature; they land **with** it.
4. **`gen-env-secrets.sh` substitutes every required placeholder** — relevant
   only if any support key is a secret.

Plus `app-env-split-contract.test.ts`, whose rule matters for **naming**:
secret detection is **by name**, so a key ending in `PASSWORD`, `SECRET` or
`KEY` goes into `app-secrets` and reaches every application pod. None of the
keys below is a secret, so they belong in the `app-env` ConfigMap — but if the
B3 carve-out ever routes through an authenticated webhook, the credential half
must be named so it lands on the secret side, not embedded in a `..._URL`.

#### Keys this feature needs

**Free from existing patterns** (no new plumbing, but each still needs the
four-target declaration and a doc row):

- `QUOTA_TIER_<TIER>_SUPPORT_CONTACTS` — the `tierLimitEnv` convention
  lowercases to camelCase, so `supportContacts` maps to `SUPPORT_CONTACTS`
  exactly as `eventRetentionDays` maps to `EVENT_RETENTION_DAYS`. Six tiers.
- `BILLING_BUNDLE_SUPPORT_{STANDARD,PRIORITY,PREMIUM}_{MONTHLY,ANNUAL,GRANT,TIERS,VOLUME_TIERS}`
  — the documented bundle-override pattern. `_VOLUME_TIERS` is how the recut
  contact curve gets tuned per deployment without a release.
- `BILLING_COMBO_ASSURED_DELIVERY_{MONTHLY,ANNUAL}`.

**New, and each one is a product decision rather than a knob:**

- **`SUPPORT_ENABLED`** — see below; this is the important one.
- **`SUPPORT_PREMIUM_ENABLED`** — the clean mechanism for the Phase 0 rota
  blocker. It lets the catalog ship complete while the 24×7 SKU stays
  withheld until the rota exists, instead of the ladder being edited twice.
- `SUPPORT_TARGET_STANDARD_HOURS` / `_PRIORITY_HOURS` /
  `SUPPORT_TARGET_PREMIUM_SEV1_MINUTES` — the published targets. These are the
  product promise, so they must not be literals in code.
- `SUPPORT_BUSINESS_HOURS_TZ`, `SUPPORT_BUSINESS_DAYS`, `SUPPORT_HOLIDAYS` —
  without these the "business hours" open question has no implementation, and
  the clock in scope C1 cannot be computed at all.
- `SUPPORT_AUTOCLOSE_AWAITING_DAYS` — gap 1's auto-close.
- `SUPPORT_MAX_ATTACHMENT_BYTES`, `SUPPORT_MAX_ATTACHMENTS_PER_CASE` — the
  attachment-limits open question.
- `SUPPORT_SECURITY_CONTACT`, `SUPPORT_BILLING_CONTACT` — B3's unpaid carve-out
  needs a destination, and the destination is per-deployment.

#### `SUPPORT_ENABLED` is not optional, and the plan never considered it

Two of the four deploy targets are `local/docker` and `local/minikube`, and the
AWS ones are equally self-hostable. **A self-hosted operator has no vendor
support team to open a case with.** Without a deployment-level switch, every
self-hosted install shows a purchasable support add-on that routes nowhere and
promises a response nobody will give.

The precedent is exact: `BILLING_ENABLED` already gates the billing service,
`NavItem.requiresBillingEnabled` already hides a link that would "only dead-end
at a 503", and billing-disabled already forces the `unlimited` tier. Support
needs the same treatment — which also resolves cleanly with B3, because with
support disabled there is no paywall to apply and the free messaging path is
simply what that deployment has.

#### Pre-existing drift in these lists — FIXED, and now guarded

`docs/environment-variables.md:794` enumerates bundle and combo ids in prose,
and all three enumerations were stale when this plan was written:

| | In code | In the doc | Was missing |
|---|---|---|---|
| Bundles | 14 | 12 | `LISTING_PACK`, `STAKEHOLDER_REPORTS` |
| Combos | 6 | 4 | `INSIGHTS_BUNDLE`, `THROUGHPUT_BUNDLE` |
| `_VOLUME_TIERS` users | 4 | 1 | `PLUGIN_PACK`, `API_PACK`, `AI_PACK` |

The cause is worth keeping, because it generalises. The doc-parity ratchet
expands a `<PLACEHOLDER>` family row into a **matcher**, so
`BILLING_BUNDLE_<ID>_MONTHLY` is satisfied by any id at all — correct for key
coverage, and blind to whether the prose names the right ids. Four of fourteen
bundles and two of six combos were undiscoverable from the only document an
operator reads.

**Both are now done**, ahead of the support work rather than alongside it: the
doc is corrected, `generate:help` re-run, and
`test/deploy-contracts/test/env-contract.test.ts` gained a
`billing catalog enumerations are documented` block that derives all three
lists from `billing-config.ts` instead of trusting prose. It was verified by
re-introducing the original drift and confirming all three assertions fail,
then restoring.

So adding three support bundles and the combo now fails the build until the doc
is updated with them — which is the behaviour this plan wanted and did not
have.

### Payment-provider onboarding — both providers, and one has lead time

Adding three bundles means teaching **both** payment providers about them.
Neither is automatic, and in both a miss means the customer holds the
entitlement without being charged.

**AWS Marketplace.** `DEFAULT_BUNDLE_DIMENSION_MAP` must gain
`support_standard`, `support_priority` and `support_premium`. Its own comment
states the stake: *"EVERY sellable bundle must appear here. A bundle missing
from this map — with no env override — is granted to the customer and then
NEVER metered on Marketplace, i.e. given away. `stakeholder_reports` shipped in
exactly that state because nothing checked."* The skip happens at
`aws-marketplace-provider.ts:213`.

`billing-config.test.ts:582` now asserts that map covers the catalog in both
directions, so **the build fails if it is missed** — that half is free. But the
dimensions must also be **registered on the AWS Marketplace listing**, which is
an external action with approval lead time that no test can perform. That is
the only item in this plan that cannot be done the day it is noticed, and it
should start before the code does.

**Stripe.** Three bundles × two intervals = **six immutable Price objects**,
created out of band with
`STRIPE_SECRET_KEY=… node api/billing/scripts/provision-stripe-prices.mjs`
(`--dry-run` previews), then recorded in `STRIPE_PRICE_MAP` as
`<bundleId>_<interval>` → Price id. A **priced** bundle absent from that map
keeps its entitlement and silently drops the line item
(`stripe-provider.ts:277`).

Neither failure is undetectable: both increment a counter behind a `for: 0m`
alert — `billing_stripe_unmapped_bundle_total` and
`billing_marketplace_unmapped_dimension_total`. A free bundle is correctly
exempt (`listing_pack` is $0, and charging nothing is not a leak). So the
runtime defence is good; it is the *work* that was unlisted.

**Combos need no provider object.** Verified: there is no combo-to-dimension
map and no combo price map. A combo is realised as a recurring credit against
its members, so `assured_delivery` adds nothing here. Stated explicitly so
nobody goes looking.

Because `STRIPE_PRICE_MAP` is a runtime env value, this is an operational step
**per deployment**, not a one-time code change — see the environment-variables
subsection above.

### Observability

Phase 4's ageing metrics need somewhere to live. The repo's alert rules are
byte-identical across four deploy targets and guarded by
`prometheus-contract.test.ts` — so a support alert is a four-file change plus
its exclusion-category classification, not a one-file change.

### Adding routes is a three-contract change

Recorded because it is a known trap here: a new platform route needs the route
table, the frontend disposition map, AND the observability router's controller
mocks. Each failure names something unrelated — a missing mock surfaces as
`SECRET_ENCRYPTION_KEY is required`.

---

## Frontend workstream


The plan referred to frontend work in passing (an inbox change in Phase 1, "a
tenant case view" in Phase 2, the `AddonGrid` analysis above) but never
enumerated it as a workstream. Measured against the actual tree:

### What exists — do not rebuild

- **`pages/dashboard/messages.tsx`** (527 lines): a `support` channel filter,
  tabs mapping to distinct server endpoints, read/priority/channel filters,
  deep-link handling and server-side narrowing of the active tab.
- **`ContactSupportCard`** mounted at `pages/dashboard/help.tsx:118`, driving
  `ComposeModal` in support mode.
- **`AddonGrid.tsx`** — the entire per-unit purchase UI (see Pricing).
- **`pages/dashboard/inbox.tsx`** is an action-item aggregator and
  **`triage.tsx`** is BUILD triage. Neither is a support queue; the names
  mislead and both were checked.

**There is no case detail view anywhere.** That is the single largest frontend
gap and the one the whole product rests on.

### The primitives make this much cheaper than it looks

`frontend/src/lib/nav.ts` already has exactly the two gates support needs, and
both carry a documented rationale that applies here unchanged:

- **`requiredFeature`** — "does NOT hide the item. A missing entitlement is
  *this isn't on your plan*, not *you can't see this* … hiding it is how an org
  on a lower tier never learns the product does SSO at all." The item renders
  locked and still routes to the page, which shows its own `FeatureLock`
  upsell, and `navItemLockedFeature` reports which entitlement is missing. This
  is the paid-support gate, already built.
- **`systemOrgOnly`** — hidden, never locked, because "no tenant can ever earn
  access, so there is nothing to discover and a locked row would only advertise
  an internal surface." That reasoning transfers exactly to the staff queue.

And one contract worth knowing before adding a page: **the nav entry IS the
page's read gate.** `src/lib/page-access.ts` derives the route requirement from
the `NavItem` declaration and `useAuthGuard` applies it bare, so a page states
its gate once. `frontend/test/auth-guard-page-gates.test.tsx` then drives the
real hook **once per declared route** — a viewer holding nothing is refused for
exactly the declared requirement, a viewer holding it gets in. So a new support
page is covered by that test automatically, and a wrong declaration fails it.

### Deliverables by phase

**Phase 1** — thread-grouping in `messages.tsx`, landed with the server change
(see the phase note: splitting them makes existing support messages vanish).
Render the per-org case number everywhere a case is named.

**Phase 2** — the case detail view; status and close controls on both sides;
the tier/add-on badge so triage can see who is paying; B4's reply affordance
for openers, which today they do not have; **and both ownership controls**
(moved up from Phase 4 with the rest of assignment):

- **Staff owner picker** — assign, hand over, or **release to unowned**. The
  release path needs an explicit affordance, not an empty selection: "nobody
  owns this" is a deliberate state, and a picker that can only be set traps a
  case on whoever touched it first.
- **Tenant owner picker** — hand the case to another **designated contact**.
  The candidate list is `support_contacts`, *not* the org's members: offering
  every member would let a tenant hand responsibility to someone the org has not
  paid a contact seat for. **Scoped to the case's OWN org**, not the account
  subtree — the allowance pools, ownership does not, so a sibling team's contact
  is never a candidate. Server-side `isSupportContact` must be passed the same
  single org, or the picker is cosmetic.
- **Both show the current owner on the case header**, because an unowned case
  and an unnoticed one look identical otherwise.

`frontend/src/components/ecosystem/EcosystemManagersPanel.tsx` is the pattern
to follow for both: it queries active org members, filters out those already
holding, drives a `@/components/ui/Select`, and grants/revokes through audited
routes. The staff picker is nearly that component with the system-org support
role as its source; the tenant picker is the same shape over a different
candidate list.

**Phase 2b** — an ageing column and sort in the staff queue, first-response
time on the case, and the **awaiting-customer state** that suspends the clock
(scope C1 — the ageing number is wrong without it). This is the UI half
of what gates the sale.

**Phase 3** — `FeatureLock` upsell and the nav `requiredFeature`; the
contact-designation UI (who may open cases, capped against `supportContacts`,
following the seats-at-invite-time shape); pricing-page copy for the
per-contact unit, the volume curve and the combo anchor; **removing support
from every tier's feature list** per B1. `AddonGrid` needs no change at all
under D-b — the read-only-quantity problem went away with D-a.

**Phase 4** — canned responses, CSAT, export, and **bulk** ownership actions.

*(Corrected: this said "assignment" while Sequencing had already moved
single-case assignment to Phase 2 — the same two-places-one-answer drift this
plan's restructure was meant to remove. Only the bulk form is Phase 4.)*

### Two frontend decisions, neither made

**One page or two?** Tenant and staff need *different gates* —
`requiredFeature` versus `systemOrgOnly` — and a `NavItem` declares one gate
for one route. So they cannot be the same nav entry, which pushes toward two
routes (the staff queue possibly `paletteOnly` under an existing section, as
alert views and triage already are). Set `keywords` on both: nobody types
"messages" looking for a support ticket.

**The B3 collision is now resolved.** This previously could not be designed
because the free path's fate was undecided. With support an add-on on every
tier, the tenant page **does** carry `requiredFeature`, and the locked-not-
hidden behaviour is exactly right: an org without the add-on sees the row, sees
it is locked, routes to the page and gets the `FeatureLock` upsell. That is the
whole point of the gate refusing to hide itself — a paywalled support product
that is invisible to non-buyers sells nothing.

One addition from B3's carve-out: the unpaid route for security reports,
billing disputes and lockouts must **not** sit behind `requiredFeature`. If it
is in-app at all it needs its own ungated surface; more likely it belongs
outside the dashboard entirely.

---

## Testing strategy

The repo's convention is that a new invariant arrives with the test that
ratchets it — this plan documents seven such contracts and proposed none of its
own. These are the ratchets support needs, each named with where it goes.

### New ratchets

| Invariant | Where | Why it needs one |
|---|---|---|
| A bundle that is **stackable AND feature-granting** behaves correctly | `api/billing/test/billing-config.test.ts` | Support is the catalog's first. `effectiveEntitlements` already handles it (features union into a `Set` independent of quantity) but nothing covers the combination |
| Response **levels are mutually exclusive** | same | No such mechanism exists today; without the test the invariant is a comment |
| `supportContacts` **cap** holds, including the pooled subtree | platform designation route tests | Mirrors the seat cap at invite time, which is already tested — follow it |
| `SUPPORT_ENABLED=false` yields **no purchasable SKU, no nav row, no case form** | `frontend/test` + billing config | A self-hosted install must not advertise support that routes nowhere |
| Marketplace dimensions cover the three new bundles | already enforced by `billing-config.test.ts:582` | Free — it fails until the map is updated |
| Ageing **excludes** paused time | case service tests | The arithmetic in `awaiting_total_seconds` is the number being sold; an off-by-one here is a billing dispute |
| Every new audit action appears in `docs/audit-events.md` | already enforced by `frontend/test/audit-action-parity.test.ts` | Free — see Cross-cutting obligations |
| New env keys exist on all four targets and are documented | already enforced by `env-contract.test.ts` | Free |
| Any new page's gate matches its nav declaration | already enforced by `auth-guard-page-gates.test.tsx` | Free — it drives the real hook once per declared route |

Five of the nine are already enforced, which is the point: most of the testing
cost here is **not** new test infrastructure, it is remembering that the
existing ratchets will fail until the corresponding work is done.

### Guard against the vacuous pass

Several of the contracts above read source or docs as text. Every one of them in
this repo carries an explicit anti-vacuity assertion — `expect(literal.size)
.toBeGreaterThan(300)`, `expect(bundles.length).toBeGreaterThan(10)`,
`expect(documented('DEFINITELY_NOT_A_REAL_ENV_VAR_XYZ')).toBe(false)` — because
a parser that silently matches nothing turns a drift guard into a no-op. Any new
source-reading test must do the same, and should be verified by **reintroducing
the drift and watching it fail**, as the billing-enumeration guard was.

### Note on running them

Filtered `jest` does **not** run the eslint and typecheck steps the projen
`test` task also spawns, so a green filtered run is not a green package. The
gate is `RUN_MONGO_INTEGRATION=1 nx run-many -t build --all`, and a wrapper's
exit code can hide `Failed tasks:` — grep the output.

---

## Migration — existing support messages


Support messages exist today, unthreaded, in production. Phase 1 must say what
happens to them, and the options are not equivalent:

- **Leave them as-is.** Each becomes a single-message case. Simplest, and
  honest — they genuinely were not threaded.
- **Backfill `threadId = id`** on existing support-channel roots, so they
  become well-formed one-message cases rather than special-cased nulls.
- **Group retroactively** by (org, subject). Appealing and wrong: it invents
  conversations that never happened.

**DECIDED, and it reverses the recommendation above: no migration at all.**

The recommendation was to backfill `threadId = id`. Two things learned while
building make that both unnecessary and harmful:

**It is unnecessary.** `support_cases.thread_id` points at the root
`messages.id` directly, so root messages keep `thread_id = NULL` exactly as the
existing convention has it. Nothing in `messages` needs mutating, and
`findInboxPaginated`'s `threadId: null` filter keeps working untouched — which
also removes the reason Phase 1 had to land the inbox change in the same release
to avoid messages vanishing.

**Backfilling CASES would corrupt the numbers Phase 2b exists to produce.** A
case row defaults to `status: 'open'` with `created_at` taken from the historical
message. Backfill a few hundred and the staff queue instantly shows a few hundred
open cases that have been "waiting" for months, and the first-response histogram
is poisoned by cases that never had a response target to measure against. The
ageing view and every premium-target alert would read as a catastrophic breach on
day one.

There is also no honest value for `level`, which is `NOT NULL` by design: these
messages were sent when support was free, so any level we wrote would assert a
response commitment that was never sold.

**So history stays as plain support messages.** They remain exactly as visible
as they are today — in the support-channel inbox, searchable, with their
attachments — and simply have no case record, because they never were cases.
Only correspondence opened after the cutover gets a case, a number and a clock.

The one consequence to state plainly: the support inbox will contain two kinds
of thing for a while, messages with a case and messages without. That is a
truthful representation of what happened, which the alternative is not.

*(`messages.purgeAfter` would have been a complication for a backfill — some
history is already scheduled for deletion — which is moot now.)*

---

## Success criteria


The plan has none so far, so: a tenant can open a case, see it in a list scoped
to their organization, attach a file, receive a reply, reply back, and close
it — referring to it throughout by a number they can quote. Support can see
every open case across tenants ordered by age, know which are paid, take
ownership of one, and annotate it privately.

Anything short of that is not a support product; it is the messaging that
already exists.

**Added by the per-contact / response-time model**, because these are the
claims the pricing table makes and nothing currently substantiates:

- A case records a **first-response time**, and the ageing view orders by it.
  Without this the response targets are unverifiable by us, not just by the
  customer.
- An org **cannot designate more contacts than it bought**, enforced the way
  invites are enforced against `seats`, and an org with no add-on has **zero**
  and cannot open a case at all.
- Holding two response levels at once is **impossible**, enforced in
  `effectiveEntitlements` rather than only at the purchase route — while any
  number of contacts at one level is fine.
- A security report, a billing dispute and a locked-out user all still reach us
  from an org holding no add-on.
- A case can be **handed over on both sides** — staff to another engineer or
  back to the unowned pool, tenant to another designated contact — with each
  change audited and `created_by` unchanged.
- Removing a designated contact leaves **no orphaned open case**.
- The pricing page states the per-contact unit, the volume curve, **and** that
  the combo discount applies only to its anchor quantity.
- No tier's feature list promises support any more.
- A deployment with `SUPPORT_ENABLED=false` shows **no** support SKU, no locked
  nav row and no case form — because a self-hosted install has no vendor
  support team, and an add-on that routes nowhere is worse than its absence.

## Open questions — NOT decided

Only genuinely undecided items live here. Anything that is *missing but
understood* is in **Scope**; anything sequenced is in the phases. Where a
question has a scope entry, this section cross-references it rather than
restating it — the earlier habit of restating is how the two drifted apart.



**Severity does not fit the existing field.** *(The governance half — who may
set and change it — is scope C2. This is the vocabulary half.)*
`MESSAGE_PRIORITIES` is
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

### Raised by the per-contact / response-time model

**24×7 is a staffing commitment, not a feature flag.** *(No longer an open
question — the hours are confirmed. Kept here because it is still the largest
unpriced cost in the proposal.)* `support_premium` promises support **around
the clock**. The one-hour Sev-1 figure was withdrawn — premium now sells
COVERAGE rather than a faster number — but that does not reduce the staffing
bill at all: 24×7 still needs people awake in enough timezones, an escalation
path, and a pager that does not currently exist for anything. If anything it
sharpens the point, because coverage is now the ONLY thing premium sells, so
failing to provide it fails the entire SKU rather than one of its claims. See
Phase 0 item 5 for what gates selling it.

**Consequence for measurement (REVISED 2026-10-31):** premium now states **8
hours, any day**, which is wall-clock with no business-hours exemption, so the
`support_first_response_seconds` histogram maps straight onto the sold number
and `SupportPremiumFirstResponseAtRisk` is a genuine **breach predictor**. It
fires at p90 > 6h, leaving two hours to act.

Standard and priority are the opposite case: a **business-day** target cannot be
expressed as a wall-clock quantile at all — a priority case raised at 17:01 on a
Friday is not late until Monday evening, about 79 wall-clock hours later — so
`SupportFirstResponseTargetMissed` stays an operational "the queue is not being
worked" guard at 24h and is labelled as such. The contractual check on those two
levels has to run against the business calendar (scope C1), not against this
metric.

**A defect found while setting that threshold.**
`support_first_response_seconds` was registered with api-server's DEFAULT
histogram buckets, which end at **300 seconds**. `histogram_quantile` cannot
interpolate past the last finite boundary, so every observation landed in `+Inf`
and p90 read back as five minutes forever — the 12h premium threshold could
never fire, and the dashboard flat-lined while looking healthy. Nothing errored.
Fixed with a per-metric `HISTOGRAM_BUCKETS` table in
`packages/api-server/src/api/metrics.ts`, with 6h and 8h placed ON boundaries so
the contractual comparison is exact rather than interpolated across a wide
bucket. The same defect was silencing `PluginQueueProcessingSlow` (p95 `> 300`
against a ceiling of exactly 300) and flat-lining the ecosystem
decision-latency panel; both are in the table now.

**"Business hours" — PARTLY DECIDED.** Two business days and next-business-day
still need a timezone, a working week and a holiday calendar, or the clock is
unfalsifiable — and under this pricing the clock **is** the product promise.
The question is now **confined to the lower two levels**: premium's "any day"
has no business calendar in it, which is a second reason to state it that way.

**DECIDED — one platform calendar, defaulting to US Eastern.** Not the tenant's
timezone: with per-tenant zones the same case raised at the same instant has a
different deadline per customer, and the staff queue cannot be ordered by "most
at risk" without computing per-tenant business time for every row. One clock,
one queue ordering, one number to defend. A customer who cannot live with a
business calendar at all is the premium customer, which is a cleaner upsell than
silently running two dozen clocks.

`SUPPORT_BUSINESS_HOURS_TZ` therefore takes a single **IANA zone**, default
`America/New_York`, and every stored timestamp stays UTC — the zone is applied
only when deriving a deadline. The default is the IANA zone and NOT the literal
`EST`, which is a fixed UTC−5 offset: an `EST` default would put the desk an
hour out for the eight months of the year that are EDT. This is the same reason
`ASK_SCHEDULE_TIMEZONE` takes an IANA zone for its cron windows.

**STILL OPEN:** the working week (`_DAYS`, proposed Mon–Fri plus an end-of-day
hour) and the holiday list (`_HOLIDAYS`, proposed an explicit operator-maintained
list of ISO dates, default empty — not a holiday library, which would pull both
a dependency and a policy that cannot be explained to a customer in a dispute).

**AND THE DESIGN THAT MAKES IT CHEAP.** Restating the targets in business DAYS
shrank this scope substantially. "48 business hours" needed an accumulating
within-day clock — pause at 17:00, resume at 09:00, count elapsed working
seconds, handle a case opened at 16:55. "Next business day" needs only a
DEADLINE FUNCTION: given an open timestamp, return the end of the Nth following
working day.

So the implementation is **a `response_due_at` column, computed once at open and
FROZEN onto the case** exactly as `level` is. Three things follow, and together
they are the reason to do it this way:
  - a holiday-list or calendar change after a case opens cannot move a promise
    already made;
  - the staff queue orders by real deadline with no calendar math per row;
  - `SupportFirstResponseTargetMissed` becomes CONTRACTUAL for standard and
    priority instead of the 24h operational guard it is today — which closes the
    measurement gap recorded above, where a wall-clock quantile simply cannot
    express a business-day target.
That one column turns the question from "how do we measure business time" into
"compute one timestamp at open", and makes all three levels measurable the same
way.

**Does the clock run once or on every reply?** First response is what the table
promises and what Phase 2b measures. Whether each subsequent tenant reply
restarts a target is unstated, and it is the difference between a cheap promise
and an expensive one.

**~~May a contact be designated anywhere in the subtree?~~ DECIDED:
subtree-wide for pooling, own-org for ownership.**

The allowance POOLS at the root, like seats: an account buys contacts once and
may spend them anywhere beneath it. But ownership and case access are OWN-ORG: a
team designates its own contacts and reassigns cases only among them.

The two together are the point. Pooling alone would mean a team's case could be
handed to a sibling team's contact, making one team's support cases readable by
another — a pooled *allowance* must not become pooled *data*. Own-org alone
would mean a team could consume account allowance it can never use.

**This also resolves C3's scope.** Case visibility is contacts-plus-author
within the case's own org — not every contact in the account.

Implemented as two distinct fields on `SupportEntitlement`, because the bug this
prevents is subtle: `canOpenCase` was first written off the SUBTREE count, which
would have let any team in a healthy account open cases it then had no
legitimate owner for. Now:

| Field | Scope | Question |
|---|---|---|
| `limit` / `used` / `canDesignate` | **subtree** | is there room under the pooled cap? |
| `ownOrgContacts` / `canOpenCase` | **own org** | is there anyone here who may own this case? |

`listActiveSupportContacts` and `isSupportContact` take an org LIST rather than a
single id on purpose, so the scope choice stays visible at each call site instead
of being hidden in the helper — the picker and transfer validation pass one org,
the cap passes the expanded subtree.

**Does reducing contacts lower the bill mid-period?** Un-designating a contact
and dropping a purchased unit are now two separate acts, which is clearer than
the derived-quantity version — but whether removing a unit credits
immediately, at renewal, or not at all is a provider-proration question that
the existing stackable packs may already answer. Check `seat` before inventing
an answer.

**What happens when the add-on lapses.** Open cases, and read access to closed
ones. Suggestion: existing threads stay readable, no new cases. A product call,
far easier now than retrofitted once customers have history.

**Case lifecycle.** NET-NEW on both sides — there is no status column to build
on. States, who may transition them (tenant, staff, or both), what closes a
case, whether a closed case can reopen, and whether closing is a message in the
thread or a field on it.

**Email reply ingress.** Phone and chat are out of scope, but customers WILL
reply to a notification email — it is the most expected support channel there
is. Today that reply goes nowhere. Either notifications say "do not reply and
here is the link", or an ingress path is built. The first is cheap and must be
decided in Phase 2; the second is a project.

**Case retention and org deletion.** `messages` carries `purgeAfter`, and
org-delete cascade gaps have bitten this repo before. Decide whether a case
outlives the org that raised it (support history has value; customer data has
obligations), and whether `purgeAfter` applies to cases on the same schedule as
ordinary messages.

**Abuse and rate limits.** `sendLimiter` already guards the support route, but
a paid tier changes the calculus: if the free path survives B3, nothing bounds
how many cases a free org opens. Decide whether case creation has its own
budget, separate from the message send limit.

---

## Explicitly out of scope


- SLA enforcement of any kind (decision 2).
- Any support read-path into tenant resources (decision 3).
- Phone or chat channels. Cases are message threads.
- **Service credits** for a missed response target. The target is a commitment
  we measure, not one we indemnify.
## Changelog

Kept because several entries record a **measurement error**, not a change of
mind, and the corrections are worth more than the conclusions. Earlier
revisions carried these in section titles ("second pass", "work the plan had
ignored", "was missing, now enumerated"), which made the document narrate its
own editing history instead of the product.

**Restructure.** The four separate "what is missing" homes — gap matrix,
capability gaps, third-pass gaps, open questions — are merged into **Scope**.
Six topics (severity, visibility, assignment, ageing, reopen, the response
clock) had been spread across three or four of them and had already drifted
apart: severity re-ranking was simultaneously "deferred out of v1" and
"required before premium ships". Sequencing lives in the phases; genuinely
undecided items stay in Open questions.

**Pricing, twice.** First drafted as a flat per-org add-on. Then per **seat** at
$2.99 / $7.99 / $14.99 — too low for five separate reasons, the worst being
that the anchor was AWS's per-account *floors* divided by a seat count, which is
a category error. Raising the base to $19.99 then exposed that **seats is the
wrong unit entirely**: case volume does not scale with seats, so a 100-seat org
would have paid 54% of its plan for standard support. Now per **support
contact**. The price point and the quantity unit were listed as independent
decisions; they were not — choosing $19.99 chose contacts.

**Premium stays 24×7 — and now states a number (REVISED 2026-10-31).** A
business-hours revision (48 / 24 / 4 business hours) was recommended on the
grounds that the platform has no pager and routes its own criticals to Slack
with a 4h repeat, making the support promise stricter than the operational
posture behind it. That recommendation was rejected: the hours are 24×7, so the
rota moves from "decide whether" to "deliver before selling", and
`SUPPORT_PREMIUM_ENABLED` is the switch that keeps the catalog shippable
meanwhile.

Withdrawing premium's response NUMBER along with the Sev-1 target went one step
too far, though, and a later pricing review caught it: it left the most
expensive rung as the only one with nothing measurable, so the ladder went blank
on the one axis a buyer compares. Premium now states **8 hours, any day** — an
hour-scale figure that still needs no pager, because eight hours is not an
on-call page, and it is strictly better than priority on every day of the week
rather than only at weekends. The rota prerequisite is unchanged.

**B3 decided.** Support is an add-on on every tier, included in none; the free
path closes with no grandfathering. This surfaced a required carve-out the
earlier draft had no reason to consider: security reports, billing disputes and
account lockouts must still reach us from an org holding no add-on.

**A false claim, corrected.** An early revision asserted "zero support surfaces
exist", from a grep of `frontend/src/pages` — **a directory that does not
exist**. Pages live at `frontend/pages`; `ContactSupportCard` was mounted the
whole time at `pages/dashboard/help.tsx:118`, and `messages.tsx` already had a
`support` channel filter. The search returned nothing because the path was
wrong, not because nothing was there.

**Decision 2 amended.** Originally "targets are stated, not enforced — no SLA
metrics". Selling response time made measurement a precondition of the sale, so
it is now "measured, not indemnified": we always know whether we hit the
target, and owe nothing when we miss.

**Three cross-cutting areas were missing outright** and are now sections:
docs/audit obligations, the frontend workstream, and environment variables —
the last of which the plan had mentioned zero times despite four `.env.example`
targets under four enforced ratchets.

**Fixed in passing, outside this plan's scope.**
`docs/environment-variables.md` enumerated billing bundle and combo ids in
prose, and all three enumerations were stale: the bundle list was missing
`LISTING_PACK` and `STAKEHOLDER_REPORTS`, the combo list was missing
`INSIGHTS_BUNDLE` and `THROUGHPUT_BUNDLE`, and the `_VOLUME_TIERS` note credited
only `SEAT` when three capacity packs use it too. The doc-parity ratchet expands
`<PLACEHOLDER>` rows into matchers, so `BILLING_BUNDLE_<ID>_MONTHLY` was
satisfied by any id and the prose was unguarded. Corrected, `generate:help`
re-run, and `env-contract.test.ts` gained a block deriving all three lists from
the catalog — verified by reintroducing the drift and confirming failure.

### Revision, 2026-10-31 — pricing review of the ladder

A review of the three levels from a purely pricing standpoint found that the
**priority-to-premium step did not justify itself**, and that the cause was the
claims rather than the numbers. Six findings, all now applied; the prices are
unchanged.

1. **Premium was the only level with no stated target.** Paying 2× bought a
   wider coverage window and *less* commitment, so the ladder went blank on the
   one axis a buyer compares, exactly where the price doubled. Premium now
   states **8 hours, any day**.
2. **The business-hours unit flattered every target by about three times.** "48
   business hours" reads as two days and means six working days — a Friday
   evening case was not late until the *following Monday*. Restated in business
   days, and in hours only where the clock genuinely does not stop.
3. **Premium beat priority on roughly two days in seven.** If both implied ~24
   hours, they were identical Tuesday to Wednesday and premium was charging 2×
   for weekends. At 8 hours it is better *every* day.
4. **Differentiation was on one axis only.** `urgent` severity is now admitted
   at premium alone, which makes the top rung a capability rather than only a
   faster clock. A lower level asking for urgent is downgraded to high and told,
   never refused — and the downgrade is counted, as the most direct read on
   premium's unmet demand the system can produce. This also closed a gap that
   would have made the capability unsellable: `priority` was hardcoded to
   `'normal'` in `ComposeModal` and **no severity control existed anywhere**, so
   premium would have been sold something the product never offered.
5. **The volume curve was identical on all three levels, leaking margin at the
   top.** Same percentage, five times the money: a uniform −30% at 20 contacts
   gave away $600/mo on the level whose case volume the seven-day rota absorbs.
   Now standard keeps the full curve, priority caps at −20%, premium at −10%,
   which also bounds the annual stack (uncapped it reached 41.7% below monthly
   list).
6. **~~A one-contact premium is $99.99 for 24×7.~~ DECIDED: minimum stays 1.**
   A 2-contact floor was considered and rejected, and the deciding reason is
   better than the one originally offered: **support sells on every tier,
   including developer**, and a developer-tier org is exactly the one-person
   outfit that might genuinely want 24×7. A floor would price premium out of the
   tier most likely to be a single on-call person.
   Two supporting reasons. On a per-CONTACT unit a minimum is a phantom charge —
   "you must nominate two people" means paying for a contact nobody uses, which
   is the per-seat-shaped charge the contact unit was chosen to avoid. And the
   underfunded-rota problem a floor was meant to solve is a PORTFOLIO problem,
   not a per-customer one: the 24×7 rota is a fixed cost that exists the moment
   there is one premium customer, so the lever is `SUPPORT_PREMIUM_ENABLED=false`
   until premium demand funds it — which already exists. If the mix later turns
   out to be dominated by one-contact accounts, the unit PRICE is the lever, with
   evidence from `support_cases_total{action="severity_downgraded"}` and attach
   by contact count. No `minQuantity` field is needed on `BundleConfig`.

7. **A SECOND LEVEL WAS PURCHASABLE, and it silently overcharged.** Found while
   answering "how would 99 standard + 1 premium apply?". The levels are mutually
   exclusive and `effectiveEntitlements` resolves a double hold to the highest
   by `continue`-ing past the losers — which discards the loser's
   `supportContacts` GRANT as well as its feature flag. The purchase route had no
   conflict check, despite the comment in `entitlements.ts` saying it "should
   reject acquiring a second level up front". So that basket charged
   $2,079/mo and granted ONE contact. Now refused by
   `supportLevelConflictError` on both the preview and the real add, in both
   directions, while a quantity increase on the level already held still passes.

   The question also exposed a framing worth recording: **a 100-seat org does not
   need 100 support contacts.** A contact is a named person authorised to file
   cases (the AWS/Azure/GCP model) — typically 2–5 people regardless of
   headcount, which is the whole reason the unit is contacts and not seats. The
   answer to that scenario is "buy 1–2 premium contacts", not "buy 100 of
   something".

   **Per-contact LEVELS** — 99 people on business hours, the on-call lead on
   24×7 — is a legitimate shape and is NOT built. It is a model change rather
   than config: `level` moves from an account fact to a per-contact fact, so
   `supportContacts` can no longer be one undifferentiated pool,
   `supportEntitlement` returns a level per contact, and designation picks a
   level per person. The case side is nearly ready (it already freezes `level` at
   open, which would become the opening contact's level). Deferred pending the
   demand signal.

**Found while setting the new threshold:** `support_first_response_seconds` was
on api-server's default histogram buckets, which end at 300 seconds, so every
support response alert was unfireable and the p90 panel read five minutes
forever. See the measurement note above — the same defect was silencing
`PluginQueueProcessingSlow` and flat-lining the ecosystem decision-latency
panel.

**Two of the new pricing tests were wrong on first write**, and the config was
right: "premium's absolute give-away is below standard's" is unachievable
without a cap under ~4% (a percentage off a 5× unit price is 5× the money), and
"no level stacks past a third off" is false for standard by design. Both were
restated against what the change actually achieves rather than relaxed.

### Revision 2, 2026-10-31 — premium becomes an UPGRADE, plus a size floor

The mutually-exclusive ladder could not express the commonest large-org shape:
*"ninety-nine people get business hours, the one carrying the pager gets 24×7."*
Buying `99 × standard + 1 × premium` charged for a hundred units and granted
**one** contact, because `effectiveEntitlements` resolves a double hold by
`continue`-ing past the loser — discarding its `supportContacts` grant along
with its feature flag. Premium is now an upgrade instead of a third level.

#### The model

| | unit | grants | price |
|---|---|---|---|
| `support_standard` | per contact | `supportContacts: 1` | $19.99 |
| `support_priority` | per contact | `supportContacts: 1` | $49.99 |
| `support_premium` | per **upgraded** contact | `supportPremiumContacts: 1` | $99.99 |

- The two **baselines** stay mutually exclusive, enforced at purchase
  (`supportLevelConflictError`) as well as in the entitlement math.
- **Premium requires a baseline** via a new `requiresAnyOf` field — an OR, where
  `requires` is an AND. The alternative, a `support_baseline` *feature flag*
  invented purely to be required, would have put a capability that does not
  exist into every support customer's entitlement list.
- An org holds **N contacts and upgrades M of them, M ≤ N**.
- Dropping the **last** baseline cascades the upgrade out; swapping standard for
  priority does **not**, because the other alternative still satisfies the OR.

**ADDITIVE pricing, decided deliberately.** An upgraded contact costs
$19.99 + $99.99 = **$119.98** (or $149.98 on a priority baseline). The upgrade
was *not* repriced to $79.99 as a delta, for three reasons: that contact is
served during business hours through the baseline *and* overnight through the
upgrade, so a delta would pretend the baseline were free; margin belongs at the
top, where the buyer is least price-sensitive; and a list price is far easier to
concede down from than to raise. It also strengthens the step that prompted the
first revision — effective per contact is now 1 / 2.5 / **6**.

The cost: $99.99 was anchored on AWS Business Support's $100 floor and $119.98
loses that comparison. Accepted — AWS Business is per-account and partly
spend-based, so the comparison was always loose.

**`level` is no longer "the best flag held".** Premium is excluded from
`BASELINE_PRECEDENCE`, because resolving it as the best level would make every
contact of a one-upgrade account look premium. The entitlement now reports the
baseline `level` *and* `premium`/`premiumLimit` separately, and a case freezes
the **opening contact's** effective level.

**Minimum quantity stays 1** (see revision 1, item 6) — support sells on every
tier including developer, and a developer-tier org is exactly the one-person
outfit that might genuinely want 24×7.

#### The size gap this exposed, and the floor that closes it

Per-contact pricing assumes contacts proxy for case volume. At 10 seats they do;
at 100 they do not — three named contacts become an internal help desk
**forwarding** tickets, so they price the *interface* rather than the *load*. A
100-person org buying 3 contacts + 1 upgrade pays $159.96 and generates a
100-person org's case volume.

Three mechanisms, in build order:

1. **Case allowance — 5 cases per baseline contact per rolling 30 days.**
   Deliberately NOT a quota-service type: `QUOTA_RESET_DAYS=3` makes every
   tracked quota a 3-day period, and 5/month does not divide into it (you would
   be forced to ~10/month, too loose, or ~20, useless). The `support_case` table
   IS the counter — one windowed count, no period mismatch, nothing to drift.
   Sized between typical usage (0.5–2 per contact per month) and the router
   pattern (3–10). **Soft always:** warn, flag, surface in the queue; never
   block, because "we have stopped answering you" is not a sendable message.

2. **~~Out-of-hours sub-allowance.~~ DROPPED — premium is a GLOBAL product
   (decided 2026-10-31).**

   The proposal was 2 per upgraded contact per rolling 30 days, on the grounds
   that a 3am case costs ~2× a daytime one. The review that killed it: one
   platform calendar is right for DEADLINES and wrong for out-of-hours
   ACCOUNTING — a Tokyo customer's entire working day is out-of-hours on
   `America/New_York`, so 2 cases/month would be consumed by ordinary daytime
   tickets in week one, and premium would be unsellable across APAC.

   The decision is that premium IS global, and the consequence is bigger than
   the number: **"out of hours" is only a cost category while nobody is
   rostered at that hour.** A global premium product means FOLLOW-THE-SUN
   coverage, and once someone is always on shift a 3am-Eastern case is simply
   somebody's normal working day. There is no differential left to cap, and a
   sub-allowance would tax customers for a cost no longer incurred. Premium's
   higher cost stays priced where it already is: $99.99 per upgraded contact
   plus the ×2.5 floor weight.

   **This enlarges the staffing prerequisite.** The rota item below says "24×7";
   a global product needs several rotas in different timezones, not one
   overnight shift. `SUPPORT_PREMIUM_ENABLED=false` therefore matters MORE, not
   less — it is the gate that keeps premium unsold until follow-the-sun exists.

   Nothing about the business calendar changes: `America/New_York` stays correct
   for the two baseline levels, which are explicitly business-hours products,
   and premium's `elapsed-hours` measure consults no calendar at all.

3. **Seat ramp — `ceil(max(0, seats − 15) × $4.99)` per month.**

   **Applied as `contacts > 0 ? max(contactsPrice, floor × (1 − volumePct)) : 0`,**
   and both qualifications on that expression are corrections to the first
   draft of this spec, each of which was a real defect:

   - **Gated on holding support at all.** Written as a bare
     `max(contactsPrice, floor)`, an org with NO support contacts has
     `contactsPrice = 0` and would be billed **$425/mo at 100 seats for support
     it never purchased**. The floor is a minimum ON support, not a penalty for
     declining it.
   - **The volume percentage applies to the floor too.** Otherwise the ramp
     silently annihilates the discount: a 100-seat org buying 20 standard
     contacts earns −30% (`20 × $19.99 × 0.7 = $279.86`), the $425 floor
     binds, and the invoice shows a volume credit that nets to exactly nothing.
     A credit shown but not realised is a dispute generator — and volume breaks
     exist to reward scale while the floor TARGETS scale, so they collide
     precisely where both apply. With the discount carried through, 20 contacts
     face `$425 × 0.7 = $297.50`, which still binds and still honours what they
     earned. (Comparing against the pre-discount list price instead is worse: it
     means a large customer can never benefit from the volume tiers at all.)

   | seats | floor | | seats | floor |
   |---|---|---|---|---|
   | 15 | $0 | | 500 | $2,421 |
   | 25 | $50 | | 1,000 | $4,916 |
   | 50 | $175 | | 2,500 | $12,401 |
   | 100 | $425 | | 5,000 | $24,875 |

   **The threshold is 15 because that is enterprise's own seat base.** Seats
   above it can only exist if the account bought seat packs beyond the top tier,
   which is a far better size signal than an arbitrary number — and at exactly
   15 the floor is $0, so the ramp is continuous with no seat at which the price
   jumps. A cliff would have mattered: `seats` pools at the account ROOT, so a
   hard threshold is stepped over by splitting into a second account.

   It binds from about **28 seats** for a 3-contact account
   (`(seats − 15) × 4.99 > 3 × 19.99` ⇒ `seats > 27`), so it reaches mid-size
   customers and not only the 100+ ones. Rounded UP to the nearest dollar.

   A banded alternative (discounting to ~$8k at 2,500 seats) was considered and
   **rejected in favour of the ramp's higher list**, with a per-subscription
   negotiated override instead: the list holds, and a discount is then something
   a person signed for. The override stores the **seat count it was agreed at**,
   not just the price — otherwise a "2,500 seats at $8k" agreement silently
   keeps applying at 10,000 seats, reintroducing the exact failure the floor
   exists to prevent.

   **SYSTEM-ORG MEMBERS ONLY may set the override (decided 2026-10-31).** It
   therefore belongs on billing's ADMIN surface (`admin-subscriptions.ts`,
   behind `requireSystemAdmin`) and NOT on the tenant-facing org routes — a
   negotiated price is a vendor decision, and putting the control anywhere a
   customer's own admin could reach it would make the floor advisory.

**It converts automatically when seats cross the threshold**, provided the floor
reads `effectiveEntitlements(tier, addons, bundles).seats` at pricing time
rather than a stored snapshot — a snapshot goes stale precisely when a seat pack
is added. Buying a pack already triggers that recalculation, so the floor moves
on the same pass, in both directions.

**Four further gaps, from a usage/pricing review of the combined model:**

- **The floor ignores which LEVEL is held.** A 100-seat standard customer and a
  100-seat premium customer both face $425, despite very different cost to
  serve — and the floor BINDS for both, since 3 contacts + 1 upgrade is only
  $159.96. So a premium customer can hold 24×7 at 100 seats for $425. A
  level-weighted floor (×1 / ×1.5 / ×2.5) would price that honestly. NOT
  decided.
- **The out-of-hours allowance is unsellable outside the Americas.** One
  platform calendar is right for DEADLINES and wrong for out-of-hours
  ACCOUNTING: a Tokyo customer's whole working day is out-of-hours on
  `America/New_York`, so 2 cases/month is consumed by ordinary daytime tickets
  in week one. The uncomfortable part is that this is economically CORRECT —
  filing at their 10am really does wake someone at our 9pm — so the allowance
  is not wrong, the product is: premium at 2 out-of-hours cases/month cannot be
  sold in APAC. Either raise the allowance (~5), price a follow-the-sun
  variant, or state plainly that premium is a US-hours product. **The sharpest
  unresolved issue in the model.**
- **Annual × floor is undefined.** Annual is 10× monthly (two months free). Is
  the annual floor 10× or 12× the monthly one? At 12× the annual customer loses
  its discount on the floor portion; at 10× the floor is 17% softer for annual
  and undercuts itself.
- **The case allowance counts cases, but cost is DURATION.** Five key-rotation
  questions and five three-day incidents consume the same allowance, and
  duration is not instrumented at all — only first response is. That is a
  measurement gap before it is a pricing one, and it caps how well any
  allowance can price the load.

**~~No mid-term increase cap.~~ DECIDED: none needed (2026-10-31).** The
concern was a customer growing 100 → 500 seats seeing the floor go $425 →
$2,421, where enterprise agreements normally cap annual uplift. But the growth
is CAUSED BY THEIR OWN SEAT PURCHASE — seats only rise when the account buys a
seat pack — so this is not involuntary uplift and there is nothing to cap: it
is the customer getting what they bought. That also settles the proration
question for this path: the floor change belongs WITH the seat purchase, which
is precisely why the add-on preview has to disclose it before the customer
confirms the pack.

**~~Reopen semantics.~~ DECIDED (2026-10-31): either side may CLOSE; only
system-org members may REOPEN a closed case.**

Two reasons at once, which is why the rule is worth stating rather than just
implementing. Product: `closed` is terminal, and a case that can come back from
it has no end — nothing downstream (ageing, reporting, the response clock) can
treat it as finished. Commercial: it is also the loophole that would let a
tenant recycle ONE case indefinitely instead of opening new ones, which under a
per-contact case allowance is a direct way to avoid the allowance. With this
rule they must open a fresh case, which counts.

`resolved` is deliberately NOT terminal for the tenant. Moving `resolved` →
`open` is the customer saying "that did not fix it", which is the feedback loop
that makes `resolved` mean anything at all and is the entire reason it is a
separate state from `closed`. Taking it away would be bad support, and it is not
the same loophole: every bounce is us having claimed a fix and the customer
rejecting it, which is a signal worth having rather than abuse.

Enforced on the TRANSITION out of a terminal state, not on the target status, so
`closed` → `closed` stays a harmless idempotent no-op. The tenant panel shows
the status control disabled with a line naming who can undo it, rather than
hiding it — "my control stopped working" is otherwise the only information the
customer gets.

**Three open mechanism questions on the floor:**
- The credit machinery cannot express it. Volume and combo discounts are
  recurring *usage credits* and only offset downward; a floor is an **uplift**,
  so it must be an invoice line item or a minimum on the total, never a negative
  credit.
- Mid-period proration: recommended **at renewal**, since a floor is a fair-use
  adjustment rather than a purchase, and a surprise mid-period charge for
  something nobody bought generates disputes.
- The add-on **preview** must show it. That endpoint already computes effective
  limits, so it already knows: *"this seat pack raises your support floor from
  $0 to $50/mo"* before the customer confirms.

#### The business calendar (scope C1), now decided and built

`responseDueAt` in api-core, with `response_due_at` frozen onto the case at
open. One platform calendar, `SUPPORT_BUSINESS_HOURS_TZ` defaulting to the
**IANA zone** `America/New_York` — never the literal `EST`, which is permanently
UTC−5 and would put the desk an hour out for the eight months that are EDT.
Working week and end-of-day hour are config; holidays are an explicit
operator-maintained list rather than a library, because a library pulls a
holiday *policy* that cannot be explained to a customer in a dispute.

Premium's measure is `elapsed-hours` and consults no calendar at all — that
absence IS its 24×7 claim, and it is why premium is the one level a wall-clock
histogram can check directly.

#### Two defects fixed in passing

- **A second support level was purchasable**, and silently overcharged: the
  purchase route had no conflict check despite `entitlements.ts` saying it
  "should reject acquiring a second level up front". 99 standard + 1 premium
  charged $2,079/mo and granted one contact.
- **The prerequisite validator crashed billing at boot** under
  `SUPPORT_ENABLED=false`: premium still declares `requiresAnyOf` on the
  baselines, and the validator checked every bundle rather than every ACTIVE
  one. The pre-existing `requires` loop had the same latent hole and had simply
  never been reached. This is the **second** instance of the shape —
  `assertCombosValid` had already had to learn it for `assured_delivery`.

### Phase 4 — operate it (BUILT, 2026-10-31)

All five items, plus the two frontend decisions the plan left open.

**Bulk ownership.** `PATCH /messages/support/bulk` — take, release or close up to
100 cases at once. One statement rather than a loop, so the write is atomic: a
partial bulk assign leaves the queue in a state nobody chose and the operator
cannot tell which half took. It reports **moved against requested**, because on
a shared queue a stale selection is the normal case — somebody else took or
closed one between the render and the click — and a bare success would hide it.
**One audit row per case, never one for the batch:** a bulk action is a
convenience for the operator and not a reason for the trail to be coarser, since
a dispute is about one case and "it was part of a batch of thirty" is not an
answer. Over-large batches are *refused* rather than clamped, so the caller is
told instead of silently acting on a prefix.

**Case export.** `GET /messages/support/cases/export`, CSV, on `messages:read`
— the same floor as the JSON list it reshapes, and a deliberate departure from
the `logs:export` precedent. That permission was split out of
`observability:read` because reading logs is paged and ephemeral while exporting
them is bulk egress that can carry secrets out of the building; neither applies
to an org's own support metadata, already fully readable one route up. Reshaping
readable data into a file is not a new disclosure. **Metadata only** — case
numbers, status and the target each case was opened against, never message
bodies, because handing over the correspondence is a different and much larger
thing.

**CSAT.** Columns on `support_case` rather than a table (a case has exactly one
rating, so a table buys a join and a uniqueness constraint to enforce what a
column gets free), with `PATCH /messages/support/:id/satisfaction`.

It exists because **first-response latency only measures whether we answered
fast, not whether the answer helped** — a desk can hit every target and be bad
at support, and nothing else in the system would notice. Three decisions worth
keeping:

- **TENANT ONLY.** The one case write staff may not make: `staff: false` is
  passed unconditionally and there is no admin variant, because a
  vendor-settable satisfaction score is not a satisfaction score.
- **Terminal cases only**, enforced in the WHERE clause so no route can forget
  it — rating a case still being worked would judge an answer nobody has
  finished giving. `resolved` counts: we have claimed a fix, so the customer is
  positioned to say whether it was one.
- **Always re-rateable.** Somebody who rates in frustration and returns calmer
  should be able to change it; freezing the first number would make the metric
  measure how people felt at their worst moment rather than what they concluded.
- **Not audited** (waived in `route-coverage.test.ts`): it moves no entitlement,
  ownership or clock, and a 1-to-5 opinion in the central trail is noise in a log
  read for authorization questions.

**Volume metrics.** CSAT is emitted as `support_satisfaction`, a histogram with
one bucket boundary per score (1–5) via the `HISTOGRAM_BUCKETS` table — so
`_sum / _count` is an exact average, with no PromQL arithmetic over five
counter series and no new Grafana datasource. A dashboard panel shows it **by
level**, which is the comparison worth having: the levels are sold on different
promises, so a premium average below the standard one is a specific, actionable
failure. It averages RATED cases only, since counting unrated as neutral is the
standard way a CSAT number becomes useless.

**Canned responses.** `support_canned_responses` plus four routes and an insert
picker in the staff reply box. **System-wide, not per-tenant** — the vendor's
own wording for recurring questions, authored once rather than retyped badly
fifty times — so the table carries no `org_id` and RLS does not apply, which is
exactly why the READ is staff-gated as hard as the writes: there is no tenancy
boundary underneath to fall back on. The picker **inserts and never sends**,
because the value of a canned reply is the part the staff member then changes; a
template that sends itself is a macro, and a macro answering a support case is
how a customer gets a reply to a question they did not ask. Retiring is soft: a
retired template is still the explanation of what a past reply said.

### The two frontend decisions, now made

**One page or two? TWO.** `/dashboard/support` for the tenant,
`/dashboard/admin/support` for the queue. They need different gates and a
`NavItem` declares one gate for one route, and `keywords` are set on both
because nobody types "messages" looking for a support ticket.

**The tenant page carries an entitlement gate, via a new
`NavItem.requiredAnyFeature`** — an OR, because the three levels are mutually
exclusive and naming one would lock the page for a customer who bought another.
Mirrors `requiresAnyOf` on a billing bundle, which exists for the same reason.
**Locked, never hidden:** an org without the add-on sees the row, sees it is
locked, routes to the page and gets the `FeatureLock` upsell — a paywalled
support product invisible to non-buyers sells nothing. The missing flag reported
is the first listed, which is the cheapest route in.

**Messages stays UNGATED beside it**, and the locked page says so out loud:
B3's carve-out requires that security reports, billing disputes and account
lockouts still reach us from an org holding nothing, so the route they travel
must not sit behind an entitlement — and somebody landing on a locked page needs
to know that, or the lock reads as "we will not talk to you".
