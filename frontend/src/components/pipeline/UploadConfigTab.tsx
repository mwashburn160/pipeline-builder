import { useState, useImperativeHandle, forwardRef } from 'react';
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
          if (propsFile) {
            const fileContent = await propsFile.text();
            propsData = JSON.parse(fileContent);
          } else if (propsInput.trim()) {
            propsData = JSON.parse(propsInput);
          } else {
            setPropsError('Please upload a props file or enter props JSON');
            return null;
          }

          if (!propsData.project || typeof propsData.project !== 'string') {
            setPropsError('Props must include "project" (string)');
            return null;
          }
          if (!propsData.organization || typeof propsData.organization !== 'string') {
            setPropsError('Props must include "organization" (string)');
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
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Pipeline Props (JSON)
        </label>

        {/* File Upload */}
        <div className="mb-3">
          <label
            htmlFor="propsFile"
            className="flex items-center justify-center w-full px-4 py-3 border-2 border-dashed border-gray-300 rounded-md cursor-pointer hover:border-blue-400 transition-colors"
          >
            <div className="text-center">
              <svg className="mx-auto h-8 w-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className="mt-1 text-sm text-gray-600">
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
            <div className="w-full border-t border-gray-300" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-white text-gray-500">or paste JSON</span>
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
          className="mt-3 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono text-xs"
          disabled={disabled}
        />

        {propsError && (
          <p className="mt-2 text-sm text-red-600">{propsError}</p>
        )}

        <p className="mt-2 text-xs text-gray-500">
          Required: project, organization. Full BuilderProps schema supported.
        </p>
      </div>
    );
  }
);

UploadConfigTab.displayName = 'UploadConfigTab';
export default UploadConfigTab;
