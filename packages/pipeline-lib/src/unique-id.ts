import { createHash } from 'crypto';

/**
 * Generates unique identifiers for AWS resources by hashing organization, project, and input string.
 * IDs are truncated to a specified length and can be uppercase or lowercase.
 */
export class UniqueId {
    private readonly _length: number;
    private readonly _prefix: string;

    /**
     * @param organization - The organization name (required).
     * @param project - The project name (required).
     * @param length - The length of the generated ID (default: 12, must be positive).
     */
    constructor(organization: string, project: string, length: number = 12) {
        if (!organization || !project) {
            throw new Error('organization and project are required');
        }
        if (length <= 0) {
            throw new Error('length must be positive');
        }
        this._length = length;
        this._prefix = organization.concat(`-${project}`);
    }

    /**
     * Generates a unique ID by hashing the prefix and input string.
     * @param str - The input string to include in the ID.
     * @param length - The length of the ID (overrides default if specified).
     * @param lowercase - If true, returns lowercase ID for AWS compatibility (e.g., S3 buckets).
     * @returns A truncated, hashed ID.
     * @throws Error if str is empty or length is invalid.
     */
    generate(str: string, length: number = this._length, lowercase: boolean = false): string {
        if (!str) {
            throw new Error('str is required');
        }
        if (length <= 0) {
            throw new Error('length must be positive');
        }
        const input = this._prefix.concat(`-${str}`);
        const id = createHash('md5').update(input, 'utf-8').digest('hex').substring(0, length);
        return lowercase ? id.toLowerCase() : id.toUpperCase();
    }
}
