import { createHash } from 'crypto';
import { CoreConstants } from '../config/app-config';

/**
 * Options for configuring UniqueId generation
 */
export interface UniqueIdOptions {
  /** Default length for generated IDs (between 8 and 32) */
  readonly defaultLength?: number;

  /** Hash algorithm to use */
  readonly algorithm?: 'sha256' | 'sha512' | 'md5';

  /** Output format for generated IDs */
  readonly format?: 'uppercase' | 'lowercase' | 'hex';

  /** Whether to cache generated IDs */
  readonly enableCache?: boolean;
}

/**
 * Generates deterministic unique identifiers based on organization, project, and input strings.
 *
 * Features:
 * - Deterministic: Same input always produces same output
 * - Collision-resistant: Uses SHA-256 hashing
 * - Configurable length: 8-32 characters
 * - Optional caching: Improves performance for repeated calls
 * - Format options: Uppercase, lowercase, or hex
 *
 * @example
 * ```typescript
 * const uniqueId = new UniqueId('my-org', 'my-project');
 *
 * const id1 = uniqueId.generate('synth');        // "A3F8B2C9D1E4F5A6"
 * const id2 = uniqueId.generate('deploy');       // "B7D2E9F1A3C5D8E2"
 * const id3 = uniqueId.generate('synth', 12);    // "A3F8B2C9D1E4"
 * ```
 */
export class UniqueId {
  private readonly _prefix: string;
  private readonly _defaultLength: number;
  private readonly _algorithm: 'sha256' | 'sha512' | 'md5';
  private readonly _format: 'uppercase' | 'lowercase' | 'hex';
  private readonly _cache: Map<string, string>;
  private readonly _enableCache: boolean;

  /**
   * Creates a new UniqueId generator
   *
   * @param organization - Organization identifier (must match NAME_PATTERN)
   * @param project - Project identifier (must match NAME_PATTERN)
   * @param options - Optional configuration
   *
   * @throws Error if organization or project are invalid
   * @throws Error if defaultLength is not between 8 and 32
   */
  constructor(
    organization: string,
    project: string,
    options: UniqueIdOptions = {},
  ) {
    // Validate inputs
    this.validateInput('organization', organization);
    this.validateInput('project', project);

    const {
      defaultLength = 16,
      algorithm = 'sha256',
      format = 'uppercase',
      enableCache = true,
    } = options;

    this.validateLength(defaultLength);

    this._prefix = `${organization}-${project}`;
    this._defaultLength = defaultLength;
    this._algorithm = algorithm;
    this._format = format;
    this._enableCache = enableCache;
    this._cache = new Map();
  }

  /**
   * Generates a unique identifier for the given input string
   *
   * @param str - Input string to hash (combined with organization-project prefix)
   * @param length - Optional length override (must be between 8 and 32)
   * @returns Deterministic unique identifier
   *
   * @example
   * ```typescript
   * const id = uniqueId.generate('synth');           // Uses default length
   * const shortId = uniqueId.generate('synth', 8);   // 8 characters
   * const longId = uniqueId.generate('synth', 32);   // 32 characters
   * ```
   */
  generate(str: string, length: number = this._defaultLength): string {
    if (!str || typeof str !== 'string') {
      throw new Error('Input string must be a non-empty string');
    }

    this.validateLength(length);

    // Check cache
    const cacheKey = `${str}:${length}`;
    if (this._enableCache && this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey)!;
    }

    // Generate hash
    const input = `${this._prefix}-${str}`;
    const hash = createHash(this._algorithm).update(input, 'utf-8').digest('hex');

    // Format output
    let result = hash.substring(0, length);
    result = this.applyFormat(result);

