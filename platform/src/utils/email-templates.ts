// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@pipeline-builder/api-core';
import { config } from '../config';
import type { InvitationEmailData } from './email';
import type { InvitationOAuthProvider } from '../models/invitation';

const logger = createLogger('email-templates');

interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const TEMPLATES_DIR = join(__dirname, 'email-templates');

/** Placeholder keys that contain pre-rendered HTML and must NOT be escaped. */
const RAW_HTML_KEYS = new Set(['oauthHtml', 'body']);

/**
 * Escape HTML-significant characters to prevent XSS via user-supplied values
 * injected into email templates.
 */
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Load an HTML template from disk and substitute `{{var}}` placeholders.
 *
 * Templates are cached in production only — in dev each render re-reads the
 * file so template changes take effect without a restart.
 *
 * All values in `vars` are HTML-escaped before substitution. Pre-rendered
 * HTML fields (see {@link RAW_HTML_KEYS}) are whitelisted to bypass escaping.
 *
 * Unknown placeholders are replaced with an empty string so recipients never
 * see raw `{{key}}` syntax; in dev a warning is logged so the omission is
 * easy to spot.
 */
const templateCache = new Map<string, string>();
function loadTemplate(name: string): string {
  // Skip the cache in dev so template edits show up without a restart.
  if (process.env.NODE_ENV !== 'production') {
    return readFileSync(join(TEMPLATES_DIR, name), 'utf-8');
  }
  let tpl = templateCache.get(name);
  if (!tpl) {
    tpl = readFileSync(join(TEMPLATES_DIR, name), 'utf-8');
    templateCache.set(name, tpl);
  }
  return tpl;
}

function substitute(tpl: string, vars: Record<string, string>, templateName: string): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const raw = vars[key];
    if (raw === undefined) {
      if (process.env.NODE_ENV !== 'production') {
        logger.warn('Missing template variable', { template: templateName, key });
      }
      return '';
    }
    return RAW_HTML_KEYS.has(key) ? raw : htmlEscape(raw);
  });
}

function renderTemplate(name: string, vars: Record<string, string>): string {
  const inner = substitute(loadTemplate(`${name}.html`), vars, name);
  const layout = loadTemplate('layout.html');
  // Layout's `{{body}}` is in RAW_HTML_KEYS, so the already-escaped inner
  // content is not double-escaped.
  return substitute(layout, { body: inner, title: vars.title ?? 'Notification' }, 'layout');
}

/**
 * Render a plain-text template (no HTML escaping, no layout wrapping).
 * Unknown placeholders are replaced with an empty string.
 */
function renderTextTemplate(name: string, vars: Record<string, string>): string {
  const tpl = loadTemplate(`${name}.txt`);
  return tpl.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const raw = vars[key];
    if (raw === undefined) {
      if (process.env.NODE_ENV !== 'production') {
        logger.warn('Missing text template variable', { template: name, key });
      }
      return '';
    }
    return raw;
  });
}

// -----------------------------------------------------------------------------
// OAuth Helpers
// -----------------------------------------------------------------------------

/** Human-readable, title-case labels for OAuth providers. */
const providerLabels: Record<InvitationOAuthProvider, string> = {
  google: 'Google',
  github: 'GitHub',
};

function labelFor(p: InvitationOAuthProvider): string {
  return providerLabels[p] ?? p;
}

function joinProviderLabels(providers: InvitationOAuthProvider[]): string {
  return providers.map(labelFor).join(', ');
}

function buildOAuthText(data: InvitationEmailData): string {
  switch (data.invitationType) {
    case 'email':
      return '\nYou will need to create an account with email and password to accept this invitation.\n';
    case 'oauth': {
      const providers = data.allowedOAuthProviders?.length
        ? joinProviderLabels(data.allowedOAuthProviders)
        : labelFor('google');
      return `\nYou can accept this invitation using your ${providers} account.\n`;
    }
    case 'any':
    default: {
      const providers = data.allowedOAuthProviders?.length
        ? joinProviderLabels(data.allowedOAuthProviders)
        : labelFor('google');
      return `\nYou can accept using email/password or sign in with ${providers}.\n`;
    }
  }
}

