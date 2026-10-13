// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Head from 'next/head';
import Link from 'next/link';

/**
 * `/privacy` — the public privacy policy. Static and credential-free: it must
 * render for logged-out visitors (it is linked from the landing footer and
 * cited to AWS for SES production access), so it reads no auth state.
 *
 * Keep the facts here true of the code: the only cookies are the essential
 * `pb_*` sign-in/security cookies, the frontend loads no analytics or ad
 * scripts, and every email is transactional, sent through Amazon SES.
 */

const EFFECTIVE = 'October 12, 2026';
const CONTACT = 'privacy@pipeline-builder.com';

interface Section {
  title: string;
  body: (string | string[])[];
}

const SECTIONS: Section[] = [
  {
    title: 'Who we are',
    body: [
      'Pipeline Builder ("we", "us") operates pipeline-builder.com, a service for building and running CI/CD pipelines that deploy into your own AWS account. This policy explains what personal information we collect, how we use it, and the choices you have.',
    ],
  },
  {
    title: 'Information we collect',
    body: [
      [
        'Account information: your name, email address, and a hashed password, or your profile details from a sign-in provider you choose (such as Google, GitHub, GitLab, Microsoft, LinkedIn or Facebook).',
        'Organization information: the organizations you belong to, your role, and invitations you send or receive.',
        'Content you provide: pipeline definitions, plugins, compliance rules, and other configuration you create in the service.',
        'Operational data: IP addresses, request and audit logs, and pipeline run records, used to operate and secure the service.',
        'Billing information: if you subscribe through AWS Marketplace, the customer and entitlement identifiers AWS provides. We do not receive or store payment card details.',
      ],
    ],
  },
  {
    title: 'How we use information',
    body: [
      [
        'To provide the service: create and secure your account, run your pipelines, and show you their results.',
        'To send transactional email: sign-in and verification links, password resets, organization invitations, and notifications you trigger or opt into.',
        'To keep the service secure and reliable: detect abuse, investigate incidents, and keep audit records.',
        'To meet legal obligations.',
      ],
      'We do not sell your personal information, and we do not use it for advertising.',
    ],
  },
  {
    title: 'Email',
    body: [
      'We send only transactional email, from noreply@pipeline-builder.com, using Amazon Simple Email Service (SES). We do not send marketing email. Addresses that bounce or report a message as spam are automatically suppressed from further sending. You can turn off many notification emails in your account settings.',
    ],
  },
  {
    title: 'Cookies',
    body: [
      'We use only cookies that are essential to signing in and keeping your session secure (for example, a session-refresh cookie and short-lived cookies that protect sign-in and single sign-on flows). We do not use analytics, advertising or third-party tracking cookies.',
    ],
  },
  {
    title: 'How we share information',
    body: [
      'We share information only as needed to run the service:',
      [
        'Amazon Web Services, which hosts the service and delivers our email.',
        'AWS Marketplace, if you subscribe through it.',
        'Sign-in providers you choose to use, to authenticate you.',
        'AI providers your organization configures with its own credentials, when you use AI features.',
        'Authorities, when required by law or to protect the rights and safety of our users.',
      ],
      'Pipelines you build run in your own AWS account, under your control.',
    ],
  },
  {
    title: 'Data retention',
    body: [
      'We keep account information while your account is active. By default, deleted items are removed after 30 days, audit logs are kept for 90 days, pipeline run events for 30 days, and database backups for 7 days. Some records may be kept longer where the law requires it.',
    ],
  },
  {
    title: 'Security',
    body: [
      'We encrypt data in transit, isolate each organization’s data, restrict internal access, and keep audit logs of administrative actions. No system is perfectly secure, but we work to protect your information.',
    ],
  },
  {
    title: 'Your choices and rights',
    body: [
      `You can access and update your account information in the service. To request a copy of your data, its correction, or deletion of your account, email ${CONTACT}. Depending on where you live, you may have additional rights under local law, and we will honor them.`,
    ],
  },
  {
    title: 'Children',
    body: ['The service is not directed to children under 16, and we do not knowingly collect their personal information.'],
  },
  {
    title: 'Changes to this policy',
    body: ['We may update this policy. We will change the effective date above, and for material changes we will notify account holders by email or in the service.'],
  },
  {
    title: 'Contact',
    body: [`Questions about this policy or your data: ${CONTACT}.`],
  },
];

export default function PrivacyPolicy() {
  return (
    <>
      <Head>
        <title>Privacy Policy — Pipeline Builder</title>
        <meta name="description" content="How Pipeline Builder collects, uses and protects your information." />
      </Head>
      <main className="max-w-3xl mx-auto px-6 py-12 text-fg">
        <Link href="/" className="font-serif text-lg font-bold text-fg">Pipeline Builder</Link>
        <h1 className="font-serif text-3xl font-bold mt-8">Privacy Policy</h1>
        <p className="text-sm text-fg-muted mt-2">Effective {EFFECTIVE}</p>
        {SECTIONS.map((s) => (
          <section key={s.title} className="mt-8">
            <h2 className="font-serif text-xl font-bold">{s.title}</h2>
            {s.body.map((b, i) =>
              Array.isArray(b) ? (
                <ul key={i} className="list-disc pl-6 mt-3 space-y-1.5 text-sm leading-relaxed">
                  {b.map((li) => <li key={li}>{li}</li>)}
                </ul>
              ) : (
                <p key={i} className="mt-3 text-sm leading-relaxed">{b}</p>
              ),
            )}
          </section>
        ))}
      </main>
    </>
  );
}
