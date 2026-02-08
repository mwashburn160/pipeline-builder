import { SecretValue } from 'aws-cdk-lib';
import type { MetaDataType } from './pipeline-types';
import type { SecurityGroupConfig } from './security-group-types';

/**
 * Network configuration using explicit subnet IDs
 *
 * Use when you know the exact subnet IDs where CodeBuild should run.
 * Subnets are selected directly by ID; VPC is looked up from the provided vpcId.
 *
 * @example
 * ```typescript
 * const network: SubnetIdsNetwork = {
 *   type: 'subnetIds',
 *   options: {
 *     vpcId: 'vpc-0a1b2c3d4e5f6a7b8',
 *     subnetIds: ['subnet-0a1b2c3d', 'subnet-4e5f6a7b'],
 *     securityGroupIds: ['sg-12345678']
 *   }
 * };
 * ```
 */
export interface SubnetIdsNetwork {
  readonly type: 'subnetIds';
  readonly options: SubnetIdsNetworkOptions;
}

/**
 * Network configuration using VPC lookup by ID
 *
 * Looks up an existing VPC by its ID and resolves subnets via subnetSelection filters.
 *
 * @example
 * ```typescript
 * const network: VpcIdNetwork = {
 *   type: 'vpcId',
 *   options: {
 *     vpcId: 'vpc-0a1b2c3d4e5f6a7b8',
 *     subnetType: 'PRIVATE_WITH_EGRESS',
 *     securityGroupIds: ['sg-12345678']
 *   }
 * };
 * ```
 */
export interface VpcIdNetwork {
  readonly type: 'vpcId';
  readonly options: VpcIdNetworkOptions;
}

/**
 * Network configuration using VPC lookup by tags
 *
 * Looks up an existing VPC by tag filters and resolves subnets via subnetSelection filters.
 *
 * @example
 * ```typescript
 * const network: VpcLookupNetwork = {
 *   type: 'vpcLookup',
 *   options: {
 *     tags: { 'aws:cloudformation:stack-name': 'NetworkStack' },
 *     subnetType: 'PRIVATE_WITH_EGRESS',
 *     availabilityZones: ['us-east-1a', 'us-east-1b']
 *   }
 * };
 * ```
 */
export interface VpcLookupNetwork {
  readonly type: 'vpcLookup';
  readonly options: VpcLookupNetworkOptions;
}

/**
 * Common subnet selection filters shared by VPC-based network options
 */
interface SubnetSelectionOptions {
  /**
   * Subnet type filter for subnet selection
   * Maps to CDK SubnetType values
   * @default 'PRIVATE_WITH_EGRESS'
   */
  readonly subnetType?: SubnetTypeName;

  /**
   * Filter subnets to specific availability zones
   * @example ['us-east-1a', 'us-east-1b']
   */
  readonly availabilityZones?: string[];

  /**
   * Filter subnets by CDK subnet group name
   * Matches the groupName assigned during VPC creation
   */
  readonly subnetGroupName?: string;

  /**
   * Security group IDs to attach to CodeBuild projects
   * @example ['sg-12345678']
   */
  readonly securityGroupIds?: string[];
}

/**
 * Configuration options for explicit subnet ID network
 */
export interface SubnetIdsNetworkOptions {
  /**
   * VPC ID that contains the subnets.
   * Required because CDK CodeBuildStep needs a vpc reference.
   * Can be a plain string or a SecretValue (e.g. from Secrets Manager).
   * @example 'vpc-0a1b2c3d4e5f6a7b8'
   */
  readonly vpcId: SecretValue | string;

  /**
   * Explicit list of subnet IDs where CodeBuild projects will run
   * @example ['subnet-0a1b2c3d', 'subnet-4e5f6a7b']
   */
  readonly subnetIds: string[];

  /**
   * Security group IDs to attach to CodeBuild projects
   * @example ['sg-12345678']
   */
  readonly securityGroupIds?: string[];
}

/**
 * Configuration options for VPC lookup by ID
 */
export interface VpcIdNetworkOptions extends SubnetSelectionOptions {
  /**
   * VPC ID to look up
   * Can be a plain string or a SecretValue (e.g. from Secrets Manager).
   * @example 'vpc-0a1b2c3d4e5f6a7b8'
   */
  readonly vpcId: SecretValue | string;
}

/**
 * Configuration options for VPC lookup by tags
 */
export interface VpcLookupNetworkOptions extends SubnetSelectionOptions {
  /**
   * Tag key-value pairs to identify the VPC
   * All tags must match for lookup to succeed
   * @example { Environment: 'production', Team: 'platform' }
   */
  readonly tags: Record<string, string>;

  /**
   * Optional VPC name (value of the 'Name' tag) for additional filtering
   */
  readonly vpcName?: string;

  /**
   * Optional AWS region override for cross-region VPC lookup
   * @example 'us-west-2'
   */
  readonly region?: string;
}

/**
 * Subnet type names corresponding to CDK SubnetType enum values
 *
 * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.SubnetType.html
 */
export type SubnetTypeName =
  | 'PRIVATE_WITH_EGRESS'
  | 'PRIVATE_WITH_NAT'
  | 'PRIVATE_ISOLATED'
  | 'PUBLIC';

/**
 * Union type of all supported network configurations.
 *
 * Used at two independent levels:
 * - Pipeline-level (`defaults.network`) — applies to all CodeBuild actions
 * - Step-level (`synth.network`, `CodeBuildStepOptions.network`) — applies to an individual build step
 *
 * Each variant resolves to vpc, subnetSelection, and optional securityGroups:
 * - SubnetIdsNetwork: VPC looked up by ID, subnets selected explicitly by ID
 * - VpcIdNetwork: VPC looked up by ID, subnets resolved via subnetSelection filters
 * - VpcLookupNetwork: VPC looked up by tags, subnets resolved via subnetSelection filters
 */
export type NetworkConfig = SubnetIdsNetwork | VpcIdNetwork | VpcLookupNetwork;

/**
 * Pipeline-level CodeBuild defaults applied to every CodeBuild action
 * (synth, self-mutation, asset publishing) via `codeBuildDefaults`.
 *
 * @example
 * ```typescript
 * const defaults: CodeBuildDefaults = {
 *   network: {
 *     type: 'vpcId',
 *     options: { vpcId: 'vpc-abc123', subnetType: 'PRIVATE_WITH_EGRESS' }
 *   },
 *   metadata: {
 *     [MetadataKeys.PRIVILEGED]: true,
 *   },
 * };
 * ```
 */
export interface CodeBuildDefaults {
  /**
   * Network configuration for all CodeBuild actions.
   * Resolves to vpc, subnetSelection, and optional securityGroups.
   */
  readonly network?: NetworkConfig;

  /**
   * Standalone security groups for all CodeBuild actions.
   * Merged with any security groups resolved from network config.
   */
  readonly securityGroups?: SecurityGroupConfig;

  /**
   * Metadata applied to all CodeBuild actions.
   * Merged with step-level metadata; step-level keys take precedence.
   */
  readonly metadata?: MetaDataType;
}
