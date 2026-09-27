# Stakeholder Reports

Scheduled, manager-facing reports: a saved report runs every week, month or
quarter, **freezes** that period's numbers, waits for the lead to add the context
the data cannot, and then goes out — by email, in-app, Slack or Teams, or as an
expiring link for someone with no account here.

It is a paid add-on (`stakeholder_reports`). The on-demand report dashboards
under **Reports** stay free on every plan; what this sells is *saving*,
*scheduling* and *publishing*.

## Why it is not just "the dashboard, emailed"

Three differences, and each one is the reason a decision in this feature went the
way it did.

**A report is frozen.** The retention sweep purges raw pipeline events by tier, so
last quarter's numbers stop being recomputable once its events are gone. Worse, a
manager who reads "91% success" on Monday and "88%" on Friday stops trusting both
numbers. So a run stores a **snapshot** — the computed sections, not a query — and
that snapshot is what every later read returns.

**A report has a narrative.** The data cannot say "we paused deploys on Tuesday
for the database migration", and without that a dip reads as a problem rather
than a plan. So a run reaches `ready_for_review` and waits: the lead writes the
summary beside the numbers, then publishes. `autoSend` skips the review, and is
off by default.

**A report leaves the platform.** Its audience is managers and stakeholders who
will not be provisioned an account to read a weekly summary. That is why
publishing is a separate permission from authoring, why recipients confirm their
own addresses, and why public links are an administrator's decision.

## Permissions

| Permission | What it allows |
|---|---|
| `reports:read` | See saved reports, their run history and the distribution list. Also the free on-demand dashboards. |
| `reports:author` | Create, edit, schedule, generate and annotate. Composing a report. |
| `reports:share` | **Publish**, and mint the links that let someone without an account read it. |
| `reports:rollup` | A report may cover descendant teams, not just its own org. |
| `org:settings` | Change **who reports may reach** — the org policy below. |

`author` and `share` are split because publishing is a different risk from
writing: a lead can be trusted to build reports without being trusted to mail
them outside the company. The built-in **Team Lead** role carries both, and
deliberately not `reports:rollup` — downward visibility across the org tree is
granted, not inherited.

The policy is on `org:settings` rather than `reports:author` for the same kind of
reason: if a report author could widen the allowed domains or turn on public
links, the policy would only be a suggestion.

## What a report covers

A **template** fixes the section list and the cadence:

| Template | Cadence | For |
|---|---|---|
| Weekly delivery | weekly | What shipped and what broke, for a manager who wants one screen on Monday. |
| Monthly health | monthly | Delivery plus reliability and plugin health, with the month-over-month move. |
| Quarterly review | quarterly | The full picture for a review conversation, including trends. |

Sections come from the same queries the dashboards run, over the same window — so
a manager who compares a report with the dashboard finds the same numbers. A
section whose entitlement the org lacks (the DORA sections need
`advanced_reporting`) renders **locked** and the rest of the report still goes
out; a section that fails to compute says so. Neither silently becomes a zero.

**Periods are cut in the report's own timezone**, chosen when the report is
saved — not the reader's, and not the server's. A weekly report for a team in
Chicago that bucketed in UTC would put Sunday evening's deploys in the wrong
week. Weeks start Monday by default; Sunday is an option.

A period the data cannot support is **refused with the reason**, not truncated: a
report labelled `2026-Q1` that quietly covered only its last 30 days would be
worse than no report, because nobody could tell.

### Data-quality notes

Every snapshot carries the caveats, in the report itself rather than in a runbook:

- **Missing deploy tags.** "No deploys" and "we cannot see your deploys" look
  identical on a chart and mean opposite things. A pipeline that has not
  re-synthed with deploy tags is named as uncounted.
- **Unresolvable lead time.** When no successful deploy carried a resolvable
  commit timestamp, commit-to-deploy time is *unknown*, never a proxy.
- **Small samples.** Below five observations a percentage swings wildly, and the
  footer says to read the counts instead.

A footer states how every number was produced, including the window and the
comparison period. Managers compare reports to dashboards; saying plainly that
both run the same queries is what makes a difference investigable rather than a
reason to distrust both.

## Runs and versions

One run per period. Regenerating produces **version N+1** and points the old row
at it — the previous version stays exactly as its recipients read it. Late events
(the ingest redriving its dead-letter queue hours later) make a corrected report
normal, so this is the supported way to fix one. Publishing is conditional on the
run still being unpublished, so two clicks send one report.

