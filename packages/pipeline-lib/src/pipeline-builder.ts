export class PipelineBuilder extends Construct {
    private readonly _uniqueId: UniqueId;
    private readonly _codepipeline: CodePipeline;
    private readonly _lookup: Lookup;

    constructor(scope: Construct, id: string, props: PipelineBuilderProps) {
        super(scope, id);

        // Validate required props
        if (!props.project || !props.organization) {
            throw new Error('project and organization are required');
        }

        this._uniqueId = new UniqueId(props.organization, props.project);
        this._lookup = new Lookup(this, this._uniqueId.generate('custom-resource'), props.organization, props.project);

        const input = this.getPipelineSource(props);
        const config = this._lookup.config(props.metadata?.SYNTH_PLUGINNAME ?? Constants.DEFAULT_SYNTH_PLUGINNAME);
        
        const pipeline = new Pipeline(this, this._uniqueId.generate('pipeline'), {
            pipelineName: props.pipelineName ?? `${props.organization}-${props.project}-pipeline`,
            pipelineType: props.metadata?.PIPELINETYPE ?? Constants.DEFAULT_PIPELINETYPE,
            restartExecutionOnUpdate: true,
        });

        this._codepipeline = new CodePipeline(this, this._uniqueId.generate('codepipeline'), {
            codePipeline: pipeline,
            synth: this.shellStep(this._uniqueId.generate('pipeline::synth'), config, input),
        });

        Tags.of(this._codepipeline).add('project', props.project);
        Tags.of(this._codepipeline).add('organization', props.organization);
    }

    private getPipelineSource(props: PipelineBuilderProps): CodePipelineSource {
        switch (props.input.inputType) {
            case 'S3': {
                const s3Options = props.input.s3Options ?? {};
                if (!s3Options.bucketName) throw new Error('S3 bucketName is required');
                return CodePipelineSource.s3(
                    Bucket.fromBucketName(this, this._uniqueId.generate('s3-bucket'), s3Options.bucketName),
                    s3Options.objectKey ?? '/',
                    {
                        role: s3Options.role,
                        trigger: s3Options.trigger,
                        actionName: s3Options.actionName,
                    }
                );
            }
            case 'GitHub': {
                const gitHubOptions = props.input.gitHubOptions ?? {};
                if (!gitHubOptions.repository) throw new Error('GitHub repository is required');
                return CodePipelineSource.gitHub(
                    gitHubOptions.repository,
                    gitHubOptions.branch ?? 'main',
                    {
                        trigger: gitHubOptions.trigger,
                        actionName: gitHubOptions.actionName,
                        authentication: gitHubOptions.authentication,
                    }
                );
            }
            default: {
                const connectionOptions = props.input.connectionOptions ?? {};
                if (!connectionOptions.connectionArn) throw new Error('Connection ARN is required');
                return CodePipelineSource.connection(
                    connectionOptions.repository ?? 'no_repository',
                    connectionOptions.branch ?? 'main',
                    {
                        actionName: connectionOptions.actionName,
                        triggerOnPush: connectionOptions.triggerOnPush,
                        connectionArn: connectionOptions.connectionArn,
                        codeBuildCloneOutput: connectionOptions.codeBuildCloneOutput,
                    }
                );
            }
        }
    }

    private shellStep(id: string, config: PluginConfig, input?: IFileSetProducer): ShellStep {
        if (!config.commands?.length) {
            throw new Error('PluginConfig.commands cannot be empty');
        }
        switch (config.pluginType) {
            case 'ShellStep':
                return new ShellStep(id, {
                    input,
                    commands: config.commands,
                });
            default:
                return new CodeBuildStep(id, {
                    input,
                    commands: config.commands,
                });
        }
    }
}
