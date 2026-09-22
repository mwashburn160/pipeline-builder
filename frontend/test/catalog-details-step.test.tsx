// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The upload dialog's Catalog details step: the
 * package is inspected, every descriptive field is listed with its detected
 * value and source, and only the fields the user EDITED travel with the upload
 * as the `metadata` part. An inspect failure must never block the upload.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { AnyFn } from './helpers/mock-fn';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import CreatePluginModal from '../src/components/plugin/CreatePluginModal';

const inspectPlugin = jest.fn<AnyFn>();
const uploadPlugin = jest.fn<AnyFn>();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: {
    inspectPlugin: (...a: unknown[]) => inspectPlugin(...a),
    uploadPlugin: (...a: unknown[]) => uploadPlugin(...a),
  },
}));
jest.mock('@/hooks/useBuildStatus', () => ({
  useBuildStatus: () => ({ status: 'idle', events: [], lastEvent: null }),
}));
jest.mock('../src/components/plugin/AIPluginBuilderTab', () => ({ __esModule: true, default: () => null }));

const INSPECT = {
  plugin: { name: 'eslint', version: '1.2.0', pluginType: 'CodeBuildStep', buildType: 'build_image' },
  fields: [
    { field: 'displayName', value: 'ESLint', source: 'spec', error: null },
    { field: 'summary', value: 'Lint JavaScript', source: 'readme', error: null },
    { field: 'description', value: 'Runs ESLint over the repo.', source: 'spec', error: null },
    { field: 'category', value: 'quality', source: 'spec', error: null },
    { field: 'keywords', value: ['lint', 'js'], source: 'spec', error: null },
    { field: 'license', value: 'MIT', source: 'dockerfile', error: null },
    { field: 'homepageUrl', value: null, source: 'spec', error: 'must use https' },
    { field: 'sourceUrl', value: 'https://github.com/acme/eslint', source: 'derived', error: null },
    { field: 'documentationUrl', value: null, source: null, error: null },
    { field: 'icon', value: { key: 'eslint' }, source: 'spec', error: null },
    { field: 'changelog', value: null, source: null, error: null },
    { field: 'readme', value: '# ESLint', source: 'readme', error: null },
  ],
};

const row = (field: string) => screen.getByTestId(`catalog-field-${field}`);

function renderAndPick() {
  render(<CreatePluginModal canPublish initialTab="upload" onClose={jest.fn<AnyFn>()} onCreated={jest.fn<AnyFn>()} />);
  // The modal renders through a portal, so look in the document, not the container.
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['zip'], 'eslint.zip', { type: 'application/zip' });
  fireEvent.change(input, { target: { files: [file] } });
  return { file };
}

beforeEach(() => {
  jest.clearAllMocks();
  inspectPlugin.mockResolvedValue(INSPECT);
  uploadPlugin.mockResolvedValue({ success: true, statusCode: 202, data: { requestId: 'req-1' } });
});

