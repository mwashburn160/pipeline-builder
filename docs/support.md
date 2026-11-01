---
layout: default
title: Support
---

<!--
Copyright 2026 Pipeline Builder Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Support

Support cases with a **response target you can hold us to**, raised by named
contacts from inside the dashboard. Three levels, bought per contact, available
on every tier.

## Highlights

- **A named contact, not a shared inbox.** You designate who may raise cases, and
  that entitlement is what you buy — so there is never a question of whether a
  request counts.
- **The target is a number, on a clock you recognise.** Two business days, next
  business day, or eight hours on a clock that does not stop for nights or
  weekends. No level is sold without a stated figure.
- **First response is measured, not estimated.** The clock stops the moment
  support first replies, and the time you spend considering a reply does not count
  against us — or for us.
- **Severity is yours to set at open**, and it decides which target applies.
- **Premium is the 24×7 level**, and the only one whose contacts may declare
  `urgent`.
- **Everything is in the product.** Raise, reply, attach, track and rate a case in
  the dashboard; the case history is a thread you keep.

## Overview

A support case is a message thread with a commitment attached. It carries a
customer-quotable number, the level it was opened under, a severity you chose, and
a `response_due_at` computed when it was raised.

| Level | First-response target | Clock | Urgent severity | Price |
|---|---|---|---|---|
| **Standard Support** | **2 business days** | business hours | — | $19.99 / mo per contact |
| **Priority Support** | **next business day** | business hours | — | $49.99 / mo per contact |
| **Premium Support** (upgrade) | **8 hours, any day** | 24×7 | ✅ | $99.99 / mo per upgraded contact |

Annual is about 10× monthly, rounded like every other price. Volume pricing
applies as contact counts rise. Premium is an **upgrade** to a Standard or
Priority contact rather than a separate level, so it is bought for the specific
people who need round-the-clock cover.

**Support is an add-on at every tier and included in none.** That is deliberate
and it is worth knowing before you plan: an organisation with no support bundle
has no contacts and raises no cases. The one exception is the `unlimited` tier,
which is uncapped.

## How it works

### Contacts are the entitlement

`supportContacts` is a live cap, checked when you **designate** someone rather
than counted per period. Buying three Standard contacts lets three named people
raise cases; designating a fourth is refused until you add capacity.

The allowance is **pooled across your account** — a root organisation and its
teams draw on the same number, so a team does not need its own bundle.

Designating and revoking are both audited, and a revoke records how many open
cases the departing contact left behind. Removing a leaver is never blocked on
their open cases — handing the cases on is better than keeping the person — so the
count makes the handover a recorded fact rather than a later discovery.

Premium is a second, separate cap (`supportPremiumContacts`), because the
question it answers is different: **who was entitled to 24×7 coverage, and when.**
Upgrades and downgrades have their own audit actions for exactly that reason.

### The response clock

`response_due_at` is computed at open, from the level and the severity you chose.

The two baseline levels are read against **one platform business calendar** — a
single IANA timezone (`SUPPORT_BUSINESS_HOURS_TZ`, `America/New_York` by default),
configurable working days, a closing hour and a holiday list. A case raised after
the working day closes starts its clock at the next open day.

**Premium does not use the calendar at all.** "8 hours, any day" is plain
wall-clock, through nights, weekends and holidays. That is the whole of its
coverage claim, and it is the one target with no business-hours exemption.

Targets are stated in the units you experience, and they improve on a single
clock: two business days, then one, then eight hours that never pause. An earlier
ladder was expressed in *business hours*, which flattered the numbers roughly
threefold — 48 business hours is six working days — so the figures above are the
real ones.

### First response is measured

The clock stops when support **first replies**, stamped at that moment rather than
inferred later from message timestamps. A second reply cannot move it.

The reported figure is elapsed time **minus** the time the case spent waiting on
you. A case answered in an hour, where the reply then took four days to come back,
is not a four-day first response — in either direction.

