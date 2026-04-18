# VPC-Isolated Pipeline (TypeScript)

## Overview

Demonstrates how to run all pipeline CodeBuild steps inside a VPC with private subnets and security groups. Shows pipeline-level defaults that apply globally and step-level overrides for integration tests that need access to specific internal services.

## What This Example Shows

- Defining `CodeBuildDefaults` with `network`, `securityGroups`, and `metadata`
- Using `vpcId` network type with availability zone selection
- Using `securityGroupLookup` to find security groups by name
- Step-level `network` override using `subnetIds` for specific subnet placement
- Per-step `env` variables for internal service connection strings
- Tenant-scoped secrets via `orgId`
- Plugin aliasing (`nodejs-build` used twice with alias `integration-tests`)

## Key Imports

```typescript
import {
  PipelineBuilder,
  BuilderProps,
  CodeBuildDefaults,
  NetworkConfig,
  SecurityGroupConfig,
} from '@mwashburn160/pipeline-core';
```

## Network Architecture

```
VPC (vpc-0a1b...)
├── Private Subnets (PRIVATE_WITH_EGRESS)
│   ├── Synth CodeBuild     ← uses pipeline defaults
│   ├── Build-Test CodeBuild ← uses pipeline defaults
│   └── Container CodeBuild  ← uses pipeline defaults
├── Specific Subnets (subnet-..001, subnet-..002)
│   └── Integration-Test     ← step-level override with DB access SG
└── NAT Gateway → Internet
```

## Usage

```typescript
const app = new cdk.App();
new VpcIsolatedPipelineStack(app, 'VpcIsolatedPipeline', {
  env: { account: '111111111111', region: 'us-east-1' },
});
```