    // Cache result
    if (this._enableCache) {
      this._cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Generates multiple unique identifiers at once
   *
   * @param inputs - Array of input strings
   * @param length - Optional length for all IDs
   * @returns Map of input strings to their generated IDs
   *
   * @example
   * ```typescript
   * const ids = uniqueId.generateBatch(['synth', 'deploy', 'test']);
   * // Map { 'synth' => 'A3F8B2C9D1E4F5A6', 'deploy' => 'B7D2E9F1A3C5D8E2', ... }
   * ```
   */
  generateBatch(inputs: string[], length?: number): Map<string, string> {
    const results = new Map<string, string>();

    for (const input of inputs) {
      results.set(input, this.generate(input, length));
    }

    return results;
  }

  /**
   * Generates a unique identifier with a custom separator between prefix and input
   *
   * @param str - Input string
   * @param separator - Custom separator (default: '-')
   * @param length - Optional length override
   * @returns Unique identifier
   *
   * @example
   * ```typescript
   * const id = uniqueId.generateWithSeparator('synth', '_');
   * ```
   */
  generateWithSeparator(str: string, separator: string = '-', length?: number): string {
    const originalPrefix = this._prefix;
    const input = `${originalPrefix}${separator}${str}`;
    const hash = createHash(this._algorithm).update(input, 'utf-8').digest('hex');

    const effectiveLength = length ?? this._defaultLength;
    this.validateLength(effectiveLength);

    let result = hash.substring(0, effectiveLength);
    return this.applyFormat(result);
  }

  /**
   * Clears the internal cache
   * Useful for memory management in long-running processes
   */
  clearCache(): void {
    this._cache.clear();
  }

  /**
   * Gets the current cache size
   * @returns Number of cached IDs
   */
  getCacheSize(): number {
    return this._cache.size;
  }

  /**
   * Gets the prefix used for ID generation
   * @returns Organization-project prefix
   */
  getPrefix(): string {
    return this._prefix;
  }

  /**
   * Gets the default length for generated IDs
   * @returns Default length
   */
  getDefaultLength(): number {
    return this._defaultLength;
  }

  /**
   * Checks if two inputs would generate the same ID
   * Useful for collision detection
   *
   * @param str1 - First input string
   * @param str2 - Second input string
   * @param length - Optional length to check
   * @returns true if IDs would be identical
   */
  wouldCollide(str1: string, str2: string, length?: number): boolean {
    const id1 = this.generate(str1, length);
    const id2 = this.generate(str2, length);
    return id1 === id2;
  }

  /**
   * Validates an input string against the NAME_PATTERN
   * @throws Error if validation fails
   */
  private validateInput(name: string, value: string): void {
    if (!value || typeof value !== 'string') {
      throw new Error(`${name} must be a non-empty string`);
    }

    if (!CoreConstants.NAME_PATTERN.test(value)) {
      throw new Error(
        `Invalid ${name}: "${value}". ` +
        'Must contain only lowercase letters, numbers, and hyphens.',
      );
    }
  }

  /**
   * Validates that a length is within acceptable bounds
   * @throws Error if validation fails
   */
  private validateLength(length: number): void {
    if (!Number.isInteger(length)) {
      throw new Error('Length must be an integer');
    }

    if (length < 8 || length > 32) {
      throw new Error('Length must be between 8 and 32 characters');
    }
  }

  /**
   * Applies the configured format to a hash string
   */
  private applyFormat(hash: string): string {
    switch (this._format) {
      case 'uppercase':
        return hash.toUpperCase();
      case 'lowercase':
        return hash.toLowerCase();
      case 'hex':
        return hash; // Already in hex
      default:
        return hash.toUpperCase();
    }
  }

  /**
   * Creates a new UniqueId instance with different options
   * Useful for creating variants without recreating the base configuration
   *
   * @param options - Options to override
   * @returns New UniqueId instance
   */
  clone(options: Partial<UniqueIdOptions> = {}): UniqueId {
    const [organization, project] = this._prefix.split('-');

    return new UniqueId(organization, project, {
      defaultLength: options.defaultLength ?? this._defaultLength,
      algorithm: options.algorithm ?? this._algorithm,
      format: options.format ?? this._format,
      enableCache: options.enableCache ?? this._enableCache,
    });
  }
}

/**
 * Creates a UniqueId generator with validation
 * Factory function for cleaner instantiation
 *
 * @param organization - Organization identifier
 * @param project - Project identifier
 * @param options - Optional configuration
 * @returns UniqueId instance
 *
 * @example
 * ```typescript
 * const uniqueId = createUniqueId('my-org', 'my-project', {
 *   defaultLength: 12,
 *   format: 'lowercase'
 * });
 * ```
 */
export function createUniqueId(
  organization: string,
  project: string,
  options?: UniqueIdOptions,
): UniqueId {
  return new UniqueId(organization, project, options);
}

/**
 * Generates a single unique ID without creating a UniqueId instance
 * Useful for one-off ID generation
 *
 * @param organization - Organization identifier
 * @param project - Project identifier
 * @param input - Input string to hash
 * @param length - ID length (default: 16)
 * @returns Generated unique ID
 *
 * @example
 * ```typescript
 * const id = generateUniqueId('my-org', 'my-project', 'synth');
 * ```
 */
export function generateUniqueId(
  organization: string,
  project: string,
  input: string,
  length: number = 16,
): string {
  const generator = new UniqueId(organization, project, { enableCache: false });
  return generator.generate(input, length);
}

/**
 * Validates that a string matches the required pattern for organization/project names
 *
 * @param value - String to validate
 * @returns true if valid, false otherwise
 */
export function isValidIdentifier(value: string): boolean {
  return typeof value === 'string' &&
         value.length > 0 &&
         CoreConstants.NAME_PATTERN.test(value);
}