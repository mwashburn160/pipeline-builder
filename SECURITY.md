# Security Policy

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** (under *Advisories*).
3. Describe the issue, the affected component and version, and how to reproduce it. A proof of concept, logs or a minimal configuration help a lot.

The report is visible only to you and the maintainers. We will discuss it with you in the draft security advisory, agree on a fix and a disclosure date, and credit you in the published advisory unless you ask us not to.

Please give us a reasonable chance to fix the issue before disclosing it publicly, and do not access, modify or delete data that is not yours while investigating.

## Response targets

These are targets, not contractual guarantees:

| Stage | Target |
|---|---|
| Acknowledge the report | within 3 business days |
| Initial assessment (validity, severity) | within 7 days |
| Fix released — Critical | within 7 days of confirmation |
| Fix released — High | within 30 days of confirmation |
| Fix released — Medium / Low | in a regular release, typically within 90 days |

We will keep you updated in the advisory thread while we work on it. When a fix ships, we publish a GitHub security advisory (with a CVE where one applies) describing the affected and fixed versions.

## Supported versions

Pipeline Builder ships continuously. Each npm package (`@pipeline-builder/*`) and container image (`ghcr.io/mwashburn160/*`) is versioned independently, and **only the latest released minor version of each is supported**. Security fixes go into a new release; older versions are not patched. Upgrade to the newest release to receive fixes.

| Version | Supported |
|---|---|
| Latest minor of each package / image | Yes |
| Anything older | No |

## Scope

In scope: the code in this repository — the platform services and frontend, the `@pipeline-builder/*` npm packages, the container images the release publishes, the official plugin catalog under `deploy/plugins/`, and the deployment tooling under `deploy/`.

Out of scope: vulnerabilities in third-party dependencies or upstream images that are already publicly known (report those upstream — we pick fixes up through our dependency audit and image rescans); findings that require an already-compromised host or cluster-admin access; and missing hardening without a demonstrated impact.

## How releases are protected

For context when assessing an issue:

- Container images are scanned before they are published (fixable High/Critical findings block the release), signed keyless with Sigstore cosign, and carry an SPDX SBOM attestation. Deploy manifests pin images by verified digest.
- Published images and third-party images pinned in the deploy tree are rescanned nightly for newly disclosed vulnerabilities.
- npm packages are published with provenance from the release workflow.
- Every pull request runs dependency auditing, secret scanning and CodeQL.
