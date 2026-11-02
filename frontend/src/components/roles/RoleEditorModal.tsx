// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

// The NARROW entry point, not the barrel. `@pipeline-builder/api-core` pulls in
// `utils/ssrf.js`, which imports `dns/promises`, `http`, `https` and `net` — so
// the barrel cannot be bundled for the browser, and `next build` fails with
// "Module not found: Can't resolve 'dns/promises'" while jest, which runs in
// Node, passes. Every other frontend consumer of the catalog uses this path.
import { ORG_ASSIGNABLE_CATEGORIES } from '@pipeline-builder/api-core/permissions';
import { Modal } from '@/components/ui/Modal';
import { ModalFooter } from '@/components/ui/ModalFooter';
import { FormField } from '@/components/ui/FormField';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { ErrorAlert } from '@/components/ui/ErrorAlert';

interface Props {
  /** The Role being edited, or null when creating one. Drives the title + button. */
  editingName: string | null;
  name: string;
  description: string;
  /** Selected permission ids. A Set because the picker toggles by id. */
  permissions: Set<string>;
  loading: boolean;
  error: string | null;
  /** DOM id prefix, so the permission group's label pairs with its `role="group"`. */
  uid: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onTogglePermission: (id: string) => void;
  onSave: () => void;
  onClose: () => void;
}

/**
 * Create / edit a custom Role: name, description, and the permission picker.
 *
 * Extracted from `pages/dashboard/roles.tsx`, where it was 82 lines of inline
 * JSX at the bottom of a 570-line page — below the list, the handlers and the
 * delete modal, so the page's shape was hidden by its biggest leaf. The page
 * still owns the form state; this renders it.
 *
 * The picker lists `ORG_ASSIGNABLE_CATEGORIES`, which is the catalog MINUS the
 * superadmin-only and system-org-only permissions — a custom Role may never
 * carry one, and offering a checkbox for something `sanitizePermissions` will
 * refuse would be a dead end rather than a choice.
 */
export function RoleEditorModal({
  editingName,
  name,
  description,
  permissions,
  loading,
  error,
  uid,
  onNameChange,
  onDescriptionChange,
  onTogglePermission,
  onSave,
  onClose,
}: Props) {
  return (
    <Modal
      title={editingName ? `Edit ${editingName}` : 'New Role'}
      onClose={() => !loading && onClose()}
      footer={
        <ModalFooter
          onCancel={onClose}
          onConfirm={onSave}
          confirmLabel={editingName ? 'Save changes' : 'Create role'}
          loading={loading}
          confirmDisabled={!name.trim()}
        />
      }
    >
      <div className="space-y-4">
        <FormField label="Name">
          <Input
            type="text"
            placeholder="e.g. Deployers, QA, Read-only"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            autoFocus
            disabled={loading}
          />
        </FormField>
        <FormField label="Description" hint="Optional — what this role is for.">
          <Input
            type="text"
            placeholder="What this role is for"
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            disabled={loading}
          />
        </FormField>
        <div className="space-y-1">
          <span className="block text-xs font-medium text-fg" id={`${uid}-permissions`}>
            Permissions <span className="text-fg-muted font-normal">({permissions.size} selected)</span>
          </span>
          <div role="group" aria-labelledby={`${uid}-permissions`} className="max-h-72 overflow-y-auto border border-default rounded-lg divide-y divide-default">
            {ORG_ASSIGNABLE_CATEGORIES.map(({ category, permissions: inCategory }) => (
              <div key={category} className="p-2.5">
                <p className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">{category}</p>
                <div className="mt-1.5 space-y-1.5">
                  {inCategory.map((p) => (
                    <label key={p.id} className="flex items-start gap-2 text-xs cursor-pointer">
                      <Checkbox
                        checked={permissions.has(p.id)}
                        onChange={() => onTogglePermission(p.id)}
                        disabled={loading}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-fg">{p.label}</span>
                        <span className="block text-fg-muted">{p.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-2xs text-fg-muted">
            Members of this role get these permissions on top of their base access. The org owner and admins already have everything.
          </p>
        </div>
        {error && <ErrorAlert message={error} />}
      </div>
    </Modal>
  );
}
