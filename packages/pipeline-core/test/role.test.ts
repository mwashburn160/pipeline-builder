// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { UniqueId } from '../src/core/id-generator';
import { resolveRole } from '../src/core/role';
import type { RoleConfig } from '../src/core/role-types';

// Mock Config.get('aws') used by createCodeBuildDefaultRole
jest.mock('../src/config/app-config', () => ({
  Config: {
    get: (key: string) => {
      if (key === 'aws') {
        return { logging: { groupName: '/pipeline-builder/builds/default' } };
      }
      return {};
    },
  },
}));

describe('resolveRole', () => {
  let stack: Stack;
  let id: UniqueId;

  beforeEach(() => {
    stack = new Stack(new App(), 'TestStack');
    id = new UniqueId();
  });

  describe('roleArn', () => {
    it('should resolve an existing role by ARN', () => {
      const config: RoleConfig = {
        type: 'roleArn',
        options: { roleArn: 'arn:aws:iam::123456789012:role/TestRole' },
      };
      const role = resolveRole(stack, id, config);
      expect(role.roleArn).toBe('arn:aws:iam::123456789012:role/TestRole');
    });

    it('should respect mutable option', () => {
      const config: RoleConfig = {
        type: 'roleArn',
        options: {
          roleArn: 'arn:aws:iam::123456789012:role/ImmutableRole',
          mutable: false,
        },
      };
      const role = resolveRole(stack, id, config);
      expect(role.roleArn).toBe('arn:aws:iam::123456789012:role/ImmutableRole');
    });
  });

  describe('roleName', () => {
    it('should resolve an existing role by name', () => {
      const config: RoleConfig = {
        type: 'roleName',
        options: { roleName: 'TestRole' },
      };
      const role = resolveRole(stack, id, config);
      expect(role.roleName).toBe('TestRole');
    });
  });

  describe('codeBuildDefault', () => {
    it('should create a role with CodeBuild service principal', () => {
      const config: RoleConfig = {
        type: 'codeBuildDefault',
        options: {},
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Principal: { Service: 'codebuild.amazonaws.com' },
            },
          ],
        },
      });
    });

    it('should attach CloudWatch Logs policy', () => {
      const config: RoleConfig = {
        type: 'codeBuildDefault',
        options: {},
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              Effect: 'Allow',
            },
          ],
        },
      });
    });
  });

  describe('oidc', () => {
    it('should create a role with OIDC provider from issuer', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
          conditions: {
            'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
          },
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
                },
              },
            },
          ],
        },
      });
    });

    it('should create a role with OIDC provider from existing ARN', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          providerArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
          conditions: {
            'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
          },
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
                },
              },
            },
          ],
        },
      });
    });

    it('should apply StringEquals conditions to trust policy', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
          conditions: {
            'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:sub': 'repo:my-org/my-repo:ref:refs/heads/main',
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                },
              },
              Effect: 'Allow',
            },
          ],
        },
      });
    });

    it('should apply StringLike conditions for wildcard matching', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
          conditionsLike: {
            'token.actions.githubusercontent.com:sub': 'repo:my-org/*',
          },
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringLike: {
                  'token.actions.githubusercontent.com:sub': 'repo:my-org/*',
                },
              },
              Effect: 'Allow',
            },
          ],
        },
      });
    });

    it('should set custom role name when provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
          roleName: 'MyOidcRole',
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'MyOidcRole',
      });
    });

    it('should attach managed policies when provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
          managedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: [
          'arn:aws:iam::aws:policy/ReadOnlyAccess',
        ],
      });
    });

    it('should default clientIds to sts.amazonaws.com when using issuer', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
            },
          ],
        },
      });
    });

    it('should throw when neither providerArn nor issuer is provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {},
      };
      expect(() => resolveRole(stack, id, config)).toThrow(
        'OIDC role config requires either providerArn or issuer',
      );
    });

    it('should include thumbprints when provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Effect: 'Allow',
            },
          ],
        },
      });
    });

    it('should throw when both providerArn and issuer are provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          providerArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
          issuer: 'https://token.actions.githubusercontent.com',
        },
      };
      expect(() => resolveRole(stack, id, config)).toThrow(
        'OIDC role config must specify either providerArn or issuer, not both',
      );
    });

    it('should set description on the role', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          description: 'OIDC role for GitHub Actions CI/CD',
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        Description: 'OIDC role for GitHub Actions CI/CD',
      });
    });

    it('should set maxSessionDuration on the role', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          maxSessionDuration: 7200,
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        MaxSessionDuration: 7200,
      });
    });

    it('should attach permission boundary when provided', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/DeveloperBoundary',
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Role', {
        PermissionsBoundary: 'arn:aws:iam::123456789012:policy/DeveloperBoundary',
      });
    });

    it('should add inline policy statements', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          policyStatements: [
            {
              actions: ['s3:GetObject', 's3:ListBucket'],
              resources: ['arn:aws:s3:::my-bucket', 'arn:aws:s3:::my-bucket/*'],
            },
          ],
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: ['s3:GetObject', 's3:ListBucket'],
              Effect: 'Allow',
              Resource: ['arn:aws:s3:::my-bucket', 'arn:aws:s3:::my-bucket/*'],
            },
          ],
        },
      });
    });

    it('should support Deny effect in inline policy statements', () => {
      const config: RoleConfig = {
        type: 'oidc',
        options: {
          issuer: 'https://token.actions.githubusercontent.com',
          policyStatements: [
            {
              effect: 'Deny',
              actions: ['s3:DeleteBucket'],
              resources: ['*'],
            },
          ],
        },
      };
      resolveRole(stack, id, config);

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 's3:DeleteBucket',
              Effect: 'Deny',
              Resource: '*',
            },
          ],
        },
      });
    });
  });

  it('should throw for unknown role config type', () => {
    const config = { type: 'unknown', options: {} } as any;
    expect(() => resolveRole(stack, id, config)).toThrow('Unknown role config type');
  });
});
