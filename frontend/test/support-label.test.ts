// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { aliasLocalPart } from '../src/lib/support-label';

describe('aliasLocalPart', () => {
  it('strips the @domain from a support alias', () => {
    expect(aliasLocalPart('support@pipeline-builder')).toBe('support');
    expect(aliasLocalPart('help@pipeline-builder')).toBe('help');
  });
  it('returns the input unchanged when there is no @', () => {
    expect(aliasLocalPart('support')).toBe('support');
  });
  it('trims surrounding whitespace', () => {
    expect(aliasLocalPart('  support@pipeline-builder  ')).toBe('support');
  });
});
