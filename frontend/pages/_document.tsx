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
  return (
    <Html lang="en" className={fontClassNames}>
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
