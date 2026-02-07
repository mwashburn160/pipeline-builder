import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config';
import logger from './logger';

/**
 * Email options interface
 */
export interface EmailOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Invitation type for OAuth support
 */
export type InvitationType = 'email' | 'oauth' | 'any';

/**
 * OAuth provider type
 */
export type OAuthProvider = 'google';

/**
 * Email template data for invitations
 */
export interface InvitationEmailData {
  recipientEmail: string;
  inviterName: string;
  organizationName: string;
  invitationToken: string;
  expiresAt: Date;
  role: string;
  invitationType?: InvitationType;
  allowedOAuthProviders?: OAuthProvider[];
}

/**
 * Email service class
 */
class EmailService {
  private transporter: Transporter | null = null;
  private initialized = false;

  /**
   * Initialize email transporter based on configuration
   */
  private initialize(): void {
    if (this.initialized) return;

    if (!config.email.enabled) {
      logger.info('Email service disabled');
      this.initialized = true;
      return;
    }

    try {
      if (config.email.provider === 'ses') {
        const sesClient = new SESv2Client({
          region: config.email.ses.region,
          ...(config.email.ses.accessKeyId && {
            credentials: {
              accessKeyId: config.email.ses.accessKeyId,
              secretAccessKey: config.email.ses.secretAccessKey,
            },
          }),
        });

        this.transporter = nodemailer.createTransport({ SES: { sesClient, SendEmailCommand } });
        logger.info('Email service initialized with SES', { region: config.email.ses.region });
      } else {
        if (config.email.provider !== 'smtp') {
          logger.warn(`Unknown email provider: ${config.email.provider}, defaulting to SMTP`);
        }

        this.transporter = nodemailer.createTransport({
          host: config.email.smtp.host,
          port: config.email.smtp.port,
          secure: config.email.smtp.secure,
          auth: config.email.smtp.user
            ? {
              user: config.email.smtp.user,
              pass: config.email.smtp.pass,
            }
            : undefined,
        });
        logger.info('Email service initialized with SMTP');
      }

      this.initialized = true;
    } catch (error) {
      logger.error('Failed to initialize email service:', error);
      this.initialized = true;
    }
  }

  /**
   * Send an email
   */
  async send(options: EmailOptions): Promise<boolean> {
    this.initialize();

    if (!config.email.enabled) {
      logger.debug('Email disabled, skipping send:', { to: options.to, subject: options.subject });
      return true;
    }

    if (!this.transporter) {
      logger.error('Email transporter not initialized');
      return false;
    }

    try {
      const result = await this.transporter.sendMail({
        from: `"${config.email.fromName}" <${config.email.from}>`,
        to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });

      logger.info('Email sent successfully', {
        messageId: result.messageId,
        to: options.to,
        subject: options.subject,
      });

      return true;
    } catch (error) {
      logger.error('Failed to send email:', error);
      return false;
    }
  }

  /**
   * Send organization invitation email
   */
  async sendInvitation(data: InvitationEmailData): Promise<boolean> {
    const inviteUrl = `${config.app.frontendUrl}/invite/accept?token=${data.invitationToken}`;
    const expiresFormatted = data.expiresAt.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const subject = `You've been invited to join ${data.organizationName}`;

    // Build OAuth providers text
    const oauthText = this.buildOAuthText(data);
    const oauthHtml = this.buildOAuthHtml(data);

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
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #4F46E5; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
    .button { display: inline-block; background: #4F46E5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; }
    .button:hover { background: #4338CA; }
    .footer { text-align: center; color: #6b7280; font-size: 14px; margin-top: 20px; }
    .role-badge { display: inline-block; background: #E0E7FF; color: #4F46E5; padding: 4px 12px; border-radius: 20px; font-size: 14px; font-weight: 500; }
    .oauth-section { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .oauth-badge { display: inline-block; background: #f3f4f6; color: #374151; padding: 6px 12px; border-radius: 6px; font-size: 13px; margin: 4px; }
  </style>
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

    return this.send({
      to: data.recipientEmail,
      subject,
      text,
      html,
    });
  }

  /**
   * Build OAuth text for plain text email
   */
  private buildOAuthText(data: InvitationEmailData): string {
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

  /**
   * Build OAuth HTML section for email
   */
  private buildOAuthHtml(data: InvitationEmailData): string {
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

  /**
   * Send invitation accepted notification to inviter
   */
  async sendInvitationAccepted(
    inviterEmail: string,
    inviterName: string,
    acceptedByName: string,
    organizationName: string,
  ): Promise<boolean> {
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
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
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

    return this.send({
      to: inviterEmail,
      subject,
      text,
      html,
    });
  }

  /**
   * Verify email configuration
   */
  async verify(): Promise<boolean> {
    this.initialize();

    if (!config.email.enabled || !this.transporter) {
      return false;
    }

    try {
      await this.transporter.verify();
      logger.info('Email service verified successfully');
      return true;
    } catch (error) {
      logger.error('Email service verification failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const emailService = new EmailService();
export default emailService;