// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { type PipelineProps, type PipelineVisibility } from './pipeline.js';

/**
 * One declared template input. `name` is the `vars.<name>` key the template body
 * references as `{{ pipeline.vars.<name> }}`.
 */
export interface TemplateInput {
  name: string;
  label?: string;
  description?: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  options?: string[];
}

/**
 * A golden-path pipeline template — a parameterized starting point whose `props`
 * carry `{{ pipeline.vars.* }}` placeholders backed by {@link TemplateInput}s.
 */
export interface PipelineTemplate {
  id: string;
  name: string;
  description?: string;
  keywords?: string[];
  category?: string;
  visibility?: PipelineVisibility;
  props: PipelineProps;
  inputs?: TemplateInput[];
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Request payload for `POST /api/pipeline-templates/:id/instantiate`. */
export interface InstantiateTemplateRequest {
  project: string;
  organization: string;
  pipelineName?: string;
  inputs?: Record<string, string | number | boolean>;
}

/**
 * Instantiate response. `props` is a concrete `BuilderProps` ready to hand to
 * `pipeline create --file` — the endpoint only renders, it creates nothing.
 */
export interface InstantiateTemplateResponse {
  props: PipelineProps;
  description?: string;
  keywords?: string[];
}
