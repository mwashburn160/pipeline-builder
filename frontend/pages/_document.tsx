import { Html, Head, Main, NextScript } from 'next/document';
import { fontClassNames } from '@/lib/fonts';

/**
 * Custom document, added for one reason: `next/font` exposes each face as a CSS
 * variable that has to be declared on an ancestor of everything that uses it.
 * globals.css sets `font-family` on `body` and on the heading elements, so the
 * variables must live on `<html>` — which only the document can reach.
 *
 * `lang` is set here too; without it every page shipped an unlabelled document.
 */
export default function Document() {
  // Search Console ownership proof, rendered only when the deployment sets one.
  //
  // Read from the runtime env rather than hardcoded, because a verification
  // token belongs to ONE property: the token on the GitHub Pages docs site
  // (_includes/head-custom.html) proves ownership of that site and would prove
  // nothing here. Each deployment that wants its app domain verified sets the
  // token Search Console issued for THAT domain.
  //
  // Not a secret — it is served in the HTML of every page by design — so it
  // travels in app-env, never app-secrets. _document renders server-side only,
  // so no NEXT_PUBLIC_ prefix is needed and the value never enters the client
  // bundle as a build-time constant; it is read per render, which is what lets
  // one image serve different domains.
  const siteVerification = process.env.GOOGLE_SITE_VERIFICATION;
  return (
    <Html lang="en" className={fontClassNames}>
      <Head>
        {siteVerification && <meta name="google-site-verification" content={siteVerification} />}
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
