# Rails Ruby Pipeline

**Repository:** [rails/rails](https://github.com/rails/rails)
**Language:** Ruby
**Build Tool:** Bundler / Rake

## Overview

A CI/CD pipeline for Ruby on Rails, the original convention-over-configuration web framework. Includes testing with SQLite, RuboCop linting, security scanning with Brakeman, and RubyGems publishing.

## Stages

| Stage | Plugins | Purpose |
|-------|---------|---------|
| **UnitTests** | `rails-test` | Run the test suite |
| **CodeQuality** | `rubocop` | Code style enforcement and static analysis |
| **SecurityScan** | `brakeman`, `bundler-audit`, `git-secrets` | Security scanning (SAST, dependencies, secrets) |

## Pipeline Flow

```
Source -> Synth -> UnitTests -> CodeQuality -> SecurityScan
```

## Key Configuration

- **Ruby 3.3** across all stages
- **Brakeman** for Rails-specific security analysis (SQL injection, XSS, mass assignment)
- **bundler-audit** for known CVEs in gem dependencies (advisory mode)
- **RuboCop** with parallel execution for faster linting
