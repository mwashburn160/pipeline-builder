# security-baseline

A foundational security policy that bundles the most critical security rules. Every organization should adopt this policy as a starting point.

**Version:** 1.0.0
**Template:** yes (available for cloning)
**Tags:** `security`, `baseline`

## Included Rules

| Rule | Target | Severity | Purpose |
|------|--------|----------|---------|
| `block-latest-image-tag` | plugin | error | Prevent mutable image tags for reproducible builds |
| `restrict-public-access` | plugin | error | Require explicit review before making plugins public |
| `block-privileged-plugins` | plugin | error | Block plugins requesting elevated container privileges |

## When to Use

Apply this policy when:
- Onboarding a new organization
- Establishing minimum security standards
- Preparing for a security audit or compliance review

## Customization

After cloning, organizations can:
- Adjust severity levels (e.g. downgrade to `warning` during migration)
- Add org-specific security rules to the policy
- Set effective dates for phased rollout
