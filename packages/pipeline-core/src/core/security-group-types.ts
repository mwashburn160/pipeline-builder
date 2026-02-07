/**
 * Security group configuration using explicit security group IDs
 *
 * Looks up existing security groups by their IDs via `SecurityGroup.fromSecurityGroupId`.
 *
 * @example
 * ```typescript
 * const sg: SecurityGroupIdsConfig = {
 *   type: 'securityGroupIds',
 *   options: {
 *     securityGroupIds: ['sg-12345678', 'sg-87654321'],
 *   }
 * };
 * ```
 */
export interface SecurityGroupIdsConfig {
  readonly type: 'securityGroupIds';
  readonly options: SecurityGroupIdsOptions;
}

/**
 * Security group configuration using name-based lookup
 *
 * Looks up an existing security group by name and VPC ID
 * via `SecurityGroup.fromLookupByName`.
 *
 * @example
 * ```typescript
 * const sg: SecurityGroupLookupConfig = {
 *   type: 'securityGroupLookup',
 *   options: {
 *     securityGroupName: 'my-codebuild-sg',
 *     vpcId: 'vpc-0a1b2c3d4e5f6a7b8',
 *   }
 * };
 * ```
 */
export interface SecurityGroupLookupConfig {
  readonly type: 'securityGroupLookup';
  readonly options: SecurityGroupLookupOptions;
}

/**
 * Configuration options for security group lookup by IDs
 */
export interface SecurityGroupIdsOptions {
  /**
   * List of security group IDs
   * @example ['sg-12345678', 'sg-87654321']
   */
  readonly securityGroupIds: string[];

  /**
   * Whether the imported security groups can be modified by attaching
   * ingress/egress rules. Set to false to avoid additional API calls
   * during synthesis.
   * @default true
   */
  readonly mutable?: boolean;
}

/**
 * Configuration options for security group lookup by name
 */
export interface SecurityGroupLookupOptions {
  /**
   * Name of the security group to look up
   * @example 'my-codebuild-sg'
   */
  readonly securityGroupName: string;

  /**
   * VPC ID that contains the security group.
   * Required for name-based lookup.
   * @example 'vpc-0a1b2c3d4e5f6a7b8'
   */
  readonly vpcId: string;
}

/**
 * Union type of all supported security group configurations.
 *
 * Used at the pipeline level (`BuilderProps.securityGroups`) to specify
 * security groups for CodeBuild actions.
 *
 * Each variant resolves to CDK `ISecurityGroup[]`:
 * - SecurityGroupIdsConfig: Security groups looked up by IDs
 * - SecurityGroupLookupConfig: Security group looked up by name + VPC
 */
export type SecurityGroupConfig = SecurityGroupIdsConfig | SecurityGroupLookupConfig;
