// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { createLogger } from '@pipeline-builder/api-core';
import { SecretValue } from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-codecommit';
import { CodeCommitTrigger, GitHubTrigger, S3Trigger } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CodePipelineSource } from 'aws-cdk-lib/pipelines';
import { Construct } from 'constructs';
import type { PipelineConfiguration } from './pipeline-configuration.js';
import type { GitHubOptions, SourceType } from './source-types.js';
import { UniqueId } from '../core/id-generator.js';
import { unwrapSecret } from '../core/pipeline-helpers.js';
import { TriggerType } from '../core/pipeline-types.js';
import { resolveTemplates } from '../template/index.js';
import { hasTemplate } from '../template/tokenizer.js';

const log = createLogger('source-builder');

/** A Secrets Manager ARN (`arn:aws:secretsmanager:...`, incl. partition variants). */
const SECRETS_MANAGER_ARN = /^arn:aws[a-z-]*:secretsmanager:/i;
/** A `secretsmanager:<secret-name>` shorthand reference. */
const SECRETS_MANAGER_REF_PREFIX = 'secretsmanager:';

/**
 * Creates the appropriate CodePipelineSource based on the pipeline configuration.
 *
 * Supports S3, GitHub, CodeStar connection, and CodeCommit sources.
 *
 * **Note on SCHEDULE triggers:** Scheduled pipelines require an EventBridge rule
 * that starts the pipeline on a cron schedule. The source trigger is set to NONE
 * (no polling/webhook). The EventBridge rule must be created separately as a
 * pipeline-level construct, not at the source level. The `schedule` field on
 * source options captures the cron expression for API/frontend use. The actual
 * EventBridge rule creation is implemented in `PipelineBuilder` (the
 * `ScheduleRule` `events.Rule` targeting the pipeline), not at the source level.
 *
 * @example
 * ```typescript
 * const sourceBuilder = new SourceBuilder(this, config);
 * const source = sourceBuilder.create(uniqueId);
 * ```
 */
export class SourceBuilder {
  constructor(
    private readonly scope: Construct,
    private readonly config: PipelineConfiguration,
  ) {}

  /**
   * Creates the appropriate CodePipelineSource based on source type
   */
  create(id: UniqueId): CodePipelineSource {
    switch (this.config.source.type) {
      case 's3':
        return this.createS3Source(id);
      case 'github':
        return this.createGitHubSource();
      case 'codestar':
        return this.createCodeStarSource();
      case 'codecommit':
        return this.createCodeCommitSource(id);
      default: {
        const _exhaustive: never = this.config.source;
        throw new Error(`Unsupported source type: ${(_exhaustive as SourceType).type}`);
      }
    }
  }

  /**
   * Creates an S3 source for the pipeline
   */
  private createS3Source(id: UniqueId): CodePipelineSource {
    const options = this.config.getS3Options();

    const bucket = Bucket.fromBucketName(
      this.scope,
      id.generate('source:bucket'),
      options.bucketName,
    );

    const trigger =
      options.trigger === TriggerType.AUTO ? S3Trigger.EVENTS : S3Trigger.NONE;

    return CodePipelineSource.s3(bucket, options.objectKey, { trigger });
  }

  /**
   * Creates a GitHub source for the pipeline
   */
  private createGitHubSource(): CodePipelineSource {
    const options = this.config.getGitHubOptions();

    return CodePipelineSource.gitHub(options.repo, options.branch, {
      trigger: options.trigger === TriggerType.AUTO ? GitHubTrigger.POLL : GitHubTrigger.NONE,
      authentication: this.resolveGitHubAuthentication(options),
    });
  }

