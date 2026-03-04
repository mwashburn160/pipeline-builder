import { Server } from 'lucide-react';
import type { HelpTopic } from './types';

export const deploymentTopic: HelpTopic = {
  id: 'deployment',
  title: 'Deployment',
  description: 'Local, Minikube, and AWS deployment guides',
  icon: Server,
  sections: [
    {
      id: 'local',
      title: 'Local Development (Docker Compose)',
      blocks: [
        {
          type: 'code',
          language: 'bash',
          content: `cd deploy/local && chmod +x bin/startup.sh && ./bin/startup.sh`,
        },
        {
          type: 'text',
          content: 'This generates TLS certs, creates volumes, and starts all services. Open https://localhost:8443 to access the dashboard.',
        },
        {
          type: 'code',
          language: 'bash',
          content: `# Shut down
./bin/shutdown.sh`,
        },
      ],
    },
    {
      id: 'local-services',
      title: 'Local Services',
      blocks: [
        {
          type: 'table',
          headers: ['Service', 'URL', 'Description'],
          rows: [
            ['Dashboard', 'https://localhost:8443', 'Next.js frontend'],
            ['API Gateway', 'https://localhost:8443/api/*', 'Nginx reverse proxy'],
            ['PgAdmin', 'http://localhost:5480', 'PostgreSQL admin UI'],
            ['Mongo Express', 'http://localhost:27081', 'MongoDB admin UI'],
            ['Grafana', 'http://localhost:3200', 'Observability dashboards'],
            ['Registry UI', 'http://localhost:5080', 'Docker registry browser'],
          ],
        },
      ],
    },
    {
      id: 'local-env',
      title: 'Key Environment Variables',
      blocks: [
        {
          type: 'text',
          content: 'Set in deploy/local/.env before first run:',
        },
        {
          type: 'table',
          headers: ['Variable', 'Description', 'Default'],
          rows: [
            ['JWT_SECRET', 'Required — 32+ char base64 secret', '—'],
            ['POSTGRES_PASSWORD', 'PostgreSQL password', 'password'],
            ['MONGO_INITDB_ROOT_PASSWORD', 'MongoDB password', 'password'],
            ['LOG_LEVEL', 'Logging verbosity', 'info'],
            ['QUOTA_DEFAULT_PLUGINS', 'Plugin quota per org', '100'],
            ['QUOTA_DEFAULT_PIPELINES', 'Pipeline quota per org', '10'],
            ['BILLING_PROVIDER', 'stub (local) or aws-marketplace (prod)', 'stub'],
          ],
        },
        {
          type: 'note',
          content: 'Databases initialize automatically on first startup — no manual migrations required.',
        },
      ],
    },
    {
      id: 'api-routing',
      title: 'API Routing (NGINX)',
      blocks: [
        {
          type: 'table',
          headers: ['Path', 'Service'],
          rows: [
            ['/api/pipeline/*', 'Pipeline service'],
            ['/api/plugin/*', 'Plugin service'],
            ['/api/quota/*', 'Quota service'],
            ['/api/billing/*', 'Billing service'],
            ['/api/messages/*', 'Message service'],
            ['/auth/*, /users/*, /organizations/*', 'Platform service'],
          ],
        },
      ],
    },
    {
      id: 'minikube',
      title: 'Minikube',
      blocks: [
        {
          type: 'text',
          content: 'Deploy to a local Kubernetes cluster with all services, databases, and observability (Prometheus, Loki, Grafana):',
        },
        {
          type: 'code',
          language: 'bash',
          content: 'kubectl apply -k deploy/minikube/k8s/',
        },
      ],
    },
    {
      id: 'aws',
      title: 'AWS Deployment',
      blocks: [
        {
          type: 'text',
          content: 'Two production-ready AWS deployment options are available, both with Let\'s Encrypt TLS:',
        },
        {
          type: 'table',
          headers: ['Option', 'Description', 'Best for'],
          rows: [
            ['EC2 (Minikube)', 'Single hardened EC2 instance running Minikube', 'Dev/staging, small teams, cost-focused'],
            ['Fargate', 'Serverless containers on ECS Fargate with ALB', 'Production, high availability, scaling'],
          ],
        },
        {
          type: 'code',
          language: 'bash',
          content: `# EC2: Single CloudFormation stack
cd deploy/aws/ec2
aws cloudformation deploy --stack-name pipeline-builder --template-file template.yaml \\
  --parameter-overrides DomainName=pipeline.example.com HostedZoneId=Z123 KeyPairName=my-key GhcrToken=ghp_xxx \\
  --capabilities CAPABILITY_IAM

# Fargate: 6 CloudFormation stacks
cd deploy/aws/fargate
bash bin/deploy.sh --domain pipeline.example.com --hosted-zone-id Z123 --ghcr-token ghp_xxx`,
        },
      ],
    },
  ],
};
