interface CoreSectionProps {
  project: string;
  organization: string;
  pipelineName: string;
  onProjectChange: (val: string) => void;
  onOrganizationChange: (val: string) => void;
  onPipelineNameChange: (val: string) => void;
  disabled?: boolean;
  errors?: Record<string, string>;
}

export default function CoreSection({
  project, organization, pipelineName,
  onProjectChange, onOrganizationChange, onPipelineNameChange,
  disabled, errors = {},
}: CoreSectionProps) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 uppercase tracking-wide">Core Information</h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Project *</label>
          <input
            type="text"
            value={project}
            onChange={(e) => onProjectChange(e.target.value)}
            placeholder="my-project"
            disabled={disabled}
            className="input"
          />
          {errors['project'] && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors['project']}</p>}
        </div>
        <div>
          <label className="label">Organization *</label>
          <input
            type="text"
            value={organization}
            onChange={(e) => onOrganizationChange(e.target.value)}
            placeholder="my-org"
            disabled={disabled}
            className="input"
          />
          {errors['organization'] && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{errors['organization']}</p>}
        </div>
      </div>
      <div>
        <label className="label">Pipeline Name</label>
        <input
          type="text"
          value={pipelineName}
          onChange={(e) => onPipelineNameChange(e.target.value)}
          placeholder={project && organization ? `${organization}-${project}-pipeline` : 'Auto-generated from org + project'}
          disabled={disabled}
          className="input"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Optional. Auto-generated if not provided.</p>
      </div>
    </div>
  );
}
