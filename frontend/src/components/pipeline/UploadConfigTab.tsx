import { useState, useImperativeHandle, useRef, forwardRef } from 'react';
import { Upload } from 'lucide-react';
import { BuilderProps } from '@/types';

/**
 * Wrapper-only fields on the pipeline upload JSON that must be stripped
 * before passing the inner shape to the backend as `BuilderProps`. Anything
 * here that lands inside `props` would otherwise leak through.
 */
const WRAPPER_ONLY_FIELDS = ['version', 'tags', 'description', 'keywords', 'props'] as const;

interface BulkValidationItem {
  index: number;
  field?: string;
  message: string;
}

/** Methods exposed to the parent modal via ref. */
export interface UploadConfigTabRef {
  /** Parses the uploaded/pasted JSON and returns BuilderProps, or null on validation failure. */
  getProps: () => Promise<BuilderProps | null>;
  /** Returns the description extracted from the uploaded JSON wrapper, if present. */
  getDescription: () => string;
  /** Returns keywords extracted from the uploaded JSON wrapper as a comma-separated string. */
  getKeywords: () => string;
}

/** Props for {@link UploadConfigTab}. */
interface UploadConfigTabProps {
  /** Whether the tab inputs should be disabled. */
  disabled?: boolean;
}

/**
 * Tab for uploading or pasting a pipeline configuration as JSON.
 *
 * Accepts either a JSON file upload or raw JSON pasted into a textarea.
 * Supports both the full pipeline wrapper format (with props/description/keywords)
 * and standalone BuilderProps format.
 */
const UploadConfigTab = forwardRef<UploadConfigTabRef, UploadConfigTabProps>(
  ({ disabled }, ref) => {
    const [propsInput, setPropsInput] = useState('');
    const [propsFile, setPropsFile] = useState<File | null>(null);
    const [propsError, setPropsError] = useState<string | null>(null);
    const [itemErrors, setItemErrors] = useState<BulkValidationItem[]>([]);
    const descriptionRef = useRef('');
    const keywordsRef = useRef('');

    useImperativeHandle(ref, () => ({
      getProps: async (): Promise<BuilderProps | null> => {
        setPropsError(null);
        setItemErrors([]);
        let propsData: BuilderProps;

        try {
          let raw: Record<string, unknown>;
          if (propsFile) {
            const fileContent = await propsFile.text();
            raw = JSON.parse(fileContent);
          } else if (propsInput.trim()) {
            raw = JSON.parse(propsInput);
          } else {
            setPropsError('Please upload a props file or enter props JSON');
            return null;
          }

          // Support both formats:
          // 1. Full pipeline JSON: { project, organization, props: { synth, ... }, description, keywords }
          // 2. BuilderProps only: { project, organization, synth, ... }
          if (raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props)) {
            const inner = raw.props as Record<string, unknown>;
            if (inner.synth && typeof inner.synth === 'object') {
              // Extract description/keywords from the wrapper before unwrapping
              if (typeof raw.description === 'string' && raw.description) {
                descriptionRef.current = raw.description;
              }
              if (Array.isArray(raw.keywords) && raw.keywords.length > 0) {
                keywordsRef.current = raw.keywords.map(String).join(', ');
              }
              raw = inner;
            }
          }

          // Strip wrapper-only fields that may have leaked into the inner shape
          // (or were on a flat BuilderProps payload). The backend rejects
          // unknown fields, so drop them rather than fail validation.
          for (const f of WRAPPER_ONLY_FIELDS) {
            if (f in raw) delete raw[f];
          }

          propsData = raw as unknown as BuilderProps;

          if (!propsData.project || typeof propsData.project !== 'string') {
            setPropsError('Props must include "project" (string)');
            return null;
          }
          if (!propsData.organization || typeof propsData.organization !== 'string') {
            setPropsError('Props must include "organization" (string)');
            return null;
          }
          if (!propsData.synth || typeof propsData.synth !== 'object') {
            setPropsError('Props must include "synth" object with a "plugin" field');
            return null;
          }

          return propsData;
        } catch {
          setPropsError('Invalid JSON format. Please check your props.');
          return null;
        }
      },
      getDescription: () => descriptionRef.current,
      getKeywords: () => keywordsRef.current,
    }));

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        if (!file.name.endsWith('.json')) {
          setPropsError('Please upload a JSON file');
          return;
        }
        setPropsFile(file);
        setPropsInput('');
        setPropsError(null);
      }
    };

    return (
      <div>
        <label className="label">
          Pipeline Props (JSON)
        </label>

        {/* File Upload */}
        <div className="mb-3">
          <label
            htmlFor="propsFile"
            className="flex items-center justify-center w-full px-4 py-3 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 transition-colors bg-gray-50/50 dark:bg-gray-800/50"
          >
            <div className="text-center">
              <Upload className="mx-auto h-8 w-8 text-gray-400 dark:text-gray-500" />
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {propsFile ? propsFile.name : 'Click to upload props.json'}
              </p>
            </div>
            <input
              id="propsFile"
              type="file"
              accept=".json"
              onChange={handleFileUpload}
              className="hidden"
              disabled={disabled}
            />
          </label>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-300 dark:border-gray-600" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-white dark:bg-gray-900 text-gray-500 dark:text-gray-400">or paste JSON</span>
          </div>
        </div>

        <textarea
          value={propsInput}
          onChange={(e) => {
            setPropsInput(e.target.value);
            setPropsFile(null);
            setPropsError(null);
          }}
          placeholder={`{
  "project": "my-project",
  "organization": "my-org",
  "synth": {
    "source": { "type": "github", "options": { "repo": "owner/repo" } },
    "plugin": { "name": "my-plugin" }
  }
}`}
          rows={10}
          className="input mt-3 font-mono text-xs"
          disabled={disabled}
        />

        {propsError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{propsError}</p>
        )}

        {itemErrors.length > 0 && (
          <div className="mt-2 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3">
            <p className="text-xs font-medium text-red-800 dark:text-red-300 mb-1">
              {itemErrors.length} item{itemErrors.length === 1 ? '' : 's'} failed validation:
            </p>
            <ul className="text-xs text-red-700 dark:text-red-300 space-y-0.5">
              {itemErrors.map((it, i) => (
                <li key={`${it.index}-${i}`}>
                  <span className="font-mono">#{it.index}</span>
                  {it.field && <span className="font-mono"> · {it.field}</span>}
                  {': '}{it.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Required: project, organization. Full BuilderProps schema supported.
        </p>
      </div>
    );
  }
);

UploadConfigTab.displayName = 'UploadConfigTab';
export default UploadConfigTab;
