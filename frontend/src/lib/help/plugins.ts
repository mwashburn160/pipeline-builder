import { Puzzle } from 'lucide-react';
import type { HelpTopic } from './types';

/** Plugin catalog entry for the searchable table. */
export interface PluginEntry {
  name: string;
  category: string;
  description: string;
  secrets: string[];
}

export const PLUGIN_CATEGORIES = [
  'Language',
  'Security',
  'Quality',
  'Monitoring',
  'Artifact & Registry',
  'Deploy',
  'Infrastructure',
  'Testing',
  'Notification',
  'AI',
] as const;

export const PLUGIN_CATALOG: PluginEntry[] = [
  // Language (12)
  { name: 'python', category: 'Language', description: 'Build, test, and package Python projects', secrets: [] },
  { name: 'nodejs', category: 'Language', description: 'Build, test, and package Node.js projects', secrets: [] },
  { name: 'java', category: 'Language', description: 'Build, test, and package Java projects (Maven/Gradle)', secrets: [] },
  { name: 'go', category: 'Language', description: 'Build, test, and lint Go projects', secrets: [] },
  { name: 'dotnet', category: 'Language', description: 'Build, test, and package .NET projects', secrets: [] },
  { name: 'rust', category: 'Language', description: 'Build, test, and package Rust projects', secrets: [] },
  { name: 'ruby', category: 'Language', description: 'Build, test, and package Ruby projects', secrets: [] },
  { name: 'cpp', category: 'Language', description: 'Build and test C/C++ projects', secrets: [] },
  { name: 'php', category: 'Language', description: 'Build, test, and package PHP projects', secrets: [] },
  { name: 'swift', category: 'Language', description: 'Build and test Swift projects', secrets: [] },
  { name: 'kotlin', category: 'Language', description: 'Build, test, and package Kotlin projects', secrets: [] },
  { name: 'scala', category: 'Language', description: 'Build, test, and package Scala projects (sbt)', secrets: [] },
  // Security (14)
  { name: 'snyk', category: 'Security', description: 'Vulnerability scanning for dependencies and code', secrets: ['SNYK_TOKEN'] },
  { name: 'sonarcloud', category: 'Security', description: 'Static analysis and code quality scanning', secrets: ['SONAR_TOKEN'] },
  { name: 'dependency-check', category: 'Security', description: 'OWASP dependency vulnerability detection', secrets: ['NVD_API_KEY (optional)'] },
  { name: 'owasp-zap', category: 'Security', description: 'Dynamic application security testing (DAST)', secrets: [] },
  { name: 'veracode', category: 'Security', description: 'Application security platform scan', secrets: ['VERACODE_API_ID', 'VERACODE_API_KEY'] },
  { name: 'checkmarx', category: 'Security', description: 'SAST and SCA scanning', secrets: ['CX_CLIENT_SECRET'] },
  { name: 'prisma-cloud', category: 'Security', description: 'Cloud-native security scanning', secrets: ['PRISMA_ACCESS_KEY', 'PRISMA_SECRET_KEY'] },
  { name: 'mend', category: 'Security', description: 'Open source security and license compliance', secrets: ['MEND_API_KEY', 'MEND_ORG_TOKEN'] },
  { name: 'gitguardian', category: 'Security', description: 'Secret detection and code security', secrets: ['GITGUARDIAN_API_KEY'] },
  { name: 'fortify', category: 'Security', description: 'Fortify on Demand / SSC SAST scanning', secrets: ['FOD_CLIENT_ID', 'FOD_CLIENT_SECRET'] },
  { name: 'trivy', category: 'Security', description: 'Container and filesystem vulnerability scanning', secrets: [] },
  { name: 'docker-lint', category: 'Security', description: 'Dockerfile best practice linting', secrets: [] },
  { name: 'license-checker', category: 'Security', description: 'License compliance checking', secrets: [] },
  { name: 'git-secrets', category: 'Security', description: 'Prevent committing secrets to Git', secrets: [] },
  // Quality (9)
  { name: 'eslint', category: 'Quality', description: 'JavaScript/TypeScript linting', secrets: [] },
  { name: 'prettier', category: 'Quality', description: 'Code formatting checker', secrets: [] },
  { name: 'checkstyle', category: 'Quality', description: 'Java code style checking', secrets: [] },
  { name: 'shellcheck', category: 'Quality', description: 'Shell script static analysis', secrets: [] },
  { name: 'codecov', category: 'Quality', description: 'Code coverage reporting', secrets: ['CODECOV_TOKEN'] },
  { name: 'coveralls', category: 'Quality', description: 'Code coverage tracking', secrets: ['COVERALLS_REPO_TOKEN'] },
  { name: 'codacy', category: 'Quality', description: 'Automated code review and coverage', secrets: ['CODACY_PROJECT_TOKEN'] },
  { name: 'codeclimate', category: 'Quality', description: 'Code quality and test coverage', secrets: ['CC_TEST_REPORTER_ID'] },
  { name: 'coverage-report', category: 'Quality', description: 'Generic coverage report generation', secrets: [] },
  // Monitoring (3)
  { name: 'datadog', category: 'Monitoring', description: 'APM and monitoring integration', secrets: ['DD_API_KEY'] },
  { name: 'newrelic', category: 'Monitoring', description: 'Observability and APM integration', secrets: ['NEW_RELIC_API_KEY'] },
  { name: 'sentry-release', category: 'Monitoring', description: 'Release tracking and error monitoring', secrets: ['SENTRY_AUTH_TOKEN'] },
  // Artifact & Registry (11)
  { name: 'docker-build', category: 'Artifact & Registry', description: 'Build Docker images', secrets: ['DOCKER_USERNAME', 'DOCKER_PASSWORD'] },
  { name: 'ghcr-push', category: 'Artifact & Registry', description: 'Push images to GitHub Container Registry', secrets: ['GITHUB_TOKEN'] },
  { name: 'gar-push', category: 'Artifact & Registry', description: 'Push images to Google Artifact Registry', secrets: ['GOOGLE_APPLICATION_CREDENTIALS'] },
  { name: 'acr-push', category: 'Artifact & Registry', description: 'Push images to Azure Container Registry', secrets: ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID'] },
  { name: 'jfrog-push', category: 'Artifact & Registry', description: 'Push artifacts to JFrog Artifactory', secrets: ['JFROG_TOKEN'] },
  { name: 'npm-publish', category: 'Artifact & Registry', description: 'Publish packages to npm', secrets: ['NPM_TOKEN'] },
  { name: 'pypi-publish', category: 'Artifact & Registry', description: 'Publish packages to PyPI', secrets: ['TWINE_USERNAME', 'TWINE_PASSWORD'] },
  { name: 'maven-publish', category: 'Artifact & Registry', description: 'Publish to Maven Central', secrets: ['OSSRH_USERNAME', 'OSSRH_PASSWORD', 'GPG_PASSPHRASE'] },
  { name: 'nuget-publish', category: 'Artifact & Registry', description: 'Publish to NuGet Gallery', secrets: ['NUGET_API_KEY'] },
  { name: 'cargo-publish', category: 'Artifact & Registry', description: 'Publish crates to crates.io', secrets: ['CARGO_REGISTRY_TOKEN'] },
  { name: 'gem-publish', category: 'Artifact & Registry', description: 'Publish gems to RubyGems', secrets: ['GEM_HOST_API_KEY'] },
  // Deploy (9)
  { name: 'terraform', category: 'Deploy', description: 'Terraform plan and apply', secrets: [] },
  { name: 'cloudformation', category: 'Deploy', description: 'CloudFormation stack deployment', secrets: [] },
  { name: 'cdk-deploy', category: 'Deploy', description: 'AWS CDK deployment', secrets: [] },
  { name: 'cdk-deploy-multi-region', category: 'Deploy', description: 'Multi-region CDK deployment', secrets: [] },
  { name: 'gcloud-deploy', category: 'Deploy', description: 'Google Cloud deployment', secrets: ['GOOGLE_APPLICATION_CREDENTIALS'] },
  { name: 'azure-deploy', category: 'Deploy', description: 'Azure deployment', secrets: ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID'] },
  { name: 'kubectl-deploy', category: 'Deploy', description: 'Kubernetes deployment via kubectl', secrets: ['KUBECONFIG'] },
  { name: 'helm-deploy', category: 'Deploy', description: 'Kubernetes deployment via Helm', secrets: ['KUBECONFIG'] },
  { name: 'flyway', category: 'Deploy', description: 'Database migration with Flyway', secrets: ['FLYWAY_URL', 'FLYWAY_USER', 'FLYWAY_PASSWORD'] },
  { name: 'liquibase', category: 'Deploy', description: 'Database migration with Liquibase', secrets: ['LIQUIBASE_COMMAND_URL', 'LIQUIBASE_COMMAND_USERNAME', 'LIQUIBASE_COMMAND_PASSWORD'] },
  { name: 'fastlane', category: 'Deploy', description: 'iOS/Android mobile builds and distribution', secrets: ['APPLE_ID', 'APP_STORE_CONNECT_API_KEY'] },
  // Infrastructure (5)
  { name: 'cdk-synth', category: 'Infrastructure', description: 'AWS CDK synthesis step', secrets: [] },
  { name: 'approval-gate', category: 'Infrastructure', description: 'Manual approval gate for pipelines', secrets: [] },
  { name: 'cache-step', category: 'Infrastructure', description: 'S3-based caching for build artifacts', secrets: [] },
  { name: 'pipeline-trigger', category: 'Infrastructure', description: 'Trigger downstream pipelines', secrets: [] },
  { name: 'cdk-synth-multi-region', category: 'Infrastructure', description: 'Multi-region CDK synthesis', secrets: [] },
  // Testing (3)
  { name: 'postman', category: 'Testing', description: 'API contract testing with Newman/Postman', secrets: [] },
  { name: 'k6', category: 'Testing', description: 'Load and performance testing', secrets: [] },
  { name: 'health-check', category: 'Testing', description: 'HTTP endpoint smoke testing', secrets: [] },
  // Notification (5)
  { name: 'slack-notify', category: 'Notification', description: 'Pipeline status alerts to Slack', secrets: ['SLACK_WEBHOOK_URL'] },
  { name: 'teams-notify', category: 'Notification', description: 'Pipeline status alerts to Microsoft Teams', secrets: ['TEAMS_WEBHOOK_URL'] },
  { name: 'pagerduty-notify', category: 'Notification', description: 'Pipeline failure alerts to PagerDuty', secrets: ['PAGERDUTY_ROUTING_KEY'] },
  { name: 'opsgenie-notify', category: 'Notification', description: 'Pipeline failure alerts to Opsgenie', secrets: ['OPSGENIE_API_KEY'] },
  { name: 'discord-notify', category: 'Notification', description: 'Pipeline status alerts to Discord', secrets: ['DISCORD_WEBHOOK_URL'] },
  // AI (2)
  { name: 'dockerfile-generator', category: 'AI', description: 'AI-powered Dockerfile generation (local Ollama)', secrets: [] },
  { name: 'dockerfile-multi-provider', category: 'AI', description: 'AI-powered Dockerfile generation (cloud providers)', secrets: ['AI_API_KEY'] },
];

export const pluginsTopic: HelpTopic = {
  id: 'plugins',
  title: 'Plugins',
  description: 'Plugin catalog, categories, secrets, and structure',
  icon: Puzzle,
  sections: [
    {
      id: 'what-are-plugins',
      title: 'What Are Plugins?',
      blocks: [
        {
          type: 'text',
          content:
            'Plugins are reusable build step definitions — a Dockerfile and manifest.yaml packaged as a ZIP. Create them once, reference them across pipelines. Every plugin runs as an isolated container step inside AWS CodePipeline.',
        },
      ],
    },
    {
      id: 'categories',
      title: 'Plugin Categories',
      blocks: [
        {
          type: 'text',
          content: 'Pipeline Builder ships with 73 plugins across 10 categories covering the full CI/CD lifecycle:',
        },
        {
          type: 'table',
          headers: ['Category', 'Count', 'Description'],
          rows: [
            ['Language', '12', 'Build, test, and compile across major languages'],
            ['Security', '14', 'SAST, DAST, SCA, secret detection, container scanning'],
            ['Quality', '9', 'Linting, formatting, code coverage reporting'],
            ['Monitoring', '3', 'APM, observability, release tracking'],
            ['Artifact & Registry', '11', 'Package publishing and container image push'],
            ['Deploy', '11', 'Cloud provisioning, K8s, database migration, mobile builds'],
            ['Infrastructure', '5', 'AWS CDK synth/deploy, pipeline utilities'],
            ['Testing', '3', 'API contract, load/performance, and smoke testing'],
            ['Notification', '5', 'Pipeline status alerts (Slack, Teams, PagerDuty, etc.)'],
            ['AI', '2', 'AI-powered Dockerfile generation'],
          ],
        },
      ],
    },
    {
      id: 'plugin-catalog',
      title: 'Plugin Catalog',
      blocks: [
        {
          type: 'text',
          content: 'Use the searchable catalog below to find plugins by name or category. Plugins with required secrets are shown with their secret names.',
        },
      ],
    },
    {
      id: 'create-plugins',
      title: 'Creating Plugins',
      blocks: [
        {
          type: 'text',
          content: 'You can create plugins in several ways:',
        },
        {
          type: 'list',
          items: [
            'Dashboard — Use the Plugins page and click "Create Plugin". The AI Builder tab lets you describe your plugin in plain language.',
            'CLI — Upload a plugin ZIP: pipeline-manager upload-plugin --file ./my-plugin.zip --organization my-org --name my-plugin --version 1.0.0',
            'REST API — POST /api/plugins with a multipart form containing the plugin ZIP.',
          ],
        },
      ],
    },
    {
      id: 'plugin-structure',
      title: 'Plugin Structure',
      blocks: [
        {
          type: 'text',
          content: 'Every plugin follows the same three-file layout:',
        },
        {
          type: 'list',
          items: [
            'Dockerfile — Defines the build environment.',
            'manifest.yaml — Declares metadata, commands, secrets, and environment variables.',
            'plugin.zip — Packages both files for upload.',
          ],
        },
        {
          type: 'code',
          language: 'yaml',
          content: `name: my-plugin
description: My custom build plugin
version: 1.0.0
pluginType: CodeBuildStep
computeType: SMALL
timeout: 15
failureBehavior: fail
secrets:
  - name: MY_TOKEN
    required: true
    description: "API token for the service"
primaryOutputDirectory: output-dir
dockerfile: Dockerfile
installCommands:
  - npm ci
commands:
  - npm run build
env:
  NODE_ENV: production`,
        },
      ],
    },
    {
      id: 'manifest-fields',
      title: 'Manifest Fields',
      blocks: [
        {
          type: 'table',
          headers: ['Field', 'Description'],
          rows: [
            ['name', 'Unique plugin identifier used in pipeline definitions'],
            ['description', 'Human-readable summary shown in the plugin catalog'],
            ['version', 'Semantic version of the plugin'],
            ['pluginType', 'Must be CodeBuildStep (the only supported type)'],
            ['computeType', 'CodeBuild instance size: SMALL (3 GB / 2 vCPU), MEDIUM (7 GB / 4 vCPU), or LARGE (15 GB / 8 vCPU)'],
            ['timeout', 'Maximum execution time in minutes'],
            ['failureBehavior', 'What happens on failure: fail, warn, or ignore'],
            ['secrets', 'List of required secrets with name, required (boolean), and description'],
            ['primaryOutputDirectory', 'Directory where build artifacts are written'],
            ['installCommands', 'Commands run during the install phase'],
            ['commands', 'Commands run during the build phase'],
            ['env', 'Default environment variables (non-secret values only)'],
          ],
        },
      ],
    },
    {
      id: 'secrets',
      title: 'How Secrets Work',
      blocks: [
        {
          type: 'text',
          content:
            'Plugin secrets are resolved at pipeline synth time through AWS Secrets Manager. Each organization stores secrets in their own AWS account using a naming convention:',
        },
        {
          type: 'code',
          language: 'text',
          content: 'pipeline-builder/{orgId}/{secretName}',
        },
        {
          type: 'list',
          items: [
            'Check which secrets a plugin requires — look at the secrets field in the manifest or the catalog above.',
            'Create secrets in AWS Secrets Manager: aws secretsmanager create-secret --name "pipeline-builder/my-org/SNYK_TOKEN" --secret-string "your-token"',
            'Deploy your pipeline — the builder automatically injects each declared secret as a SECRETS_MANAGER-type environment variable.',
          ],
        },
        {
          type: 'note',
          content:
            'Secrets are scoped by organization ID, so different orgs manage their own tokens independently and secrets never cross organizational boundaries.',
        },
      ],
    },
  ],
};
