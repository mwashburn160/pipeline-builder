// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Boxes } from 'lucide-react';
import type { HelpTopic } from './types';

/**
 * Help docs for the Registry page — the native Docker registry browser
 * that replaces the joxit `registry-express` UI. System-admin only.
 */
export const registryTopic: HelpTopic = {
  id: 'registry',
  title: 'Registry',
  description: 'Browse the Docker image registry, view manifests, and promote tags across orgs.',
  icon: Boxes,
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      blocks: [
        {
          type: 'text',
          content:
            'The Registry page lists every repository in the in-cluster Docker registry and lets system admins inspect, copy, and delete tags. Repositories are namespaced by org: `system/*` holds catalog images visible to every authenticated user, and `org-<orgId>/*` holds each tenant\'s private builds.',
        },
        {
          type: 'note',
          content:
            'This page is sysadmin-only. Org members see their own org\'s plugins on the Plugins page; they don\'t need the raw registry view.',
        },
      ],
    },
    {
      id: 'browsing',
      title: 'Browsing',
      blocks: [
        {
          type: 'text',
          content:
            'The left pane groups repos by namespace (`system` first, then `org-*` alphabetical). Click a repo to load its tag list in the middle pane; click a tag to load its manifest detail on the right. Use the filter input to search across all namespaces — matching groups stay open.',
        },
        {
          type: 'text',
          content:
            'Multi-arch images carry a "multi-arch" badge. Clicking the tag loads the OCI image index; the right pane lists each platform manifest with a drill-in arrow. The URL encodes the drilled-into state (`?repo=…&tag=…&platform=linux/amd64`), so browser refresh / back / forward all work.',
        },
      ],
    },
    {
      id: 'tag-copy',
      title: 'Copy tag (promotion)',
      blocks: [
        {
          type: 'text',
          content:
            'Use Copy tag… to promote an org build into the system catalog (or to fork one image into another namespace). Source/target are both `<repo>:<ref>` — the modal pre-fills the source from the clicked row and lets you change the target repo and ref independently.',
        },
        {
          type: 'warning',
          content:
            'Promoting to `system/*` makes the image visible to every authenticated user. The action emits a `registry.tag.copy` audit event with `isPromotionToSystem: true` so it\'s queryable in the audit log.',
        },
        {
          type: 'list',
          items: [
            'If the target already exists pointing at a different digest, the modal surfaces the conflict — confirm "Overwrite" to replace.',
            'If a source layer disappears mid-copy, the modal shows the missing digest and offers a retry.',
            'Multi-arch images copy every platform manifest + every unique blob in one operation.',
          ],
        },
      ],
    },
    {
      id: 'tag-delete',
      title: 'Delete tag',
      blocks: [
        {
          type: 'text',
          content:
            'Distribution registries delete manifests by digest, not by tag. The confirm modal resolves the tag to a digest, then scans up to 50 other tags in the same repo to find which share that digest — those tags all stop working after the delete.',
        },
        {
          type: 'note',
          content:
            'Blob layers become orphaned until the registry\'s garbage collector runs. Operators can free that storage by running `registry garbage-collect /etc/distribution/config.yml` on the registry container.',
        },
        {
          type: 'text',
          content:
            'Deletes emit a `registry.tag.delete` audit event with the resolved digest.',
        },
      ],
    },
  ],
};
