// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useState, useId } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { CatalogEntry } from '@/types/observability';

/** Column spans a panel may occupy in the 12-column grid. */
const SPANS = [3, 4, 6, 8, 9, 12];

/** Modal to pick a catalog query + viz + title for a new panel. */
export function AddPanelModal(props: {
  catalog: CatalogEntry[];
  onClose: () => void;
  onAdd: (entry: CatalogEntry, title: string, vizKind: string, span: number) => void;
}) {
  const uid = useId();
  const { catalog, onClose, onAdd } = props;
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const [title, setTitle] = useState('');
  const [vizKind, setVizKind] = useState('line');
  const [span, setSpan] = useState<number>(6);

  const filtered = catalog.filter(c => c.key.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Modal title="Add panel" onClose={onClose} maxWidth="max-w-lg" tall>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor={`${uid}-filter`}>Filter</label>
          <Input id={`${uid}-filter`}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Type to filter catalog keys…"
          />
        </div>
        <div>
          <span className="block text-xs font-medium text-fg-muted mb-1" id={`${uid}-catalog`}>Catalog query ({filtered.length})</span>
          <div role="group" aria-labelledby={`${uid}-catalog`} className="max-h-64 overflow-y-auto border border-default rounded">
            {filtered.map(entry => (
              <button
                key={entry.key}
                onClick={() => { setSelected(entry); if (!title) setTitle(entry.key.replace(/_/g, ' ')); }}
                className={`block w-full text-left px-3 py-1.5 text-xs font-mono border-b border-default last:border-b-0 ${selected?.key === entry.key ? 'bg-info-bg text-info-strong' : 'hover:bg-surface-muted'}`}
              >
                <div>{entry.key}</div>
                <div className="text-2xs text-fg-muted">{entry.source}</div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="p-3 text-xs text-fg-muted">No matches.</div>
            )}
          </div>
        </div>
        {selected && (
          <>
            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor={`${uid}-title`}>Title</label>
              <Input id={`${uid}-title`}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor={`${uid}-viz`}>Viz</label>
                <Select id={`${uid}-viz`}
                  value={vizKind}
                  onChange={(e) => setVizKind(e.target.value)}
                >
                  <option value="stat">stat</option>
                  <option value="line">line</option>
                  <option value="table">table</option>
                  <option value="stacked-bar">stacked-bar</option>
                </Select>
              </div>
              <div>
                <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor={`${uid}-span`}>Span</label>
                <Select id={`${uid}-span`}
                  value={span}
                  onChange={(e) => setSpan(parseInt(e.target.value, 10))}
                >
                  {SPANS.map(s => <option key={s} value={s}>span {s}</option>)}
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => onAdd(selected, title.trim() || selected.key, vizKind, span)}
                disabled={!title.trim()}
              >
                Add panel
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
