# Claude Code

Read README.md, docs/CONTRIBUTING.md and AGENTS.md (imported below). This file covers only Claude Code specifics.

- **Hooks** (`.claude/settings.json`): PostToolUse runs `vp fmt --write` on each edited file. The fallow gate is a git pre-commit hook (see docs/CONTRIBUTING.md).
- **Worktrees** go under `.claude/worktrees/`, one per branch; run `vp install` in each.
- In a cloud session `gh` may reach only GitHub's REST API; open PRs with `gh api repos/thomasfosterau/effect-wikimedia/pulls -X POST` if `gh pr create` fails.

@../README.md

@../docs/CONTRIBUTING.md

@../AGENTS.md
