// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Wrench } from 'lucide-react';
import type { HelpTopic } from './types';

/**
 * Help for the managed pipeline toolchain: which release a pipeline's build
 * image and `cdk-synth` step run, and who decides (docs/plans/
 * bootstrap-image-versioning.md §5). Hand-authored: there is no 1:1 doc yet.
 */
export const pipelineToolchainTopic: HelpTopic = {
  id: 'pipeline-toolchain',
  title: 'Pipeline toolchain',
  description: 'Which toolchain release your pipelines run, and how a release pin, your org default, the platform default and canary decide it.',
  icon: Wrench,
  sections: [
    {
      id: 'overview',
      title: 'What the toolchain is',
      blocks: [
        {
          type: 'text',
          content:
            'Every pipeline synthesizes and self-mutates on a managed toolchain: the CodeBuild build image (`pipeline-bootstrap`, carrying pipeline-manager, the AWS CDK, cdk-assets, Node, pnpm and esbuild) and the `cdk-synth` synth step. The two are published together by the platform as ONE release with its own version, such as `1.4.2`. You never pick their versions separately.',
        },
        {
          type: 'note',
          content:
            'Pipelines move to a new release on their NEXT run. Changing a default never re-runs anything.',
        },
      ],
    },
    {
      id: 'who-decides',
      title: 'Who decides which release runs',
      blocks: [
        {
          type: 'text',
          content: 'The most specific setting wins, in this order:',
        },
        {
          type: 'table',
          headers: ['Level', 'Set by', 'Applies to'],
          rows: [
            ['Release pin', 'Anyone who can edit the pipeline (Pipeline settings → Toolchain)', 'That one pipeline'],
            ['Org default', 'Holders of Manage pipeline toolchain (Owners and Admins), in Settings → Organization → Pipeline toolchain', 'Every unpinned pipeline in the organization and its teams, unless a team sets its own'],
            ['Canary', 'The platform operators, for a few organizations', 'Unpinned pipelines of a canary organization WITHOUT an org default'],
            ['Platform default', 'The platform operators', 'Everyone else'],
          ],
        },
        {
          type: 'list',
          items: [
            'Release pin: holds one pipeline on an exact release, whatever the defaults do. Leave the selector on the default to stop pinning.',
            'Org default: holds the whole organization on a release, ahead of any canary and of platform promotions. "Follow platform default" removes it.',
            'Canary: the platform tries a new release on a few organizations before promoting it. An org default always beats canary, so canary has no effect while your org default is set.',
            'Platform default: the release the platform has promoted for everyone. Following it means you get each promotion automatically.',
          ],
        },
      ],
    },
    {
      id: 'eligible',
      title: 'Which releases you can choose',
      blocks: [
        {
          type: 'text',
          content:
            'A pin or an org default may name only an eligible release: one that is live, complete, and has either served as the platform default or is currently in canary for your organization. Anything else is refused with `TOOLCHAIN_RELEASE_NOT_ELIGIBLE`.',
        },
        {
          type: 'list',
          items: [
            'Deprecated and yanked releases are shown, labelled, but cannot be newly chosen. A pipeline or org already on one keeps resolving it, with a warning, until you move it.',
            'A release that is several releases behind the platform default, or picks up a fixable Critical or known-exploited finding, is flagged in the panel and its admins are notified.',
            'The `cdk-synth` step has no version field of its own: pinning it alone is refused with `TOOLCHAIN_PIN_VIA_RELEASE`. Pin the release instead.',
            'Templates never carry a toolchain pin; pipelines created from one follow the default.',
          ],
        },
      ],
    },
    {
      id: 'org-default',
      title: 'Setting the org default',
      blocks: [
        {
          type: 'list',
          items: [
            'Settings → Organization → Pipeline toolchain shows the effective release and why, canary status, and how many pipelines are pinned or behind the default. Members can read it; changing it needs Manage pipeline toolchain.',
            'Before saving, the confirmation says how many of your pipelines will move on their next run and how many pinned pipelines will not. Every change re-verifies your identity.',
            'History lists each change; "Revert to previous" restores the one before.',
            'A team without its own default inherits its root organization\'s ("Inherit from …").',
          ],
        },
      ],
    },
  ],
};
