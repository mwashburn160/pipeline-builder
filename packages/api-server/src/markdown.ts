// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side renderer for UNTRUSTED markdown — plugin READMEs, security
 * advisories, reviews and review replies (docs/plugin-publishing.md
 * "Markdown safety").
 *
 * Import it through its own subpath, never the package root:
 *   import { renderUntrustedMarkdown } from '@pipeline-builder/api-server/lib/markdown.js';
 * The unified/remark/rehype stack is ESM-only and only the few services that
 * render markdown should load it. It is server-only by design: api-core (which
 * the frontend imports) must not carry it, and the stored HTML this produces is
 * the ONLY form that is ever served — client-side rendering of untrusted
 * markdown is forbidden.
 *
 * Pipeline: remark-parse → remark-gfm → remark-rehype (raw HTML is DROPPED, not
 * passed through: no `allowDangerousHtml`) → rehype-sanitize (strict allowlist
 * below) → link policy (http(s)/mailto only, `rel="nofollow ugc noopener"`) →
 * rehype-stringify. Every image is dropped: remote images are tracking pixels,
 * and a README has no same-origin images to show.
 */

import type { Element, ElementContent, Root, RootContent } from 'hast';
import rehypeSanitize, { type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

/**
 * Hard input cap (bytes, UTF-8). Callers enforce their own tighter limits (a
 * README is ≤ 64 KB); this bounds the parser for any caller that forgets.
 */
export const UNTRUSTED_MARKDOWN_MAX_BYTES = 64 * 1024;

/** `rel` set on every surviving link. */
export const UNTRUSTED_LINK_REL = 'nofollow ugc noopener';

/**
 * The strict allowlist. Anything not named here is unwrapped (its text kept)
 * or, for the `strip` set, removed with its content. No `id`/`name` (so no DOM
 * clobbering), no `style`, no event handlers, no `img`, no raw HTML, no
 * comments, no doctypes.
 */
const SANITIZE_SCHEMA: SanitizeSchema = {
  tagNames: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'blockquote',
    'ul', 'ol', 'li',
    'pre', 'code',
    'em', 'strong', 'del',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a',
  ],
  attributes: {
    a: ['href'],
    // Fenced-code language hint only (`language-ts`), for client highlighting.
    code: [['className', /^language-[a-z0-9+#-]{1,32}$/]],
    ol: ['start'],
    th: [['align', 'left', 'right', 'center']],
    td: [['align', 'left', 'right', 'center']],
  },
  protocols: { href: ['http', 'https', 'mailto'] },
  // Removed WITH their content (never unwrapped into visible text).
  strip: ['script', 'style', 'svg', 'math', 'iframe', 'object', 'embed', 'template', 'noscript'],
  allowComments: false,
  allowDoctypes: false,
  clobber: [],
  clobberPrefix: '',
  required: {},
  ancestors: {},
};

/** An href that may survive: absolute http(s) or mailto. Relative and fragment
 *  links are dropped too — a relative README link would resolve INTO this app. */
const SAFE_HREF = /^(?:https?:\/\/[^\s/]|mailto:[^\s])/i;

/**
 * Link policy, run AFTER sanitize: keep only absolute http(s)/mailto hrefs (an
 * anchor without one is unwrapped to its text), stamp `rel`, and open web links
 * in a new tab. Drops any `img` defensively even though the schema already
 * excludes it.
 */
function rehypeLinkPolicy() {
  const rewrite = (children: Array<RootContent | ElementContent>): Array<RootContent | ElementContent> => {
    const out: Array<RootContent | ElementContent> = [];
    for (const node of children) {
      if (node.type !== 'element') {
        out.push(node);
        continue;
      }
      const el = node as Element;
      if (el.tagName === 'img') continue;
      el.children = rewrite(el.children) as ElementContent[];
      if (el.tagName === 'a') {
        const href = typeof el.properties?.href === 'string' ? el.properties.href.trim() : '';
        if (!SAFE_HREF.test(href)) {
          out.push(...el.children);
          continue;
        }
        const web = /^https?:/i.test(href);
        el.properties = {
          href,
          rel: UNTRUSTED_LINK_REL.split(' '),
          ...(web ? { target: '_blank' } : {}),
        };
      }
      out.push(el);
    }
    return out;
  };
  return (tree: Root) => {
    tree.children = rewrite(tree.children) as RootContent[];
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize, SANITIZE_SCHEMA)
  .use(rehypeLinkPolicy)
  .use(rehypeStringify)
  .freeze();

/**
 * Render untrusted markdown to sanitized HTML, safe to store and serve as-is.
 *
 * @throws RangeError when `md` exceeds {@link UNTRUSTED_MARKDOWN_MAX_BYTES}.
 */
export function renderUntrustedMarkdown(md: string): string {
  if (Buffer.byteLength(md, 'utf8') > UNTRUSTED_MARKDOWN_MAX_BYTES) {
    throw new RangeError(`Markdown exceeds ${UNTRUSTED_MARKDOWN_MAX_BYTES} bytes`);
  }
  return String(processor.processSync(md));
}
