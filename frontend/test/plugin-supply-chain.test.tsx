// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The plugin detail modal's "Supply chain" section. Every image-producing
 * plugin with a digest is signed (signing failure fails the build), one without
 * a digest is refused by synth, and a plugin with no image of its own has
 * nothing to sign. The SBOM comes from the signed attestation, so a 409
 * IMAGE_VERIFICATION_FAILED must reach the user rather than fail silently.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { pluginsApi } from '../src/lib/api/domains/plugins';
import { ApiError } from '../src/lib/api/errors';
import { PluginSupplyChain, truncateDigest } from '../src/components/plugin/PluginSupplyChain';

const toastError = jest.fn<AnyFn>();
jest.mock('@/components/ui/Toast', () => require('./helpers/pageMocks').toastModule(() => ({ error: toastError, success: jest.fn(), warning: jest.fn(), info: jest.fn() })));

const downloadPluginSbom = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { downloadPluginSbom: (...a: unknown[]) => downloadPluginSbom(...a) },
}));

const triggerBlobDownload = jest.fn<AnyFn>();
jest.mock('@/lib/download', () => ({
  __esModule: true,
  triggerBlobDownload: (...a: unknown[]) => triggerBlobDownload(...a),
}));

const DIGEST = `sha256:${'a'.repeat(56)}12345678`;
const signed = {
  id: 'p1', buildType: 'build_image', pluginType: 'CodeBuildStep',
  imageDigest: DIGEST, imageSource: 'built',
} as const;

beforeEach(() => { jest.clearAllMocks(); });

describe('PluginSupplyChain', () => {
  it('shows a signed, built image with the truncated digest, full value in the title, and provenance', () => {
    render(<PluginSupplyChain plugin={signed} />);
    expect(screen.getByText('Signed')).toBeTruthy();
    const code = screen.getByText(truncateDigest(DIGEST));
    expect(code.getAttribute('title')).toBe(DIGEST);
    expect(screen.getByText(/includes build provenance/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeTruthy();
  });

  it('says an uploaded image carries no build provenance', () => {
    render(<PluginSupplyChain plugin={{ ...signed, buildType: 'prebuilt', imageSource: 'uploaded' }} />);
    expect(screen.getByText(/no build provenance/)).toBeTruthy();
  });

  it('warns that an image-producing plugin without a digest must be rebuilt', () => {
    render(<PluginSupplyChain plugin={{ ...signed, imageDigest: null, imageSource: null }} />);
    expect(screen.getByText(/Unsigned image — rebuild or re-upload/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Download SBOM/ })).toBeNull();
  });

  it.each([
    ['metadata_only', { buildType: 'metadata_only' as const }],
    ['approval step', { pluginType: 'ManualApprovalStep' }],
  ])('a %s plugin runs without its own image', (_label, over) => {
    render(<PluginSupplyChain plugin={{ ...signed, imageDigest: null, imageSource: null, ...over }} />);
    expect(screen.getByText('This plugin runs without its own image.')).toBeTruthy();
    expect(screen.queryByText(/Unsigned/)).toBeNull();
  });

  it('downloads the SBOM under the server-provided filename', async () => {
    const blob = new Blob(['{}']);
    downloadPluginSbom.mockResolvedValue({ blob, filename: 'scan-1.0.0.spdx.json' });
    render(<PluginSupplyChain plugin={signed} />);
    fireEvent.click(screen.getByRole('button', { name: /Download SBOM/ }));
    await waitFor(() => expect(triggerBlobDownload).toHaveBeenCalledWith(blob, 'scan-1.0.0.spdx.json'));
    expect(downloadPluginSbom).toHaveBeenCalledWith('p1');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('surfaces a failed attestation verification as an error toast', async () => {
    downloadPluginSbom.mockRejectedValue(new ApiError('signature does not verify', 409, 'IMAGE_VERIFICATION_FAILED'));
    render(<PluginSupplyChain plugin={signed} />);
    fireEvent.click(screen.getByRole('button', { name: /Download SBOM/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Image verification failed: signature does not verify'));
    expect(triggerBlobDownload).not.toHaveBeenCalled();
  });
});

describe('downloadPluginSbom', () => {
  const { ApiCore } = jest.requireActual<typeof import('../src/lib/api/core')>('../src/lib/api/core');
  const core = new ApiCore();

  function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    global.fetch = jest.fn<AnyFn>(async () => ({
      ok: status < 400,
      status,
      json: async () => body,
      headers: new Headers(headers),
      blob: async () => new Blob(['{}']),
    })) as unknown as typeof fetch;
  }

  it('returns the blob and the Content-Disposition filename', async () => {
    respond(200, null, { 'Content-Disposition': 'attachment; filename="scan-1.0.0.spdx.json"' });
    const res = await pluginsApi(core).downloadPluginSbom('p1');
    expect(res.filename).toBe('scan-1.0.0.spdx.json');
    expect((global.fetch as unknown as jest.Mock).mock.calls[0][0]).toBe('/api/plugins/p1/sbom');
  });

  it('keeps the error envelope\'s message and code', async () => {
    respond(409, { success: false, statusCode: 409, message: 'SBOM attestation did not verify', code: 'IMAGE_VERIFICATION_FAILED' });
    await expect(pluginsApi(core).downloadPluginSbom('p1')).rejects.toMatchObject({
      statusCode: 409, code: 'IMAGE_VERIFICATION_FAILED', message: 'SBOM attestation did not verify',
    });
  });
});