  /**
   * Resolve the GitHub authentication token into a {@link SecretValue} without
   * leaking the token value into the synthesized template.
   *
   * - `undefined` token → no authentication (CDK default).
   * - A `SecretValue` → passed through (already a reference, never plaintext).
   * - A Secrets Manager ARN or `secretsmanager:<name>` string → resolved via
   *   `SecretValue.secretsManager`, so only the reference lands in the template.
   * - A genuine raw plaintext token → rejected by default (it would be baked as
   *   plaintext into CloudFormation/CDK context). Only when
   *   `allowPlainTextToken` is explicitly set is it embedded via
   *   `SecretValue.unsafePlainText`, and a loud warning is emitted.
   */
  private resolveGitHubAuthentication(options: GitHubOptions): SecretValue | undefined {
    let token = options.token;
    if (token === undefined) return undefined;

    // A SecretValue is already a reference (e.g. Secrets Manager) — never plaintext.
    if (typeof token !== 'string') return token;

    // Synth-time templating: resolve `{{ pipeline.* }}` in the token against the
    // pipeline scope (e.g. `secretsmanager:pipeline-builder/{{ pipeline.vars.orgId }}/
    // github-token`) so the secret reference can be parameterized by pipeline vars —
    // the only source field that is templatable. No-op when the token carries no
    // template (a plain ARN, `secretsmanager:` ref, or plaintext resolves to itself).
    if (hasTemplate(token)) {
      const holder = { token };
      const { errors } = resolveTemplates(holder, this.config.getPipelineScope(), (f) => f === 'token', 'pipeline');
      if (errors.length > 0) {
        const e = errors[0]!;
        throw new Error(`GitHub source token template resolution failed at '${e.field ?? 'token'}': ${e.message}`);
      }
      token = holder.token;
    }

    // A string that names a Secrets Manager secret is resolved to a reference so
    // only the pointer — not the token — is written to the template / CDK context.
    if (SECRETS_MANAGER_ARN.test(token)) {
      return SecretValue.secretsManager(token);
    }
    if (token.toLowerCase().startsWith(SECRETS_MANAGER_REF_PREFIX)) {
      return SecretValue.secretsManager(token.slice(SECRETS_MANAGER_REF_PREFIX.length));
    }

    // Genuine raw plaintext token — this is the exposure. Reject by default and
    // point the caller at a secret reference or a CodeStar connection.
    if (!options.allowPlainTextToken) {
      throw new Error(
        'GitHub source `token` is a raw plaintext value, which would be baked into the ' +
        'synthesized CloudFormation template (and CDK context / stack state). Provide a ' +
        'Secrets Manager reference instead — an `arn:aws:secretsmanager:...` ARN, a ' +
        '`secretsmanager:<secret-name>` string, or a `SecretValue.secretsManager(...)` — or ' +
        'prefer a CodeStar connection (`type: "codestar"`). To intentionally embed the token ' +
        'in plaintext, set `allowPlainTextToken: true`.',
      );
    }

    log.warn(
      'GitHub source `token` is being embedded as PLAINTEXT in the synthesized CloudFormation ' +
      'template because `allowPlainTextToken` is set. Anyone with template, CDK context, or ' +
      'stack state access can read this token. Use a Secrets Manager reference or a CodeStar ' +
      'connection instead.',
    );
    return SecretValue.unsafePlainText(token);
  }

  /**
   * Creates a CodeStar connection source for the pipeline
   */
  private createCodeStarSource(): CodePipelineSource {
    const options = this.config.getCodeStarOptions();

    return CodePipelineSource.connection(options.repo, options.branch, {
      connectionArn: unwrapSecret(options.connectionArn),
      triggerOnPush: options.trigger === TriggerType.AUTO,
      codeBuildCloneOutput: options.codeBuildCloneOutput,
    });
  }

  /**
   * Creates a CodeCommit source for the pipeline
   */
  private createCodeCommitSource(id: UniqueId): CodePipelineSource {
    const options = this.config.getCodeCommitOptions();

    const repository = Repository.fromRepositoryName(
      this.scope,
      id.generate('source:repo'),
      options.repositoryName,
    );

    return CodePipelineSource.codeCommit(repository, options.branch ?? 'main', {
      trigger: options.trigger === TriggerType.AUTO ? CodeCommitTrigger.EVENTS : CodeCommitTrigger.NONE,
    });
  }
}
