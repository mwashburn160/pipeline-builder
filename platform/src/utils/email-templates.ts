// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config';
import type { InvitationEmailData } from './email';

interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const TEMPLATES_DIR = join(__dirname, 'email-templates');

/**
 * Load an HTML template from disk and substitute `{{var}}` placeholders.
 * Templates are cached after first load. Unknown placeholders are left intact
 * (easier to spot bugs than silently dropping them).
 */
const templateCache = new Map<string, string>();
function renderTemplate(name: string, vars: Record<string, string>): string {
  let tpl = templateCache.get(name);
  if (!tpl) {
    tpl = readFileSync(join(TEMPLATES_DIR, `${name}.html`), 'utf-8');
    templateCache.set(name, tpl);
  }
  return tpl.replace(/\{\{(\w+)\}\}/g, (_match, key) => vars[key] ?? `{{${key}}}`);
}

// -----------------------------------------------------------------------------
// OAuth Helpers
// -----------------------------------------------------------------------------

function buildOAuthText(data: InvitationEmailData): string {
  switch (data.invitationType) {
    case 'email':
      return '\nYou will need to create an account with email and password to accept this invitation.\n';
    case 'oauth': {
      const providers = data.allowedOAuthProviders?.length
        ? data.allowedOAuthProviders.join(', ')
        : 'Google';
      return `\nYou can accept this invitation using your ${providers} account.\n`;
    }
    case 'any':
    default:
      return data.allowedOAuthProviders?.length
        ? `\nYou can accept using email/password or sign in with ${data.allowedOAuthProviders.join(', ')}.\n`
        : '\nYou can accept using email/password or sign in with Google.\n';
  }
}

function buildOAuthHtml(data: InvitationEmailData): string {
  const providerIcons: Record<string, string> = {
    google: '🔵 Google',
    github: '⚫ GitHub',
  };

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
      const providers = data.allowedOAuthProviders?.length
        ? data.allowedOAuthProviders
        : ['google'];
      const providerBadges = providers
        .map(p => `<span class="oauth-badge">${providerIcons[p] || p}</span>`)
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
  const expiresFormatted = data.expiresAt.toLocaleDateString('en-US', {
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
    inviterName,
    acceptedByName,
    organizationName,
    fromName: config.email.fromName,
  });

  return { subject, text, html };
}
