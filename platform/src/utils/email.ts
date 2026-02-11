import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { createLogger } from '@mwashburn160/api-core';
import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config';

const logger = createLogger('platform-api');
import { invitationTemplate, invitationAcceptedTemplate } from './email-templates';

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
    const { subject, text, html } = invitationTemplate(data);
    return this.send({ to: data.recipientEmail, subject, text, html });
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
    const { subject, text, html } = invitationAcceptedTemplate(inviterName, acceptedByName, organizationName);
    return this.send({ to: inviterEmail, subject, text, html });
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
