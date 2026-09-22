// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for validation/dockerfile-static — the static read of a plugin's OWN
 * Dockerfile: its LABELs and final USER.
 */

import { describe, it, expect } from '@jest/globals';
import { OCI_LABELS, parseDockerfile, parseLabelArgs } from '../src/validation/dockerfile-static.js';

describe('parseLabelArgs', () => {
  it('reads key=value pairs with double quotes, escapes and single quotes', () => {
    expect(parseLabelArgs('a=1 "b"="two words" c=\'lit $x\' d="say \\"hi\\""')).toEqual([
      ['a', '1'], ['b', 'two words'], ['c', 'lit $x'], ['d', 'say "hi"'],
    ]);
  });

  it('reads the legacy `LABEL key value` form', () => {
    expect(parseLabelArgs('maintainer Jane Doe <jane@example.com>')).toEqual([['maintainer', 'Jane Doe <jane@example.com>']]);
  });

  it('yields nothing for an unterminated quote or an empty legacy value', () => {
    expect(parseLabelArgs('a="open')).toEqual([]);
    expect(parseLabelArgs('lonely')).toEqual([]);
  });

  it('skips words that are not key=value', () => {
    expect(parseLabelArgs('a=1 =nokey b=2')).toEqual([['a', '1'], ['b', '2']]);
  });
});

describe('parseDockerfile', () => {
  it('reads the OCI labels, joining line continuations and skipping comments inside them', () => {
    const facts = parseDockerfile([
      'FROM alpine:3.20',
      'LABEL org.opencontainers.image.title="Trivy scan" \\',
      '      # a comment inside the continuation',
      '      org.opencontainers.image.description="Scans images for CVEs." \\',
      '',
      '      org.opencontainers.image.licenses=Apache-2.0',
      'USER 10001',
    ].join('\n'));
    expect(facts.labels).toEqual({
      [OCI_LABELS.title]: 'Trivy scan',
      [OCI_LABELS.description]: 'Scans images for CVEs.',
      [OCI_LABELS.licenses]: 'Apache-2.0',
    });
    expect(facts.finalUser).toBe('10001');
  });

  it('ignores values containing `$` (build args are unknown at upload), including a later override', () => {
    const facts = parseDockerfile([
      'ARG VERSION=1',
      'FROM alpine',
      'LABEL org.opencontainers.image.source=https://github.com/acme/p',
      'LABEL org.opencontainers.image.source=https://github.com/acme/${VERSION}',
      'LABEL org.opencontainers.image.version=$VERSION',
    ].join('\n'));
    expect(facts.labels).toEqual({});
  });

  it('uses only the final stage — labels and USER in a discarded build stage never reach the image', () => {
    const facts = parseDockerfile([
      'FROM golang:1.23 AS build',
      'LABEL org.opencontainers.image.title=builder',
      'USER builder',
      'FROM alpine',
      'LABEL org.opencontainers.image.description=final',
    ].join('\n'));
    expect(facts.labels).toEqual({ [OCI_LABELS.description]: 'final' });
    expect(facts.finalUser).toBeNull();
  });

  it('includes an earlier stage the final one is built FROM (its own content), later values winning', () => {
    const facts = parseDockerfile([
      'FROM --platform=linux/amd64 alpine AS base',
      'LABEL a=from-base b=base',
      'USER app',
      'FROM base',
      'LABEL b=final',
    ].join('\n'));
    expect(facts.labels).toEqual({ a: 'from-base', b: 'final' });
    expect(facts.finalUser).toBe('app');
  });

  it('honours the `# escape=` parser directive', () => {
    const facts = parseDockerfile([
      '# escape=`',
      'FROM mcr.microsoft.com/windows',
      'LABEL a=1 `',
      '      b=2',
    ].join('\r\n'));
    expect(facts.labels).toEqual({ a: '1', b: '2' });
  });

  it('is empty for no content, no FROM, or instructions before the first FROM', () => {
    expect(parseDockerfile(null)).toEqual({ labels: {}, finalUser: null, baseImage: null });
    expect(parseDockerfile('LABEL a=1\nUSER root')).toEqual({ labels: {}, finalUser: null, baseImage: null });
    expect(parseDockerfile('# only a comment\n\n')).toEqual({ labels: {}, finalUser: null, baseImage: null });
  });

  it('treats an empty USER as unset', () => {
    expect(parseDockerfile('FROM alpine\nUSER   ').finalUser).toBeNull();
  });

  it('reports the external base image of the final stage, following stage aliases', () => {
    expect(parseDockerfile('FROM pipeline-plugin-base:24.04\nRUN true').baseImage).toBe('pipeline-plugin-base:24.04');
    expect(parseDockerfile([
      'FROM golang:1.23 AS Build',
      'FROM ubuntu@sha256:' + 'a'.repeat(64) + ' AS runtime',
      'FROM runtime',
      'COPY --from=build /x /x',
    ].join('\n')).baseImage).toBe('ubuntu@sha256:' + 'a'.repeat(64));
    expect(parseDockerfile('FROM --platform=linux/amd64 Registry.example/Img:Tag').baseImage).toBe('Registry.example/Img:Tag');
  });

  it('has no base image for scratch or a build-argument base', () => {
    expect(parseDockerfile('FROM scratch').baseImage).toBeNull();
    expect(parseDockerfile('ARG V=1\nFROM node:${V}').baseImage).toBeNull();
  });
});
