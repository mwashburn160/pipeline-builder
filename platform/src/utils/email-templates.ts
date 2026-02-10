/**
 * @module utils/email-templates
 * @description Email templates for invitation and notification emails.
 * Separates template content from the email transport layer.
 */

import { config } from '../config';
import type { InvitationEmailData } from './email';

interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

// ============================================================================
// Shared Styles
// ============================================================================

const baseStyles = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
  .container { max-width: 600px; margin: 0 auto; padding: 20px; }
`.trim();

const invitationStyles = `
  ${baseStyles}
  .header { background: #4F46E5; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
  .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
  .button { display: inline-block; background: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
  .button:hover { background: #4338CA; }
  .footer { text-align: center; color: #6b7280; font-size: 14px; margin-top: 20px; }
  .role-badge { display: inline-block; background: #E0E7FF; color: #4F46E5; padding: 4px 12px; border-radius: 20px; font-size: 14px; font-weight: 500; }
  .oauth-section { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .oauth-badge { display: inline-block; background: #f3f4f6; color: #374151; padding: 6px 12px; border-radius: 6px; font-size: 13px; margin: 4px; }
`.trim();

// ============================================================================
// OAuth Helpers
// ============================================================================

function buildOAuthText(data: InvitationEmailData): string {
  if (data.invitationType === 'email') {
    return '\nYou will need to create an account with email and password to accept this invitation.\n';
  }

  if (data.invitationType === 'oauth') {
    const providers = data.allowedOAuthProviders?.length
      ? data.allowedOAuthProviders.join(', ')
      : 'Google';
    return `\nYou can accept this invitation using your ${providers} account.\n`;
  }

  // 'any' type
  if (data.allowedOAuthProviders?.length) {
    return `\nYou can accept using email/password or sign in with ${data.allowedOAuthProviders.join(', ')}.\n`;
  }

  return '\nYou can accept using email/password or sign in with Google.\n';
}

function buildOAuthHtml(data: InvitationEmailData): string {
  if (data.invitationType === 'email') {
    return `
      <div class="oauth-section">
        <p style="margin: 0; font-size: 14px; color: #6b7280;">
          <strong>Note:</strong> You will need to create an account with email and password to accept this invitation.
        </p>
      </div>
    `;
  }

  const providerIcons: Record<string, string> = {
    google: '🔵 Google',
  };

  let providers: string[];
  if (data.allowedOAuthProviders?.length) {
    providers = data.allowedOAuthProviders;
  } else if (data.invitationType === 'oauth' || data.invitationType === 'any') {
    providers = ['google'];
  } else {
    return '';
  }

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

// ============================================================================
// Templates
// ============================================================================

/**
 * Build invitation email content (subject, text, html).
 */
export function invitationTemplate(data: InvitationEmailData): EmailContent {
  const inviteUrl = `${config.app.frontendUrl}/invite/accept?token=${data.invitationToken}`;
  const expiresFormatted = data.expiresAt.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
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

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Organization Invitation</title>
  <style>${invitationStyles}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0;">You're Invited!</h1>
    </div>
    <div class="content">
      <p>Hello,</p>
      <p><strong>${data.inviterName}</strong> has invited you to join <strong>${data.organizationName}</strong>.</p>
      <p>Your role: <span class="role-badge">${data.role}</span></p>
      <p style="text-align: center;">
        <a href="${inviteUrl}" class="button">Accept Invitation</a>
      </p>
      ${oauthHtml}
      <p style="font-size: 14px; color: #6b7280;">
        This invitation will expire on <strong>${expiresFormatted}</strong>.
      </p>
      <p style="font-size: 14px; color: #6b7280;">
        If you didn't expect this invitation, you can safely ignore this email.
      </p>
    </div>
    <div class="footer">
      <p>Sent by ${config.email.fromName}</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  return { subject, text, html };
}

/**
 * Build invitation-accepted notification email content.
 */
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

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    ${baseStyles}
    .content { background: #f0fdf4; padding: 30px; border-radius: 8px; border-left: 4px solid #22c55e; }
  </style>
</head>
<body>
  <div class="container">
    <div class="content">
      <h2 style="color: #16a34a; margin-top: 0;">🎉 New Team Member!</h2>
      <p>Hello ${inviterName},</p>
      <p><strong>${acceptedByName}</strong> has accepted your invitation and joined <strong>${organizationName}</strong>.</p>
      <p>Best regards,<br>The ${config.email.fromName} Team</p>
    </div>
  </div>
</body>
</html>
  `.trim();

  return { subject, text, html };
}
