// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/** The pipeline detail page's header actions: run, edit, save as template, delete. */

import { LayoutTemplate, Pencil, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/Loading';
import { TAP_TARGET } from '@/components/ui/responsive';

const ACTION_CLASS = `inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed max-sm:flex-[1_1_40%] ${TAP_TARGET}`;

interface PipelineDetailHeaderActionsProps {
  canEdit: boolean;
  canWriteTemplate: boolean;
  triggering: boolean;
  hasRuns: boolean;
  onTrigger: () => void;
  onEdit: () => void;
  onSaveTemplate: () => void;
  onDelete: () => void;
}

export function PipelineDetailHeaderActions({
  canEdit, canWriteTemplate, triggering, hasRuns, onTrigger, onEdit, onSaveTemplate, onDelete,
}: PipelineDetailHeaderActionsProps) {
  return (
    // On a phone the four actions share the width two by two, as 44px targets.
    <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
      <Button
        onClick={onTrigger}
        disabled={triggering}
        className={ACTION_CLASS}
        disabledReason={canEdit ? undefined : 'Read-only (public catalog entry)'}
      >
        {triggering ? <LoadingSpinner size="sm" /> : <Play className="w-4 h-4" />}
        {hasRuns ? 'Re-run' : 'Run pipeline'}
      </Button>
      <Button
        variant="secondary"
        onClick={onEdit}
        className={ACTION_CLASS}
        disabledReason={canEdit ? undefined : 'Read-only (public catalog entry)'}
      >
        <Pencil className="w-4 h-4" /> Edit
      </Button>
      <Button
        variant="secondary"
        onClick={onSaveTemplate}
        disabled={!canWriteTemplate}
        className={ACTION_CLASS}
        title={canWriteTemplate ? 'Save this pipeline as a reusable golden-path template' : 'Requires templates:write'}
      >
        <LayoutTemplate className="w-4 h-4" /> Save as template
      </Button>
      <Button
        variant="danger"
        onClick={onDelete}
        className={ACTION_CLASS}
        disabledReason={canEdit ? undefined : 'Read-only (public catalog entry)'}
      >
        <Trash2 className="w-4 h-4" /> Delete
      </Button>
    </div>
  );
}
