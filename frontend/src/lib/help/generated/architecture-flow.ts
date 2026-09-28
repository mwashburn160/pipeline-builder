// GENERATED FROM docs/architecture-flow.md — DO NOT EDIT.
// Regenerate: npm run generate:help  (see frontend/scripts/generate-help.mjs)
// SOURCE-SHA256: b9d7b7cbab8ee3fc6bfbc229c48929317e9898b020da340224d1bbfac0a1c783
// SPDX-License-Identifier: Apache-2.0
import { Workflow } from 'lucide-react';
import type { HelpTopic } from '../types';

export const architectureFlowTopic: HelpTopic = {
  "icon": Workflow,
  "id": "architecture-flow",
  "title": "Architecture & Flow",
  "description": "How Pipeline Builder turns plugins and pipelines into running AWS CodePipelines",
  "sections": [
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "<!-- Copyright 2026 Pipeline Builder Contributors SPDX-License-Identifier: Apache-2.0 -->"
        },
        {
          "type": "text",
          "content": "How a pipeline gets from a definition in the UI to a running CodePipeline, traced end to end."
        }
      ]
    },
    {
      "id": "highlights",
      "title": "Highlights",
      "blocks": [
        {
          "type": "list",
          "items": [
            "Every hop runs over mTLS. All service-to-service and service-to-datastore traffic goes through an Istio ambient mesh with STRICT mutual TLS and identity-based L4 authorization; the only plaintext edges are the TLS ingress and two PERMISSIVE carve-outs.",
            "Pipelines are synthesized, not interpreted. A definition becomes a CloudFormation template via AWS CDK, then native CodePipeline + CodeBuild resources in the customer's own account.",
            "A plugin is a container, and a step is a CodeBuild action running that container's image.",
            "Three build types. A plugin can build its image at upload, ship a prebuilt image, or carry no image at all and run on CodeBuild's default.",
            "Every resource is org-scoped, from the pipeline row to the Secrets Manager path — see Multi-Team Isolation.",
            "The four flows are independent. Uploading a plugin, creating a pipeline, synthesizing it and executing it each have their own failure modes and their own trail."
          ]
        }
      ]
    },
    {
      "id": "overview",
      "title": "Overview",
      "blocks": [
        {
          "type": "text",
          "content": "Pipeline Builder is a multi-team platform for creating AWS CodePipeline CI/CD pipelines out of reusable, containerized plugins. Users define pipelines through the UI, CLI, API or CDK, and the system synthesizes them into CloudFormation templates via AWS CDK."
        },
        {
          "type": "text",
          "content": "It ships with 119 ready-to-use plugins spanning build, test, security, quality, monitoring and infrastructure, and can also generate new plugins and pipelines from natural-language prompts via pluggable AI providers — Anthropic, OpenAI, Google, xAI and Amazon Bedrock."
        },
        {
          "type": "text",
          "content": "This page is for engineers who need the mechanism rather than the product story. For the latter, see Organization Benefits."
        }
      ]
    },
    {
      "id": "how-it-works",
      "title": "How it works",
      "blocks": [
        {
          "type": "text",
          "content": "Four flows, in the order a new user meets them:"
        },
        {
          "type": "table",
          "headers": [
            "Flow",
            "Starts with",
            "Ends with"
          ],
          "rows": [
            [
              "1. Plugin upload and build",
              "A plugin ZIP (Dockerfile + spec)",
              "A built, scanned, digest-pinned image in the registry"
            ],
            [
              "1b. Publishing to the ecosystem",
              "A version the publisher wants listed",
              "An approved public listing other orgs can install"
            ],
            [
              "2. Pipeline creation",
              "A BuilderProps definition",
              "A validated, quota-counted pipeline row"
            ],
            [
              "3. CDK synthesis",
              "That stored definition",
              "A CloudFormation template with CodePipeline and CodeBuild resources"
            ],
            [
              "4. CodePipeline execution",
              "A source commit or a manual run",
              "Stage results, artifacts and events streamed back for analytics"
            ]
          ]
        },
        {
          "type": "text",
          "content": "Each flow below is drawn as a sequence, then broken down into the structures it reads and writes."
        }
      ]
    },
    {
      "id": "configuration",
      "title": "Configuration",
      "blocks": [
        {
          "type": "text",
          "content": "Nothing on this page is configured here — it describes the mechanism the other pages configure. The entry points:"
        },
        {
          "type": "list",
          "items": [
            "Deploy the platform — AWS Deployment for EC2/EKS, or the local targets for evaluation.",
            "Load or author plugins — Plugin Catalog and Plugin Publishing.",
            "Define pipelines — Developer Guide for the five interfaces, CDK Usage for the construct, Metadata Keys for the synth-time overrides.",
            "Wire the event path so Flow 4's results reach reporting — Onboarding Step 6.",
            "Set the guardrails — Compliance validates at Flow 2, before anything is created."
          ]
        }
      ]
    },
    {
      "id": "system-architecture",
      "title": "System Architecture",
      "blocks": [
        {
          "type": "note",
          "content": "Service mesh: every service-to-service and service-to-datastore hop shown below runs over an Istio ambient mesh — STRICT mutual TLS + identity-based L4 authorization (via the per-node ztunnel). The only plaintext edges are the ALB/nginx TLS ingress and two PERMISSIVE carve-outs."
        },
        {
          "type": "code",
          "content": "flowchart TB\n    subgraph Clients\n        FE[Frontend<br/>Next.js]\n        CLI[CLI<br/>pipeline-manager]\n        API_EXT[REST API]\n    end\n\n    subgraph Platform[\"Pipeline Builder Platform\"]\n        NGINX[Nginx<br/>Reverse Proxy]\n        PLATFORM[Platform API<br/>Identity / Orgs / Audit]\n        PIPELINE[Pipeline API]\n        PLUGIN[Plugin API]\n        COMPLIANCE[Compliance]\n        QUOTA[Quota]\n        BILLING[Billing]\n        MESSAGE[Message]\n        REPORTING[Reporting]\n        IMGREG[Image Registry<br/>Token / Image API]\n    end\n\n    subgraph Data\n        MONGO[(MongoDB<br/>Users / Orgs)]\n        PG[(PostgreSQL<br/>Pipelines / Plugins)]\n        REDIS[(Redis<br/>BullMQ / Cache)]\n    end\n\n    subgraph Build\n        BK[buildkitd Sidecar<br/>Rootless BuildKit]\n        REG[Registry<br/>Plugin Images]\n    end\n\n    FE & CLI & API_EXT --> NGINX\n    NGINX -->|route by path| PLATFORM & PIPELINE & PLUGIN & COMPLIANCE & QUOTA & BILLING & MESSAGE & REPORTING & IMGREG\n    PIPELINE & PLUGIN & COMPLIANCE & REPORTING & IMGREG -.->|verify tokens via JWKS| PLATFORM\n    PLUGIN & PIPELINE -->|validate| COMPLIANCE\n    PLATFORM --> MONGO\n    PIPELINE & PLUGIN & COMPLIANCE & REPORTING --> PG\n    PLUGIN --> REDIS\n    PLUGIN -->|buildctl build_image| BK\n    PLUGIN -->|crane push prebuilt| REG\n    BK -->|push with scoped Bearer token| REG\n    IMGREG -->|mint scoped token| REG",
          "language": "mermaid"
        }
      ]
    },
    {
      "id": "flow-1-plugin-upload-build",
      "title": "Flow 1: Plugin Upload & Build",
      "blocks": [
        {
          "type": "text",
          "content": "Plugins are containerized build tools (e.g., eslint, terraform, docker-build) packaged as ZIP files containing a Dockerfile and plugin-spec.yaml."
        },
        {
          "type": "code",
          "content": "sequenceDiagram\n    participant Dev as Developer\n    participant API as Plugin API\n    participant Queue as Build Queue<br/>(BullMQ)\n    participant BK as buildkitd Sidecar\n    participant Reg as Registry\n    participant IR as image-registry<br/>(signer)\n    participant DB as PostgreSQL\n\n    Dev->>API: POST /plugins (multipart: plugin.zip)\n    API->>API: Extract ZIP (spec, Dockerfile, config)\n    API->>API: Compliance check (fail-closed)\n    API-->>Dev: 202 Accepted\n\n    API->>Queue: Enqueue build job\n\n    Queue->>BK: buildctl build --frontend dockerfile.v0<br/>attest:provenance=mode=min\n    BK->>Reg: push image index (bearer-token auth)\n    BK-->>Queue: pushed digest (--metadata-file)\n    Queue->>Reg: syft scan <repo>@<digest> → SPDX SBOM\n    Queue->>IR: POST /internal/plugin-signatures {repo, digest, sbom}\n    IR->>Reg: cosign sign + cosign attest (sha256-<digest>.sig / .att)\n    Queue->>DB: Store plugin (name, version, commands, env, imageDigest, imageSource)\n    Queue-->>Dev: SSE: build complete",
          "language": "mermaid"
        },
        {
          "type": "text",
          "content": "Every pushed image is signed by digest and carries a signed SPDX SBOM attestation before the plugin row is written — a failure in either step fails the build. The signing key lives only in image-registry: the plugin pod shares its network namespace with the buildkitd sidecar running untrusted tenant RUN steps, so it holds just the public key. For a build_image plugin the signed digest is an image index that also carries BuildKit's SLSA provenance (mode=min — max would publish build args); a prebuilt upload gets the SBOM and signature but no provenance (imageSource: uploaded). See Plugin supply chain."
        },
        {
          "type": "text",
          "content": "Plugin ZIP Structure"
        },
        {
          "type": "code",
          "content": "flowchart LR\n    ZIP[plugin.zip] --> Config[config.yaml<br/>buildType, dockerfile path]\n    ZIP --> Spec[plugin-spec.yaml<br/>name, version, commands, env]\n    ZIP --> DF[Dockerfile<br/>Container image]\n    ZIP --> TAR[image.tar<br/>prebuilt only]",
          "language": "mermaid"
        },
        {
          "type": "text",
          "content": "Build Types"
        },
        {
          "type": "code",
          "content": "flowchart LR\n    subgraph build_image\n        DF2[Dockerfile] --> Build[buildctl build<br/>+ provenance] --> Push1[buildkit push] --> Sign1[SBOM + sign] --> R1[Registry]\n    end\n\n    subgraph prebuilt\n        TAR2[image.tar] --> Push2[crane push] --> Sign2[SBOM + sign] --> R2[Registry]\n    end\n\n    subgraph metadata_only\n        Spec2[plugin-spec.yaml] --> Direct[Deploy directly<br/>No Docker build]\n    end",
          "language": "mermaid"
        }
      ]
    },
    {
      "id": "flow-1b-publishing-to-the-plugin-ecosystem",
      "title": "Flow 1b: Publishing to the Plugin Ecosystem",
      "blocks": [
        {
          "type": "text",
          "content": "A plugin reaches other organizations only through the plugin ecosystem: the publisher requests a listing, the system organization approves it, and the approved version is copied into a read-only public/* registry namespace. visibility: public never crosses an org boundary on its own."
        },
        {
          "type": "code",
          "content": "sequenceDiagram\n    participant Pub as Publisher org\n    participant Plugin as Plugin API\n    participant Mod as Ecosystem Managers<br/>(system org)\n    participant IR as Image Registry\n    participant Reg as Registry\n\n    Pub->>Plugin: POST /plugins/publish-requests (kind new_listing / new_version)\n    Plugin->>Plugin: Gates (public, license, README, signed, scanned, vuln)<br/>Pin digest + freeze version\n    alt bootstrap exception or auto-approval rule\n        Plugin->>Plugin: Approve as system\n    else manual review\n        Plugin-->>Mod: N24 (queue)\n        Mod->>Plugin: approve (and second-approve for Official / Verified)\n    end\n    Plugin->>IR: POST /internal/plugin-publications (pinned digest, tier)\n    IR->>Reg: Copy org-ID/name@digest to public/PUBLISHER/name\n    IR->>Reg: Sign fresh (pb.trust, pb.publisher) + attest SBOM + tag version\n    Plugin->>Plugin: Record listing + listing version (immutable)\n    Plugin-->>Pub: N25 (approved)",
          "language": "mermaid"
        },
        {
          "type": "list",
          "items": [
            "Official catalog. The system org's plugins are listings under the"
          ]
        },
        {
          "type": "text",
          "content": "pipeline-builder publisher, loaded by load-plugins.sh as the official-catalog-loader service account (publishRequest=true). The first load rides the one-time bootstrap exception; later gate-green patch/minor updates ride the seeded Official auto-approval rule."
        },
        {
          "type": "list",
          "items": [
            "Resolution until installs ship. Plugin reads and lookups include another"
          ]
        },
        {
          "type": "text",
          "content": "org's plugin only when it is a system-org row that is the source of a live Official listing version (OFFICIAL_LISTED_PLUGIN_SCOPE in pipeline-data). W2 switches resolution to installs (implicit for Official) and to the listing's public/* image repository."
        },
        {
          "type": "list",
          "items": [
            "Re-sign job. A tier change, suspension, handle change or transfer"
          ]
        },
        {
          "type": "text",
          "content": "re-signs every published image with the new annotations, then drops the lookup verify cache."
        }
      ]
    },
    {
      "id": "flow-2-pipeline-creation",
      "title": "Flow 2: Pipeline Creation",
      "blocks": [
        {
          "type": "text",
          "content": "Users compose pipelines from plugins via the UI or API."
        },
        {
          "type": "code",
          "content": "sequenceDiagram\n    participant User as User (UI/API)\n    participant Plat as Platform API\n    participant Pipe as Pipeline API\n    participant Comp as Compliance\n    participant DB as PostgreSQL\n\n    User->>Plat: Create Pipeline (project, org, props)\n    Plat->>Pipe: POST /pipelines\n    Pipe->>Pipe: Auth + quota check\n    Pipe->>Comp: Validate pipeline props\n    Comp-->>Pipe: Allowed / Blocked\n    Pipe->>DB: Store pipeline (id, project, org, props JSON)\n    Pipe-->>User: 201 Created",
          "language": "mermaid"
        },
        {
          "type": "text",
          "content": "BuilderProps Structure (stored as JSON in props column)"
        },
        {
          "type": "code",
          "content": "{\n  \"project\": \"my-app\",\n  \"organization\": \"acme-corp\",\n  \"pipelineName\": \"main-pipeline\",\n  \"synth\": {\n    \"source\": { \"repo\": \"owner/repo\", \"branch\": \"main\" },\n    \"plugin\": { \"name\": \"cdk-synth\" }\n  },\n  \"stages\": [\n    {\n      \"stageName\": \"Test\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"jest\" } },\n        { \"plugin\": { \"name\": \"eslint\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Security\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"snyk-nodejs\" } },\n        { \"plugin\": { \"name\": \"trivy\" } }\n      ]\n    },\n    {\n      \"stageName\": \"Deploy\",\n      \"steps\": [\n        { \"plugin\": { \"name\": \"cdk-deploy\" } }\n      ]\n    }\n  ]\n}",
          "language": "json"
        }
      ]
    },
    {
      "id": "flow-3-cdk-synthesis-pipeline-to-cloudformation",
      "title": "Flow 3: CDK Synthesis (Pipeline to CloudFormation)",
      "blocks": [
        {
          "type": "text",
          "content": "The pipeline definition is synthesized into an AWS CloudFormation template using CDK."
        },
        {
          "type": "code",
          "content": "sequenceDiagram\n    participant CLI as pipeline-manager\n    participant CDK as CDK Constructs\n    participant Lambda as Plugin Lookup<br/>Lambda\n    participant API as Platform API\n\n    CLI->>CDK: cdk synth / cdk deploy\n    CDK->>CDK: PipelineBuilder(props)\n    CDK->>CDK: Create PluginLookup (Custom Resource + Lambda)\n\n    Note over CDK,Lambda: At deploy time (CloudFormation)\n    CDK->>Lambda: Resolve stage plugins\n    Lambda->>API: POST /api/plugins/lookup\n    API-->>Lambda: Plugin config (commands, env, computeType)\n    Lambda-->>CDK: Base64-encoded plugin data\n\n    CDK->>CDK: Create CodeBuildStep per stage/step\n    CDK->>CDK: Assemble CodePipeline (Source → Synth → Stages)\n    CDK-->>CLI: CloudFormation template",
          "language": "mermaid"
        },
        {
          "type": "text",
          "content": "pipeline-manager pre-resolves every plugin through the same POST /api/plugins/lookup before synth. For a plugin that runs on its own image, the plugin service first runs cosign verify against the plugin-signing public key and answers 409 IMAGE_VERIFICATION_FAILED if the signature doesn't verify (or the plugin has no signed digest) — which aborts the synth rather than falling back. The synthesized CodeBuild image is then pinned by digest (<repo>@sha256:…), never by the mutable name:version tag."
        },
        {
          "type": "text",
          "content": "Generated CloudFormation Resources"
        },
        {
          "type": "code",
          "content": "flowchart TB\n    CFN[CloudFormation Template]\n    CFN --> CP[AWS::CodePipeline::Pipeline]\n    CFN --> CB1[AWS::CodeBuild::Project x N]\n    CFN --> LF[AWS::Lambda::Function<br/>Plugin Lookup]\n    CFN --> IAM[AWS::IAM::Role<br/>Pipeline Execution]\n    CFN --> S3[AWS::S3::Bucket<br/>Artifacts]\n    CFN --> CW[AWS::CloudWatch::LogGroup]\n\n    CB1 --> BE[BuildEnvironment]\n    BE --> IMG[Image: plugin or AWS default]\n    BE --> CT[ComputeType: from plugin]\n    BE --> ENV[EnvironmentVariables:<br/>plugin.env + metadata + secrets]",
          "language": "mermaid"
        }
      ]
    },
    {
      "id": "flow-4-codepipeline-execution",
      "title": "Flow 4: CodePipeline Execution",
      "blocks": [
        {
          "type": "text",
          "content": "When the generated pipeline runs (triggered by source change, schedule, or manual start)."
        },
        {
          "type": "code",
          "content": "sequenceDiagram\n    participant GH as GitHub\n    participant CP as CodePipeline\n    participant CB as CodeBuild\n    participant IMG as Plugin Image\n\n    GH->>CP: Push / webhook\n    CP->>CP: Stage: Source (fetch code)\n\n    CP->>CB: Stage: Synth\n    CB->>IMG: Pull cdk-synth image\n    CB->>CB: Run pipeline-manager pipeline synth\n    CB-->>CP: Output: cdk.out/\n\n    CP->>CP: Stage: SelfMutation (update pipeline if changed)\n\n    CP->>CB: Stage: Test\n    CB->>IMG: Pull jest + eslint images\n    CB->>CB: Run plugin commands\n\n    CP->>CB: Stage: Security\n    CB->>IMG: Pull snyk + trivy images\n    CB->>CB: Run security scans\n\n    CP->>CB: Stage: Deploy\n    CB->>IMG: Pull cdk-deploy image\n    CB->>CB: Run deployment\n\n    CP->>CP: Pipeline Complete",
          "language": "mermaid"
        },
        {
          "type": "text",
          "content": "How Plugin Images Are Used at Runtime"
        },
        {
          "type": "code",
          "content": "flowchart LR\n    subgraph Database\n        Plugin[Plugin Record<br/>name: eslint<br/>version: 1.0.0<br/>imageDigest: sha256:…<br/>commands: npx eslint .<br/>computeType: SMALL]\n    end\n\n    subgraph \"CDK Synth Time\"\n        CBS[CodeBuildStep<br/>Image: registry/org-acme/eslint@sha256:…<br/>ComputeType: BUILD_GENERAL1_SMALL<br/>BuildSpec: npx eslint .]\n    end\n\n    subgraph \"CodePipeline Runtime\"\n        CB2[CodeBuild pulls image<br/>Runs install + build commands<br/>In plugin container]\n    end\n\n    Plugin --> CBS --> CB2",
          "language": "mermaid"
        }
      ]
    },
    {
      "id": "key-components",
      "title": "Key Components",
      "blocks": [
        {
          "type": "table",
          "headers": [
            "Component",
            "Purpose",
            "Key Files"
          ],
          "rows": [
            [
              "Frontend",
              "Pipeline/plugin management UI",
              "frontend/pages/dashboard/"
            ],
            [
              "Platform API",
              "Sign-in and token issuance (ES256, published as JWKS), user/org management, audit",
              "platform/src/controllers/"
            ],
            [
              "Pipeline API",
              "Pipeline CRUD, compliance",
              "api/pipeline/src/"
            ],
            [
              "Plugin API",
              "Plugin upload, build queue, AI generation, the plugin ecosystem (publishers, publish requests, the Ecosystem console)",
              "api/plugin/src/, api/plugin/src/services/ecosystem/"
            ],
            [
              "Image Registry",
              "Registry bearer-token minting, image management/GC",
              "api/image-registry/src/"
            ],
            [
              "pipeline-core",
              "CDK constructs, plugin lookup",
              "packages/pipeline-core/src/pipeline/"
            ],
            [
              "pipeline-data",
              "DB schemas (Drizzle ORM)",
              "packages/pipeline-data/src/database/"
            ],
            [
              "pipeline-manager",
              "CLI for cdk synth/deploy",
              "packages/pipeline-manager/"
            ],
            [
              "buildkitd sidecar",
              "Rootless BuildKit daemon for plugin builds",
              "K8s native sidecar / ECS sidecar / compose service"
            ],
            [
              "Registry",
              "Docker image storage",
              "Docker Registry v2"
            ]
          ]
        }
      ]
    },
    {
      "id": "multi-team-isolation",
      "title": "Multi-Team Isolation",
      "blocks": [
        {
          "type": "code",
          "content": "flowchart TB\n    ROOT[Root Organization: acme-corp<br/>orgId: abc123]\n    ROOT --> PLUG[Plugins<br/>scoped by orgId + visibility]\n    ROOT --> PIPE[Pipelines<br/>scoped by project, org, orgId]\n    ROOT --> SEC[Secrets<br/>AWS SM: /prefix/abc123/secretName]\n    ROOT --> QUO[Quotas + seats<br/>pooled at the root org]\n    ROOT --> COMP[Compliance<br/>per-org policy rules]\n    ROOT --> TEAM[Team: acme-mobile<br/>orgId: def456, parentOrgId: abc123]\n    TEAM --> TMEM[Members + roles<br/>scoped to the team]",
          "language": "mermaid"
        },
        {
          "type": "text",
          "content": "Org → team hierarchy. A team is a nested Organization (a doc with parentOrgId set, sharing the same schema/collection). Resource scoping is per org/team by orgId — but seats, quotas, and billing pool at the root organization (a person on several teams counts as one seat; usage sums across the subtree). Roles (permission sets) and the derived per-org label are per org/team; a user's effective permissions are the union of their assigned Roles, resolved in whichever org/team is active. A root-org admin can administer its child teams via the hierarchy (canAdministerOrg), while super-admins span everything."
        }
      ]
    }
  ],
  "sourceDoc": "docs/architecture-flow.md"
};
