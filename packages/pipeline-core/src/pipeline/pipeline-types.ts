/**
 * Re-exports all pipeline type definitions for backward compatibility.
 *
 * Canonical locations:
 * - Source types:  ./source-types
 * - Network types: ../core/network-types
 * - Step types:    ./step-types
 */

// Source types
export type {
  S3Source,
  GitHubSource,
  CodeStarSource,
  S3Options,
  GitHubOptions,
  CodeStarOptions,
} from './source-types';

// Network types (canonical home: core/network-types)
export type {
  SubnetIdsNetwork,
  VpcIdNetwork,
  VpcLookupNetwork,
  SubnetIdsNetworkOptions,
  VpcIdNetworkOptions,
  VpcLookupNetworkOptions,
  SubnetTypeName,
  NetworkConfig,
  CodeBuildDefaults,
} from '../core/network-types';

// Step / plugin types
export type {
  PluginOptions,
  SynthOptions,
  PluginManifest,
  CodeBuildStepOptions,
} from './step-types';
