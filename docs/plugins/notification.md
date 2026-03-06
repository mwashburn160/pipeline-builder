# Notification Plugins

Pipeline status alerts and incident management integrations.

```mermaid
flowchart LR
    Pipeline[Pipeline Event] --> Type{Notification Type}
    Type -->|Chat| slack-notify
    Type -->|Chat| teams-notify
    Type -->|Chat| discord-notify
    Type -->|Incident| pagerduty-notify
    Type -->|Incident| opsgenie-notify
    Type -->|Email| email-notify
    Type -->|VCS| github-status
```

| Plugin | Service | Compute | Secrets | Key Env Vars |
|--------|---------|---------|---------|--------------|
| slack-notify | Slack | SMALL | `SLACK_WEBHOOK_URL` | `NOTIFICATION_TYPE`, `PIPELINE_NAME`, `PIPELINE_STATUS`, `MENTION_ON_FAILURE` |
| teams-notify | Microsoft Teams | SMALL | `TEAMS_WEBHOOK_URL` | `NOTIFICATION_TYPE`, `PIPELINE_NAME`, `PIPELINE_STATUS` |
| pagerduty-notify | PagerDuty | SMALL | `PAGERDUTY_ROUTING_KEY` | `NOTIFICATION_TYPE`, `PD_SEVERITY`, `PD_SOURCE` |
| opsgenie-notify | Opsgenie | SMALL | `OPSGENIE_API_KEY` | `NOTIFICATION_TYPE`, `OG_PRIORITY`, `OG_TEAM` |
| discord-notify | Discord | SMALL | `DISCORD_WEBHOOK_URL` | `NOTIFICATION_TYPE`, `PIPELINE_NAME`, `PIPELINE_STATUS` |
| email-notify | Email (SES/SMTP) | SMALL | `SMTP_PASSWORD` (optional) | `EMAIL_RECIPIENTS`, `EMAIL_SUBJECT`, `NOTIFICATION_TYPE`, `SES_REGION` |
| github-status | GitHub | SMALL | `GITHUB_TOKEN` | `GITHUB_OWNER`, `GITHUB_REPO`, `COMMIT_SHA`, `STATUS_CONTEXT` |
