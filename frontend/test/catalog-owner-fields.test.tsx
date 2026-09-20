// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Team ownership of a catalog entity — shared by pipelines AND plugins.
 *
 * There is deliberately no "move to team" for either: `pipelines` and `plugins`
 * are both FORCE'd RLS with `WITH CHECK (org_id = current_org_id())`, so
 * Postgres refuses an UPDATE that rewrites `org_id`. What the model does
 * support is the catalog owner plus the `public` visibility rung a team org
 * reads its parent's rows at — one predicate
 * (`AccessControlQueryBuilder.buildAccessControl`) serves both entities, and
 * both services pass the team's `parentOrgId` on every read path, so the
 * warning is equally true either way. Owning something the team cannot see is a
 * label with nothing behind it, which is what that warning exists to catch.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CatalogOwnerFields } from '../src/components/ui/CatalogOwnerFields';

let hierarchy = { activeOrg: { id: 'root-1' }, hasChildOrgs: true, isChildOrg: false };
jest.mock('@/hooks/useOrgHierarchy', () => ({
  __esModule: true,
  useOrgHierarchy: () => hierarchy,
}));

const getOrganizationTeams = jest.fn();
jest.mock('@/lib/api', () => ({
  __esModule: true,
  default: { getOrganizationTeams: (...a: unknown[]) => getOrganizationTeams(...a) },
}));

beforeEach(() => {
  jest.clearAllMocks();
  hierarchy = { activeOrg: { id: 'root-1' }, hasChildOrgs: true, isChildOrg: false };
  getOrganizationTeams.mockResolvedValue({ success: true, data: { teams: [{ orgId: 'team-1', orgName: 'Payments' }] } });
});

const noop = () => {};

/** Defaults are the pipeline flavour; the plugin cases override the two strings. */
const PIPELINE = { entityNoun: 'pipelines', publishPermission: 'pipelines:publish' } as const;
const PLUGIN = { entityNoun: 'plugins', publishPermission: 'plugins:publish' } as const;

