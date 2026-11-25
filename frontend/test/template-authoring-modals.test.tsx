// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Golden-path template authoring, with real children and only `@/lib/api`
 * mocked:
 *  - CreateTemplateModal: pick a source pipeline (its props fetched by id),
 *    the source's repository (`synth.source.options.repo`) auto-declared as a
 *    `repo` input and swapped for `{{ vars.repo }}` everywhere in the saved
 *    props — the source itself, so instantiate builds the supplied repo; the half-filled / mis-named input
 *    refusals; a refused create; the preselected "Save as template" flow;
 *  - EditTemplateModal: the template's props hydrate the REAL builder (no
 *    toolchain picker — templates never carry one), inputs are edited, and the
 *    save body carries the edits;
 *  - ImportTemplateModal: paste / upload, the shape refusals, and the
 *    public→org clamp without `templates:publish`.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AnyFn } from './helpers/mock-fn';
import { apiFn, resetApiMock } from './helpers/apiMock';
import { ApiError } from '../src/lib/api/errors';

jest.mock('@/lib/api', () => require('./helpers/apiMock').apiMockModule());

import { CreateTemplateModal } from '@/components/pipeline/CreateTemplateModal';
import EditTemplateModal from '@/components/pipeline/EditTemplateModal';
import { ImportTemplateModal } from '@/components/pipeline/ImportTemplateModal';

const REPO = 'acme/web';
const REPO_URL = `https://github.com/${REPO}`;
const PROPS = {
  project: 'web', organization: 'acme', pipelineName: 'acme-web-pipeline',
  synth: { source: { type: 'github', options: { repo: 'acme/web' } }, plugin: { name: 'cdk-synth' } },
  global: { 'aws:cdk:repo:url': REPO_URL },
};
const PIPELINE = {
  id: 'pl-1', orgId: 'org-1', project: 'web', organization: 'acme', pipelineName: 'web', props: PROPS,
  visibility: 'org', isActive: true, isDefault: false, createdAt: '', createdBy: 'u1',
};

beforeEach(() => {
  resetApiMock();
  apiFn('createPipelineTemplate').mockResolvedValue({ success: true, data: { template: { id: 't-1' } } });
});

