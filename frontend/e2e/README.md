# Frontend e2e

Playwright runs against `next dev`, and the backend does not run at all. Every `/api/**`
request is answered by the stub platform in `support/backend.ts`, plus per-journey
fixtures in `support/fixtures/`. The suite needs no services, no database and no
secrets.

| Project | Specs | What it checks |
|---------|-------|----------------|
| `chromium` | every `*.spec.ts` except `screenshots.spec.ts` | user journeys, and the axe scans in `a11y.spec.ts` |
| `screenshots` | `screenshots.spec.ts` | visual baselines; Linux only, see below |

## Running

```sh
cd frontend
pnpm run test:e2e                           # all projects; boots next dev on :3311 (E2E_PORT)
pnpm run test:e2e -- e2e/inbox.spec.ts      # one file
E2E_BASE_URL=http://localhost:3000 pnpm run test:e2e   # against an app that is already running
```

Outside CI, a `next dev` already listening on the port is reused. Browsers come from
`npx playwright install chromium`.

## The stub platform

* `stubBackend(page)` registers one `page.route('**/api/**')` handler that answers from a
  per-test table.
  * `api.on('METHOD /path', handler)` adds or overrides an endpoint.
  * `api.calls('METHOD /path')` returns the requests that were recorded.
  * Unknown endpoints answer `{ success: true }` and are listed in `api.unhandled`.
* `signedInPage(page, user)` starts a page as a returning, signed-in browser.
  * `OWNER` is a tenant owner.
  * `SYSADMIN` is a superadmin active in the system org who holds every permission, so
    every nav entry is visible.
* Model only the CURRENT API. Use the canonical URLs, for example
  `/dashboard/usage?tab=billing&section=plans`, `/dashboard/inbox?tab=messages` and
  `/dashboard/members?tab=invitations`. Don't add compat branches for old routes.
* Envelopes carry their own `statusCode`. The client reads it from the body, so a stub
  that means 202 sets it in the JSON too.

## Accessibility (`a11y.spec.ts`)

axe scans run against WCAG 2.0/2.1 A and AA. A scan fails on any `serious` or `critical`
violation. Three groups are scanned:

* the public pages;
* every dashboard page the system admin can reach from the nav, derived from
  `src/lib/nav.ts` with the sidebar's own visibility check (`support/pages.ts`). This
  covers the rail, the Platform sub-groups, the avatar and help menus, and the ⌘K-only
  tab entries. A guard test fails if the rendered nav shows an entry the walk does not
  cover;
* the main modals: step-up, the idle warning, delete pipeline, delete plugin, KMS
  config and support floor.

`KNOWN_FINDINGS` records product findings that exist today. It is a ratchet:
* a new finding fails the scan;
* a fixed finding also fails until its entry is removed.

Fix the product rather than adding an entry.

## Screenshots (`screenshots.spec.ts`)

The spec covers the shell and the key pages in light and dark. The shell, the Inbox and
a deploy in progress are also shot at 390×844.

Every shot is made deterministic:
* `Date` is frozen at the fixtures' reference time, and the stub mints its tokens at that
  same instant;
* the time zone is UTC and the locale en-US;
* `<time>` elements and plain-text relative times ("1 hr. ago", "yesterday") are masked;
* motion is reduced, animations are disabled, and `support/screenshot.css` removes
  transitions, the caret and Next's dev overlay.

The baselines in `__screenshots__/` are **Linux renders**, which is what CI runs. CI runs
the suite inside the official Playwright image of the same version as `@playwright/test`
(`mcr.microsoft.com/playwright:v<version>-noble`). On macOS or Windows the spec skips
itself, so `pnpm run test:e2e` stays green there.

To check or update the baselines from any OS, run them in that image:

```sh
cd frontend
pnpm run test:e2e:screenshots                          # compare against the baselines
pnpm run test:e2e:screenshots -- --update-snapshots    # rewrite them after an intended UI change
```

`e2e/scripts/screenshots-docker.sh` works like this:
* It runs `next dev` on the host (or reuses one already on `:3311`). The repo's
  `node_modules` carry host-native binaries, so the app can't run in the container.
* It mounts the repo into the Playwright image and runs `playwright test
  --project=screenshots` there.
* `scripts/tcp-forward.mjs` forwards the container's `localhost:3311` to the host, so the
  app is still served from `localhost`.

Review the changed PNGs (`git diff --stat e2e/__screenshots__`) before committing them.

When a shot fails in CI, the job uploads `playwright-report-<shard>`. That artifact holds
the HTML report and `test-results/`, which has the expected, actual and diff images and
the traces.

### Bumping Playwright

`@playwright/test` and the CI image are pinned together through `PLAYWRIGHT_VERSION` in
`projenrc/workflow.ts`. To bump:

1. Change the version.
2. Re-pin the image digest with
   `docker buildx imagetools inspect mcr.microsoft.com/playwright:v<version>-noble`.
3. Run `npx projen` from the repo root.
4. Regenerate the baselines with `--update-snapshots`. A new Chromium renders slightly
   differently.

## CI

The `frontend_e2e` job in `.github/workflows/test.yml` is generated from
`projenrc/workflow.ts`:

* It runs inside the pinned Playwright image.
* It runs every project, journeys, axe and screenshots, across 2 shards
  (`--shard=n/2`) with 2 workers each, and retries once.
* When a shard fails, it uploads that shard's report and diffs.
