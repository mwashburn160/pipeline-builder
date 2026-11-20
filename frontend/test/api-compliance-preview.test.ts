// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { expect, it, jest } from '@jest/globals';
import type { ApiCore } from '@/lib/api/core';
import { complianceApi } from '@/lib/api/domains/compliance';

it('sends pipeline preview attributes in the shape used by pipeline creation', async () => {
  const request = jest.fn(async (_path: string, _init: RequestInit) => ({ success: true }));
  const api = complianceApi({ request } as unknown as ApiCore);
  const props = {
    project: 'spring-demo',
    organization: 'demo',
    pipelineName: 'spring-demo-pipeline',
    synth: {},
    tags: { environment: 'demo' },
  };
  const { signal } = new AbortController();

  await api.dryRunPipelineCompliance(props, { signal });

  expect(request).toHaveBeenCalledTimes(1);
  const [path, init] = request.mock.calls[0];
  expect(path).toBe('/api/compliance/validate/pipeline/dry-run');
  expect(init.method).toBe('POST');
  expect(init.signal).toBe(signal);
  expect(JSON.parse(String(init.body))).toEqual({
    attributes: {
      project: props.project,
      organization: props.organization,
      pipelineName: props.pipelineName,
      props,
    },
  });
});
