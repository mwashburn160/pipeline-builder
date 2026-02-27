# Rails Ruby Pipeline

**Repository:** [rails/rails](https://github.com/rails/rails)
**Language:** Ruby
**Build Tool:** Bundler / Rake

## Overview

A full-featured CI/CD pipeline for Ruby on Rails, the original convention-over-configuration web framework. Features multi-database testing (SQLite, PostgreSQL, MySQL), security scanning with Brakeman, and RubyGems publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **Lint** | rubocop, erb-lint | Ruby style enforcement and ERB template linting |
| **Test-SQLite** | rails-test, minitest-coverage | Fast test suite with SQLite and coverage reporting |
| **Test-PostgreSQL** | rails-test (pg), rails-test (mysql) | Multi-database compatibility testing |
| **Security** | brakeman, bundler-audit, git-secrets | Rails SAST, gem vulnerability scanning, secret detection |
| **Publish** | gem-build, gem-push | Build and publish gems to RubyGems.org |

## Pipeline Flow

```
Source (GitHub) → Synth → Lint → Test-SQLite → Test-PostgreSQL → Security → Publish
```

## Key Configuration

- **Ruby 3.3** across all stages
- **Multi-database testing** against SQLite (fast), PostgreSQL (production), and MySQL (compat)
- **MEDIUM compute** for PostgreSQL test stage due to database overhead
- **Brakeman** for Rails-specific security analysis (SQL injection, XSS, mass assignment)
- **bundler-audit** for known CVEs in gem dependencies
- **RuboCop** with parallel execution for faster linting
- **MySQL testing** runs with `warn` failure behavior (secondary database)
