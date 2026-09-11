// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// Grounding / retrieval for the "Ask" agent's how-to answers.
//
// A dependency-free BM25 index over documentation chunks. The service layer loads
// `docs/*.md`, splits each file into heading-scoped chunks via `chunkMarkdown`, and
// builds an index with `buildGroundingIndex`; `answer-how-to` retrieves the top
// chunks to ground the model. Kept pure (no fs / no network) so it is unit-testable
// and reusable across the service and tests.

/** A retrievable documentation chunk. */
export interface GroundingDoc {
  /** Stable identifier, e.g. `deployment.md#in-cluster-alertmanager`. */
  id: string;
  /** The chunk text (heading + body) that gets searched and shown to the model. */
  text: string;
  /** Human-readable section title, for source attribution. */
  title?: string;
  /** Deep-link the answer can cite (dashboard path or docs URL). */
  url?: string;
}

/** A scored retrieval result. */
export interface GroundingHit {
  doc: GroundingDoc;
  score: number;
}

/** A built, queryable index. */
export interface GroundingIndex {
  search(query: string, k?: number): GroundingHit[];
  readonly size: number;
}

// A small English stopword set — dropping these sharpens BM25 on short how-to
// queries ("how do I ...") without needing a full NLP dependency.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in', 'on',
  'for', 'with', 'as', 'by', 'at', 'from', 'is', 'are', 'be', 'do', 'does', 'did',
  'how', 'what', 'when', 'where', 'which', 'who', 'why', 'can', 'i', 'you', 'my', 'me',
  'it', 'this', 'that', 'these', 'those', 'we', 'our', 'us', 'so', 'up', 'out',
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and 1-char tokens. */
export function tokenize(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return tokens.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Slugify a heading for use in a chunk id / anchor. */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Split a Markdown document into heading-scoped chunks. Content before the first
 * heading becomes an intro chunk; each subsequent chunk spans a heading and its body
 * up to the next heading of any level. Front-matter (`--- ... ---`) is stripped.
 *
 * @param markdown - Raw Markdown source
 * @param meta - `id` prefix (e.g. the file's base name) and optional base `url`
 * @returns One GroundingDoc per section (empty sections skipped)
 */
export function chunkMarkdown(markdown: string, meta: { id: string; url?: string }): GroundingDoc[] {
  // Strip YAML front-matter if present.
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const lines = body.split('\n');

  const chunks: GroundingDoc[] = [];
  let heading = '';
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    const anchor = heading ? slugify(heading) : `intro-${chunks.length}`;
    chunks.push({
      id: `${meta.id}#${anchor}`,
      text: heading ? `${heading}\n${text}` : text,
      title: heading || meta.id,
      url: meta.url,
    });
  };

  // Track fenced code blocks (``` or ~~~) so shell/YAML comment lines starting with
  // `#` inside a fence are NOT mistaken for Markdown headings (which would split a
  // runnable example across chunks and fabricate bogus section titles).
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    const m = inFence ? null : /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}

/** A source documentation file to be chunked and indexed. */
export interface DocFile {
  /** Id prefix for the file's chunks, e.g. `deployment.md`. */
  id: string;
  /** Raw Markdown contents. */
  content: string;
  /** Optional base deep-link the chunks can cite. */
  url?: string;
}

/**
 * Convenience: chunk a set of Markdown files and build one combined index. The HTTP
 * service reads `docs/*.md` from disk and passes the contents here — the fs access
 * stays in the service so this module remains pure and testable.
 *
 * @param files - Markdown files to index
 * @returns A queryable index over every file's chunks
 */
export function buildDocsIndexFromFiles(files: DocFile[]): GroundingIndex {
  const chunks = files.flatMap((f) => chunkMarkdown(f.content, { id: f.id, url: f.url }));
  return buildGroundingIndex(chunks);
}

/**
 * Build a BM25 index over the given chunks. BM25 params are the standard
 * k1=1.5, b=0.75. Search is case-insensitive and stopword-filtered.
 *
 * @param docs - Chunks to index
 * @returns A queryable {@link GroundingIndex}
 */
export function buildGroundingIndex(docs: GroundingDoc[]): GroundingIndex {
  const k1 = 1.5;
  const b = 0.75;

  const postings = docs.map((doc) => {
    const terms = tokenize(doc.text);
    const freq = new Map<string, number>();
    for (const t of terms) freq.set(t, (freq.get(t) ?? 0) + 1);
    return { doc, freq, length: terms.length };
  });

  // Document frequency per term.
  const df = new Map<string, number>();
  for (const p of postings) {
    for (const term of p.freq.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const N = postings.length;
  const avgdl = N > 0 ? postings.reduce((s, p) => s + p.length, 0) / N : 0;

  const idf = (term: string): number => {
    const n = df.get(term) ?? 0;
    if (n === 0) return 0;
    // BM25 idf with +1 to keep it non-negative.
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };

  return {
    size: N,
    search(query: string, k = 5): GroundingHit[] {
      const qterms = tokenize(query);
      if (qterms.length === 0 || N === 0) return [];
      // Compute idf once per distinct query term (not once per posting).
      const qidf = new Map<string, number>();
      for (const term of qterms) if (!qidf.has(term)) qidf.set(term, idf(term));
      const hits: GroundingHit[] = [];
      for (const p of postings) {
        let score = 0;
        for (const term of qterms) {
          const f = p.freq.get(term);
          if (!f) continue;
          const denom = f + k1 * (1 - b + (b * p.length) / (avgdl || 1));
          score += (qidf.get(term) ?? 0) * ((f * (k1 + 1)) / denom);
        }
        if (score > 0) hits.push({ doc: p.doc, score });
      }
      hits.sort((a, b2) => b2.score - a.score);
      return hits.slice(0, k);
    },
  };
}
