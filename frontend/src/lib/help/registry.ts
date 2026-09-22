// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { Boxes } from 'lucide-react';
import type { HelpTopic } from './types';

/**
 * Help docs for the Registry page — the native Docker registry browser.
 * System-admin only.
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
            'The Registry page lists every repository in the in-cluster Docker registry and lets system admins inspect, copy, and delete tags. Repositories are namespaced: `system/*` holds the platform\'s own plugin builds, `org-<orgId>/*` holds each tenant\'s private builds, and `public/<publisher>/<name>` holds the images of plugins listed in the public plugin directory.',
        },
        {
          type: 'note',
          content:
            'This page is sysadmin-only. Org members see their own org\'s plugins on the Plugins page; they don\'t need the raw registry view.',
        },
      ],
    },
    {
      id: 'public-namespace',
      title: 'The public/* namespace',
      blocks: [
        {
          type: 'text',
          content:
            'When the system org approves a plugin version for the public directory, image-registry copies that exact digest (manifest and layers, never the old signature) from the publisher\'s private repository into `public/<publisher>/<name>`, signs it fresh with the platform key, and attaches the SBOM as a signed attestation. The signature carries two signed annotations: the trust tier (`pb.trust`: official, verified, community or unverified) and the publisher handle (`pb.publisher`). Lookup verifies them, so a tier edited in the database without a re-sign is caught.',
        },
        {
          type: 'list',
          items: [
            'Every signed-in identity may pull from `public/*`; nobody may push, retag or delete there — not even a superadmin. Only image-registry\'s internal publication routes, called by the plugin service, write it.',
            'Listed versions are immutable: the same version can never point at a different digest. A mistake is fixed by yanking the version and publishing a new one.',
            'Yank removes the version tag only. Pipelines pull by digest, so an existing pipeline keeps working; new resolutions stop picking the version.',
            'A tier change, suspension or ownership transfer re-signs the image with new annotations; the image itself is unchanged.',
            'Garbage collection never touches `public/*` by age. A digest is deleted only when it was yanked more than 180 days ago and no pipeline\'s step manifest still references it.',
            'Storage in `public/*` counts toward the publishing org\'s registry usage.',
          ],
        },
        {
          type: 'note',
          content:
            'Copy tag and Delete tag refuse `public/*` targets. Publishing, yanking and re-signing happen through the Ecosystem console, never by hand.',
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
