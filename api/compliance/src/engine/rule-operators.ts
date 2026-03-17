/**
 * Rule operator evaluation functions.
 *
 * Each operator takes a field value from the entity and a rule value,
 * returning true if the condition is MET (no violation) or false if VIOLATED.
 */

import type { RuleOperator } from '@mwashburn160/pipeline-core';

const MAX_REGEX_LENGTH = 200;

/**
 * Safely compile and test a regex pattern with length limits.
 * Returns false (violation) if pattern is invalid or too long.
 */
function safeRegexTest(pattern: string, value: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH) return false;
  try {
    const regex = new RegExp(pattern);
    return regex.test(value);
  } catch {
    return false;
  }
}

/**
 * Get a nested value from an object using dot-notation path.
 * Supports computed field prefixes: $count(), $length(), $keys(), $lines()
 */
export function getFieldValue(entity: Record<string, unknown>, fieldPath: string): unknown {
  // Handle computed fields
  const computedMatch = fieldPath.match(/^\$(\w+)\((.+)\)$/);
  if (computedMatch) {
    const [, fn, innerPath] = computedMatch;
    const innerValue = getFieldValue(entity, innerPath);

    switch (fn) {
      case 'count':
        if (Array.isArray(innerValue)) return innerValue.length;
        if (innerValue && typeof innerValue === 'object') return Object.keys(innerValue).length;
        return 0;
      case 'length':
        if (typeof innerValue === 'string') return innerValue.length;
        return 0;
      case 'keys':
        if (innerValue && typeof innerValue === 'object' && !Array.isArray(innerValue)) {
          return Object.keys(innerValue);
        }
        return [];
      case 'lines':
        if (typeof innerValue === 'string') return innerValue.split('\n').length;
        return 0;
      default:
        return undefined;
    }
  }

  // Standard dot-notation traversal
  const parts = fieldPath.split('.');
  let current: unknown = entity;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Evaluate a single operator against field and rule values.
 *
 * Returns true if the condition is SATISFIED (no violation).
 * Returns false if the condition is VIOLATED.
 */
export function evaluateOperator(
  operator: RuleOperator,
  fieldValue: unknown,
  ruleValue: unknown,
): boolean {
  switch (operator) {
    // Equality
    case 'eq':
      return fieldValue === ruleValue || String(fieldValue) === String(ruleValue);
    case 'neq':
      return fieldValue !== ruleValue && String(fieldValue) !== String(ruleValue);

    // String containment
    case 'contains':
      if (typeof fieldValue === 'string' && typeof ruleValue === 'string') {
        return fieldValue.toLowerCase().includes(ruleValue.toLowerCase());
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.some((v) => String(v).toLowerCase() === String(ruleValue).toLowerCase());
      }
      return false;
    case 'notContains':
      return !evaluateOperator('contains', fieldValue, ruleValue);

    // Regex
    case 'regex':
      if (typeof ruleValue !== 'string') return false;
      return safeRegexTest(ruleValue, String(fieldValue ?? ''));

    // Numeric comparison
    case 'gt':
      return Number(fieldValue) > Number(ruleValue);
    case 'gte':
      return Number(fieldValue) >= Number(ruleValue);
    case 'lt':
      return Number(fieldValue) < Number(ruleValue);
    case 'lte':
      return Number(fieldValue) <= Number(ruleValue);

    // Set membership
    case 'in':
      if (!Array.isArray(ruleValue)) return false;
      return ruleValue.some((v) => String(v) === String(fieldValue));
    case 'notIn':
      if (!Array.isArray(ruleValue)) return true;
      return !ruleValue.some((v) => String(v) === String(fieldValue));

    // Existence
    case 'exists':
      return fieldValue !== null && fieldValue !== undefined;
    case 'notExists':
      return fieldValue === null || fieldValue === undefined;

    // Count/length operators (for computed fields)
    case 'countGt':
      return Number(fieldValue) > Number(ruleValue);
    case 'countLt':
      return Number(fieldValue) < Number(ruleValue);
    case 'lengthGt':
      return Number(fieldValue) > Number(ruleValue);
    case 'lengthLt':
      return Number(fieldValue) < Number(ruleValue);

    default:
      return true; // Unknown operator = no violation
  }
}

/**
 * Validate that a regex pattern is safe to use.
 * Returns an error message if unsafe, null if safe.
 */
export function validateRegexPattern(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return `Regex pattern exceeds maximum length of ${MAX_REGEX_LENGTH} characters`;
  }

  // Reject known dangerous patterns (nested quantifiers)
  if (/(\+|\*|\{[^}]+\})\s*(\+|\*|\{[^}]+\})/.test(pattern)) {
    return 'Regex pattern contains nested quantifiers which may cause performance issues';
  }

  try {
    new RegExp(pattern);
    return null;
  } catch (err) {
    return `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`;
  }
}
