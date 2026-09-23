import { useState, useEffect, useCallback, useMemo } from 'react';
import { formatDateTime } from '@/lib/format';
import { useEntityFetch } from '@/hooks/useEntityFetch';
import { LoadingSpinner } from '@/components/ui/Loading';
import { Modal } from '@/components/ui/Modal';
import { ReadonlyField } from '@/components/ui/ReadonlyField';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/Button';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { InfoAlert } from '@/components/ui/InfoAlert';
import { SuccessAlert } from '@/components/ui/SuccessAlert';
import { WarningAlert } from '@/components/ui/WarningAlert';
import api from '@/lib/api';
import { ApiError } from '@/lib/api/errors';
import type { PluginSummary } from '@/lib/api/domains/plugins';
import { formatError, formatEnvelopeError } from '@/lib/constants';
import { CATEGORY_DISPLAY_NAMES, PLUGIN_CATEGORIES } from '@/lib/plugin-categories';
import {
  CATALOG_FIELD_EDITOR, CATALOG_FIELD_HINTS, CATALOG_FIELD_LABELS, CATALOG_SOURCE_LABELS,
  catalogValueToText, parseCatalogText,
} from '@/lib/plugin-catalog';
import { PLUGIN_CATALOG_FIELDS, type Plugin, type PluginCatalogField, type Visibility } from '@/types';
import { VisibilitySelect, visibilityHint } from '@/components/ui/VisibilitySelect';
import { CatalogOwnerFields, type CatalogOwner } from '@/components/ui/CatalogOwnerFields';
import { useAuth } from '@/hooks/useAuth';
import { isOrgAdmin, isSystemAdmin } from '@/lib/auth-helpers';
import { useUnmountedRef } from '@/hooks/useUnmountedRef';
import { useAutoCloseTimer } from '@/hooks/useAutoCloseTimer';
import { invalidate } from '@/lib/api-cache';

/** Props for the EditPluginModal component. */
interface EditPluginModalProps {
  /** The row to edit — a list summary is enough; the full record (catalog
   *  metadata, owner) is fetched by id on mount and seeds the form. */
  plugin: PluginSummary;
  /** Whether the current user may PUBLISH (make a plugin public) — gates the
   *  access-modifier control. Sourced from `can('plugins:publish')` (superadmins
   *  bypass), matching the backend gate, not the org-admin role. */
  canPublish: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
  /** Callback when the plugin is successfully saved. */
  onSaved: () => void;
}

type CatalogTexts = Record<PluginCatalogField, string>;

/** A stored plugin's value for a catalog field (the README is stored as `readmeMd`). */
function storedCatalogValue(pl: Plugin, field: PluginCatalogField): unknown {
  return field === 'readme' ? pl.readmeMd : pl[field];
}

/** The catalog fields as the form renders them for a given record. */
function catalogTexts(pl: Plugin): CatalogTexts {
  return Object.fromEntries(
    PLUGIN_CATALOG_FIELDS.map((f) => [f, catalogValueToText(f, storedCatalogValue(pl, f))]),
  ) as CatalogTexts;
}

const EMPTY_TEXTS = Object.fromEntries(PLUGIN_CATALOG_FIELDS.map((f) => [f, ''])) as CatalogTexts;

/**
 * Modal for editing a plugin's catalog details (the descriptive fields) and its
 * operational settings (visibility, owner, active/default).
 *
 * The execution contract — commands, environment, secrets, compute, name,
 * version — is not editable here: it changes only by uploading a new version
 * (the API refuses those keys). Only CHANGED fields are sent.
 */