describe('CreateTemplateModal', () => {
  function renderCreate(over: Partial<Parameters<typeof CreateTemplateModal>[0]> = {}) {
    const onClose = jest.fn<AnyFn>();
    const onCreated = jest.fn<AnyFn>();
    render(<CreateTemplateModal canPublish={false} onClose={onClose} onCreated={onCreated} {...over} />);
    return { onClose, onCreated };
  }
  const createBtn = () => screen.getByRole('button', { name: /Create template/ });

  it('builds a repo-parameterized template from a picked pipeline', async () => {
    apiFn('listAllPipelines').mockResolvedValue([{ id: 'pl-1', pipelineName: 'web', project: 'web' }, { id: 'pl-2', pipelineName: '', project: 'api' }]);
    apiFn('getPipelineById').mockResolvedValue({ success: true, data: { pipeline: PIPELINE } });
    const { onCreated } = renderCreate();
    const picker = screen.getByLabelText('Source pipeline');
    expect(await within(picker).findByRole('option', { name: 'api' })).toBeInTheDocument();
    expect(createBtn()).toBeDisabled();

    fireEvent.change(picker, { target: { value: 'pl-1' } });
    await waitFor(() => expect(screen.getByLabelText('Template name')).toHaveValue('web-template'));
    expect(apiFn('getPipelineById')).toHaveBeenCalledWith('pl-1');
    // The source repository was detected and declared as an input on its own.
    expect(await screen.findByDisplayValue('repo')).toBeInTheDocument();
    expect(screen.getByLabelText('Value to replace')).toHaveValue(REPO);
    // "Parameterize repository" does not add it twice.
    fireEvent.click(screen.getByRole('button', { name: /Parameterize repository/ }));
    expect(screen.getAllByLabelText('Input name')).toHaveLength(1);

    // A second, typed input: number default coerced, options split.
    fireEvent.click(screen.getByRole('button', { name: /Add input/ }));
    const names = screen.getAllByLabelText('Input name');
    fireEvent.change(names[1], { target: { value: 'replicas' } });
    fireEvent.change(screen.getAllByLabelText('Input type')[1], { target: { value: 'number' } });
    fireEvent.change(screen.getAllByLabelText('Input default')[1], { target: { value: '3' } });
    fireEvent.change(screen.getAllByLabelText('Input options')[1], { target: { value: '1, 3, 5' } });

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'backend' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: ' Node service ' } });
    fireEvent.change(screen.getByLabelText('Keywords'), { target: { value: 'golden, node' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'org' } });
    fireEvent.click(createBtn());

    await waitFor(() => expect(apiFn('createPipelineTemplate')).toHaveBeenCalledTimes(1));
    const body = apiFn('createPipelineTemplate').mock.calls[0][0] as Record<string, any>;
    expect(body).toMatchObject({
      name: 'web-template', category: 'backend', description: 'Node service', keywords: ['golden', 'node'], visibility: 'org',
      inputs: [
        { name: 'repo', label: 'Repository', type: 'string', required: true },
        { name: 'replicas', type: 'number', default: 3, options: ['1', '3', '5'] },
      ],
    });
    // The SOURCE is parameterized (instantiate bakes it into a real repository);
    // the metadata URL that embeds it follows (it resolves at synth).
    expect(body.props.synth.source.options.repo).toBe('{{ vars.repo }}');
    expect(body.props.global['aws:cdk:repo:url']).toBe('https://github.com/{{ vars.repo }}');
    expect(JSON.stringify(body.props)).not.toContain(REPO);
    expect(await screen.findByText('Template "web-template" saved as shared with your organization.')).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledTimes(1);
    // Locked after success: a second click cannot create a duplicate.
    expect(createBtn()).toBeDisabled();
  });

  it('refuses a replacement with no input name, and an input name that is not an identifier', async () => {
    renderCreate({ pipeline: PIPELINE as never });
    await screen.findByDisplayValue('repo');
    fireEvent.change(screen.getByLabelText('Input name'), { target: { value: '' } });
    fireEvent.click(createBtn());
    expect(await screen.findByText(`Give the input that replaces "${REPO}" a name.`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Input name'), { target: { value: '9lives' } });
    fireEvent.click(createBtn());
    expect(await screen.findByText(/Input name "9lives" must be a valid identifier/)).toBeInTheDocument();
    // Removing the row clears the way; the template saves as a fixed clone.
    fireEvent.click(screen.getByRole('button', { name: 'Remove input' }));
    expect(screen.getByText(/No inputs — the template instantiates as a fixed clone/)).toBeInTheDocument();
    fireEvent.click(createBtn());
    await waitFor(() => expect(apiFn('createPipelineTemplate')).toHaveBeenCalledTimes(1));
    expect(apiFn('createPipelineTemplate').mock.calls[0][0]).toMatchObject({ name: 'web-template', visibility: 'private', inputs: [], props: PROPS });
  });

  it('a refused create keeps the modal usable and shows the server message', async () => {
    apiFn('createPipelineTemplate').mockResolvedValueOnce({ success: false, message: 'A template with that name exists' });
    apiFn('createPipelineTemplate').mockRejectedValueOnce(new Error('network down'));
    renderCreate({ pipeline: PIPELINE as never });
    await screen.findByDisplayValue('repo');
    fireEvent.click(createBtn());
    expect(await screen.findByText('A template with that name exists')).toBeInTheDocument();
    fireEvent.click(createBtn());
    expect(await screen.findByText(/network down/)).toBeInTheDocument();
    expect(createBtn()).toBeEnabled();
  });

  it('a preselected list row without props fetches the full record; a failed load says so', async () => {
    apiFn('getPipelineById').mockResolvedValueOnce({ success: false });
    renderCreate({ pipeline: { ...PIPELINE, props: undefined } as never });
    expect(screen.getByLabelText('Source pipeline')).toBeDisabled();
    expect(await screen.findByText('Could not load the selected pipeline.')).toBeInTheDocument();
    expect(apiFn('getPipelineById')).toHaveBeenCalledWith('pl-1');
  });

  it('a file that cannot be read is reported', async () => {
    renderImportForReadError();
    const file = new File(['x'], 'bad.json');
    Object.defineProperty(file, 'text', { value: async () => { throw new Error('unreadable'); } });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    expect(await screen.findByText(/unreadable/)).toBeInTheDocument();
  });

  it('the picker failing to load is reported', async () => {
    apiFn('listAllPipelines').mockRejectedValue(new Error('boom'));
    renderCreate();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });
});

function renderImportForReadError() {
  render(<ImportTemplateModal canPublish={false} onClose={jest.fn<AnyFn>()} onImported={jest.fn<AnyFn>()} />);
}

