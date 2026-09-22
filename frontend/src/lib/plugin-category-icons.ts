// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One lucide glyph per plugin category (docs/plans/plugin-ecosystem.md §6a.1).
 *
 * Kept OUT of `plugin-categories.ts`, which must stay dependency-free (it is on
 * every route's provider path). Glyphs draw in `currentColor`, so they follow
 * the theme. Used on the directory's category grid, category pages, the search
 * facet list, and as the last-resort plugin icon.
 */
import {
  Activity, Bell, Bot, CodeXml, FlaskConical, Layers, Package, Rocket, ShieldCheck, Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { PluginCategory } from './plugin-categories';

export const CATEGORY_ICONS: Record<PluginCategory, LucideIcon> = {
  language: CodeXml,
  security: ShieldCheck,
  quality: Sparkles,
  testing: FlaskConical,
  artifact: Package,
  deploy: Rocket,
  infrastructure: Layers,
  monitoring: Activity,
  notification: Bell,
  ai: Bot,
};
