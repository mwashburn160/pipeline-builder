// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The stakeholder-report engine: period resolution, the section registry, the
 * templates, and the composer that turns them into a frozen snapshot.
 *
 * Enumerated rather than `export *` so the module's internals (the civil-date
 * helpers, the headline heuristics) stay private — the same discipline
 * reporting-service.ts applies to the reporting modules.
 */

export {
  resolvePeriod,
  resolvePeriodByLabel,
  rejectUnreportablePeriod,
  nextPeriodBoundary,
  completePeriodsSince,
  type ResolvedPeriod,
  type PeriodRejection,
} from './period.js';

export {
  registerSection,
  getSection,
  allSections,
  sectionIds,
  type SectionSpec,
  type SectionContext,
  type SectionDataSource,
} from './sections.js';

export {
  REPORT_TEMPLATE_SPECS,
  getTemplate,
  assertTemplatesResolve,
  type TemplateSpec,
} from './templates.js';

export {
  composeSnapshot,
  LOW_SAMPLE_THRESHOLD,
  type ReportSnapshot,
  type ComposedSection,
  type DataQualityNote,
  type ComposeOptions,
  type TrendDirection,
} from './compose.js';

export {
  StakeholderReportStore,
  stakeholderReportStore,
  hashToken,
  mintToken,
  DEFAULT_SHARE_LINK_TTL_DAYS,
  MAX_SHARE_LINK_TTL_DAYS,
  MAX_BOUNCES,
  VERIFICATION_TTL_MS,
  type CreateDefinitionInput,
  type UpdateDefinitionInput,
  type MintedShareLink,
  type ResolvedShareLink,
} from './store.js';
