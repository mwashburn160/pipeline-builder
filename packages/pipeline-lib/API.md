# API Reference <a name="API Reference" id="api-reference"></a>

## Constructs <a name="Constructs" id="Constructs"></a>

### Lookup <a name="Lookup" id="@pipeline-builder/pipeline-lib.Lookup"></a>

#### Initializers <a name="Initializers" id="@pipeline-builder/pipeline-lib.Lookup.Initializer"></a>

```typescript
import { Lookup } from '@pipeline-builder/pipeline-lib'

new Lookup(scope: Construct, id: string, organization: string, project: string)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.Lookup.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.Lookup.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.Lookup.Initializer.parameter.organization">organization</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.Lookup.Initializer.parameter.project">project</a></code> | <code>string</code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="@pipeline-builder/pipeline-lib.Lookup.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="@pipeline-builder/pipeline-lib.Lookup.Initializer.parameter.id"></a>

- *Type:* string

---

##### `organization`<sup>Required</sup> <a name="organization" id="@pipeline-builder/pipeline-lib.Lookup.Initializer.parameter.organization"></a>

- *Type:* string

---

##### `project`<sup>Required</sup> <a name="project" id="@pipeline-builder/pipeline-lib.Lookup.Initializer.parameter.project"></a>

- *Type:* string

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.Lookup.toString">toString</a></code> | Returns a string representation of this construct. |
| <code><a href="#@pipeline-builder/pipeline-lib.Lookup.config">config</a></code> | *No description.* |

---

##### `toString` <a name="toString" id="@pipeline-builder/pipeline-lib.Lookup.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

##### `config` <a name="config" id="@pipeline-builder/pipeline-lib.Lookup.config"></a>

```typescript
public config(pluginName: string): PluginConfig
```

###### `pluginName`<sup>Required</sup> <a name="pluginName" id="@pipeline-builder/pipeline-lib.Lookup.config.parameter.pluginName"></a>

- *Type:* string

---

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.Lookup.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### `isConstruct` <a name="isConstruct" id="@pipeline-builder/pipeline-lib.Lookup.isConstruct"></a>

```typescript
import { Lookup } from '@pipeline-builder/pipeline-lib'

Lookup.isConstruct(x: any)
```

Checks if `x` is a construct.

Use this method instead of `instanceof` to properly detect `Construct`
instances, even when the construct library is symlinked.

Explanation: in JavaScript, multiple copies of the `constructs` library on
disk are seen as independent, completely different libraries. As a
consequence, the class `Construct` in each copy of the `constructs` library
is seen as a different class, and an instance of one class will not test as
`instanceof` the other class. `npm install` will not create installations
like this, but users may manually symlink construct libraries together or
use a monorepo tool: in those cases, multiple copies of the `constructs`
library can be accidentally installed, and `instanceof` will behave
unpredictably. It is safest to avoid using `instanceof`, and using
this type-testing method instead.

###### `x`<sup>Required</sup> <a name="x" id="@pipeline-builder/pipeline-lib.Lookup.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.Lookup.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |

---

##### `node`<sup>Required</sup> <a name="node" id="@pipeline-builder/pipeline-lib.Lookup.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---


### PipelineBuilder <a name="PipelineBuilder" id="@pipeline-builder/pipeline-lib.PipelineBuilder"></a>

#### Initializers <a name="Initializers" id="@pipeline-builder/pipeline-lib.PipelineBuilder.Initializer"></a>

```typescript
import { PipelineBuilder } from '@pipeline-builder/pipeline-lib'