export default function EditPluginModal({ plugin, canPublish, onClose, onSaved }: EditPluginModalProps) {
  const [texts, setTexts] = useState<CatalogTexts>(EMPTY_TEXTS);
  /** The form renders only once seeded from the fetched record — never with blanks
   *  a quick user (or a save) could mistake for cleared fields. */
  const [seeded, setSeeded] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<PluginCatalogField, string>>>({});
  const [isActive, setIsActive] = useState(plugin.isActive);
  const [isDefault, setIsDefault] = useState(plugin.isDefault);
  const [visibility, setVisibility] = useState<Visibility>(plugin.visibility);
  // Catalog owner (person or team); the list row omits the owner columns, so it
  // seeds from the full record below. Reassigning it is admin-only server-side.
  const [owner, setOwner] = useState<CatalogOwner>({});
  const { user } = useAuth();
  const canAssignOwner = isOrgAdmin(user) || isSystemAdmin(user);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** A 409: this version's catalog details are frozen by a publish request / listing. */
  const [frozenMessage, setFrozenMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const unmountedRef = useUnmountedRef();
  const autoClose = useAutoCloseTimer();

  // Fetch the full plugin by ID (the list row lacks the catalog metadata and
  // owner); useEntityFetch only re-fires on id change so a stale re-mount won't
  // overwrite in-progress user edits.
  const fetchPlugin = useCallback(async (id: string): Promise<Plugin> => {
    const response = await api.getPluginById(id);
    if (!response.data?.plugin) throw new Error(formatEnvelopeError(response, 'Failed to load plugin'));
    return response.data.plugin;
  }, []);
  const { entity: fullPlugin, fetching, error: fetchError } = useEntityFetch<Plugin>(plugin.id, fetchPlugin);

  // Seed editable fields once the full record loads.
  useEffect(() => {
    if (!fullPlugin) return;
    setTexts(catalogTexts(fullPlugin));
    setIsActive(fullPlugin.isActive);
    setIsDefault(fullPlugin.isDefault);
    setVisibility(fullPlugin.visibility);
    setOwner({ ownerId: fullPlugin.ownerId, ownerType: fullPlugin.ownerType });
    setSeeded(true);
  }, [fullPlugin]);

  const p = fullPlugin;
  const loadingRecord = fetching || !p || !seeded;
  const baseTexts = useMemo(() => (fullPlugin ? catalogTexts(fullPlugin) : null), [fullPlugin]);

  const changedCatalogFields = baseTexts
    ? PLUGIN_CATALOG_FIELDS.filter((f) => texts[f] !== baseTexts[f])
    : [];
  const ownerChanged = !!fullPlugin
    && ((owner.ownerId ?? null) !== (fullPlugin.ownerId ?? null) || (owner.ownerType ?? null) !== (fullPlugin.ownerType ?? null));
  const visibilityChanged = !!fullPlugin && visibility !== fullPlugin.visibility;
  const isActiveChanged = !!fullPlugin && isActive !== fullPlugin.isActive;
  const isDefaultChanged = !!fullPlugin && isDefault !== fullPlugin.isDefault;
  // A misplaced backdrop click must not discard edits silently — including a
  // lone owner reassignment.
  const dirty = seeded && (changedCatalogFields.length > 0 || ownerChanged || visibilityChanged || isActiveChanged || isDefaultChanged);

  const setText = (field: PluginCatalogField, value: string) => {
    setTexts((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const handleSave = async () => {
    setSaveError(null);
    setFrozenMessage(null);
    setSuccess(null);
    if (!fullPlugin) return;

    // Only the fields that changed — light client checks first; the server is
    // authoritative and its 400 message is shown as is.
    const data: Parameters<typeof api.updatePlugin>[1] = {};
    const errors: Partial<Record<PluginCatalogField, string>> = {};
    for (const field of changedCatalogFields) {
      const prevIcon = field === 'icon' ? fullPlugin.icon : null;
      const parsed = parseCatalogText(field, texts[field], prevIcon);
      if (parsed.ok) (data as Record<string, unknown>)[field] = parsed.value;
      else errors[field] = `${CATALOG_FIELD_LABELS[field]} ${parsed.error}`;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSaveError('Fix the highlighted fields and try again.');
      return;
    }
    if (visibilityChanged) data.visibility = visibility;
    if (isActiveChanged) data.isActive = isActive;
    if (isDefaultChanged) data.isDefault = isDefault;
    // Owner is admin-only server-side and non-nullable in the schema, so only
    // send it when this viewer may set it AND it resolves to a real id.
    if (ownerChanged && canAssignOwner && owner.ownerId && owner.ownerType) {
      data.ownerId = owner.ownerId;
      data.ownerType = owner.ownerType;
    }

    if (Object.keys(data).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      const response = await api.updatePlugin(plugin.id, data);
      if (unmountedRef.current) return;
      if (response?.success) {
        setSuccess('Plugin updated successfully!');
        // The pipeline builder's plugin picker caches the catalog — drop it.
        invalidate.plugins();
        onSaved();
        autoClose.schedule(onClose, 1500);
      } else {
        setSaveError(formatEnvelopeError(response, 'Failed to update plugin'));
      }
    } catch (err) {
      if (unmountedRef.current) return;
      if (err instanceof ApiError && err.statusCode === 409) setFrozenMessage(err.message);
      else setSaveError(formatError(err, 'Failed to update plugin'));
    } finally {
      if (!unmountedRef.current) setSaving(false);
    }
  };

  const footer = (
    <div className="flex justify-end space-x-3">
      <Button variant="secondary" onClick={onClose} disabled={saving}>
        Cancel
      </Button>
      <Button onClick={() => void handleSave()} disabled={saving || loadingRecord}>
        {saving ? (<><LoadingSpinner size="sm" className="mr-2" />Saving...</>) : 'Save Changes'}
      </Button>
    </div>
  );

  const renderCatalogField = (field: PluginCatalogField) => {
    const label = CATALOG_FIELD_LABELS[field];
    const source = p?.metadataSources?.[field];
    const hint = [source ? `Source: ${CATALOG_SOURCE_LABELS[source]}` : null, CATALOG_FIELD_HINTS[field]]
      .filter(Boolean).join(' · ') || undefined;
    const kind = CATALOG_FIELD_EDITOR[field];
    const value = texts[field];
    const onChange = (v: string) => setText(field, v);
    return (
      <FormField key={field} label={label} hint={hint} error={fieldErrors[field]} className="mb-3">
        {kind === 'textarea' ? (
          <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={field === 'description' ? 3 : 5} disabled={saving} />
        ) : kind === 'select' ? (
          <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={saving}>
            <option value="">— None —</option>
            {PLUGIN_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_DISPLAY_NAMES[c]}</option>)}
            {value && !(PLUGIN_CATEGORIES as readonly string[]).includes(value) && <option value={value}>{value}</option>}
          </Select>
        ) : (
          <Input
            type="text" value={value} onChange={(e) => onChange(e.target.value)} disabled={saving}
            placeholder={kind === 'keywords' ? 'keyword1, keyword2, keyword3' : undefined}
          />
        )}
      </FormField>
    );
  };

  return (
    <Modal title="Edit plugin" onClose={onClose} maxWidth="max-w-2xl" tall footer={footer} dirty={dirty}>
      <ErrorAlert message={saveError} />
      {frozenMessage && (
        <WarningAlert
          message={(
            <>
              <span className="font-medium">Catalog details are frozen for this version.</span>{' '}
              {frozenMessage} Visibility and status changes can still be saved on their own.
            </>
          )}
        />
      )}
      <SuccessAlert message={success} />

      {!p && fetchError ? (
        <ErrorAlert message={formatError(fetchError, 'Failed to load plugin')} />
      ) : loadingRecord || !p ? (
        <div className="flex justify-center py-12"><LoadingSpinner size="lg" /></div>
      ) : (
        <div className="space-y-4">
          {/* Read-only Fields */}
          <div className="border-b border-default pb-4">
            <h3 className="text-sm font-medium text-fg-muted mb-3">System information (read-only)</h3>
            <div className="grid grid-cols-2 gap-4">
              <ReadonlyField label="Name" value={p.name} valueClassName="font-mono" />
              <ReadonlyField label="Version" value={p.version} valueClassName="font-mono" />
              <ReadonlyField label="Plugin type" value={p.pluginType} />
              <ReadonlyField label="Compute type" value={p.computeType} />
              <ReadonlyField label="ID" value={p.id} valueClassName="font-mono" />
              <ReadonlyField label="Org ID" value={p.orgId} />
              <ReadonlyField label="Created by" value={p.createdBy} />
              <ReadonlyField label="Created at" value={formatDateTime(p.createdAt)} />
              <ReadonlyField label="Updated by" value={p.updatedBy} />
              <ReadonlyField label="Updated at" value={formatDateTime(p.updatedAt)} />
              <ReadonlyField label="Image URI" value={p.uri} className="col-span-2" valueClassName="font-mono break-all" />
            </div>
            <InfoAlert
              className="mt-3"
              message="Commands, environment, secrets and compute are the plugin's execution contract. They change only by uploading a new version."
            />
          </div>

          {/* Catalog details */}
          <div className="border-b border-default pb-4">
            <h3 className="text-sm font-medium text-fg-muted mb-3">Catalog details</h3>
            {PLUGIN_CATALOG_FIELDS.map(renderCatalogField)}
          </div>

          {/* Access & Status */}
          <div>
            <h3 className="text-sm font-medium text-fg-muted mb-3">Access & Status</h3>
            <div className="grid grid-cols-2 gap-4 mb-3">
              <FormField label="Visibility" hint={visibilityHint(canPublish, 'plugins:publish', true)}>
                <VisibilitySelect value={visibility} onChange={setVisibility} canPublish={canPublish} disabled={saving} />
              </FormField>
              {/* Owner + team access — the same control the pipeline editor uses,
                  because the backend rules are the same: admin-only owner write,
                  `plugins:publish` for the rung a team org reads at, and no move. */}
              <CatalogOwnerFields
                value={owner}
                onChange={setOwner}
                visibility={visibility}
                canAssign={canAssignOwner}
                personOwnerId={(p.ownerType === 'user' && p.ownerId) || p.createdBy || ''}
                onShareWithTeams={canPublish ? () => setVisibility('public') : undefined}
                entityNoun="plugins"
                publishPermission="plugins:publish"
                idPrefix="editPlugin"
                disabled={saving}
              />
            </div>
            <div className="flex items-center space-x-6">
              <div className="flex items-center">
                <Checkbox id="editIsActive" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 text-brand focus:ring-[color:var(--pb-ring)]" disabled={saving} />
                <label htmlFor="editIsActive" className="ml-2 block text-sm text-fg-muted">Active</label>
              </div>
              <div className="flex items-center">
                <Checkbox id="editIsDefault" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="h-4 w-4 text-brand focus:ring-[color:var(--pb-ring)]" disabled={saving} />
                <label htmlFor="editIsDefault" className="ml-2 block text-sm text-fg-muted">Default</label>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
