// GENERATED FROM docs/billing-bundles.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: a40d98ca4fe6c68fbf6a98d0ba89e1fb5470620c26c8703061ef847a7ad755b7
// SPDX-License-Identifier: Apache-2.0
import { Package } from 'lucide-react';
import type { HelpTopic } from '../types';

export const billingBundlesTopic: HelpTopic = {
  "icon": Package,
  "id": "billing-bundles",
  "title": "Billing Add-on Bundles",
  "description": "Stackable add-ons that raise pooled caps (seats, pipelines, plugins, storage)",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "<!-- Copyright 2026 Pipeline Builder Contributors SPDX-License-Identifier: Apache-2.0 -->"
        },
        {
          "type": "text",
          "content": "Purchasable packs that stack on top of an account's subscription tier to raise its caps or unlock features — without moving the whole account to a higher tier."
        }
      ]
    },
    {
      "id": "highlights",
      "title": "Highlights",
      "blocks": [
        {
          "type": "list",
          "items": [
            "One governing rule: effective[quota] = tierBase[quota] + Σ(bundle.grant × quantity).",
            "A team that needs a few more seats buys the pack, rather than jumping from Pro to Enterprise.",
            "Caps pool at the account root. The whole org → team subtree draws from one shared pool.",
            "Combos apply automatically the moment their members are present — nothing to buy or redeem — and you always get the combination giving the largest total discount, never a double discount.",
            "Discounts are recurring usage credits, never provider coupons, so the preview shows a negative line and totalCents is already net.",
            "An unlimited baseline stays unlimited. Bundles never shrink a -1.",
            "Two things are deliberately not sold: SSO (a Team-and-up tier feature) and Verified publishing (eligibility only, awarded after review).",
            "Removal can't strand usage. An over-cap guard blocks a removal that would drop a pooled cap below current usage."
          ]
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "The tier sets the baseline; bundles adjust it. This page is the operator and admin reference for what each bundle grants, how the combo discounts work, how caps pool across teams, and the endpoints and environment overrides for managing them."
        },
        {
          "type": "text",
          "content": "Written for org admins and owners buying extra capacity, and for operators configuring the catalog. For the tier baselines bundles build on, see feature tiers; for the org/team model the caps apply to, see Organization Benefits."
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How it works",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Enable — an operator sets BILLING_BUNDLES_ENABLED=true. Self-service purchase is disabled under AWS Marketplace.",
            "Preview — an admin lists bundles (GET /bundles) and previews a change (POST /subscriptions/:id/addons/preview) to confirm the new effective limits before committing.",
            "Purchase — add or change an add-on (POST /subscriptions/:id/addons). Stackable packs can be bought in quantity.",
            "Compute — billing recomputes effective[quota] = tierBase + Σ(grant × quantity) and applies any qualifying combo as a recurring usage credit, using best-combo packing so nothing is discounted twice.",
            "Sync and pool — the effective entitlement is pushed to the enforcing services and pooled at the account root across every team."
          ]
        },
        {
          "type": "text",
          "content": "Where the effective entitlement is synced"
        },
        {
          "type": "table",
          "headers": [
            "What",
            "Goes to",
            "Via"
          ],
          "rows": [
            [
              "The nine tracked quota types",
              "quota service",
              "quota sync"
            ],
            [
              "seats and purchased features (e.g. advanced_reporting)",
              "platform service",
              "PUT /organization/{orgId}/seat-limit"
            ],
            [
              "Effective retention windows",
              "reporting service",
              "PUT /api/reports/retention-sync/{orgId}, writing dora_settings"
            ]
          ]
        },
        {
          "type": "text",
          "content": "All three target the account root. Retention is not one of the nine flow quotas — it reuses the tier-baseline + bundle-grant math but rides its own reporting sync leg."
        },
        {
          "type": "text",
          "content": "What stacking does and does not do"
        },
        {
          "type": "list",
          "items": [
            "Stackable bundles can be purchased in quantity — enter 15 Member Seats for +15 seats, with a volume discount.",
            "An unlimited baseline (-1, e.g. Team and up on dashboards) stays unlimited. Bundles never shrink it.",
            "Feature bundles (Advanced Reporting, Team Usage Analytics, Standard/Advanced Compliance, Stakeholder Reports) add a capability rather than a number, and are not stackable.",
            "Effective limits are pooled at the account root — see pooling."
          ]
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Turn bundles on. BILLING_BUNDLES_ENABLED=true. Bundles are hidden unless set.",
            "Override any economics you need to with the variables below. Every price, grant and eligible-tier list is env-tunable.",
            "Confirm the provider. Under AWS Marketplace, self-service purchase is off and add-on charges are reported as metered usage instead.",
            "Have admins preview before committing. POST /subscriptions/:id/addons/preview returns the new effective limits, so the caps that change are visible in advance."
          ]
        },
        {
          "type": "text",
          "content": "Overrides"
        },
        {
          "type": "table",
          "headers": [
            "Variable",
            "Effect"
          ],
          "rows": [
            [
              "BILLING_BUNDLES_ENABLED=true",
              "Master switch — bundles are hidden unless set"
            ],
            [
              "BILLING_BUNDLE_<ID>_MONTHLY / _ANNUAL",
              "Override a bundle's price (cents)"
            ],
            [
              "BILLING_BUNDLE_<ID>_GRANT",
              "Override the grant amount (single-dimension bundles only)"
            ],
            [
              "BILLING_BUNDLE_<ID>_TIERS",
              "JSON array of tiers allowed to buy the bundle"
            ],
            [
              "BILLING_BUNDLE_SEAT_VOLUME_TIERS",
              "Tune the Member Seat volume-discount thresholds"
            ],
            [
              "BILLING_COMBO_<COMBO>_MONTHLY / _ANNUAL",
              "Override a combo's combined price (cents) — e.g. BILLING_COMBO_ANALYTICS_SUITE_MONTHLY"
            ]
          ]
        },
        {
          "type": "text",
          "content": "<ID> is the bundle id upper-cased: SEAT, PIPELINE_PACK, PLUGIN_PACK, API_PACK, AI_PACK, STORAGE_PACK, LISTING_PACK, RETENTION_PACK, DORA_HISTORY_PACK, ADVANCED_REPORTING, TEAM_USAGE_ANALYTICS, COMPLIANCE_STANDARD, COMPLIANCE_ADVANCED, STAKEHOLDER_REPORTS, SUPPORT_STANDARD, SUPPORT_PRIORITY, SUPPORT_PREMIUM."
        },
        {
          "type": "text",
          "content": "<COMBO> is the combo id upper-cased: ANALYTICS_SUITE, TEAM_GROWTH, COMPLIANCE_SUITE, INSIGHTS_BUNDLE, THROUGHPUT_BUNDLE, SCALE_BUNDLE, ASSURED_DELIVERY."
        },
        {
          "type": "note",
          "content": "AWS Marketplace: when the billing provider is aws-marketplace, self-service bundle purchase is disabled — entitlements flow from Marketplace instead, and add-on charges are reported as metered usage (BatchMeterUsage). The retention packs meter as the RetentionPack / DoraHistoryPack dimensions. Combo credits (and other usage-credit discounts) realize on Marketplace by withholding metered usage when BILLING_METERING_ENABLED is on — see Billing Discounts → AWS Marketplace. See Environment Variables for the full billing configuration."
        }
      ]
    },
    {
      "id": "the-bundles",
      "title": "The bundles",
      "blocks": [
        {
          "type": "text",
          "content": "Prices are the built-in defaults (USD); annual defaults to 10× monthly."
        },
        {
          "type": "table",
          "headers": [
            "Bundle",
            "Grant",
            "Monthly",
            "Annual",
            "Available to",
            "Stackable"
          ],
          "rows": [
            [
              "Member Seat",
              "+1 member seat, +100,000 API calls, +200 AI calls (volume discounts — see below)",
              "$49.99",
              "$499.99",
              "Team, Business, Enterprise",
              "✅"
            ],
            [
              "Pipeline Pack",
              "+5 pipelines and +25 plugin builds / period — both, so the 5:1 ratio the tiers hold survives the purchase",
              "$29.99",
              "$299.99",
              "Team, Business, Enterprise",
              "✅"
            ],
            [
              "Plugin Pack",
              "+10 plugin builds / period",
              "$11.99",
              "$119.99",
              "paid tiers",
              "✅ (volume)"
            ],
            [
              "API Pack",
              "+25,000 API calls / period",
              "$11.99",
              "$119.99",
              "paid tiers",
              "✅ (volume)"
            ],
            [
              "AI Pack",
              "+100 AI calls / period",
              "$11.99",
              "$119.99",
              "paid tiers",
              "✅ (volume)"
            ],
            [
              "Storage Pack",
              "+10 GB registry storage",
              "$19.99",
              "$199.99",
              "all tiers",
              "✅"
            ],
            [
              "Listing Pack",
              "+5 public plugin-ecosystem listings (the listings count quota)",
              "free",
              "free",
              "paid tiers",
              "✅ (max 2)"
            ],
            [
              "Standard Retention Pack",
              "+90 days standard pipeline-event retention",
              "$15",
              "$150",
              "all tiers",
              "✅ (max 7)"
            ],
            [
              "DORA History Pack",
              "+365 days DORA history and +365 days on the per-org report-query window",
              "$30",
              "$300",
              "all tiers",
              "✅ (max 1)"
            ],
            [
              "Advanced Reporting (DORA)",
              "unlocks the advanced_reporting feature",
              "$30",
              "$300",
              "Developer, Pro, Team",
              "❌"
            ],
            [
              "Team Usage Analytics",
              "unlocks the team_usage_analytics feature (per-team usage breakdown across the org → team subtree)",
              "$30",
              "$300",
              "Team, Business",
              "❌"
            ],
            [
              "Standard Compliance",
              "unlocks the compliance_standard feature — a curated CI/CD best-practice rule library (~20 rules)",
              "$29.99",
              "$299.99",
              "Developer, Pro, Team, Business",
              "❌"
            ],
            [
              "Advanced Compliance",
              "unlocks the compliance_advanced feature — curated SOC2 / PCI-DSS / CIS framework libraries — requires Standard Compliance",
              "$99.99",
              "$999.99",
              "Developer, Pro, Team, Business",
              "❌"
            ],
            [
              "Stakeholder Reports",
              "unlocks the stakeholder_reports feature — saved, scheduled manager-facing reports: frozen period snapshots, review-and-publish, email / in-app / Slack / Teams delivery and expiring share links",
              "$30",
              "$300",
              "Pro, Team, Business",
              "❌"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Why the capacity packs are tier-restricted"
        },
        {
          "type": "text",
          "content": "Member Seat and Pipeline Pack are the tier differentiators, so both start at Team — a single-seat Developer or Pro can't cheaply stack them to undercut Team, and must upgrade instead."
        },
        {
          "type": "text",
          "content": "Both grant more than one dimension, for the same reason. Every paid tier holds a fixed ratio that a single-dimension pack would break:"
        },
        {
          "type": "list",
          "items": [
            "the tiers keep plugins at 5× pipelines, so Pipeline Pack grants +5 pipelines, +25 plugins;",
            "the tiers keep 100,000 API calls and 200 AI calls per seat — Pro 1/100k/200, Team 3/300k/600, Business 8/800k/1,600, Enterprise 15/1.5M/3,000 — so Member Seat grants +1 seat, +100,000 API calls, +200 AI calls."
          ]
        },
        {
          "type": "text",
          "content": "Without the capacity, a Team account at 3 seats plus 12 packs reached 15 seats still sharing 300,000 API calls — 20,000 per seat against Enterprise's 100,000 at the same headcount. Restoring that by hand cost $19.99 + 4 API Packs + 2 AI Packs = $91.93 per seat, which is why the seat is priced at $49.99 rather than $19.99: between the ladder's own implied seat prices ($34.00 Team→Business, $92.86 Business→Enterprise), with the volume curve converging on $34.99 at 40+ seats. Upgrading therefore stays better value per seat than stacking packs."
        },
        {
          "type": "text",
          "content": "Neither takes a BILLING_BUNDLE_<ID>_GRANT override — that knob retunes one dimension and has no way to say which on a multi-dimension pack."
        },
        {
          "type": "text",
          "content": "The throughput packs (plugin, API, AI, listing) are not sold on Developer. It is the $0 tier, and any grant worth selling is large next to a free tier's own rate, so a free account could out-buy a paid one on a single dimension for the price of a pack — a conversion leak rather than expansion revenue. Developer's path up is an upgrade. Only Storage Pack remains on every tier, because at +10 GB it cannot cross a tier boundary (Developer's 2 GB + 10 GB is still under Pro's 25 GB)."
        },
        {
          "type": "text",
          "content": "Grants are sized against the cheapest tier that can buy them, at roughly a third of its own cap, and no pack may exceed half a buyer's cap or reach the next tier's — both enforced by api/billing/test/bundle-sizing.test.ts, which also asserts that assembling the next tier out of packs always costs more than the upgrade."
        },
        {
          "type": "text",
          "content": "API Pack tops up a finite API-call cap that every tier has (Team 300k, Business 800k, Enterprise 1.5M per QUOTA_RESET_DAYS window, 3 days by default — not per month; see Organization Benefits: \"Per period\" is not per month). The pack's own +25,000 grant is per the same window, so a pack bought against a monthly reading of the cap delivers ten times what the buyer expected rather than a tenth."
        },
        {
          "type": "text",
          "content": "Every price is a whole dollar or .99"
        },
        {
          "type": "text",
          "content": "One rule covers the whole catalog: any amount a customer is charged ends on .00 or .99, and rounding always goes up."
        },
        {
          "type": "text",
          "content": "It exists because none of the odd cents were authored. Three mechanisms derived them:"
        },
        {
          "type": "list",
          "items": [
            "the annual convention — annual is 10× monthly, so every .99 monthly price became a .90 annual one ($19.99/mo arrived as $199.90/yr);",
            "combo pricing — a combined price set as \"30% off the member basket\" lands wherever the arithmetic lands ($90.86, $34.92, $22.39);",
            "percentage reductions — a volume curve or a percent coupon takes a share of a base and leaves whatever remainder it leaves."
          ]
        },
        {
          "type": "text",
          "content": "Each is reasonable on its own, and together they put arbitrary cents on an invoice, which reads as a rounding error rather than a price."
        },
        {
          "type": "text",
          "content": "Rounding up is deliberate in both directions. Rounding a charge down gives away revenue nobody decided to give away; rounding a reduction up gives away the same money from the other side. So a reduction is never rounded on its own — the amount still charged is snapped up and the credit is taken as the remainder. A 50% coupon on a $49.00 plan therefore charges $24.99 against a credit of $24.01, which reconciles exactly against the line above it. The step is at most 98 cents, so the rule can never move a price materially; what it removes is the appearance of imprecision."
        },
        {
          "type": "text",
          "content": "Two deliberate exceptions:"
        },
        {
          "type": "list",
          "items": [
            "An exact dollar is left alone. Lifting $30.00 to $30.99 would be a price rise, not a rounding.",
            "A total is not snapped. $29.99 + $19.99 stays $49.98. Snapping the total would make it disagree with the sum of its own lines — an invoice whose arithmetic does not add up, which is exactly the failure the support size floor was restructured to avoid (it bills a visible top-up line rather than a silent minimum on the subtotal). Prices are price-shaped; their sum is just a sum."
          ]
        },
        {
          "type": "text",
          "content": "Operator overrides pass through the same rule, so BILLING_BUNDLE_SEAT_MONTHLY=4950 resolves to $49.99 rather than putting $49.50 on an invoice."
        },
        {
          "type": "text",
          "content": "Member Seat volume discounts"
        },
        {
          "type": "text",
          "content": "Two ways to add any stackable pack. Each card carries a one-click +1 (labelled in the pack's own units — +10 GB for storage, +1 for seats) and a typed field for an exact quantity. The quick-add only fills the field: the line beneath still reads current → new · cost and nothing is charged until Add/Update, and it is disabled at the pack's maxQuantity rather than letting a click run past it. There is deliberately no one-click remove — a reduction is destructive, so it goes through the field and a confirmation. That combination is why the control can exist at all: the bare ±1 stepper it replaced hid both the resulting quantity and its price, and let a buyer click past the cap into a 400."
        },
        {
          "type": "text",
          "content": "Storage is entered in GB, not in packs. The typed field takes an absolute quantity, and for most packs the number you type is the number you mean — one seat is one seat. Storage's grant is 10 GB, so the field would otherwise ask for \"6\" to mean 60 GB. It accepts GB in multiples of the pack size instead, converts to packs on commit, and refuses a value that is not a whole pack rather than rounding it — rounding up would charge for capacity nobody asked for, and rounding down would quietly deliver less than was typed. The step follows the grant, so a deployment that overrides BILLING_BUNDLE_STORAGE_PACK_GRANT to 20 GB gets a 20 GB step with no code change."
        },
        {
          "type": "text",
          "content": "Seats are per-unit ($49.99 each), and the more you buy the cheaper each gets:"
        },
        {
          "type": "table",
          "headers": [
            "Seats",
            "Discount off the seat line"
          ],
          "rows": [
            [
              "≥ 5",
              "10%"
            ],
            [
              "≥ 15",
              "20%"
            ],
            [
              "≥ 40",
              "30%"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The discount is realized as a recurring usage credit, like a combo, so the provider still charges unit × quantity and the credit offsets the balance. The add-on preview shows a negative \"Member Seat volume discount\" line so totalCents reflects the net. Thresholds are env-tunable via BILLING_BUNDLE_SEAT_VOLUME_TIERS."
        },
        {
          "type": "text",
          "content": "Listing Pack and the listings quota"
        },
        {
          "type": "text",
          "content": "Listing Pack raises the listings count quota — the number of active public listings an org's publisher can hold in the plugin ecosystem. Tier base: Developer 3, Pro 10, Team 25, Business 50, Enterprise 100. Installing plugins is free on every plan and needs no pack."
        },
        {
          "type": "text",
          "content": "The pack itself is free. Ecosystem publishing is deliberately not monetized: installing costs nothing on any tier and the Verified trust tier is earned by review rather than bought, so charging for the capacity to publish taxed the one thing that grows the catalog for everyone. It is capped at 2 packs (+10) because a free stackable pack with no ceiling would be self-service unlimited listings, and the quota exists for moderation and registry cost rather than revenue."
        },
        {
          "type": "text",
          "content": "Like plugins and pipelines it is a count, so removing packs below the org's current active-listing count is refused by the over-cap guard. A plan downgrade is different: it is never refused for listings — the listings stay listed, and new versions and listing updates are refused (security fixes excepted) until the org is back under its limit (notice N29). The limit is enforced when a publish request is submitted and again when it is approved; see Plugin Publishing."
        },
        {
          "type": "text",
          "content": "Retention is tier-aware and bundle-extendable"
        },
        {
          "type": "text",
          "content": "Each tier carries a baseline reporting-retention window — paid tiers default to 30 days for standard pipeline events and 180 days for DORA source, while the unlimited tier is unlimited retention (-1, history is never swept)."
        },
        {
          "type": "text",
          "content": "The two retention packs stack like every other pack: effective retention = tier baseline + Σ(pack grant × quantity). Buy Standard Retention Pack ×2 for +180 days of standard-event history. Billing computes that effective window and syncs it to the reporting service (dora_settings.event_retention_days / dora_retention_days)."
        },
        {
          "type": "text",
          "content": "The DORA History Pack also widens the per-org report-query window, which now tracks retention and is capped at an absolute 730 days — so a pack holder can actually query the extended range, not just retain the raw rows. It only does anything useful alongside Advanced Reporting (DORA)."
        },
        {
          "type": "text",
          "content": "Stakeholder Reports"
        },
        {
          "type": "list",
          "items": [
            "It carries the report's DORA sections. A buyer does not also need Advanced Reporting to see them: the live DORA dashboard stays behind advanced_reporting, but a report's DORA panels do not. An add-on whose headline numbers are locked behind a second purchase is not what its own description promises.",
            "One free preview per organization, ever. An org without the add-on can generate a single watermarked sample report from its own data. It cannot be scheduled or shared — nothing is persisted, so there is no definition to schedule and no run to link to. Not per user and not per month: the preview exists so a lead can see their own numbers before asking anyone to pay, which takes one report.",
            "On lapse, every report in the ACCOUNT pauses with the reason entitlement, including reports owned by teams under the root — entitlement is pooled at the root, so pausing only the root would leave the teams running on a cancelled subscription. Published snapshots stay readable and existing share links live until they expire; no new link is minted and nothing new is delivered. Re-subscribing resumes exactly what the lapse paused; a report paused because its owner was deactivated stays paused. Upgrading to Enterprise prunes the charge and keeps the capability.",
            "Not sold to Developer. A single developer has nobody to report upward to, so the SKU would be an upsell for something they cannot use. It is included on Enterprise and Unlimited, and the on-demand report dashboards stay free on every plan — what this sells is saving, scheduling and publishing a report. See Stakeholder Reports."
          ]
        },
        {
          "type": "text",
          "content": "Compliance content add-ons"
        },
        {
          "type": "text",
          "content": "Standard / Advanced Compliance unlock curated compliance-content libraries (see Compliance → Curated content add-ons). Both are purchasable on Developer / Pro / Team and included on Enterprise / Unlimited, where there is nothing to buy."
        },
        {
          "type": "text",
          "content": "Advanced requires Standard. The purchase route rejects adding Advanced alone (400), so buy Standard first and add Advanced, or buy the Compliance Suite combo to get both at once. Cancelling Standard while Advanced is held cascade-cancels Advanced."
        },
        {
          "type": "text",
          "content": "These bundles gate only the curated libraries — authoring your own org rules stays free and ungated on every tier."
        },
        {
          "type": "text",
          "content": "Buy-up-a-capability add-ons"
        },
        {
          "type": "text",
          "content": "Advanced Reporting and Team Usage Analytics are the \"buy a capability without changing tier\" path. Each is standard from Enterprise up, and the bundle lets a lower tier add it à la carte — so the add-on is offered only to the tiers that don't already include it: Advanced Reporting to Developer/Pro/Team, Team Usage Analytics to Team, since Developer and Pro can't nest teams and so have nothing to break down."
        },
        {
          "type": "text",
          "content": "What is deliberately not sold"
        },
        {
          "type": "text",
          "content": "SSO is not an add-on. It is a tier feature from Team up, and there is deliberately no way to buy it below that. It used to be a $40/mo Pro-only bundle, which was both dominated and broken: Pro ($39) plus the add-on cost exactly Team ($79), which includes SSO and teams and domain registration; and SSO needs a DNS-verified email domain, which is itself a Team-and-up tier check — so a Pro buyer's Okta / Entra / generic-OIDC / SAML connection failed at callback with OIDC_EMAIL_DOMAIN_NOT_VERIFIED. A lower tier that needs SSO upgrades to Team; the UI's sso lock links to the Plans tab rather than to an add-on. See Authentication → Per-org enterprise SSO."
        },
        {
          "type": "text",
          "content": "Verified publishing is not sold. The verified_publisher feature (Team, Business, Enterprise and billing-off instances) only makes an org eligible to apply for the Verified badge; the system org awards it after review. No bundle adds it. A Verified publisher whose plan drops below Team keeps the badge for a 30-day grace period, then returns to Community."
        }
      ]
    },
    {
      "id": "combo-pricing",
      "title": "Combo pricing",
      "blocks": [
        {
          "type": "text",
          "content": "Some add-ons are cheaper bought together. When an account holds every member of a combo, each at or above its minimum quantity, the set is billed at a reduced combined price instead of the sum of the members — and the difference is realized as a recurring usage credit (never a provider coupon), consistent with the discount model."
        },
        {
          "type": "table",
          "headers": [
            "Combo",
            "Members",
            "Buy separately",
            "Together",
            "You save"
          ],
          "rows": [
            [
              "Analytics Suite",
              "Advanced Reporting (DORA) + Team Usage Analytics + Stakeholder Reports",
              "$90 / mo · $900 / yr",
              "$63 / mo · $630 / yr",
              "$27 / mo · $270 / yr"
            ],
            [
              "Team Growth Bundle",
              "≥ 5 Member Seats + Team Usage Analytics",
              "$279.95 / mo · $2,799.95 / yr",
              "$195.99 / mo · $1,959.99 / yr",
              "$83.96 / mo · $839.96 / yr"
            ],
            [
              "Compliance Suite",
              "Standard Compliance + Advanced Compliance",
              "$129.98 / mo · $1,299.98 / yr",
              "$90.99 / mo · $909.99 / yr",
              "$38.99 / mo · $389.99 / yr"
            ],
            [
              "Insights Bundle",
              "Team Usage Analytics + Stakeholder Reports",
              "$60 / mo · $600 / yr",
              "$42 / mo · $420 / yr",
              "$18 / mo · $180 / yr"
            ],
            [
              "Throughput Bundle",
              "Plugin Pack + API Pack + AI Pack",
              "$35.97 / mo · $359.97 / yr",
              "$25.99 / mo · $259.99 / yr",
              "$9.98 / mo · $99.98 / yr"
            ],
            [
              "Scale Bundle",
              "API Pack + Storage Pack",
              "$31.98 / mo · $319.98 / yr",
              "$22.99 / mo · $229.99 / yr",
              "$8.99 / mo · $89.99 / yr"
            ]
          ]
        },
        {
          "type": "text",
          "content": "How it works:"
        },
        {
          "type": "list",
          "items": [
            "The combo applies automatically the moment its members are present — there is nothing extra to buy or redeem.",
            "Minimum-quantity members. A member can require a minimum quantity: Team Growth needs ≥ 5 Member Seats. It counts the purchased Seat add-on, not the account's total tier seats, and the credit is flat — extra seats beyond the minimum don't increase it.",
            "The saving is shown up front: the add-on preview and the add/remove responses include a negative combo line (e.g. Team Growth Bundle discount −$38.96), so totalCents already reflects the net.",
            "It is realized as a recurring usage credit re-granted each billing period, derived fresh from the current add-on composition — the invoice reconciler grants Σ member price × minQty − combined price (clamped ≥ 0) per period, idempotent per invoice. Existing qualifying accounts begin receiving the credit at their next invoice, retroactive by design."
          ]
        },
        {
          "type": "text",
          "content": "Why there is both an Analytics Suite and an Insights Bundle. A combo only applies when the account holds every member, and advanced_reporting is included in Business — so Business cannot buy that member and the three-member Suite can never form there. Without the Insights Bundle a Business account buying the other two paid full list ($60) while a Team account paid $63 for all three. The Insights Bundle is the same pair minus the member the tier already owns, and on Team it simply loses to the Suite's larger credit."
        },
        {
          "type": "list",
          "items": [
            "Overlap. Team Usage Analytics belongs to both the Analytics Suite and Team Growth. You always receive the combination of combos giving the largest total discount, and no add-on is ever discounted twice — if two combos share a member, only the single best one applies, with ties broken deterministically. So an account with DORA + Team Usage Analytics + seats gets one $27 credit (the larger Analytics Suite), not two.",
            "Removing a member simply stops the next re-grant — the current period's credit is not clawed back — and emits a combo_expired billing event. The preview warns \"Ends your Team Growth Bundle discount — −$38.96/mo\" before you commit.",
            "The billing dashboard nudges toward the pairing: when the other member is owned, an unsatisfied member's card shows a \"Completes the Team Growth Bundle — save $38.96/mo\" hint, for the single best combo that card completes."
          ]
        },
        {
          "type": "text",
          "content": "Proration note. A mid-period seat increase is prorated by the provider at the full unit price; the volume-discount credit reconciles at the next invoice, so the discount lags one cycle on the proration amount, then catches up automatically. Steady state — full billing periods — is unaffected."
        },
        {
          "type": "text",
          "content": "Combos are only advertised when every member is purchasable on the account's tier. Developer, for example, can't buy Team Usage Analytics, so it isn't offered either combo."
        }
      ]
    },
    {
      "id": "pooling-across-teams",
      "title": "Pooling across teams",
      "blocks": [
        {
          "type": "text",
          "content": "For an account with teams, bundle grants raise the root account's pooled caps, and the whole subtree draws from that shared pool:"
        },
        {
          "type": "list",
          "items": [
            "Seats are counted as distinct active members plus pending invites across the root and all its teams, checked against the pooled seat cap at invite time.",
            "Count quotas (plugins, pipelines, …) sum each team's usage against the root's pooled cap.",
            "Storage is measured live across the subtree at image-push time — it is not pre-summed.",
            "Removing a bundle can't drop a pooled cap below current usage: billing's over-cap guard blocks a removal that would strand seats, plugins or pipelines."
          ]
        }
      ]
    },
    {
      "id": "buying-and-managing-bundles",
      "title": "Buying and managing bundles",
      "blocks": [
        {
          "type": "text",
          "content": "Bundles are managed through the billing service — the dashboard Billing page or the API. Mutations require an org admin/owner."
        },
        {
          "type": "table",
          "headers": [
            "Action",
            "Endpoint"
          ],
          "rows": [
            [
              "List available bundles",
              "GET /bundles"
            ],
            [
              "Preview the effect of an add-on change",
              "POST /subscriptions/:id/addons/preview"
            ],
            [
              "Add / change an add-on",
              "POST /subscriptions/:id/addons"
            ],
            [
              "Remove an add-on",
              "DELETE /subscriptions/:id/addons/:bundleId"
            ],
            [
              "Open the billing portal",
              "POST /portal"
            ]
          ]
        },
        {
          "type": "text",
          "content": "The preview endpoint returns the new effective limits before you commit, so you can confirm exactly which caps change."
        }
      ]
    },
    {
      "id": "related",
      "title": "Related",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Feature Tiers — the tier baselines bundles build on",
            "Billing Discounts — the usage-credit model combos are realized through",
            "Billing Providers — Stripe and AWS Marketplace setup",
            "Organization Benefits — the account/team model and how caps pool",
            "Environment Variables — billing and quota configuration reference"
          ]
        }
      ]
    }
  ],
  "sourceDoc": "docs/billing-bundles.md"
};