new PipelineBuilder(scope: Construct, id: string, props: PipelineBuilderProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilder.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilder.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilder.Initializer.parameter.props">props</a></code> | <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilderProps">PipelineBuilderProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="@pipeline-builder/pipeline-lib.PipelineBuilder.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="@pipeline-builder/pipeline-lib.PipelineBuilder.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="@pipeline-builder/pipeline-lib.PipelineBuilder.Initializer.parameter.props"></a>

- *Type:* <a href="#@pipeline-builder/pipeline-lib.PipelineBuilderProps">PipelineBuilderProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilder.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="@pipeline-builder/pipeline-lib.PipelineBuilder.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilder.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### `isConstruct` <a name="isConstruct" id="@pipeline-builder/pipeline-lib.PipelineBuilder.isConstruct"></a>

```typescript
import { PipelineBuilder } from '@pipeline-builder/pipeline-lib'

PipelineBuilder.isConstruct(x: any)
```

Checks if `x` is a construct.

Use this method instead of `instanceof` to properly detect `Construct`
instances, even when the construct library is symlinked.

Explanation: in JavaScript, multiple copies of the `constructs` library on
disk are seen as independent, completely different libraries. As a
consequence, the class `Construct` in each copy of the `constructs` library
is seen as a different class, and an instance of one class will not test as
`instanceof` the other class. `npm install` will not create installations
like this, but users may manually symlink construct libraries together or
use a monorepo tool: in those cases, multiple copies of the `constructs`
library can be accidentally installed, and `instanceof` will behave
unpredictably. It is safest to avoid using `instanceof`, and using
this type-testing method instead.

###### `x`<sup>Required</sup> <a name="x" id="@pipeline-builder/pipeline-lib.PipelineBuilder.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilder.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |

---

##### `node`<sup>Required</sup> <a name="node" id="@pipeline-builder/pipeline-lib.PipelineBuilder.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---


## Structs <a name="Structs" id="Structs"></a>

### ConnectionOptions <a name="ConnectionOptions" id="@pipeline-builder/pipeline-lib.ConnectionOptions"></a>

#### Initializer <a name="Initializer" id="@pipeline-builder/pipeline-lib.ConnectionOptions.Initializer"></a>

```typescript
import { ConnectionOptions } from '@pipeline-builder/pipeline-lib'

const connectionOptions: ConnectionOptions = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.ConnectionOptions.property.connectionArn">connectionArn</a></code> | <code>string</code> | The ARN of the CodeStar Connection created in the AWS console that has permissions to access this GitHub or BitBucket repository. |
| <code><a href="#@pipeline-builder/pipeline-lib.ConnectionOptions.property.actionName">actionName</a></code> | <code>string</code> | The action name used for this source in the CodePipeline. |
| <code><a href="#@pipeline-builder/pipeline-lib.ConnectionOptions.property.codeBuildCloneOutput">codeBuildCloneOutput</a></code> | <code>boolean</code> | If this is set, the next CodeBuild job clones the repository (instead of CodePipeline downloading the files). |
| <code><a href="#@pipeline-builder/pipeline-lib.ConnectionOptions.property.triggerOnPush">triggerOnPush</a></code> | <code>boolean</code> | Controls automatically starting your pipeline when a new commit is made on the configured repository and branch. |
| <code><a href="#@pipeline-builder/pipeline-lib.ConnectionOptions.property.repository">repository</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.ConnectionOptions.property.branch">branch</a></code> | <code>string</code> | *No description.* |

---

##### `connectionArn`<sup>Required</sup> <a name="connectionArn" id="@pipeline-builder/pipeline-lib.ConnectionOptions.property.connectionArn"></a>

```typescript
public readonly connectionArn: string;
```

- *Type:* string

The ARN of the CodeStar Connection created in the AWS console that has permissions to access this GitHub or BitBucket repository.

> [https://docs.aws.amazon.com/codepipeline/latest/userguide/connections-create.html](https://docs.aws.amazon.com/codepipeline/latest/userguide/connections-create.html)

---

*Example*

```typescript
'arn:aws:codestar-connections:us-east-1:123456789012:connection/12345678-abcd-12ab-34cdef5678gh'
```


##### `actionName`<sup>Optional</sup> <a name="actionName" id="@pipeline-builder/pipeline-lib.ConnectionOptions.property.actionName"></a>

```typescript
public readonly actionName: string;
```

- *Type:* string
- *Default:* The repository string

The action name used for this source in the CodePipeline.

---

##### `codeBuildCloneOutput`<sup>Optional</sup> <a name="codeBuildCloneOutput" id="@pipeline-builder/pipeline-lib.ConnectionOptions.property.codeBuildCloneOutput"></a>

```typescript
public readonly codeBuildCloneOutput: boolean;
```

- *Type:* boolean
- *Default:* false

If this is set, the next CodeBuild job clones the repository (instead of CodePipeline downloading the files).

This provides access to repository history, and retains symlinks (symlinks would otherwise be
removed by CodePipeline).

**Note**: if this option is true, only CodeBuild jobs can use the output artifact.

> [https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-CodestarConnectionSource.html#action-reference-CodestarConnectionSource-config](https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-CodestarConnectionSource.html#action-reference-CodestarConnectionSource-config)

---

##### `triggerOnPush`<sup>Optional</sup> <a name="triggerOnPush" id="@pipeline-builder/pipeline-lib.ConnectionOptions.property.triggerOnPush"></a>

```typescript
public readonly triggerOnPush: boolean;
```

- *Type:* boolean
- *Default:* true

Controls automatically starting your pipeline when a new commit is made on the configured repository and branch.

If unspecified,
the default value is true, and the field does not display by default.

> [https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-CodestarConnectionSource.html](https://docs.aws.amazon.com/codepipeline/latest/userguide/action-reference-CodestarConnectionSource.html)

---

##### `repository`<sup>Required</sup> <a name="repository" id="@pipeline-builder/pipeline-lib.ConnectionOptions.property.repository"></a>

```typescript
public readonly repository: string;
```

- *Type:* string

---

##### `branch`<sup>Optional</sup> <a name="branch" id="@pipeline-builder/pipeline-lib.ConnectionOptions.property.branch"></a>

```typescript
public readonly branch: string;
```

- *Type:* string

---

### GitHubOptions <a name="GitHubOptions" id="@pipeline-builder/pipeline-lib.GitHubOptions"></a>

#### Initializer <a name="Initializer" id="@pipeline-builder/pipeline-lib.GitHubOptions.Initializer"></a>

```typescript
import { GitHubOptions } from '@pipeline-builder/pipeline-lib'

const gitHubOptions: GitHubOptions = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.GitHubOptions.property.actionName">actionName</a></code> | <code>string</code> | The action name used for this source in the CodePipeline. |
| <code><a href="#@pipeline-builder/pipeline-lib.GitHubOptions.property.authentication">authentication</a></code> | <code>aws-cdk-lib.SecretValue</code> | A GitHub OAuth token to use for authentication. |
| <code><a href="#@pipeline-builder/pipeline-lib.GitHubOptions.property.trigger">trigger</a></code> | <code>aws-cdk-lib.aws_codepipeline_actions.GitHubTrigger</code> | How AWS CodePipeline should be triggered. |
| <code><a href="#@pipeline-builder/pipeline-lib.GitHubOptions.property.repository">repository</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.GitHubOptions.property.branch">branch</a></code> | <code>string</code> | *No description.* |

---

##### `actionName`<sup>Optional</sup> <a name="actionName" id="@pipeline-builder/pipeline-lib.GitHubOptions.property.actionName"></a>

```typescript
public readonly actionName: string;
```

- *Type:* string
- *Default:* The repository string

The action name used for this source in the CodePipeline.

---

##### `authentication`<sup>Optional</sup> <a name="authentication" id="@pipeline-builder/pipeline-lib.GitHubOptions.property.authentication"></a>

```typescript
public readonly authentication: SecretValue;
```

- *Type:* aws-cdk-lib.SecretValue
- *Default:* SecretValue.secretsManager('github-token')

A GitHub OAuth token to use for authentication.

It is recommended to use a Secrets Manager `Secret` to obtain the token:

```ts
const oauth = cdk.SecretValue.secretsManager('my-github-token');
```

The GitHub Personal Access Token should have these scopes:

* **repo** - to read the repository
* **admin:repo_hook** - if you plan to use webhooks (true by default)

> [https://docs.aws.amazon.com/codepipeline/latest/userguide/GitHub-create-personal-token-CLI.html](https://docs.aws.amazon.com/codepipeline/latest/userguide/GitHub-create-personal-token-CLI.html)

---

##### `trigger`<sup>Optional</sup> <a name="trigger" id="@pipeline-builder/pipeline-lib.GitHubOptions.property.trigger"></a>

```typescript
public readonly trigger: GitHubTrigger;
```

- *Type:* aws-cdk-lib.aws_codepipeline_actions.GitHubTrigger
- *Default:* GitHubTrigger.WEBHOOK

How AWS CodePipeline should be triggered.

With the default value "WEBHOOK", a webhook is created in GitHub that triggers the action.
With "POLL", CodePipeline periodically checks the source for changes.
With "None", the action is not triggered through changes in the source.

To use `WEBHOOK`, your GitHub Personal Access Token should have
**admin:repo_hook** scope (in addition to the regular **repo** scope).

---

##### `repository`<sup>Required</sup> <a name="repository" id="@pipeline-builder/pipeline-lib.GitHubOptions.property.repository"></a>

```typescript
public readonly repository: string;
```

- *Type:* string

---

##### `branch`<sup>Optional</sup> <a name="branch" id="@pipeline-builder/pipeline-lib.GitHubOptions.property.branch"></a>

```typescript
public readonly branch: string;
```

- *Type:* string

---

### InputProps <a name="InputProps" id="@pipeline-builder/pipeline-lib.InputProps"></a>

#### Initializer <a name="Initializer" id="@pipeline-builder/pipeline-lib.InputProps.Initializer"></a>

```typescript
import { InputProps } from '@pipeline-builder/pipeline-lib'

const inputProps: InputProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.InputProps.property.inputType">inputType</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.InputProps.property.connectionOptions">connectionOptions</a></code> | <code><a href="#@pipeline-builder/pipeline-lib.ConnectionOptions">ConnectionOptions</a></code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.InputProps.property.gitHubOptions">gitHubOptions</a></code> | <code><a href="#@pipeline-builder/pipeline-lib.GitHubOptions">GitHubOptions</a></code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.InputProps.property.s3Options">s3Options</a></code> | <code><a href="#@pipeline-builder/pipeline-lib.S3Options">S3Options</a></code> | *No description.* |

---

##### `inputType`<sup>Required</sup> <a name="inputType" id="@pipeline-builder/pipeline-lib.InputProps.property.inputType"></a>

```typescript
public readonly inputType: string;
```

- *Type:* string

---

##### `connectionOptions`<sup>Optional</sup> <a name="connectionOptions" id="@pipeline-builder/pipeline-lib.InputProps.property.connectionOptions"></a>

```typescript
public readonly connectionOptions: ConnectionOptions;
```

- *Type:* <a href="#@pipeline-builder/pipeline-lib.ConnectionOptions">ConnectionOptions</a>

---

##### `gitHubOptions`<sup>Optional</sup> <a name="gitHubOptions" id="@pipeline-builder/pipeline-lib.InputProps.property.gitHubOptions"></a>

```typescript
public readonly gitHubOptions: GitHubOptions;
```

- *Type:* <a href="#@pipeline-builder/pipeline-lib.GitHubOptions">GitHubOptions</a>

---

##### `s3Options`<sup>Optional</sup> <a name="s3Options" id="@pipeline-builder/pipeline-lib.InputProps.property.s3Options"></a>

```typescript
public readonly s3Options: S3Options;
```

- *Type:* <a href="#@pipeline-builder/pipeline-lib.S3Options">S3Options</a>

---

### PipelineBuilderProps <a name="PipelineBuilderProps" id="@pipeline-builder/pipeline-lib.PipelineBuilderProps"></a>

#### Initializer <a name="Initializer" id="@pipeline-builder/pipeline-lib.PipelineBuilderProps.Initializer"></a>

```typescript
import { PipelineBuilderProps } from '@pipeline-builder/pipeline-lib'

const pipelineBuilderProps: PipelineBuilderProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.input">input</a></code> | <code><a href="#@pipeline-builder/pipeline-lib.InputProps">InputProps</a></code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.organization">organization</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.project">project</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.metadata">metadata</a></code> | <code>{[ key: string ]: any}</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.pipelineName">pipelineName</a></code> | <code>string</code> | *No description.* |

---

##### `input`<sup>Required</sup> <a name="input" id="@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.input"></a>

```typescript
public readonly input: InputProps;
```

- *Type:* <a href="#@pipeline-builder/pipeline-lib.InputProps">InputProps</a>

---

##### `organization`<sup>Required</sup> <a name="organization" id="@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.organization"></a>

```typescript
public readonly organization: string;
```

- *Type:* string

---

##### `project`<sup>Required</sup> <a name="project" id="@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.project"></a>

```typescript
public readonly project: string;
```

- *Type:* string

---

##### `metadata`<sup>Optional</sup> <a name="metadata" id="@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.metadata"></a>

```typescript
public readonly metadata: {[ key: string ]: any};
```

- *Type:* {[ key: string ]: any}

---

##### `pipelineName`<sup>Optional</sup> <a name="pipelineName" id="@pipeline-builder/pipeline-lib.PipelineBuilderProps.property.pipelineName"></a>

```typescript
public readonly pipelineName: string;
```

- *Type:* string

---

### PluginConfig <a name="PluginConfig" id="@pipeline-builder/pipeline-lib.PluginConfig"></a>

#### Initializer <a name="Initializer" id="@pipeline-builder/pipeline-lib.PluginConfig.Initializer"></a>

```typescript
import { PluginConfig } from '@pipeline-builder/pipeline-lib'

const pluginConfig: PluginConfig = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.PluginConfig.property.commands">commands</a></code> | <code>string[]</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PluginConfig.property.pluginName">pluginName</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PluginConfig.property.pluginType">pluginType</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PluginConfig.property.version">version</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.PluginConfig.property.description">description</a></code> | <code>string</code> | *No description.* |

---

##### `commands`<sup>Required</sup> <a name="commands" id="@pipeline-builder/pipeline-lib.PluginConfig.property.commands"></a>

```typescript
public readonly commands: string[];
```

- *Type:* string[]

---

##### `pluginName`<sup>Required</sup> <a name="pluginName" id="@pipeline-builder/pipeline-lib.PluginConfig.property.pluginName"></a>

```typescript
public readonly pluginName: string;
```

- *Type:* string

---

##### `pluginType`<sup>Required</sup> <a name="pluginType" id="@pipeline-builder/pipeline-lib.PluginConfig.property.pluginType"></a>

```typescript
public readonly pluginType: string;
```

- *Type:* string

---

##### `version`<sup>Required</sup> <a name="version" id="@pipeline-builder/pipeline-lib.PluginConfig.property.version"></a>

```typescript
public readonly version: string;
```

- *Type:* string

---

##### `description`<sup>Optional</sup> <a name="description" id="@pipeline-builder/pipeline-lib.PluginConfig.property.description"></a>

```typescript
public readonly description: string;
```

- *Type:* string

---

### S3Options <a name="S3Options" id="@pipeline-builder/pipeline-lib.S3Options"></a>

#### Initializer <a name="Initializer" id="@pipeline-builder/pipeline-lib.S3Options.Initializer"></a>

```typescript
import { S3Options } from '@pipeline-builder/pipeline-lib'

const s3Options: S3Options = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.S3Options.property.actionName">actionName</a></code> | <code>string</code> | The action name used for this source in the CodePipeline. |
| <code><a href="#@pipeline-builder/pipeline-lib.S3Options.property.role">role</a></code> | <code>aws-cdk-lib.aws_iam.IRole</code> | The role that will be assumed by the pipeline prior to executing the `S3Source` action. |
| <code><a href="#@pipeline-builder/pipeline-lib.S3Options.property.trigger">trigger</a></code> | <code>aws-cdk-lib.aws_codepipeline_actions.S3Trigger</code> | How should CodePipeline detect source changes for this Action. |
| <code><a href="#@pipeline-builder/pipeline-lib.S3Options.property.bucketName">bucketName</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.S3Options.property.objectKey">objectKey</a></code> | <code>string</code> | *No description.* |

---

##### `actionName`<sup>Optional</sup> <a name="actionName" id="@pipeline-builder/pipeline-lib.S3Options.property.actionName"></a>

```typescript
public readonly actionName: string;
```

- *Type:* string
- *Default:* The bucket name

The action name used for this source in the CodePipeline.

---

##### `role`<sup>Optional</sup> <a name="role" id="@pipeline-builder/pipeline-lib.S3Options.property.role"></a>

```typescript
public readonly role: IRole;
```

- *Type:* aws-cdk-lib.aws_iam.IRole
- *Default:* a new role will be generated

The role that will be assumed by the pipeline prior to executing the `S3Source` action.

---

##### `trigger`<sup>Optional</sup> <a name="trigger" id="@pipeline-builder/pipeline-lib.S3Options.property.trigger"></a>

```typescript
public readonly trigger: S3Trigger;
```

- *Type:* aws-cdk-lib.aws_codepipeline_actions.S3Trigger
- *Default:* S3Trigger.POLL

How should CodePipeline detect source changes for this Action.

Note that if this is S3Trigger.EVENTS, you need to make sure to include the source Bucket in a CloudTrail Trail,
as otherwise the CloudWatch Events will not be emitted.

> [https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/log-s3-data-events.html](https://docs.aws.amazon.com/AmazonCloudWatch/latest/events/log-s3-data-events.html)

---

##### `bucketName`<sup>Required</sup> <a name="bucketName" id="@pipeline-builder/pipeline-lib.S3Options.property.bucketName"></a>

```typescript
public readonly bucketName: string;
```

- *Type:* string

---

##### `objectKey`<sup>Optional</sup> <a name="objectKey" id="@pipeline-builder/pipeline-lib.S3Options.property.objectKey"></a>

```typescript
public readonly objectKey: string;
```

- *Type:* string

---

## Classes <a name="Classes" id="Classes"></a>

### Constants <a name="Constants" id="@pipeline-builder/pipeline-lib.Constants"></a>

#### Initializers <a name="Initializers" id="@pipeline-builder/pipeline-lib.Constants.Initializer"></a>

```typescript
import { Constants } from '@pipeline-builder/pipeline-lib'

new Constants()
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |

---




#### Constants <a name="Constants" id="Constants"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_ARCHITECTURE">DEFAULT_ARCHITECTURE</a></code> | <code>aws-cdk-lib.aws_lambda.Architecture</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_LOG_RETENTION">DEFAULT_LOG_RETENTION</a></code> | <code>aws-cdk-lib.aws_logs.RetentionDays</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_MEMORY_SIZE">DEFAULT_MEMORY_SIZE</a></code> | <code>number</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_PIPELINETYPE">DEFAULT_PIPELINETYPE</a></code> | <code>aws-cdk-lib.aws_codepipeline.PipelineType</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_SYNTH_PLUGINNAME">DEFAULT_SYNTH_PLUGINNAME</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_TIMEOUT">DEFAULT_TIMEOUT</a></code> | <code>aws-cdk-lib.Duration</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.Constants.property.NODEJS_VERSION">NODEJS_VERSION</a></code> | <code>aws-cdk-lib.aws_lambda.Runtime</code> | *No description.* |

---

##### `DEFAULT_ARCHITECTURE`<sup>Required</sup> <a name="DEFAULT_ARCHITECTURE" id="@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_ARCHITECTURE"></a>

```typescript
public readonly DEFAULT_ARCHITECTURE: Architecture;
```

- *Type:* aws-cdk-lib.aws_lambda.Architecture

---

##### `DEFAULT_LOG_RETENTION`<sup>Required</sup> <a name="DEFAULT_LOG_RETENTION" id="@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_LOG_RETENTION"></a>

```typescript
public readonly DEFAULT_LOG_RETENTION: RetentionDays;
```

- *Type:* aws-cdk-lib.aws_logs.RetentionDays

---

##### `DEFAULT_MEMORY_SIZE`<sup>Required</sup> <a name="DEFAULT_MEMORY_SIZE" id="@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_MEMORY_SIZE"></a>

```typescript
public readonly DEFAULT_MEMORY_SIZE: number;
```

- *Type:* number

---

##### `DEFAULT_PIPELINETYPE`<sup>Required</sup> <a name="DEFAULT_PIPELINETYPE" id="@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_PIPELINETYPE"></a>

```typescript
public readonly DEFAULT_PIPELINETYPE: PipelineType;
```

- *Type:* aws-cdk-lib.aws_codepipeline.PipelineType

---

##### `DEFAULT_SYNTH_PLUGINNAME`<sup>Required</sup> <a name="DEFAULT_SYNTH_PLUGINNAME" id="@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_SYNTH_PLUGINNAME"></a>

```typescript
public readonly DEFAULT_SYNTH_PLUGINNAME: string;
```

- *Type:* string

---

##### `DEFAULT_TIMEOUT`<sup>Required</sup> <a name="DEFAULT_TIMEOUT" id="@pipeline-builder/pipeline-lib.Constants.property.DEFAULT_TIMEOUT"></a>

```typescript
public readonly DEFAULT_TIMEOUT: Duration;
```

- *Type:* aws-cdk-lib.Duration

---

##### `NODEJS_VERSION`<sup>Required</sup> <a name="NODEJS_VERSION" id="@pipeline-builder/pipeline-lib.Constants.property.NODEJS_VERSION"></a>

```typescript
public readonly NODEJS_VERSION: Runtime;
```

- *Type:* aws-cdk-lib.aws_lambda.Runtime

---

### UniqueId <a name="UniqueId" id="@pipeline-builder/pipeline-lib.UniqueId"></a>

#### Initializers <a name="Initializers" id="@pipeline-builder/pipeline-lib.UniqueId.Initializer"></a>

```typescript
import { UniqueId } from '@pipeline-builder/pipeline-lib'

new UniqueId(organization: string, project: string, length?: number)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.UniqueId.Initializer.parameter.organization">organization</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.UniqueId.Initializer.parameter.project">project</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/pipeline-lib.UniqueId.Initializer.parameter.length">length</a></code> | <code>number</code> | *No description.* |

---

##### `organization`<sup>Required</sup> <a name="organization" id="@pipeline-builder/pipeline-lib.UniqueId.Initializer.parameter.organization"></a>

- *Type:* string

---

##### `project`<sup>Required</sup> <a name="project" id="@pipeline-builder/pipeline-lib.UniqueId.Initializer.parameter.project"></a>

- *Type:* string

---

##### `length`<sup>Optional</sup> <a name="length" id="@pipeline-builder/pipeline-lib.UniqueId.Initializer.parameter.length"></a>

- *Type:* number

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#@pipeline-builder/pipeline-lib.UniqueId.generate">generate</a></code> | *No description.* |

---

##### `generate` <a name="generate" id="@pipeline-builder/pipeline-lib.UniqueId.generate"></a>

```typescript
public generate(str: string, length?: number): string
```

###### `str`<sup>Required</sup> <a name="str" id="@pipeline-builder/pipeline-lib.UniqueId.generate.parameter.str"></a>

- *Type:* string

---

###### `length`<sup>Optional</sup> <a name="length" id="@pipeline-builder/pipeline-lib.UniqueId.generate.parameter.length"></a>

- *Type:* number

---