describe('Catalog details step', () => {
  it('inspects the chosen file and lists detected values with their source badges', async () => {
    const { file } = renderAndPick();
    await screen.findByTestId('catalog-field-displayName');
    expect(inspectPlugin).toHaveBeenCalledWith(file, expect.objectContaining({ signal: expect.anything() }));

    expect(row('displayName')).toHaveTextContent('ESLint');
    expect(within(row('displayName')).getByText('Spec')).toBeInTheDocument();
    expect(within(row('summary')).getByText('README')).toBeInTheDocument();
    expect(within(row('license')).getByText('Dockerfile')).toBeInTheDocument();
    expect(within(row('sourceUrl')).getByText('Generated')).toBeInTheDocument();
    expect(row('keywords')).toHaveTextContent('lint, js');
    expect(row('category')).toHaveTextContent('Quality');
    expect(row('documentationUrl')).toHaveTextContent('Not found in package');
  });

  it('shows an invalid detected value blank, with the reason', async () => {
    renderAndPick();
    await screen.findByTestId('catalog-field-homepageUrl');
    expect(row('homepageUrl')).toHaveTextContent('Not used: must use https');
    expect(row('homepageUrl')).not.toHaveTextContent('Not found in package');
  });

  it('Accept all marks every field accepted and uploads without a metadata part', async () => {
    renderAndPick();
    await screen.findByTestId('catalog-field-displayName');
    fireEvent.click(screen.getByRole('button', { name: /accept all/i }));
    expect(within(row('summary')).getByText('Accepted')).toBeInTheDocument();
    expect(within(row('readme')).getByText('Accepted')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(uploadPlugin).toHaveBeenCalled());
    expect(uploadPlugin.mock.calls[0][2]).toMatchObject({ catalogEdits: {} });
  });

  it('sends only the edited fields as catalog edits, and a revert drops the edit', async () => {
    renderAndPick();
    await screen.findByTestId('catalog-field-summary');

    fireEvent.click(screen.getByRole('button', { name: 'Accept Display name' }));
    expect(within(row('displayName')).getByText('Accepted')).toBeInTheDocument();

    // Edit the summary.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Summary' }));
    fireEvent.change(within(row('summary')).getByRole('textbox'), { target: { value: 'Find lint in JS and TS' } });
    fireEvent.click(within(row('summary')).getByRole('button', { name: 'Save' }));
    expect(within(row('summary')).getByText('Edited')).toBeInTheDocument();
    expect(row('summary')).toHaveTextContent('Find lint in JS and TS');

    // Edit keywords (comma-separated) and category (select).
    fireEvent.click(screen.getByRole('button', { name: 'Edit Keywords' }));
    fireEvent.change(within(row('keywords')).getByRole('textbox'), { target: { value: 'lint, typescript ,js' } });
    fireEvent.click(within(row('keywords')).getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Category' }));
    fireEvent.change(within(row('category')).getByRole('combobox'), { target: { value: 'testing' } });
    fireEvent.click(within(row('category')).getByRole('button', { name: 'Save' }));

    // Edit then revert the license — it must not be sent.
    fireEvent.click(screen.getByRole('button', { name: 'Edit License' }));
    fireEvent.change(within(row('license')).getByRole('textbox'), { target: { value: 'Apache-2.0' } });
    fireEvent.click(within(row('license')).getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert License' }));
    expect(row('license')).toHaveTextContent('MIT');

    fireEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(uploadPlugin).toHaveBeenCalled());
    expect(uploadPlugin.mock.calls[0][2]).toMatchObject({
      catalogEdits: { summary: 'Find lint in JS and TS', keywords: ['lint', 'typescript', 'js'], category: 'testing' },
    });
    expect(Object.keys((uploadPlugin.mock.calls[0][2] as { catalogEdits: object }).catalogEdits).sort())
      .toEqual(['category', 'keywords', 'summary']);
  }, 20_000);

  it('refuses a non-https link client-side without recording the edit', async () => {
    renderAndPick();
    await screen.findByTestId('catalog-field-documentationUrl');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Documentation URL' }));
    fireEvent.change(within(row('documentationUrl')).getByRole('textbox'), { target: { value: 'http://docs.example.com' } });
    fireEvent.click(within(row('documentationUrl')).getByRole('button', { name: 'Save' }));
    expect(row('documentationUrl')).toHaveTextContent('must use https');
    expect(within(row('documentationUrl')).queryByText('Edited')).not.toBeInTheDocument();
  });

  it('still allows the upload when inspect fails', async () => {
    inspectPlugin.mockRejectedValue(new Error('Invalid plugin package'));
    renderAndPick();
    expect(await screen.findByText(/Invalid plugin package/)).toBeInTheDocument();
    expect(screen.getByText(/You can still upload/)).toBeInTheDocument();

    const upload = screen.getByRole('button', { name: /^upload$/i });
    expect(upload).not.toBeDisabled();
    fireEvent.click(upload);
    await waitFor(() => expect(uploadPlugin).toHaveBeenCalled());
    expect(uploadPlugin.mock.calls[0][2]).toMatchObject({ catalogEdits: {} });
  });

  it('shows the server 400 message when an edit is refused on upload', async () => {
    const { ApiError } = jest.requireActual<typeof import('../src/lib/api/errors')>('../src/lib/api/errors');
    uploadPlugin.mockRejectedValue(new ApiError('metadata.license: must be a supported SPDX license identifier', 400));
    renderAndPick();
    await screen.findByTestId('catalog-field-license');
    fireEvent.click(screen.getByRole('button', { name: /^upload$/i }));
    expect(await screen.findByText(/must be a supported SPDX license identifier/)).toBeInTheDocument();
  });
});

describe('plugins API client — inspect + catalog edits', () => {
  // The real client (the `@/lib/api` mock above only replaces the default export).
  const { pluginsApi } = jest.requireActual<typeof import('../src/lib/api/domains/plugins')>('../src/lib/api/domains/plugins');
  const { ApiCore } = jest.requireActual<typeof import('../src/lib/api/core')>('../src/lib/api/core');
  const core = new ApiCore();
  const file = new File(['zip'], 'p.zip', { type: 'application/zip' });

  function respond(status: number, body: unknown) {
    const fetchMock = jest.fn<AnyFn>(async () => ({ ok: status < 400, status, json: async () => body }));
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }
  const sentForm = (fetchMock: jest.Mock<AnyFn>) => (fetchMock.mock.calls[0][1] as { body: FormData }).body;

  it('inspectPlugin posts the file and unwraps the payload', async () => {
    const fetchMock = respond(200, { success: true, statusCode: 200, data: INSPECT });
    await expect(pluginsApi(core).inspectPlugin(file)).resolves.toEqual(INSPECT);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plugins/inspect');
    expect(sentForm(fetchMock).get('plugin')).toBeInstanceOf(File);
  });

  it('inspectPlugin surfaces the server message', async () => {
    respond(400, { success: false, statusCode: 400, message: 'plugin-spec.yaml not found' });
    await expect(pluginsApi(core).inspectPlugin(file)).rejects.toMatchObject({ statusCode: 400, message: 'plugin-spec.yaml not found' });
  });

  it('uploadPlugin sends the edits as the metadata JSON part, and omits it when there are none', async () => {
    let fetchMock = respond(202, { success: true, statusCode: 202, data: { requestId: 'r' } });
    await pluginsApi(core).uploadPlugin(file, 'org', { catalogEdits: { summary: 'New', license: null } });
    expect(JSON.parse(sentForm(fetchMock).get('metadata') as string)).toEqual({ summary: 'New', license: null });

    fetchMock = respond(202, { success: true, statusCode: 202, data: { requestId: 'r' } });
    await pluginsApi(core).uploadPlugin(file, 'org', { catalogEdits: {} });
    expect(sentForm(fetchMock).has('metadata')).toBe(false);
  });
});
