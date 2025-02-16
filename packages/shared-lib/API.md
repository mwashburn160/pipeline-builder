# API Reference <a name="API Reference" id="api-reference"></a>

## Constructs <a name="Constructs" id="Constructs"></a>

### PipelineBuilder <a name="PipelineBuilder" id="@pipeline-builder/shared-lib.PipelineBuilder"></a>

#### Initializers <a name="Initializers" id="@pipeline-builder/shared-lib.PipelineBuilder.Initializer"></a>

```typescript
import { PipelineBuilder } from '@pipeline-builder/shared-lib'

new PipelineBuilder(scope: Construct, id: string, props: PipelineBuilderProps)
```

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/shared-lib.PipelineBuilder.Initializer.parameter.scope">scope</a></code> | <code>constructs.Construct</code> | *No description.* |
| <code><a href="#@pipeline-builder/shared-lib.PipelineBuilder.Initializer.parameter.id">id</a></code> | <code>string</code> | *No description.* |
| <code><a href="#@pipeline-builder/shared-lib.PipelineBuilder.Initializer.parameter.props">props</a></code> | <code><a href="#@pipeline-builder/shared-lib.PipelineBuilderProps">PipelineBuilderProps</a></code> | *No description.* |

---

##### `scope`<sup>Required</sup> <a name="scope" id="@pipeline-builder/shared-lib.PipelineBuilder.Initializer.parameter.scope"></a>

- *Type:* constructs.Construct

---

##### `id`<sup>Required</sup> <a name="id" id="@pipeline-builder/shared-lib.PipelineBuilder.Initializer.parameter.id"></a>

- *Type:* string

---

##### `props`<sup>Required</sup> <a name="props" id="@pipeline-builder/shared-lib.PipelineBuilder.Initializer.parameter.props"></a>

- *Type:* <a href="#@pipeline-builder/shared-lib.PipelineBuilderProps">PipelineBuilderProps</a>

---

#### Methods <a name="Methods" id="Methods"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#@pipeline-builder/shared-lib.PipelineBuilder.toString">toString</a></code> | Returns a string representation of this construct. |

---

##### `toString` <a name="toString" id="@pipeline-builder/shared-lib.PipelineBuilder.toString"></a>

```typescript
public toString(): string
```

Returns a string representation of this construct.

#### Static Functions <a name="Static Functions" id="Static Functions"></a>

| **Name** | **Description** |
| --- | --- |
| <code><a href="#@pipeline-builder/shared-lib.PipelineBuilder.isConstruct">isConstruct</a></code> | Checks if `x` is a construct. |

---

##### `isConstruct` <a name="isConstruct" id="@pipeline-builder/shared-lib.PipelineBuilder.isConstruct"></a>

```typescript
import { PipelineBuilder } from '@pipeline-builder/shared-lib'

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

###### `x`<sup>Required</sup> <a name="x" id="@pipeline-builder/shared-lib.PipelineBuilder.isConstruct.parameter.x"></a>

- *Type:* any

Any object.

---

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/shared-lib.PipelineBuilder.property.node">node</a></code> | <code>constructs.Node</code> | The tree node. |

---

##### `node`<sup>Required</sup> <a name="node" id="@pipeline-builder/shared-lib.PipelineBuilder.property.node"></a>

```typescript
public readonly node: Node;
```

- *Type:* constructs.Node

The tree node.

---


## Structs <a name="Structs" id="Structs"></a>

### PipelineBuilderProps <a name="PipelineBuilderProps" id="@pipeline-builder/shared-lib.PipelineBuilderProps"></a>

#### Initializer <a name="Initializer" id="@pipeline-builder/shared-lib.PipelineBuilderProps.Initializer"></a>

```typescript
import { PipelineBuilderProps } from '@pipeline-builder/shared-lib'

const pipelineBuilderProps: PipelineBuilderProps = { ... }
```

#### Properties <a name="Properties" id="Properties"></a>

| **Name** | **Type** | **Description** |
| --- | --- | --- |
| <code><a href="#@pipeline-builder/shared-lib.PipelineBuilderProps.property.organization">organization</a></code> | <code>string</code> | Organization name. |
| <code><a href="#@pipeline-builder/shared-lib.PipelineBuilderProps.property.project">project</a></code> | <code>string</code> | Project name. |

---

##### `organization`<sup>Required</sup> <a name="organization" id="@pipeline-builder/shared-lib.PipelineBuilderProps.property.organization"></a>

```typescript
public readonly organization: string;
```

- *Type:* string

Organization name.

---

##### `project`<sup>Required</sup> <a name="project" id="@pipeline-builder/shared-lib.PipelineBuilderProps.property.project"></a>

```typescript
public readonly project: string;
```

- *Type:* string

Project name.

---



