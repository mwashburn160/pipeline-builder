// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { createLogger } from '@pipeline-builder/api-core';
import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config';
import { invitationTemplate, invitationAcceptedTemplate } from './email-templates';
import type { InvitationType, InvitationOAuthProvider } from '../models/invitation';

const logger = createLogger('email-service');

export interface EmailOptions {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

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
  allowedOAuthProviders?: InvitationOAuthProvider[];
  /**
   * BCP-47 locale for date formatting in the invitation email
   * (e.g., the `expiresAt` "expires on …" string).
   * Defaults to `'en-US'`. No caller passes this today — the field exists
   * so future i18n work (e.g., recipient-language detection) can flow
   * through without another signature change.
   */
  locale?: string;
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
      // Do NOT mark as initialized — allow retry on next call
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
        // Route SES sends through the configuration set so bounces/complaints
        // publish to the deploy's SNS topic. nodemailer's SESv2 transport
        // merges `ses` into the SendEmailCommand input. Omitted for SMTP / when
        // no config set is configured.
        ...(config.email.provider === 'ses' && config.email.ses.configurationSet
          ? { ses: { ConfigurationSetName: config.email.ses.configurationSet } }
          : {}),
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

  // Note: a `verify()` method (wrapping nodemailer's transporter.verify())
  // used to live here but was never called from platform startup; removed
  // rather than left as dead code. If a startup health check is ever wired
  // in (likely from `platform/src/index.ts`), reintroduce it there and
  // expose a method here that returns transporter.verify().
}

// Export singleton instance
export const emailService = new EmailService();
export default emailService;
