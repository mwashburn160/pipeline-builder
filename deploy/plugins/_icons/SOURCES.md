# Plugin icon sources

Curated vendor/tool marks for **Official** plugin listings
(licensing rules: docs/plugin-publishing.md#why-the-ecosystem-works-this-way). One SVG per key:
`<key>.svg`, referenced from a plugin spec as `icon: <key>` or
`icon: { key: <key>, badge: <language-key> }`.

## Policy

- **Nominative use only.** A mark identifies which tool a plugin runs. It never
  implies affiliation or endorsement; the plugin page says "Not affiliated with
  or endorsed by <vendor>" unless the publisher is that vendor. Curated marks are
  reserved for Official listings and Verified publishers who own the mark.
- **Sources, in order:** [Simple Icons](https://simpleicons.org) at a **pinned
  version** (currently `16.32.0`), copied byte-for-byte; then a vendor press-kit
  mark, **only** where the vendor's published brand terms permit third-party
  integration listings (the permitting guideline URL is recorded in the row);
  otherwise **no logo** — the plugin renders a monogram.
- **Never redraw** a mark that a vendor had removed from Simple Icons (AWS,
  Microsoft/Azure/Teams, Slack, Semgrep, Veracode, Fortify, Mend, Playwright,
  Oracle, …).
- **Licences.** The Simple Icons project is CC0-1.0, but a few marks carry the
  licence of the original artwork (Simple Icons' `license` field). That licence is
  recorded per row; share-alike/attribution marks are distributed unmodified with
  the attribution link shown. Marks under a non-commercial licence are not used.
- **Removal requests** from a mark's owner are honoured within **5 business
  days** by deleting the key's file and row and changing the affected specs to the
  `# icon: none — …` comment form. Plugins fall back to monograms; no plugin
  re-release is needed.
- **Brand colour.** The `Hex` column is read by
  `frontend/scripts/generate-plugin-icons.mjs` into the icon manifest (the icon is
  drawn as a CSS mask filled with it, falling back to the text colour when it
  fails 3:1 contrast). The `Name` column is the vendor/tool display name.
- **Adding an icon:** copy the SVG from the pinned Simple Icons version, add a
  row below, run `node scripts/generate-plugin-icons.mjs` in `frontend/`, and
  commit the regenerated `frontend/src/generated/plugin-icons.ts`. The frontend
  tests check that every spec key resolves, that files and rows match, and that
  every SVG passes the lint (no script, event handlers, `foreignObject`, external
  references, or more than one `viewBox`).

## Icons

| Key | Name | Hex | Source | Licence | Brand guidelines | Retrieved |
|---|---|---|---|---|---|---|
| `apachemaven` | Apache Maven | #C71A36 | Simple Icons `apachemaven` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/apachemaven.svg | Apache-2.0 (mark's own licence, via Simple Icons; attribution: https://apache.org/logos) | https://www.apache.org/foundation/marks | 2026-09-21 |
| `checkmarx` | Checkmarx | #54B848 | Simple Icons `checkmarx` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/checkmarx.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `codacy` | Codacy | #222F29 | Simple Icons `codacy` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/codacy.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `codecov` | Codecov | #F01F7A | Simple Icons `codecov` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/codecov.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `cplusplus` | C++ | #00599C | Simple Icons `cplusplus` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/cplusplus.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `cypress` | Cypress | #69D3A7 | Simple Icons `cypress` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/cypress.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `datadog` | Datadog | #632CA6 | Simple Icons `datadog` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/datadog.svg | CC0-1.0 (Simple Icons) | https://www.datadoghq.com/about/resources/ | 2026-09-21 |
| `dependencycheck` | OWASP Dependency-Check | #F78D0A | Simple Icons `dependencycheck` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/dependencycheck.svg | Apache-2.0 (mark's own licence, via Simple Icons; attribution: https://github.com/jeremylong/DependencyCheck/blob/8ee82149179c6faeca78727e57039e987c387e26/src/site/resources/images/logo.svg) | — | 2026-09-21 |
| `docker` | Docker | #2496ED | Simple Icons `docker` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/docker.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `dotnet` | .NET | #512BD4 | Simple Icons `dotnet` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/dotnet.svg | CC0-1.0 (Simple Icons) | https://github.com/dotnet/brand/blob/c7d0f51b8ec59531332d05fb27a5b758a7a3d689/dotnet-styleGuide-2024.pdf | 2026-09-21 |
| `eslint` | ESLint | #4B32C3 | Simple Icons `eslint` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/eslint.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `flyway` | Flyway | #CC0200 | Simple Icons `flyway` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/flyway.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `github` | GitHub | #181717 | Simple Icons `github` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/github.svg | CC0-1.0 (Simple Icons) | https://github.com/logos | 2026-09-21 |
| `gnubash` | GNU Bash | #4EAA25 | Simple Icons `gnubash` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/gnubash.svg | MIT (mark's own licence, via Simple Icons; attribution: https://github.com/odb/official-bash-logo/tree/61eff022f2dad3c7468f5deb4f06652d15f2c143) | https://github.com/odb/official-bash-logo | 2026-09-21 |
| `go` | Go | #00ADD8 | Simple Icons `go` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/go.svg | CC0-1.0 (Simple Icons) | https://blog.golang.org/go-brand | 2026-09-21 |
| `googlecloud` | Google Cloud | #4285F4 | Simple Icons `googlecloud` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/googlecloud.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `helm` | Helm | #0F1689 | Simple Icons `helm` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/helm.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `jest` | Jest | #C21325 | Simple Icons `jest` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/jest.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `jfrog` | JFrog | #40BE46 | Simple Icons `jfrog` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/jfrog.svg | CC0-1.0 (Simple Icons) | https://jfrog.com/brand-guidelines | 2026-09-21 |
| `k6` | k6 | #7D64FF | Simple Icons `k6` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/k6.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `kubernetes` | Kubernetes | #326CE5 | Simple Icons `kubernetes` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/kubernetes.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `newrelic` | New Relic | #1CE783 | Simple Icons `newrelic` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/newrelic.svg | CC0-1.0 (Simple Icons) | https://newrelic.com/about/media-assets#guidelines | 2026-09-21 |
| `nodejs` | Node.js | #5FA04E | Simple Icons `nodedotjs` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/nodedotjs.svg | CC0-1.0 (Simple Icons) | https://nodejs.org/en/about/branding | 2026-09-21 |
| `npm` | npm | #CB3837 | Simple Icons `npm` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/npm.svg | CC0-1.0 (Simple Icons) | https://docs.npmjs.com/policies/logos-and-usage | 2026-09-21 |
| `nuget` | NuGet | #004880 | Simple Icons `nuget` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/nuget.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `openjdk` | OpenJDK | #000000 | Simple Icons `openjdk` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/openjdk.svg | BSD-3-Clause (mark's own licence, via Simple Icons; attribution: https://hg.openjdk.java.net/duke/duke/file/ca00f100dafc/vector/Agent.svg) | — | 2026-09-21 |
| `pagerduty` | PagerDuty | #06AC38 | Simple Icons `pagerduty` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/pagerduty.svg | CC0-1.0 (Simple Icons) | https://www.pagerduty.com/brand/ | 2026-09-21 |
| `paloaltonetworks` | Palo Alto Networks | #F04E23 | Simple Icons `paloaltonetworks` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/paloaltonetworks.svg | CC0-1.0 (Simple Icons) | https://www.paloaltonetworks.com/company/brand | 2026-09-21 |
| `php` | PHP | #777BB4 | Simple Icons `php` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/php.svg | CC-BY-SA-4.0 (mark's own licence, via Simple Icons; attribution: https://php.net/download-logos.php) | — | 2026-09-21 |
| `postman` | Postman | #FF6C37 | Simple Icons `postman` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/postman.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `prettier` | Prettier | #F7B93E | Simple Icons `prettier` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/prettier.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `pulumi` | Pulumi | #8A3391 | Simple Icons `pulumi` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/pulumi.svg | CC0-1.0 (Simple Icons) | https://www.pulumi.com/brand/ | 2026-09-21 |
| `pypi` | PyPI | #3775A9 | Simple Icons `pypi` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/pypi.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `pytest` | Pytest | #0A9EDC | Simple Icons `pytest` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/pytest.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `python` | Python | #3776AB | Simple Icons `python` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/python.svg | CC0-1.0 (Simple Icons) | https://www.python.org/community/logos/ | 2026-09-21 |
| `ruby` | Ruby | #CC342D | Simple Icons `ruby` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/ruby.svg | CC-BY-SA-2.5 (mark's own licence, via Simple Icons; attribution: https://www.ruby-lang.org/en/about/logo/) | — | 2026-09-21 |
| `rubygems` | RubyGems | #E9573F | Simple Icons `rubygems` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/rubygems.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `rubyonrails` | Ruby on Rails | #D30001 | Simple Icons `rubyonrails` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/rubyonrails.svg | CC0-1.0 (Simple Icons) | https://rubyonrails.org/trademarks/ | 2026-09-21 |
| `ruff` | Ruff | #D7FF64 | Simple Icons `ruff` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/ruff.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `rust` | Rust | #000000 | Simple Icons `rust` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/rust.svg | CC-BY-SA-4.0 (mark's own licence, via Simple Icons; attribution: https://www.rust-lang.org) | https://www.rust-lang.org/policies/media-guide | 2026-09-21 |
| `sentry` | Sentry | #362D59 | Simple Icons `sentry` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/sentry.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `serverless` | Serverless | #FD5750 | Simple Icons `serverless` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/serverless.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `snyk` | Snyk | #4C4A73 | Simple Icons `snyk` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/snyk.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `sonarcloud` | SonarQube Cloud | #126ED3 | Simple Icons `sonarqubecloud` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/sonarqubecloud.svg | CC0-1.0 (Simple Icons) | — | 2026-09-21 |
| `terraform` | Terraform | #844FBA | Simple Icons `terraform` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/terraform.svg | CC0-1.0 (Simple Icons) | https://www.hashicorp.com/brand | 2026-09-21 |
| `trivy` | Trivy | #1904DA | Simple Icons `trivy` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/trivy.svg | CC0-1.0 (Simple Icons) | https://www.aquasec.com/brand | 2026-09-21 |
| `typescript` | TypeScript | #3178C6 | Simple Icons `typescript` — https://cdn.jsdelivr.net/npm/simple-icons@16.32.0/icons/typescript.svg | CC0-1.0 (Simple Icons) | https://www.typescriptlang.org/branding | 2026-09-21 |

## Plugins with no icon (monogram)

These specs carry `# icon: none — <reason>` instead of an `icon:` key.

| Plugin | Reason |
|---|---|
| ai/dockerfile-multi-provider | calls several AI providers, so no single vendor mark identifies it |
| artifact/acr-push | Microsoft/Azure marks were removed from Simple Icons at Microsoft's request; no confirmed press-kit permission |
| artifact/ecr-push | AWS marks were removed from Simple Icons at AWS's request; no confirmed press-kit permission |
| deploy/azure-deploy | Microsoft/Azure marks were removed from Simple Icons at Microsoft's request; no confirmed press-kit permission |
| deploy/cdk-deploy | AWS marks were removed from Simple Icons at AWS's request; no confirmed press-kit permission |
| deploy/cdk-deploy-multi-region | AWS marks were removed from Simple Icons at AWS's request; no confirmed press-kit permission |
| deploy/cloudformation | AWS marks were removed from Simple Icons at AWS's request; no confirmed press-kit permission |
| deploy/ecs-deploy | AWS marks were removed from Simple Icons at AWS's request; no confirmed press-kit permission |
| deploy/lambda-deploy | AWS marks were removed from Simple Icons at AWS's request; no confirmed press-kit permission |
| infrastructure/cdk-synth | AWS marks were removed from Simple Icons at AWS's request; no confirmed press-kit permission |
| infrastructure/manual-approval | generic pipeline step with no vendor |
| infrastructure/manual-approval-custom | generic pipeline step with no vendor |
| infrastructure/s3-cache | AWS marks were removed from Simple Icons at AWS's request; no confirmed press-kit permission |
| language/java-oracle | Oracle/Java marks were removed from Simple Icons at Oracle's request; no confirmed press-kit permission |
| notification/email-notify | generic pipeline step with no vendor |
| notification/slack-notify | Slack mark was removed from Simple Icons at Slack's request; no confirmed press-kit permission |
| notification/teams-notify | Microsoft/Azure marks were removed from Simple Icons at Microsoft's request; no confirmed press-kit permission |
| quality/checkstyle | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| quality/golangci-lint | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| quality/jacoco | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| quality/mypy | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| quality/rubocop | the RuboCop mark in Simple Icons is licensed CC-BY-NC-4.0 (non-commercial), which this product cannot meet |
| quality/shellcheck | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| quality/spotbugs | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| security/bandit | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| security/brakeman | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| security/bundler-audit | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| security/cargo-audit | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| security/docker-lint | runs Hadolint/Dockle, which have no mark in Simple Icons; Docker's mark would misattribute the tool |
| security/fortify | Fortify (OpenText) mark was removed from Simple Icons at the vendor's request; no confirmed press-kit permission |
| security/git-secrets | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| security/gitguardian | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| security/gosec | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| security/license-checker | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| security/mend | Mend mark was removed from Simple Icons at the vendor's request; no confirmed press-kit permission |
| security/semgrep | Semgrep mark was removed from Simple Icons at the vendor's request; no confirmed press-kit permission |
| security/veracode | Veracode mark was removed from Simple Icons at the vendor's request; no confirmed press-kit permission |
| testing/artillery | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| testing/coverage-py | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| testing/health-check | generic pipeline step with no vendor |
| testing/minitest-coverage | no mark in Simple Icons 16.32.0; no confirmed vendor press-kit permission |
| testing/playwright | Playwright (Microsoft) mark was removed from Simple Icons at the vendor's request; no confirmed press-kit permission |

No vendor press-kit marks are used yet: none of the vendors whose marks were
removed from Simple Icons had brand terms confirmed to permit third-party
integration listings at the time of retrieval.
