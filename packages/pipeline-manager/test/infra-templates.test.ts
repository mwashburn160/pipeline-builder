// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The two CloudFormation templates the CLI deploys into a customer account
 * (`infra setup-events`, `infra store-token`).
 *
 *   - PARTITION. A literal `arn:aws:` names nothing in GovCloud or China: the
 *     managed policy attach fails the stack there, and an inline grant on a
 *     literal-partition ARN silently grants nothing. Every ARN goes through
 *     `${AWS::Partition}`.
 *   - SCOPE. Each grant is pinned to the stack's own region and account. The
 *     ingestion Lambda only ever calls the region its EventBridge rule lives in
 *     (it uses `event.region`), so a `*` region bought nothing but reach.
 *     CodeBuild project names are NOT prefix-scoped: pipeline-core leaves them
 *     to CloudFormation (`<LogicalId>-<random>`) unless a step sets
 *     `projectName`, so there is no stable prefix to pin to.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from '@jest/globals';

type Json = any;

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'templates');
const TEMPLATES = ['events-stack.json', 'token-renew-stack.json'] as const;
const raw = (f: string) => readFileSync(join(dir, f), 'utf-8');
const load = (f: string): Json => JSON.parse(raw(f));

/** Every string in the document, recursively. */
function strings(node: Json, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => strings(n, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => strings(n, out));
  return out;
}

/** Every IAM statement in every inline policy, with `Fn::If` branches unwrapped. */
function statements(tpl: Json): Json[] {
  const out: Json[] = [];
  for (const res of Object.values<Json>(tpl.Resources)) {
    if (res.Type !== 'AWS::IAM::Role') continue;
    for (const p of res.Properties.Policies ?? []) {
      for (const s of p.PolicyDocument.Statement) {
        if (s['Fn::If']) {
          for (const branch of s['Fn::If'].slice(1)) if (!branch.Ref) out.push(branch);
        } else {out.push(s);}
      }
    }
  }
  return out;
}

/** A statement's resources as their Fn::Sub template strings (GetAtt refs kept as objects). */
function resources(s: Json): Json[] {
  const list = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
  return list.flatMap((r: Json) => {
    if (r && r['Fn::If']) return r['Fn::If'].slice(1).filter((b: Json) => !b.Ref);
    return [r];
  }).map((r: Json) => (r && r['Fn::Sub']) ?? r);
}

const actionsOf = (s: Json): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);

describe.each(TEMPLATES)('%s', (file) => {
  const tpl = load(file);

  it('contains no hard-coded partition', () => {
    expect(raw(file)).not.toMatch(/arn:aws:/);
    for (const s of strings(tpl).filter((x) => x.startsWith('arn:'))) {
      expect(s.startsWith('arn:${AWS::Partition}:')).toBe(true);
    }
  });

  it('attaches the Lambda basic execution role through the partition pseudo-parameter', () => {
    const role = Object.values<Json>(tpl.Resources).find((r) => r.Type === 'AWS::IAM::Role');
    expect(role.Properties.ManagedPolicyArns).toEqual([
      { 'Fn::Sub': 'arn:${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole' },
    ]);
  });

  it('grants no wildcard action and no bare `*` resource', () => {
    for (const s of statements(tpl)) {
      for (const a of actionsOf(s)) {
        expect(a).not.toBe('*');
        expect(a).not.toMatch(/:\*$/);
      }
      for (const r of resources(s)) expect(r).not.toBe('*');
    }
  });

  it('pins every ARN-string resource to the stack region and account', () => {
    for (const s of statements(tpl)) {
      for (const r of resources(s)) {
        if (typeof r !== 'string') continue; // Fn::GetAtt on a resource in this stack
        expect(r).toMatch(/^arn:\$\{AWS::Partition\}:[a-z-]+:\$\{AWS::Region\}:\$\{AWS::AccountId\}:/);
      }
    }
  });
});

describe('events-stack.json ingestion grants', () => {
  const tpl = load('events-stack.json');
  const grant = (action: string) => statements(tpl).find((s) => actionsOf(s).includes(action));

  it('reads builds only in this region/account', () => {
    expect(resources(grant('codebuild:BatchGetBuilds')!)).toEqual(['arn:${AWS::Partition}:codebuild:${AWS::Region}:${AWS::AccountId}:project/*']);
  });

  it('filters only CodeBuild log groups in this region/account', () => {
    expect(resources(grant('logs:FilterLogEvents')!)).toEqual(['arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/*:*']);
  });

  it('reads pipeline tags and (DORA) commits only in this region/account', () => {
    expect(resources(grant('codepipeline:ListTagsForResource')!)).toEqual(['arn:${AWS::Partition}:codepipeline:${AWS::Region}:${AWS::AccountId}:*']);
    expect(resources(grant('codecommit:GetCommit')!)).toEqual(['arn:${AWS::Partition}:codecommit:${AWS::Region}:${AWS::AccountId}:*']);
  });
});
