# quality-standards

A policy that ensures plugins meet minimum quality and documentation standards before publication. Promotes discoverability and maintainability across the plugin catalog.

**Version:** 1.0.0
**Template:** yes (available for cloning)
**Tags:** `quality`, `documentation`, `versioning`

## Included Rules

| Rule | Target | Severity | Purpose |
|------|--------|----------|---------|
| `require-plugin-description` | plugin | warning | Ensure every plugin has a meaningful description |
| `require-plugin-version-semver` | plugin | error | Enforce semantic versioning (MAJOR.MINOR.PATCH) |
| `require-plugin-keywords` | plugin | warning | Require searchable keywords for catalog discoverability |

## When to Use

Apply this policy when:
- Building a shared plugin catalog across teams
- Establishing publishing standards for an internal marketplace
- Improving plugin discoverability and documentation coverage

## Customization

After cloning, organizations can:
- Promote description/keyword warnings to errors for stricter enforcement
- Add additional metadata rules (e.g. require author, license, homepage)
- Set minimum description length thresholds
