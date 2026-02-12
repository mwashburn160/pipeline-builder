import { FormBuilderState } from '@/types/form-types';
import { FormField } from '@/components/ui/FormField';

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
      <FormField label="Source Type">
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
      </FormField>

      {sourceType === 's3' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
          <FormField label="Bucket Name *" error={errors['synth.s3.bucketName']}>
            <input
              type="text"
              value={s3.bucketName}
              onChange={(e) => onS3Change('bucketName', e.target.value)}
              placeholder="my-source-bucket"
              disabled={disabled}
              className="input"
            />
          </FormField>
          <FormField label="Object Key">
            <input
              type="text"
              value={s3.objectKey}
              onChange={(e) => onS3Change('objectKey', e.target.value)}
              placeholder="source.zip"
              disabled={disabled}
              className="input"
            />
          </FormField>
          <FormField label="Trigger">
            <select
              value={s3.trigger}
              onChange={(e) => onS3Change('trigger', e.target.value)}
              disabled={disabled}
              className="input"
            >
              <option value="NONE">None (Manual)</option>
              <option value="POLL">Poll (Auto)</option>
            </select>
          </FormField>
        </div>
      )}

      {sourceType === 'github' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
          <FormField label="Repository *" error={errors['synth.github.repo']}>
            <input
              type="text"
              value={github.repo}
              onChange={(e) => onGithubChange('repo', e.target.value)}
              placeholder="owner/repo"
              disabled={disabled}
              className="input"
            />
          </FormField>
          <FormField label="Branch">
            <input
              type="text"
              value={github.branch}
              onChange={(e) => onGithubChange('branch', e.target.value)}
              placeholder="main"
              disabled={disabled}
              className="input"
            />
          </FormField>
          <FormField label="Token (PAT)">
            <input
              type="text"
              autoComplete="off"
              value={github.token}
              onChange={(e) => onGithubChange('token', e.target.value)}
              placeholder="ghp_..."
              disabled={disabled}
              className="input"
              style={{ WebkitTextSecurity: 'disc' } as React.CSSProperties}
            />
          </FormField>
          <FormField label="Trigger">
            <select
              value={github.trigger}
              onChange={(e) => onGithubChange('trigger', e.target.value)}
              disabled={disabled}
              className="input"
            >
              <option value="NONE">None (Manual)</option>
              <option value="POLL">Poll (Auto)</option>
            </select>
          </FormField>
        </div>
      )}

      {sourceType === 'codestar' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
          <FormField label="Repository *" error={errors['synth.codestar.repo']}>
            <input
              type="text"
              value={codestar.repo}
              onChange={(e) => onCodestarChange('repo', e.target.value)}
              placeholder="owner/repo"
              disabled={disabled}
              className="input"
            />
          </FormField>
          <FormField label="Branch">
            <input
              type="text"
              value={codestar.branch}
              onChange={(e) => onCodestarChange('branch', e.target.value)}
              placeholder="main"
              disabled={disabled}
              className="input"
            />
          </FormField>
          <FormField label="Connection ARN *" error={errors['synth.codestar.connectionArn']}>
            <input
              type="text"
              value={codestar.connectionArn}
              onChange={(e) => onCodestarChange('connectionArn', e.target.value)}
              placeholder="arn:aws:codestar-connections:..."
              disabled={disabled}
              className="input"
            />
          </FormField>
          <FormField label="Trigger">
            <select
              value={codestar.trigger}
              onChange={(e) => onCodestarChange('trigger', e.target.value)}
              disabled={disabled}
              className="input"
            >
              <option value="NONE">None (Manual)</option>
              <option value="POLL">Poll (Auto)</option>
            </select>
          </FormField>
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
