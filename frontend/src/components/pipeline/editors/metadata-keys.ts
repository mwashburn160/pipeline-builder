/**
 * Predefined metadata keys for the pipeline form builder.
 * Mirrors MetadataKeys from pipeline-core/pipeline-types.ts.
 */

export interface MetadataKeyOption {
  key: string;
  label: string;
  type: 'boolean' | 'string';
}

export interface MetadataKeyGroup {
  category: string;
  keys: MetadataKeyOption[];
}

export const METADATA_KEY_GROUPS: MetadataKeyGroup[] = [
  {
    category: 'CodePipeline',
    keys: [
      { key: 'aws:cdk:pipelines:codepipeline:selfmutation', label: 'Self Mutation', type: 'boolean' },
      { key: 'aws:cdk:pipelines:codepipeline:crossaccountkeys', label: 'Cross Account Keys', type: 'boolean' },
      { key: 'aws:cdk:pipelines:codepipeline:dockerenabledforselfmutation', label: 'Docker Enabled for Self Mutation', type: 'boolean' },
      { key: 'aws:cdk:pipelines:codepipeline:dockerenabledforsynth', label: 'Docker Enabled for Synth', type: 'boolean' },
      { key: 'aws:cdk:pipelines:codepipeline:enablekeyrotation', label: 'Enable Key Rotation', type: 'boolean' },
      { key: 'aws:cdk:pipelines:codepipeline:publishassetsinparallel', label: 'Publish Assets in Parallel', type: 'boolean' },
      { key: 'aws:cdk:pipelines:codepipeline:reusecrossregionsupportstacks', label: 'Reuse Cross Region Support Stacks', type: 'boolean' },
      { key: 'aws:cdk:pipelines:codepipeline:usechangesets', label: 'Use Change Sets', type: 'boolean' },
      { key: 'aws:cdk:pipelines:codepipeline:usepipelineroleforactions', label: 'Use Pipeline Role for Actions', type: 'boolean' },
      { key: 'aws:cdk:pipelines:codepipeline:artifactbucket', label: 'Artifact Bucket', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:assetpublishingcodebuilddefaults', label: 'Asset Publishing CodeBuild Defaults', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:cdkassetscliversion', label: 'CDK Assets CLI Version', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:cliversion', label: 'CLI Version', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:codebuilddefaults', label: 'CodeBuild Defaults', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:codepipeline', label: 'CodePipeline', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:crossregionreplicationbuckets', label: 'Cross Region Replication Buckets', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:dockercredentials', label: 'Docker Credentials', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:pipelinename', label: 'Pipeline Name', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:pipelinetype', label: 'Pipeline Type', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:role', label: 'Pipeline Role', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:selfmutationcodebuilddefaults', label: 'Self Mutation CodeBuild Defaults', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:synth', label: 'Synth', type: 'string' },
      { key: 'aws:cdk:pipelines:codepipeline:synthcodebuilddefaults', label: 'Synth CodeBuild Defaults', type: 'string' },
    ],
  },
  {
    category: 'CodeBuildStep',
    keys: [
      { key: 'aws:cdk:pipelines:codebuildstep:actionrole', label: 'Action Role', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:additionalinputs', label: 'Additional Inputs', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:buildenvironment', label: 'Build Environment', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:cache', label: 'Cache', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:commands', label: 'Commands', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:env', label: 'Environment', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:envfromcfnoutputs', label: 'Env from CFN Outputs', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:filesystemlocations', label: 'File System Locations', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:input', label: 'Input', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:installcommands', label: 'Install Commands', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:logging', label: 'Logging', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:partialbuildspec', label: 'Partial Build Spec', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:primaryoutputdirectory', label: 'Primary Output Directory', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:projectname', label: 'Project Name', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:role', label: 'Step Role', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:rolepolicystatements', label: 'Role Policy Statements', type: 'string' },
      { key: 'aws:cdk:pipelines:codebuildstep:timeout', label: 'Timeout', type: 'string' },
    ],
  },
  {
    category: 'ShellStep',
    keys: [
      { key: 'aws:cdk:pipelines:shellstep:additionalinputs', label: 'Additional Inputs', type: 'string' },
      { key: 'aws:cdk:pipelines:shellstep:commands', label: 'Commands', type: 'string' },
      { key: 'aws:cdk:pipelines:shellstep:env', label: 'Environment', type: 'string' },
      { key: 'aws:cdk:pipelines:shellstep:envfromcfnoutputs', label: 'Env from CFN Outputs', type: 'string' },
      { key: 'aws:cdk:pipelines:shellstep:input', label: 'Input', type: 'string' },
      { key: 'aws:cdk:pipelines:shellstep:installcommands', label: 'Install Commands', type: 'string' },
      { key: 'aws:cdk:pipelines:shellstep:primaryoutputdirectory', label: 'Primary Output Directory', type: 'string' },
    ],
  },
  {
    category: 'Build Environment',
    keys: [
      { key: 'aws:cdk:codebuild:buildenvironment:privileged', label: 'Privileged', type: 'boolean' },
      { key: 'aws:cdk:codebuild:buildenvironment:buildimage', label: 'Build Image', type: 'string' },
      { key: 'aws:cdk:codebuild:buildenvironment:certificate', label: 'Certificate', type: 'string' },
      { key: 'aws:cdk:codebuild:buildenvironment:computetype', label: 'Compute Type', type: 'string' },
      { key: 'aws:cdk:codebuild:buildenvironment:dockerserver', label: 'Docker Server', type: 'string' },
      { key: 'aws:cdk:codebuild:buildenvironment:environmentvariables', label: 'Environment Variables', type: 'string' },
      { key: 'aws:cdk:codebuild:buildenvironment:fleet', label: 'Fleet', type: 'string' },
    ],
  },
  {
    category: 'Custom Build',
    keys: [
      { key: 'aws:cdk:build:parallel', label: 'Parallel', type: 'boolean' },
      { key: 'aws:cdk:build:cache', label: 'Cache', type: 'boolean' },
      { key: 'aws:cdk:build:timeout', label: 'Timeout', type: 'string' },
    ],
  },
];

/** Flat lookup: key string → MetadataKeyOption */
export const METADATA_KEY_MAP = new Map<string, MetadataKeyOption>(
  METADATA_KEY_GROUPS.flatMap((g) => g.keys.map((k) => [k.key, k] as const)),
);
