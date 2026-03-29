import { FormBuilderState } from '@/types/form-types';
import { FormField } from '@/components/ui/FormField';

/** Props for {@link SourceTypeEditor}. */
interface SourceTypeEditorProps {
  /** Currently selected source type (github, s3, codestar, or codecommit). */
  sourceType: FormBuilderState['synth']['sourceType'];
  /** S3 source configuration values. */
  s3: FormBuilderState['synth']['s3'];
  /** GitHub source configuration values. */
  github: FormBuilderState['synth']['github'];
  /** CodeStar source configuration values. */
  codestar: FormBuilderState['synth']['codestar'];
  /** CodeCommit source configuration values. */
  codecommit: FormBuilderState['synth']['codecommit'];
  /** Callback when the source type selector changes. */
  onSourceTypeChange: (type: FormBuilderState['synth']['sourceType']) => void;
  /** Callback when an S3 source field changes. */
  onS3Change: (field: string, value: string) => void;
  /** Callback when a GitHub source field changes. */
  onGithubChange: (field: string, value: string) => void;
  /** Callback when a CodeStar source field changes. */
  onCodestarChange: (field: string, value: string | boolean) => void;
  /** Callback when a CodeCommit source field changes. */
  onCodecommitChange: (field: string, value: string) => void;
  /** Whether all inputs should be disabled. */
  disabled?: boolean;
  /** Validation errors keyed by field path (e.g. 'synth.github.repo'). */
  errors?: Record<string, string>;
}

/**
 * Editor for configuring the pipeline source type and its provider-specific options.
 *
 * Renders a source type selector (GitHub, S3, CodeStar) and conditionally displays
 * the relevant fields for the selected provider (repo, branch, bucket, connection ARN, etc.).
 */
export default function SourceTypeEditor({
  sourceType, s3, github, codestar, codecommit,
  onSourceTypeChange, onS3Change, onGithubChange, onCodestarChange, onCodecommitChange,
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
          <option value="codecommit">CodeCommit</option>
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
              <option value="AUTO">Auto</option>
              <option value="SCHEDULE">On Schedule</option>
            </select>
          </FormField>
          {s3.trigger === 'SCHEDULE' && (
            <div>
              <label className="label">Schedule Expression</label>
              <input
                type="text"
                className="input"
                placeholder="rate(1 day) or cron(0 0 * * ? *)"
                value={s3.schedule || ''}
                onChange={(e) => onS3Change('schedule', e.target.value)}
                disabled={disabled}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Use rate() or cron() syntax. Example: rate(1 day), cron(0 8 * * ? *)
              </p>
            </div>
          )}
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
              <option value="AUTO">Auto</option>
              <option value="SCHEDULE">On Schedule</option>
            </select>
          </FormField>
          {github.trigger === 'SCHEDULE' && (
            <div>
              <label className="label">Schedule Expression</label>
              <input
                type="text"
                className="input"
                placeholder="rate(1 day) or cron(0 0 * * ? *)"
                value={github.schedule || ''}
                onChange={(e) => onGithubChange('schedule', e.target.value)}
                disabled={disabled}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Use rate() or cron() syntax. Example: rate(1 day), cron(0 8 * * ? *)
              </p>
            </div>
          )}
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
              <option value="AUTO">Auto</option>
              <option value="SCHEDULE">On Schedule</option>
            </select>
          </FormField>
          {codestar.trigger === 'SCHEDULE' && (
            <div>
              <label className="label">Schedule Expression</label>
              <input
                type="text"
                className="input"
                placeholder="rate(1 day) or cron(0 0 * * ? *)"
                value={codestar.schedule || ''}
                onChange={(e) => onCodestarChange('schedule', e.target.value)}
                disabled={disabled}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Use rate() or cron() syntax. Example: rate(1 day), cron(0 8 * * ? *)
              </p>
            </div>
          )}
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

      {sourceType === 'codecommit' && (
        <div className="space-y-3 pl-4 border-l-2 border-gray-200 dark:border-gray-700">
          <FormField label="Repository Name *" error={errors['synth.codecommit.repositoryName']}>
            <input
              type="text"
              value={codecommit.repositoryName}
              onChange={(e) => onCodecommitChange('repositoryName', e.target.value)}
              placeholder="my-repo"
              disabled={disabled}
              className="input"
            />
          </FormField>
          <FormField label="Branch">
            <input
              type="text"
              value={codecommit.branch}
              onChange={(e) => onCodecommitChange('branch', e.target.value)}
              placeholder="main"
              disabled={disabled}
              className="input"
            />
          </FormField>
          <FormField label="Trigger">
            <select
              value={codecommit.trigger}
              onChange={(e) => onCodecommitChange('trigger', e.target.value)}
              disabled={disabled}
              className="input"
            >
              <option value="NONE">None (Manual)</option>
              <option value="AUTO">Auto</option>
              <option value="SCHEDULE">On Schedule</option>
            </select>
          </FormField>
          {codecommit.trigger === 'SCHEDULE' && (
            <div>
              <label className="label">Schedule Expression</label>
              <input
                type="text"
                className="input"
                placeholder="rate(1 day) or cron(0 0 * * ? *)"
                value={codecommit.schedule || ''}
                onChange={(e) => onCodecommitChange('schedule', e.target.value)}
                disabled={disabled}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Use rate() or cron() syntax. Example: rate(1 day), cron(0 8 * * ? *)
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
