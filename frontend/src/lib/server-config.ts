// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * @module lib/server-config
 * @description Server-only RUNTIME configuration: plain environment variables
 * (no `NEXT_PUBLIC_` prefix) that each deployment sets on the frontend
 * container, so one image can serve every environment.
 *
 * Import this ONLY from server-side code — API routes, `_document`, and
 * modules used solely by `getServerSideProps`. Never from a component or a
 * module a component imports: these values are not in the browser bundle, so
 * there they would read as `undefined`.
 *
 * Each member is a getter, read at access time rather than captured at module
 * load, so a value is always the process's current env (tests rely on that).
 *
 * Two runtime variables are read outside this module because their modules are
 * also imported by client code: `APP_SITE_URL` (`lib/site-url.ts`) and
 * `PLATFORM_BASE_URL` (`API_URL` in `lib/api/util.ts`, SSR only).
 */
export const serverConfig = {
  /**
   * `BILLING_INTERNAL_URL`: in-cluster base URL of the billing service, used to
   * exchange an AWS Marketplace registration token without going through the
   * public gateway. Unset ⇒ the exchange reports a deployment fault.
   */
  get billingInternalUrl(): string | undefined {
    return process.env.BILLING_INTERNAL_URL || undefined;
  },

  /**
   * `ERROR_REPORT_URL`: collector the `/client-errors` relay forwards browser
   * error reports to. Unset ⇒ reports are dropped and the relay tells the
   * browser reporting is off.
   */
  get errorReportUrl(): string | undefined {
    return process.env.ERROR_REPORT_URL || undefined;
  },

  /**
   * `GOOGLE_SITE_VERIFICATION`: Search Console ownership token rendered as a
   * `<meta>` tag in every page. Not a secret. Unset ⇒ no tag.
   */
  get googleSiteVerification(): string | undefined {
    return process.env.GOOGLE_SITE_VERIFICATION || undefined;
  },
};