### Severity, and who sets it

You choose severity when you open the case, and it decides which target applies:

| Severity | Set by |
|---|---|
| `normal` (default), `high` | any contact, at open |
| `urgent` | **Premium contacts only** |

Severity is **staff-only to change afterwards**. You pick it at open; after that
it is our record of what was agreed, which is what makes a later conversation
about a missed target a factual one.

### The case lifecycle

| Status | Means |
|---|---|
| `open` | raised, awaiting a first response |
| `awaiting_support` | back with us after your reply |
| `awaiting_customer` | we have replied and are waiting on you — this is the state that pauses the elapsed-time measurement |
| `resolved` | answered; reopenable by replying |
| `closed` | finished |

A case is never silently archived. `resolved` and `closed` are distinct so that
"we believe this is answered" and "this is finished" are different statements.

### Rating a case

When a case is closed you can rate it 1–5 with an optional comment. CSAT is the
one case field staff may not write, and it is deliberately **not** in the audit
trail: your opinion of your own closed case changes no entitlement and no clock,
so it belongs in the record of the case rather than the record of who did what.

### Fair use

A soft allowance of `SUPPORT_CASE_ALLOWANCE_PER_CONTACT` cases per contact per
30-day window, counted against contacts **bought** rather than designated — if you
paid for five, you are entitled to five contacts' worth.

**It never refuses a case.** Crossing it raises a metric and flags the audit row,
and anything beyond that is a conversation. "We have stopped answering you" is not
a sendable message.

## Configuration

Operator-side; see [Environment Variables](environment-variables.md) for the full
table.

| Variable | Default | What it does |
|---|---|---|
| `SUPPORT_ENABLED` | `true` | Withdraws all three levels from the catalog when false. On-call paging requires it. |
| `SUPPORT_PREMIUM_ENABLED` | `true` | Offers the 24×7 level. A deployment with no round-the-clock rota can withhold the SKU while keeping the catalog complete. |
| `SUPPORT_BUSINESS_HOURS_TZ` | `America/New_York` | The single IANA zone the business calendar is read in. |
| `SUPPORT_BUSINESS_HOURS_DAYS` | `1,2,3,4,5` | Working weekdays. |
| `SUPPORT_BUSINESS_HOURS_END_HOUR` | `17` | When a working day closes. |
| `SUPPORT_BUSINESS_HOURS_HOLIDAYS` | — | Non-working dates, `YYYY-MM-DD`. |
| `SUPPORT_CASE_ALLOWANCE_PER_CONTACT` | `5` | Fair-use cases per contact per window; `0` disables the check. |
| `SUPPORT_CASE_ALLOWANCE_WINDOW_DAYS` | `30` | The rolling window it is counted over. |

**Premium's target runs overnight, so pair it with a pager.** `SUPPORT_PREMIUM_ENABLED`
ships on while on-call paging ships off, which means a fresh deployment offers a
24×7 target with nothing rostered against it. That is a reasonable choice for a
vendor already on call elsewhere, and `OnCallCasesBreachingUnpaged` makes it a
visible one. See [On-call Paging](oncall-paging.md).

## What is audited

Metadata only — **no message body ever reaches the audit trail.**

`support.case.open` and `support.case.reply` (staff side only, carrying whether
that reply stopped the clock); the four workflow actions `status`, `severity`,
`assign` and `transfer`, each with both sides of the transition; the contact
entitlement actions `designate`, `revoke`, `upgrade` and `downgrade`; and
`support.case.note` for internal staff notes, which records that a note was
written and its length but never its text.

See [Audit Events](audit-events.md) for the full list.

## Related

- [Billing Add-on Bundles](billing-bundles.md) — the three levels, volume pricing and combos
- [On-call Paging](oncall-paging.md) — how the premium target is defended out of hours
- [Organization Benefits](organization-benefits.md) — tiers, seats and pooled limits
- [Notifications](notifications.md) — how case activity reaches you