describe('CatalogOwnerFields', () => {
  it('renders nothing for a flat org with no team owner', () => {
    hierarchy = { activeOrg: { id: 'root-1' }, hasChildOrgs: false, isChildOrg: false };
    const { container } = render(
      <CatalogOwnerFields {...PIPELINE} value={{}} onChange={noop} visibility="org" canAssign personOwnerId="u1" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(getOrganizationTeams).not.toHaveBeenCalled();
  });

  it('offers the org teams and reports a team pick as a catalog owner', async () => {
    const onChange = jest.fn();
    render(<CatalogOwnerFields {...PIPELINE} value={{}} onChange={onChange} visibility="public" canAssign personOwnerId="u1" />);
    await screen.findByRole('option', { name: /Team: Payments/ });

    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'team:team-1' } });
    expect(onChange).toHaveBeenCalledWith({ ownerId: 'team-1', ownerType: 'team' });
    await waitFor(() => expect(getOrganizationTeams).toHaveBeenCalled());
  });

  it('hands a team-owned entity back to a named person, never to nothing', async () => {
    const onChange = jest.fn();
    render(
      <CatalogOwnerFields
        {...PIPELINE}
        value={{ ownerId: 'team-1', ownerType: 'team' }}
        onChange={onChange}
        visibility="public"
        canAssign
        personOwnerId="creator-9"
      />,
    );
    await screen.findByRole('option', { name: /Team: Payments/ });
    fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'user' } });
    // The server schema requires a non-empty ownerId, so "a person" must resolve.
    expect(onChange).toHaveBeenCalledWith({ ownerId: 'creator-9', ownerType: 'user' });
    await waitFor(() => expect(getOrganizationTeams).toHaveBeenCalled());
  });

  it.each([
    ['pipelines', PIPELINE],
    ['plugins', PLUGIN],
  ])('warns in %s wording when the owning team cannot see it, and offers the fix', async (noun, props) => {
    const onShare = jest.fn();
    render(
      <CatalogOwnerFields
        {...props}
        value={{ ownerId: 'team-1', ownerType: 'team' }}
        onChange={noop}
        visibility="org"
        canAssign
        personOwnerId="u1"
        onShareWithTeams={onShare}
      />,
    );
    const warning = await screen.findByTestId('team-visibility-warning');
    expect(warning).toHaveTextContent(new RegExp(`public ${noun}`));
    expect(warning).toHaveTextContent(/can't open this one yet/i);
    fireEvent.click(screen.getByRole('button', { name: /set visibility to public/i }));
    expect(onShare).toHaveBeenCalled();
    await waitFor(() => expect(getOrganizationTeams).toHaveBeenCalled());
  });

  it.each([
    ['pipelines:publish', PIPELINE],
    ['plugins:publish', PLUGIN],
  ])('names the missing %s permission when the viewer cannot publish', async (permission, props) => {
    render(
      <CatalogOwnerFields
        {...props}
        value={{ ownerId: 'team-1', ownerType: 'team' }}
        onChange={noop}
        visibility="private"
        canAssign
        personOwnerId="u1"
      />,
    );
    expect(await screen.findByTestId('team-visibility-warning')).toHaveTextContent(permission);
    expect(screen.queryByRole('button', { name: /set visibility to public/i })).not.toBeInTheDocument();
    await waitFor(() => expect(getOrganizationTeams).toHaveBeenCalled());
  });

  it('keeps a team owner the roster no longer lists selected', async () => {
    getOrganizationTeams.mockResolvedValue({ success: true, data: { teams: [] } });
    render(
      <CatalogOwnerFields
        {...PLUGIN}
        value={{ ownerId: 'gone-team', ownerType: 'team' }}
        onChange={noop}
        visibility="public"
        canAssign
        personOwnerId="u1"
      />,
    );
    await waitFor(() => expect(getOrganizationTeams).toHaveBeenCalled());
    expect((screen.getByLabelText('Owner') as HTMLSelectElement).value).toBe('team:gone-team');
    expect(screen.getByRole('option', { name: /no longer listed/i })).toBeInTheDocument();
  });

  it('is read-only for a non-admin, who the server would ignore anyway', async () => {
    render(
      <CatalogOwnerFields {...PLUGIN} value={{}} onChange={noop} visibility="org" canAssign={false} personOwnerId="u1" />,
    );
    expect(screen.getByLabelText('Owner')).toBeDisabled();
    expect(screen.getByText(/Only an organization admin can reassign ownership/i)).toBeInTheDocument();
    await waitFor(() => expect(getOrganizationTeams).toHaveBeenCalled());
  });

  it('never asks a team org for its own teams', async () => {
    hierarchy = { activeOrg: { id: 'team-1' }, hasChildOrgs: false, isChildOrg: true };
    render(
      <CatalogOwnerFields
        {...PIPELINE}
        value={{ ownerId: 'team-1', ownerType: 'team' }}
        onChange={noop}
        visibility="public"
        canAssign
        personOwnerId="u1"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Owner')).toBeInTheDocument());
    expect(getOrganizationTeams).not.toHaveBeenCalled();
  });

  it('gives each host a distinct DOM id so two can coexist', async () => {
    const { unmount } = render(
      <CatalogOwnerFields {...PIPELINE} value={{}} onChange={noop} visibility="org" canAssign personOwnerId="u1" idPrefix="editPipeline" />,
    );
    expect(screen.getByLabelText('Owner')).toHaveAttribute('id', 'editPipelineOwner');
    await waitFor(() => expect(getOrganizationTeams).toHaveBeenCalled());
    unmount();

    render(
      <CatalogOwnerFields {...PLUGIN} value={{}} onChange={noop} visibility="org" canAssign personOwnerId="u1" idPrefix="editPlugin" />,
    );
    expect(screen.getByLabelText('Owner')).toHaveAttribute('id', 'editPluginOwner');
    await waitFor(() => expect(getOrganizationTeams).toHaveBeenCalled());
  });
});
