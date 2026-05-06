// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

jest.mock('../src/config', () => ({
  config: {
    app: { frontendUrl: 'https://app.example.com' },
    email: { fromName: 'Pipeline Builder' },
  },
}));

jest.mock('fs', () => {
  const actualFs = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actualFs,
    readFileSync: jest.fn((path: string, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.endsWith('invitation.html')) {
        return '<p>Hi from {{inviterName}}</p><p>{{organizationName}} ({{role}})</p><a href="{{inviteUrl}}">{{inviteUrl}}</a>{{oauthHtml}}<span>{{expiresFormatted}}</span><footer>{{fromName}}</footer>';
      }
      if (typeof path === 'string' && path.endsWith('invitation-accepted.html')) {
        return '<p>{{inviterName}} - {{acceptedByName}} joined {{organizationName}}</p><footer>{{fromName}}</footer>';
      }
      return (actualFs.readFileSync as unknown as (...args: unknown[]) => unknown)(path, ...rest);
    }),
  };
});

import type { InvitationEmailData } from '../src/utils/email';
import { invitationTemplate, invitationAcceptedTemplate } from '../src/utils/email-templates';

function buildData(overrides: Partial<InvitationEmailData> = {}): InvitationEmailData {
  return {
    recipientEmail: 'user@example.com',
    inviterName: 'Alice',
    organizationName: 'Acme Inc',
    invitationToken: 'tok-123',
    expiresAt: new Date('2026-12-31T00:00:00Z'),
    role: 'member',
    ...overrides,
  };
}

describe('invitationTemplate', () => {
  it('should produce subject containing organization name', () => {
    const result = invitationTemplate(buildData());
    expect(result.subject).toBe("You've been invited to join Acme Inc");
  });

  it('should include invite URL with token in text', () => {
    const result = invitationTemplate(buildData());
    expect(result.text).toContain('https://app.example.com/invite/accept?token=tok-123');
  });

  it('should substitute placeholders in HTML', () => {
    const result = invitationTemplate(buildData());
    expect(result.html).toContain('Alice');
    expect(result.html).toContain('Acme Inc');
    expect(result.html).toContain('member');
    expect(result.html).toContain('Pipeline Builder');
  });

  it('should include OAuth providers when invitationType=oauth', () => {
    const result = invitationTemplate(
      buildData({ invitationType: 'oauth', allowedOAuthProviders: ['google', 'github'] }),
    );
    expect(result.text).toContain('google, github');
    expect(result.html).toContain('Google');
    expect(result.html).toContain('GitHub');
  });

  it('should warn about email-only invitation in text', () => {
    const result = invitationTemplate(buildData({ invitationType: 'email' }));
    expect(result.text).toContain('email and password');
    expect(result.html).toContain('email and password');
  });

  it('should handle "any" type with default Google provider', () => {
    const result = invitationTemplate(buildData({ invitationType: 'any' }));
    expect(result.text).toContain('Google');
  });

  it('should include formatted expiration date', () => {
    const result = invitationTemplate(buildData());
    // toLocaleDateString output varies by locale but should contain year
    expect(result.text).toContain('2026');
  });
});

describe('invitationAcceptedTemplate', () => {
  it('should produce subject with acceptedByName and organizationName', () => {
    const result = invitationAcceptedTemplate('Alice', 'Bob', 'Acme Inc');
    expect(result.subject).toBe('Bob has joined Acme Inc');
  });

  it('should greet inviter in body text', () => {
    const result = invitationAcceptedTemplate('Alice', 'Bob', 'Acme Inc');
    expect(result.text).toContain('Hello Alice');
    expect(result.text).toContain('Bob has accepted');
    expect(result.text).toContain('Acme Inc');
  });

  it('should substitute placeholders in HTML', () => {
    const result = invitationAcceptedTemplate('Alice', 'Bob', 'Acme Inc');
    expect(result.html).toContain('Alice');
    expect(result.html).toContain('Bob');
    expect(result.html).toContain('Acme Inc');
    expect(result.html).toContain('Pipeline Builder');
  });
});
