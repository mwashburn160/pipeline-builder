/**
 * Tests for metrics utilities.
 * normalizeRoute is not exported directly, so we test the regex logic used by it.
 */

describe('normalizeRoute regex patterns', () => {
  // Replicate the normalizeRoute logic since the function is module-private
  function normalizeRoute(path: string): string {
    return path
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+(?=\/|$)/g, '/:id');
  }

  it('should replace UUIDs with :id', () => {
    expect(normalizeRoute('/plugins/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('/plugins/:id');
  });

  it('should replace multiple UUIDs', () => {
    expect(normalizeRoute('/orgs/550e8400-e29b-41d4-a716-446655440000/plugins/660e8400-e29b-41d4-a716-446655440000'))
      .toBe('/orgs/:id/plugins/:id');
  });

  it('should replace numeric IDs', () => {
    expect(normalizeRoute('/users/123')).toBe('/users/:id');
    expect(normalizeRoute('/users/123/posts/456')).toBe('/users/:id/posts/:id');
  });

  it('should not replace non-ID path segments', () => {
    expect(normalizeRoute('/health')).toBe('/health');
    expect(normalizeRoute('/api/plugins')).toBe('/api/plugins');
  });

  it('should handle UUIDs in uppercase', () => {
    expect(normalizeRoute('/plugins/550E8400-E29B-41D4-A716-446655440000'))
      .toBe('/plugins/:id');
  });

  it('should handle trailing numeric ID without slash', () => {
    expect(normalizeRoute('/items/99')).toBe('/items/:id');
  });

  it('should not replace numbers within path segments', () => {
    expect(normalizeRoute('/api/v2/plugins')).toBe('/api/v2/plugins');
  });
});