function buildOAuthHtml(data: InvitationEmailData): string {
  switch (data.invitationType) {
    case 'email':
      return `
        <div class="oauth-section">
          <p style="margin: 0; font-size: 14px; color: #6b7280;">
            <strong>Note:</strong> You will need to create an account with email and password to accept this invitation.
          </p>
        </div>
      `;
    case 'oauth':
    case 'any': {
      const providers: InvitationOAuthProvider[] = data.allowedOAuthProviders?.length
        ? data.allowedOAuthProviders
        : ['google'];
      const providerBadges = providers
        .map(p => `<span class="oauth-badge">${htmlEscape(labelFor(p))}</span>`)
        .join('');
      const introText = data.invitationType === 'oauth'
        ? 'Accept this invitation using:'
        : 'Or sign in with:';
      return `
        <div class="oauth-section">
          <p style="margin: 0 0 8px 0; font-size: 14px; color: #6b7280;">
            <strong>${introText}</strong>
          </p>
          <div>${providerBadges}</div>
        </div>
      `;
    }
    default:
      return '';
  }
}

// -----------------------------------------------------------------------------
// Templates
// -----------------------------------------------------------------------------

/** Build invitation email content (subject, text, html). */
export function invitationTemplate(data: InvitationEmailData): EmailContent {
  const inviteUrl = `${config.app.frontendUrl}/invite/accept?token=${data.invitationToken}`;
  // Locale is currently always 'en-US' in production — we accept a per-call
  // override on InvitationEmailData for future i18n, but no caller passes
  // one today. Keep the default hard-coded here until the platform learns
  // recipient locale (e.g., from User.preferences).
  const locale = data.locale ?? 'en-US';
  const expiresFormatted = data.expiresAt.toLocaleDateString(locale, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const oauthText = buildOAuthText(data);
  const oauthHtml = buildOAuthHtml(data);

  const subject = `You've been invited to join ${data.organizationName}`;
  const text = `
Hello,

${data.inviterName} has invited you to join ${data.organizationName} as a ${data.role}.

Click the link below to accept the invitation:
${inviteUrl}
${oauthText}
This invitation will expire on ${expiresFormatted}.

If you didn't expect this invitation, you can safely ignore this email.

Best regards,
The ${config.email.fromName} Team
  `.trim();

  const html = renderTemplate('invitation', {
    title: 'Organization Invitation',
    inviterName: data.inviterName,
    organizationName: data.organizationName,
    role: data.role,
    inviteUrl,
    oauthHtml,
    expiresFormatted,
    fromName: config.email.fromName,
  });

  return { subject, text, html };
}

/** Build invitation-accepted notification email content. */
export function invitationAcceptedTemplate(
  inviterName: string,
  acceptedByName: string,
  organizationName: string,
): EmailContent {
  const subject = `${acceptedByName} has joined ${organizationName}`;
  const text = `
Hello ${inviterName},

Great news! ${acceptedByName} has accepted your invitation and joined ${organizationName}.

Best regards,
The ${config.email.fromName} Team
  `.trim();

  const html = renderTemplate('invitation-accepted', {
    title: 'Invitation Accepted',
    inviterName,
    acceptedByName,
    organizationName,
    fromName: config.email.fromName,
  });

  return { subject, text, html };
}

/**
 * Build email-verification email content (subject, text, html).
 *
 * TODO([route] agent): wire this into `controllers/auth.ts` ~line 200 in place
 * of the inline HTML/text strings — the controller should call
 * `verifyEmailTemplate(verifyUrl)` and forward the result to `emailService.send`.
 */
export function verifyEmailTemplate(verifyUrl: string): EmailContent {
  const subject = `Verify your email for ${config.email.fromName}`;
  const text = renderTextTemplate('verify-email', {
    verifyUrl,
    fromName: config.email.fromName,
  });
  const html = renderTemplate('verify-email', {
    title: 'Verify Your Email',
    verifyUrl,
    fromName: config.email.fromName,
  });
  return { subject, text, html };
}
