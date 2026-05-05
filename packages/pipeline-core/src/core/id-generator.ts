// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';

/**
 * Generates unique CDK construct IDs by appending auto-incrementing counters
 * to labels, with an optional stack-identity hash inserted after the first
 * namespace segment to prevent collisions across pipelines/orgs.
 *
 * Why the hash matters:
 *   AWS resources with explicit names (CloudWatch log groups, IAM roles)
 *   collide if two CDK stacks generate the same name. When org A's
 *   spring-boot pipeline and org B's spring-boot pipeline both deploy a
 *   `plugin-lookup-1` log group, the second deploy fails with
 *   "Resource already exists". The hash makes each (project, org) pair
 *   produce a unique stable name without changing the rest of the label.
 *
 * Format with org+project:
 *   generate('plugin:lookup')   → 'plugin:{hash}:lookup:1'
 *   generate('log:group')       → 'log:{hash}:group:1'
 *   generate('plugin:lookup')   → 'plugin:{hash}:lookup:2'   (counter inc)
 *   generate('cdk:pipeline:1')  → 'cdk:pipeline:1'           (already counted)
 *
 * Format without org+project (backward compat):
 *   generate('plugin:lookup')   → 'plugin:lookup:1'
 *
 * @example
 * ```typescript
 * const id = new UniqueId({ organization: 'AcmeCorp', project: 'spring-boot' });
 * id.generate('plugin:lookup');   // "plugin:a1b2c3d4:lookup:1"
 * id.generate('log:group');       // "log:a1b2c3d4:group:1"
 * id.generate('plugin:lookup');   // "plugin:a1b2c3d4:lookup:2"
 * ```
 */
export interface UniqueIdOptions {
  /** Organization name — combined with project to form the stack-identity hash. */
  readonly organization?: string;
  /** Project name — combined with organization to form the stack-identity hash. */
  readonly project?: string;
}

export class UniqueId {
  private readonly _counters = new Map<string, number>();
  private readonly _stackId: string;

  constructor(opts: UniqueIdOptions = {}) {
    if (opts.organization && opts.project) {
      // 8 hex chars = 32 bits = 1 in 4 billion collision odds across pipelines.
      // Lowercased for case-insensitive stability ("AcmeCorp" === "acmecorp").
      this._stackId = createHash('sha256')
        .update(`${opts.project}:${opts.organization}`.toLowerCase())
        .digest('hex')
        .slice(0, 8);
    } else {
      this._stackId = '';
    }
  }

  /**
   * Returns a unique construct ID for the given label.
   * If the label already ends with a numeric counter, it is returned as-is.
   * Otherwise, an auto-incrementing counter is appended; if a stack-identity
   * hash was provided at construction, it's inserted after the first segment.
   *
   * @param label - Colon-separated namespace (e.g., 'plugin:lookup')
   * @returns The label with hash + counter inserted
   */
  generate(label: string): string {
    if (!label || typeof label !== 'string') {
      throw new Error('Label must be a non-empty string');
    }

    // Already counted (e.g., 'cdk:pipeline:1') — pass through.
    if (/:\d+$/.test(label)) {
      return label;
    }

    const count = (this._counters.get(label) ?? 0) + 1;
    this._counters.set(label, count);

    if (!this._stackId) {
      return `${label}:${count}`;
    }

    // Insert the stack hash after the first namespace segment so the leading
    // category (`plugin`, `log`, `resource`, etc.) stays human-readable.
    const idx = label.indexOf(':');
    if (idx === -1) {
      // Single-segment label — put the hash before the counter.
      return `${label}:${this._stackId}:${count}`;
    }
    const head = label.slice(0, idx);
    const tail = label.slice(idx + 1);
    return `${head}:${this._stackId}:${tail}:${count}`;
  }

  /** The stack-identity hash, or empty string when not configured. */
  get stackId(): string {
    return this._stackId;
  }
}
