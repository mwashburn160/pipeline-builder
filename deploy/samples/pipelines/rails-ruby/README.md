# Rails Ruby Pipeline

**Repository:** [rails/rails](https://github.com/rails/rails)
**Language:** Ruby
**Build Tool:** Bundler / Rake

## Overview

A CI/CD pipeline for Ruby on Rails, the original convention-over-configuration web framework. Includes testing with SQLite, RuboCop linting, security scanning with Brakeman, and RubyGems publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Test** | rails-test | Test suite with SQLite |
| **Lint** | rubocop | Ruby style enforcement |
| **Security** | brakeman, bundler-audit, git-secrets | Rails SAST, gem vulnerability scanning, secret detection |
| **Publish** | gem-publish | Publish gems to RubyGems.org |

## Pipeline Flow

```
Source (GitHub) → Synth → Test → Lint → Security → Publish
```

## Key Configuration

- **Ruby 3.3** across all stages
- **Brakeman** for Rails-specific security analysis (SQL injection, XSS, mass assignment)
- **bundler-audit** for known CVEs in gem dependencies (advisory mode)
- **RuboCop** with parallel execution for faster linting
