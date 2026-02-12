import { useState, useImperativeHandle, forwardRef } from 'react';
import { Upload } from 'lucide-react';
import { BuilderProps } from '@/types';

export interface UploadConfigTabRef {
  getProps: () => Promise<BuilderProps | null>;
}

interface UploadConfigTabProps {
  disabled?: boolean;
}

const UploadConfigTab = forwardRef<UploadConfigTabRef, UploadConfigTabProps>(
  ({ disabled }, ref) => {
    const [propsInput, setPropsInput] = useState('');
    const [propsFile, setPropsFile] = useState<File | null>(null);
    const [propsError, setPropsError] = useState<string | null>(null);

    useImperativeHandle(ref, () => ({
      getProps: async (): Promise<BuilderProps | null> => {
        setPropsError(null);
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
          // 1. Full pipeline JSON: { project, organization, props: { synth, ... } }
          // 2. BuilderProps only: { project, organization, synth, ... }
          if (raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props)) {
            const inner = raw.props as Record<string, unknown>;
            if (inner.synth && typeof inner.synth === 'object') {
              raw = inner;
            }
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

        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Required: project, organization. Full BuilderProps schema supported.
        </p>
      </div>
    );
  }
);

UploadConfigTab.displayName = 'UploadConfigTab';
export default UploadConfigTab;