describe('EditTemplateModal', () => {
  const TEMPLATE = {
    id: 't-1', orgId: 'org-1', createdBy: 'u1', createdAt: '2026-11-01T00:00:00Z', updatedBy: 'u2', updatedAt: '2026-11-02T00:00:00Z',
    name: 'node-service', description: 'Node starter', keywords: ['node'], category: 'backend', visibility: 'org',
    props: PROPS, inputs: [{ name: 'repoUrl', label: 'Repository URL', type: 'string', required: true }],
    lifecycle: 'production', isActive: true,
  };
  function renderEdit() {
    const onClose = jest.fn<AnyFn>();
    const onSaved = jest.fn<AnyFn>();
    render(<EditTemplateModal template={TEMPLATE as never} canPublish onClose={onClose} onSaved={onSaved} />);
    return { onClose, onSaved };
  }
  const toLast = async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    await screen.findByLabelText('Repository *');
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    await screen.findByRole('button', { name: '+ Add Stage' });
  };

  beforeEach(() => {
    apiFn('getPipelineTemplate').mockResolvedValue({ success: true, data: { template: TEMPLATE } });
    apiFn('updatePipelineTemplate').mockResolvedValue({ success: true, data: {} });
  });

  it('hydrates the builder from the template, edits inputs, and saves the edits', async () => {
    const { onSaved } = renderEdit();
    expect(await screen.findByLabelText('Project *')).toHaveValue('web');
    expect(apiFn('getPipelineTemplate')).toHaveBeenCalledWith('t-1');
    // Templates never carry a toolchain pin.
    expect(screen.queryByText('Toolchain')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('repoUrl')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'node-svc' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Add input/ }));
    fireEvent.change(screen.getAllByLabelText('Input name')[1], { target: { value: 'debug' } });
    fireEvent.change(screen.getAllByLabelText('Input type')[1], { target: { value: 'boolean' } });
    fireEvent.change(screen.getAllByLabelText('Input default')[1], { target: { value: 'true' } });
    fireEvent.change(screen.getAllByLabelText('Input label')[1], { target: { value: 'Debug' } });
    fireEvent.click(within(screen.getAllByLabelText('Input name')[1].closest('.rounded-lg') as HTMLElement).getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'public' } });

    await toLast();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiFn('updatePipelineTemplate')).toHaveBeenCalledTimes(1));
    const [id, body] = apiFn('updatePipelineTemplate').mock.calls[0] as [string, Record<string, any>];
    expect(id).toBe('t-1');
    expect(body).toMatchObject({
      name: 'node-svc', category: 'general', visibility: 'public', description: 'Node starter', keywords: ['node'],
      inputs: [
        { name: 'repoUrl', label: 'Repository URL', type: 'string', required: true },
        { name: 'debug', label: 'Debug', type: 'boolean', required: true, default: true },
      ],
    });
    expect(body.props).toMatchObject({ project: 'web', organization: 'acme', global: { 'aws:cdk:repo:url': REPO_URL } });
    expect(await screen.findByText('Template updated successfully!')).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('an empty name or a mis-named input sends nothing and returns to step one', async () => {
    renderEdit();
    await screen.findByLabelText('Project *');
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: '' } });
    await toLast();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByLabelText('Template name')).toHaveValue('');
    expect(apiFn('updatePipelineTemplate')).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'ok' } });
    fireEvent.change(screen.getByLabelText('Input name'), { target: { value: 'bad name' } });
    await toLast();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByLabelText('Template name')).toBeInTheDocument();
    expect(apiFn('updatePipelineTemplate')).not.toHaveBeenCalled();
    // Removing the bad row lets it through.
    fireEvent.click(screen.getByRole('button', { name: 'Remove input' }));
    await toLast();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiFn('updatePipelineTemplate')).toHaveBeenCalledTimes(1));
  });

  // Regression: the edit modal bounced to step one on an invalid name with no message.
  it('says why an empty template name was refused', async () => {
    renderEdit();
    await screen.findByLabelText('Project *');
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: '' } });
    await toLast();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await screen.findByLabelText('Template name');
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
  });

  it('sends the loaded updatedAt as expectedUpdatedAt; a 412 says so and Reload resets the form to the latest', async () => {
    apiFn('updatePipelineTemplate').mockRejectedValueOnce(new ApiError('The record was modified by someone else.', 412, 'PRECONDITION_FAILED'));
    const { onSaved } = renderEdit();
    await screen.findByLabelText('Project *');
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'my-stale-name' } });
    await toLast();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiFn('updatePipelineTemplate')).toHaveBeenCalledTimes(1));
    expect(apiFn('updatePipelineTemplate').mock.calls[0][1]).toMatchObject({ expectedUpdatedAt: '2026-11-02T00:00:00Z' });
    expect(await screen.findByTestId('concurrency-conflict')).toHaveTextContent('This was changed by someone else since you opened it. Reload to see the latest.');
    expect(onSaved).not.toHaveBeenCalled();

    apiFn('getPipelineTemplate').mockResolvedValue({ success: true, data: { template: { ...TEMPLATE, name: 'their-name', updatedAt: '2026-11-03T00:00:00Z' } } });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByLabelText('Template name')).toHaveValue('their-name'));
    expect(screen.queryByTestId('concurrency-conflict')).not.toBeInTheDocument();

    await toLast();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiFn('updatePipelineTemplate')).toHaveBeenCalledTimes(2));
    expect(apiFn('updatePipelineTemplate').mock.calls[1][1]).toMatchObject({ name: 'their-name', expectedUpdatedAt: '2026-11-03T00:00:00Z' });
  });

  it('Edit JSON opens the template props; a refused save shows the error', async () => {
    apiFn('updatePipelineTemplate').mockRejectedValue(new Error('Template is referenced by 3 pipelines'));
    renderEdit();
    await screen.findByLabelText('Project *');
    fireEvent.click(screen.getByRole('button', { name: 'Edit JSON' }));
    expect(await screen.findByText(/edit the template `props` directly/)).toBeInTheDocument();
    await toLast();
    fireEvent.click(screen.getByRole('button', { name: /Previous/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    await screen.findByRole('button', { name: '+ Add Stage' });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText(/Template is referenced by 3 pipelines/)).toBeInTheDocument();
  });
});

