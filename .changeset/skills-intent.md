---
'@adonis-agora/authz': patch
'@adonis-agora/authz-react': patch
---

Ship TanStack Intent AI-agent skills with both packages: six SKILL.md files
(`packages/core/skills/authz-*`, `packages/react/skills/authz-react-ui`) plus
repo-level `_artifacts/` (domain map, skill spec, skill tree), validated by
`intent validate` and a new `.github/workflows/check-skills.yml`. Skills are
published via the new `skills/` entry in each package's `files` array.
