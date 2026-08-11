// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ApiCore } from '../core';
import { buildQuery } from '../util';
import type { ApiResponse, BuilderProps, PipelineTemplate } from '@/types';

export function pipelineTemplatesApi(core: ApiCore) {
  return {
    /** List golden-path pipeline templates (own-org + shared system-org catalog). */
    listPipelineTemplates: async (params?: Record<string, string>) => {
      return core.request<ApiResponse<{ templates: PipelineTemplate[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }>>(
        `/api/pipeline-templates${buildQuery(params)}`,
      );
    },

    getPipelineTemplateById: async (id: string) => {
      return core.request<ApiResponse<{ template: PipelineTemplate }>>(`/api/pipeline-templates/${id}`);
    },

    /**
     * Render a template into a concrete pipeline `props` by supplying its declared
     * inputs. The returned props flow straight into `createPipeline` (the normal
     * create path, where compliance + quota apply).
     */
    instantiatePipelineTemplate: async (
      id: string,
      body: { project: string; organization: string; pipelineName?: string; inputs?: Record<string, string | number | boolean> },
    ) => {
      return core.request<ApiResponse<{ props: BuilderProps; description?: string; keywords?: string[] }>>(
        `/api/pipeline-templates/${id}/instantiate`,
        { method: 'POST', body: JSON.stringify(body) },
      );
    },

    createPipelineTemplate: async (data: {
      name: string;
      description?: string;
      keywords?: string[];
      category?: string;
      accessModifier?: 'public' | 'private';
      props: BuilderProps;
      inputs?: PipelineTemplate['inputs'];
    }) => {
      return core.request<ApiResponse<{ template: PipelineTemplate }>>('/api/pipeline-templates', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    deletePipelineTemplate: async (id: string) => {
      return core.request<ApiResponse<{ message: string }>>(`/api/pipeline-templates/${id}`, { method: 'DELETE' });
    },
  };
}
