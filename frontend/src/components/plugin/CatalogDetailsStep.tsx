// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/ui/ErrorAlert';
import { LoadingSpinner } from '@/components/ui/Loading';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { isAbortError } from '@/lib/abort';
import { formatError } from '@/lib/constants';
import type { PluginCatalogEdits, PluginInspectResult } from '@/types';
import { CatalogFieldEditor } from './CatalogFieldEditor';

interface CatalogDetailsStepProps {
  /** The chosen package; inspected once per file (re-key the step on a new file). */
  file: File;
  /** The fields the user edited — ONLY those; `null` clears a field. */
  edits: PluginCatalogEdits;
  onEditsChange: (edits: PluginCatalogEdits) => void;
  disabled?: boolean;
}

/**
 * The upload dialog's "Catalog details" step: the
 * package is inspected (`POST /plugins/inspect`, a dry run) and every
 * descriptive field is listed with the value detected from it and where it came
 * from. Each field is accepted or edited (the shared {@link CatalogFieldEditor});
 * only EDITED fields are sent with the upload (`onEditsChange`) — everything
 * else is accepted as detected, so an inspect failure never blocks the upload.
 */
export function CatalogDetailsStep({ file, edits, onEditsChange, disabled = false }: CatalogDetailsStepProps) {
  // `clearDataOnError`: the fields belong to the package that was inspected, so
  // a failed re-inspect of a DIFFERENT file must not leave the old one's fields
  // on screen under the error.
  const inspect = useFetch<PluginInspectResult>(
    (signal) => api.inspectPlugin(file, { signal }),
    [file],
    { clearDataOnError: true },
  );
  const result = inspect.data;
  const inspecting = inspect.loading;
  const inspectError = inspect.error ? formatError(inspect.error, 'Could not read the plugin package') : null;

  const editCount = Object.keys(edits).length;

  return (
    <CatalogFieldEditor
      fields={result?.fields ?? null}
      edits={edits}
      onEditsChange={onEditsChange}
      disabled={disabled}
      heading="Catalog details"
      headingId="catalog-details-heading"
      description="Detected from the package. Accept each value or edit it; only edited fields are sent with the upload."
      testId="catalog-details-step"
    >
      {inspecting && (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <LoadingSpinner size="sm" /> Reading package…
        </div>
      )}

      {inspectError && (
        <ErrorAlert
          message={`${inspectError} You can still upload — every detected value will be accepted as is.`}
        />
      )}

      {result && (
        <p className="text-xs text-fg-muted">
          <span className="font-medium text-fg">{result.plugin.name}</span> v{result.plugin.version}
          {editCount > 0 && <> · {editCount} edited</>}
        </p>
      )}
    </CatalogFieldEditor>
  );
}
