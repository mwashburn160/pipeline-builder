// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from '@jest/globals';
import { renderUntrustedMarkdown, UNTRUSTED_MARKDOWN_MAX_BYTES } from '../src/markdown.js';

/** Assert nothing executable or tracking survived. */
function expectInert(html: string): void {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/<svg/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/<style/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/javascript:/i);
  expect(html).not.toMatch(/vbscript:/i);
  expect(html).not.toMatch(/data:/i);
  expect(html).not.toMatch(/<!--/);
  expect(html).not.toMatch(/\sstyle=/i);
  expect(html).not.toMatch(/\sid=/i);
}

describe('renderUntrustedMarkdown', () => {
  it('renders the allowlisted structure', () => {
    const html = renderUntrustedMarkdown([
      '# Title', '', 'Some *em* and **strong** and ~~del~~.', '',
      '- a', '- b', '', '1. one', '', '> quote', '', '```ts', 'const x = 1;', '```', '', '---', '',
      '| a | b |', '|:--|--:|', '| 1 | 2 |',
    ].join('\n'));
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<del>del</del>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('<hr>');
    expect(html).toContain('<table>');
    expect(html).toContain('<td align="right">2</td>');
    expectInert(html);
  });

  it('hardens http(s) links with rel + target', () => {
    const html = renderUntrustedMarkdown('[site](https://example.com/x)');
    expect(html).toBe('<p><a href="https://example.com/x" rel="nofollow ugc noopener" target="_blank">site</a></p>');
  });

  it('keeps mailto links without a target', () => {
    const html = renderUntrustedMarkdown('[mail](mailto:a@example.com)');
    expect(html).toBe('<p><a href="mailto:a@example.com" rel="nofollow ugc noopener">mail</a></p>');
  });

  it.each([
    ['javascript: link', '[x](javascript:alert(1))'],
    ['uppercase javascript', '[x](JAVASCRIPT:alert(1))'],
    ['entity-encoded javascript', '[x](jav&#x61;script:alert(1))'],
    ['tab-split javascript', '[x](jav&#x09;ascript:alert(1))'],
    ['percent-encoded javascript', '[x](%6Aavascript:alert(1))'],
    ['vbscript', '[x](vbscript:msgbox(1))'],
    ['data: html', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['relative link', '[x](/admin/delete)'],
    ['protocol-relative', '[x](//evil.example/)'],
    ['fragment', '[x](#top)'],
  ])('drops the href of a %s (keeping the text)', (_label, md) => {
    const html = renderUntrustedMarkdown(md);
    expect(html).not.toMatch(/<a/);
    expect(html).toContain('x');
    expectInert(html);
  });

  it('drops raw HTML, including script and event handlers', () => {
    const html = renderUntrustedMarkdown([
      '<script>alert(1)</script>',
      '',
      '<img src=x onerror=alert(1)>',
      '',
      '<div onclick="alert(1)">click</div>',
      '',
      '<a href="javascript:alert(1)">raw</a>',
      '',
      'inline <b onmouseover=alert(1)>bold</b> text',
    ].join('\n'));
    expectInert(html);
    expect(html).not.toMatch(/<div|<b>|<b\s/);
  });

  it('drops inline SVG and iframes', () => {
    const html = renderUntrustedMarkdown('<svg><script>alert(1)</script></svg>\n\n<iframe src="https://evil"></iframe>');
    expectInert(html);
  });

  it('drops HTML comments', () => {
    expectInert(renderUntrustedMarkdown('before <!-- <script>alert(1)</script> --> after'));
  });

  it('drops every image: remote, data: and SVG', () => {
    const html = renderUntrustedMarkdown([
      '![pixel](https://tracker.example/p.gif)',
      '![d](data:image/png;base64,AAAA)',
      '![s](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
      '![rel](./logo.png)',
      '[![badge](https://img.shields.io/x)](https://example.com)',
    ].join('\n\n'));
    expectInert(html);
    // The badge's wrapping link survives, emptied of its image.
    expect(html).toContain('href="https://example.com"');
  });

  it('hardens GFM autolinks and bare URLs', () => {
    const html = renderUntrustedMarkdown('<https://example.com> and www.example.org and a@example.com');
    expect(html).toContain('<a href="https://example.com" rel="nofollow ugc noopener" target="_blank">');
    expect(html).toContain('href="http://www.example.org"');
    expect(html).toContain('href="mailto:a@example.com"');
    expectInert(html);
  });

  it('resolves reference links through the same policy', () => {
    const good = renderUntrustedMarkdown('[ok][r]\n\n[r]: https://example.com');
    expect(good).toContain('href="https://example.com" rel="nofollow ugc noopener"');
    const bad = renderUntrustedMarkdown('[bad][r]\n\n[r]: javascript:alert(1)');
    expect(bad).not.toMatch(/<a/);
    expectInert(bad);
  });

  it('escapes nested / double encodings rather than decoding them into markup', () => {
    const html = renderUntrustedMarkdown('&lt;script&gt;alert(1)&lt;/script&gt; and &amp;lt;img src=x onerror=alert(1)&amp;gt;');
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain('&#x3C;script>');
  });

  it('strips attributes smuggled on allowed tags (class, id, style)', () => {
    const html = renderUntrustedMarkdown('```js" onmouseover="alert(1)\ncode\n```');
    expectInert(html);
    expect(html).not.toContain('onmouseover');
  });

  it('drops GFM task-list checkboxes (no <input>)', () => {
    const html = renderUntrustedMarkdown('- [x] done\n- [ ] todo');
    expect(html).not.toMatch(/<input/);
    expect(html).toContain('done');
  });

  it('refuses oversized input', () => {
    expect(() => renderUntrustedMarkdown('a'.repeat(UNTRUSTED_MARKDOWN_MAX_BYTES + 1))).toThrow(RangeError);
  });
});
