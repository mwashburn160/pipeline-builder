/**
 * Generates unique CDK construct IDs by appending auto-incrementing counters to labels.
 * Labels that already end with a numeric counter (e.g., 'cdk:pipeline:1') are returned as-is.
 *
 * @example
 * ```typescript
 * const id = new UniqueId();
 *
 * id.generate('plugin:lookup');   // "plugin:lookup:1"
 * id.generate('cdk:synth');       // "cdk:synth:1"
 * id.generate('plugin:lookup');   // "plugin:lookup:2"
 * id.generate('cdk:pipeline:1'); // "cdk:pipeline:1" (already has counter)
 * ```
 */
export class UniqueId {
  private readonly _counters = new Map<string, number>();

  /**
   * Returns a unique construct ID for the given label.
   * If the label already ends with a numeric counter, it is returned as-is.
   * Otherwise, an auto-incrementing counter is appended.
   *
   * @param label - Colon-separated namespace (e.g., 'plugin:lookup')
   * @returns The label with counter appended, or unchanged if it already has one
   */
  generate(label: string): string {
    if (!label || typeof label !== 'string') {
      throw new Error('Label must be a non-empty string');
    }

    // If label already ends with a numeric counter, return as-is
    if (/:\d+$/.test(label)) {
      return label;
    }

    const count = (this._counters.get(label) ?? 0) + 1;
    this._counters.set(label, count);

    return `${label}:${count}`;
  }
}
