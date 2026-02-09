import { FormBuilderState } from '@/types/form-types';

interface SourceTypeEditorProps {
  sourceType: FormBuilderState['synth']['sourceType'];
  s3: FormBuilderState['synth']['s3'];
  github: FormBuilderState['synth']['github'];
  codestar: FormBuilderState['synth']['codestar'];
  onSourceTypeChange: (type: FormBuilderState['synth']['sourceType']) => void;
  onS3Change: (field: string, value: string) => void;
  onGithubChange: (field: string, value: string) => void;
  onCodestarChange: (field: string, value: string | boolean) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
}

export default function SourceTypeEditor({
  sourceType, s3, github, codestar,
  onSourceTypeChange, onS3Change, onGithubChange, onCodestarChange,
  disabled, errors = {},
}: SourceTypeEditorProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className="label">Source Type</label>
        <select
          value={sourceType}
          onChange={(e) => onSourceTypeChange(e.target.value as FormBuilderState['synth']['sourceType'])}
          disabled={disabled}
          className="input"
        >
          <option value="github">GitHub</option>
          <option value="s3">S3</option>
          <option value="codestar">CodeStar</option>
        </select>
      </div>

      {sourceType === 's3' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
          <div>
            <label className="label">Bucket Name *</label>
            <input
              type="text"
              value={s3.bucketName}
              onChange={(e) => onS3Change('bucketName', e.target.value)}
              placeholder="my-source-bucket"
              disabled={disabled}
              className="input"
            />
            {errors['synth.s3.bucketName'] && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors['synth.s3.bucketName']}</p>}
          </div>
          <div>
            <label className="label">Object Key</label>
            <input
              type="text"
              value={s3.objectKey}
              onChange={(e) => onS3Change('objectKey', e.target.value)}
              placeholder="source.zip"
              disabled={disabled}
              className="input"
            />
          </div>
          <div>
            <label className="label">Trigger</label>
            <select
              value={s3.trigger}
              onChange={(e) => onS3Change('trigger', e.target.value)}
              disabled={disabled}
              className="input"
            >
              <option value="NONE">None (Manual)</option>
              <option value="POLL">Poll (Auto)</option>
            </select>
          </div>
        </div>
      )}

      {sourceType === 'github' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
          <div>
            <label className="label">Repository *</label>
            <input
              type="text"
              value={github.repo}
              onChange={(e) => onGithubChange('repo', e.target.value)}
              placeholder="owner/repo"
              disabled={disabled}
              className="input"
            />
            {errors['synth.github.repo'] && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors['synth.github.repo']}</p>}
          </div>
          <div>
            <label className="label">Branch</label>
            <input
              type="text"
              value={github.branch}
              onChange={(e) => onGithubChange('branch', e.target.value)}
              placeholder="main"
              disabled={disabled}
              className="input"
            />
          </div>
          <div>
            <label className="label">Token (PAT)</label>
            <input
              type="password"
              value={github.token}
              onChange={(e) => onGithubChange('token', e.target.value)}
              placeholder="ghp_..."
              disabled={disabled}
              className="input"
            />
          </div>
          <div>
            <label className="label">Trigger</label>
            <select
              value={github.trigger}
              onChange={(e) => onGithubChange('trigger', e.target.value)}
              disabled={disabled}
              className="input"
            >
              <option value="NONE">None (Manual)</option>
              <option value="POLL">Poll (Auto)</option>
            </select>
          </div>
        </div>
      )}

      {sourceType === 'codestar' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
          <div>
            <label className="label">Repository *</label>
            <input
              type="text"
              value={codestar.repo}
              onChange={(e) => onCodestarChange('repo', e.target.value)}
              placeholder="owner/repo"
              disabled={disabled}
              className="input"
            />
            {errors['synth.codestar.repo'] && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors['synth.codestar.repo']}</p>}
          </div>
          <div>
            <label className="label">Branch</label>
            <input
              type="text"
              value={codestar.branch}
              onChange={(e) => onCodestarChange('branch', e.target.value)}
              placeholder="main"
              disabled={disabled}
              className="input"
            />
          </div>
          <div>
            <label className="label">Connection ARN *</label>
            <input
              type="text"
              value={codestar.connectionArn}
              onChange={(e) => onCodestarChange('connectionArn', e.target.value)}
              placeholder="arn:aws:codestar-connections:..."
              disabled={disabled}
              className="input"
            />
            {errors['synth.codestar.connectionArn'] && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors['synth.codestar.connectionArn']}</p>}
          </div>
          <div>
            <label className="label">Trigger</label>
            <select
              value={codestar.trigger}
              onChange={(e) => onCodestarChange('trigger', e.target.value)}
              disabled={disabled}
              className="input"
            >
              <option value="NONE">None (Manual)</option>
              <option value="POLL">Poll (Auto)</option>
            </select>
          </div>
          <div className="flex items-center">
            <input
              id="codeBuildCloneOutput"
              type="checkbox"
              checked={codestar.codeBuildCloneOutput}
              onChange={(e) => onCodestarChange('codeBuildCloneOutput', e.target.checked)}
              disabled={disabled}
              className="h-4 w-4 text-blue-600 border-gray-300 dark:border-gray-600 rounded focus:ring-blue-500"
            />
            <label htmlFor="codeBuildCloneOutput" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
              CodeBuild Clone Output
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