describe('ImportTemplateModal', () => {
  function renderImport(canPublish = false) {
    const onClose = jest.fn<AnyFn>();
    const onImported = jest.fn<AnyFn>();
    render(<ImportTemplateModal canPublish={canPublish} onClose={onClose} onImported={onImported} />);
    return { onClose, onImported };
  }
  const paste = (text: string) => fireEvent.change(screen.getByLabelText('Template JSON'), { target: { value: text } });
  const importBtn = () => screen.getByRole('button', { name: /Import template/ });

  it('refuses invalid JSON, a missing name and missing props, each by name', async () => {
    renderImport();
    expect(importBtn()).toBeDisabled();
    paste('{nope');
    fireEvent.click(importBtn());
    expect(await screen.findByText(/Invalid JSON/)).toBeInTheDocument();
    paste('null');
    fireEvent.click(importBtn());
    expect(await screen.findByText('JSON must be a template object.')).toBeInTheDocument();
    paste('{"props":{}}');
    fireEvent.click(importBtn());
    expect(await screen.findByText('Template JSON is missing a "name".')).toBeInTheDocument();
    // Regression: a non-string name made `.trim()` throw instead of refusing.
    paste('{"name":5,"props":{}}');
    fireEvent.click(importBtn());
    expect(await screen.findByText('Template JSON is missing a "name".')).toBeInTheDocument();
    paste('{"name":"x"}');
    fireEvent.click(importBtn());
    expect(await screen.findByText(/missing a "props"/)).toBeInTheDocument();
    expect(apiFn('createPipelineTemplate')).not.toHaveBeenCalled();
  });

  it('a public export imports as org-shared without templates:publish, and says so', async () => {
    const { onImported } = renderImport(false);
    paste(JSON.stringify({ id: 'ignored', name: ' node ', description: ' d ', keywords: ['a', 3, 'b'], visibility: 'public', props: PROPS, inputs: [{ name: 'repoUrl', type: 'string' }] }));
    fireEvent.click(importBtn());
    await waitFor(() => expect(apiFn('createPipelineTemplate')).toHaveBeenCalledTimes(1));
    expect(apiFn('createPipelineTemplate').mock.calls[0][0]).toEqual({
      name: 'node', description: 'd', keywords: ['a', 'b'], category: 'general', visibility: 'org', props: PROPS,
      inputs: [{ name: 'repoUrl', type: 'string' }],
    });
    expect(await screen.findByText(/imported \(imported as org-shared — publishing needs templates:publish\)/)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalled();
    expect(importBtn()).toBeDisabled();
  });

  it('with templates:publish a public export stays public; an absent rung is a private draft', async () => {
    renderImport(true);
    paste(JSON.stringify({ name: 'a', visibility: 'public', props: PROPS }));
    fireEvent.click(importBtn());
    await waitFor(() => expect(apiFn('createPipelineTemplate')).toHaveBeenCalledTimes(1));
    expect(apiFn('createPipelineTemplate').mock.calls[0][0]).toMatchObject({ visibility: 'public', inputs: [] });
  });

  it('reads an uploaded .json file into the editor; a refused import shows the message', async () => {
    apiFn('createPipelineTemplate').mockResolvedValueOnce({ success: false, message: 'Name taken' });
    renderImport();
    const json = JSON.stringify({ name: 'from-file', category: 'ops', visibility: 'org', props: PROPS });
    const file = new File([json], 't.json', { type: 'application/json' });
    // jsdom's Blob has no `text()` (every browser does).
    Object.defineProperty(file, 'text', { value: async () => json });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('Template JSON')).toHaveValue(json));
    fireEvent.click(importBtn());
    expect(await screen.findByText('Name taken')).toBeInTheDocument();
    expect(apiFn('createPipelineTemplate').mock.calls[0][0]).toMatchObject({ category: 'ops', visibility: 'org' });
    apiFn('createPipelineTemplate').mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(importBtn());
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
  });
});