Once published, the summary is **frozen**. Editing it afterwards would make the
delivered version unreconstructable; regenerate instead.

## Recipients

The distribution list belongs to the **organization**, not to a report, so one
unsubscribe is honoured everywhere and one address is reusable across reports.

Adding an address goes through three checks:

1. **Is it a member?** A member address is always admissible and skips
   confirmation — the org has already established that person belongs to it.
2. **Is the domain allowed?** Anything else is measured against the
   administrator's allowed-domain list. An **empty list means members only**, not
   "anyone" — the closed reading is the one that cannot leak a report because
   somebody forgot to configure something.
3. **Does it need approval?** When the org requires it, an external address is
   stored unapproved and nothing is delivered until an administrator approves.

An external address then **confirms by email** before the first delivery, so
typing an address is never enough to make a report arrive at it. The confirmation
is a POST from an explicit button on `/reports/confirm`, not a GET, because a mail
scanner opening every link in an email would otherwise consume the token before
the person clicked it.

The recipient list shows each address's real state — confirmed, awaiting
confirmation, unsubscribed, bouncing — because a list that shows an address but
not that it has never confirmed is how a report silently reaches nobody. Three
bounces stop delivery; one does not, since a single bounce is often an
out-of-office reply or a full mailbox.

## Share links

A read-only link to one published run, for a reader with no account.

- **Off until an administrator turns them on.** An org that never considered
  public links has none.
- The token is 256 bits of CSPRNG output, stored only as a SHA-256 hash. A
  database copy cannot be turned back into working URLs, and the raw token is
  shown **once**, when the link is created.
- It **expires** — 30 days by default, 180 at most — and can be revoked.
- Optional **name redaction** replaces project and pipeline names with stable
  placeholders: internal names leak intent (`project-atlas-migration`) even when
  the numbers are harmless.
- The page sends `noindex`, `Referrer-Policy: no-referrer` and
  `Cache-Control: private, no-store`, and is rate-limited per client address.
- An unknown, revoked, expired or withdrawn link returns **one
  indistinguishable 404**, so a holder of a dead link learns nothing else.
- Link unfurlers and mail scanners (Slack, Microsoft Safe Links, and the rest)
  are served but **not counted**, so a view count means a person read it.

**A delivered copy cannot be recalled.** Revoking a link stops new views of the
link; it does not pull back an email that has already arrived. The publish
confirmation says so before the click, not after.

## Ownership

A definition names an **owner**, and a scheduled run is authorized as that
person — there is no caller to authorize as. Two consequences:

- The **creator** owns it. The API refuses an `ownerId` on create, because
  otherwise anyone with `reports:author` could schedule a report that runs with
  someone else's access.
- Deactivating or removing the owner **pauses** their reports, and the
  organization's administrators are told which ones and what to do. The
  scheduler re-checks the owner on every run as a backstop.

Transfer hands a definition to another active member who holds `reports:author`,
checked against the identity service rather than assumed, and clears the pause.

A paused report always says **why**: the add-on lapsed, the owner lost access, or
the owner lost the permission. "Paused" with no reason is a support ticket.

## Audit trail

Publishing is the moment internal delivery numbers leave the platform, so the
whole outward path is recorded: `reporting.report.published` /
`.republished` (which period, which version, how many recipients),
`.link.created` / `.link.revoked`, `.recipient.added` / `.recipient.removed`,
`.ownership.transfer`, `.policy.update`, `.definition.*` and `.paused`.

Reading a shared report is **logged and counted per link, not audited**. It is an
unauthenticated, externally-triggered event, and anyone holding a URL could
otherwise write unbounded rows into the organization's audit trail — turning a
read into a way to bury the entries that matter.

Tokens never appear in an audit event. An audit row carrying a working credential
would turn read access to the trail into read access to the report.

## Plans

Included in **Enterprise** and **Unlimited**; sold as a $30/month add-on to
**Pro** and **Team**. Not offered on Developer — a single developer has nobody to
report upward to. See [Billing Bundles](billing-bundles.md).

## Related

- [DORA Metrics](dora-metrics.md) — the delivery metrics the DORA sections use,
  and what makes each one measurable.
- [Permissions](permissions.md) — the full catalog and how roles resolve.
- [Notifications](notifications.md) — the delivery channels and how an org
  configures them.
- [Audit Events](audit-events.md) — the action catalog and the integrity model.
