# Claude Code

What is specific to Claude Code in this repo. The general guidance is imported below: the agent conventions and gate order from `AGENTS.md`, setup and commands from `CONTRIBUTING.md`, and the project overview from `README.md`. Edit those files, not copies here.

## Hooks (`.claude/settings.json`)

- **SessionStart** (`.claude/hooks/session-start.sh`, on startup and resume) installs the global Vite+ CLI at the catalog's `vite-plus` pin with the official installer (npm-provenance and SHA-512 checked; it needs `vite.plus` and `viteplus.dev` on the environment's allowlist), links `vp` and `vpx` into `~/.local/bin` (the CLI lives under `$VP_HOME` when set, as in the Vite+ container image, else `~/.local/share/vite-plus`), writes that PATH line once to `$CLAUDE_ENV_FILE` where the harness offers it, and installs dependencies against the lockfile with `vp install --frozen-lockfile`. It removes the `fallow` shim and the walking `vp` shim earlier versions put there. Everything else goes through Vite+: `vp exec fallow …` for fallow, `vpx <file>.ts` for scripts; the global `vp` delegates to each checkout's own `vite-plus`, worktrees included. If the installer can't run, `vp` falls back to this checkout's `node_modules` copy. It hydrates no secrets; nothing here needs one. `.devcontainer/` reuses it to provision Codespaces.
- **PreToolUse** (`.claude/hooks/fallow-gate.sh`, on Bash) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` returns `fail` (the gate AGENTS.md's "Fallow local gate" describes). It reads the coverage map on disk and regenerates it (`vp run test:coverage`) only when it is missing, as in a fresh worktree, never when it is stale, so run `vp run test:coverage` after changing code. It runs only in this project and its `.claude/worktrees/<name>` checkouts (judged on the checkout's top level, so a commit from a subdirectory is still audited, and neither a repository nested inside a worktree nor a separate clone placed at a worktree path, which shares no git directory with this project, is trusted), with fallow as `vp exec fallow` (the checkout's own pinned copy); from any other tree it skips with a notice and runs none of that tree's tooling. `fallow hooks install --target agent --agent claude` regenerates this script without asking: re-apply the local deviations its header lists.
- **PostToolUse** (on Write / Edit / MultiEdit) runs `vp fmt --write` on each edited file.

## Plugins

`.claude/settings.json` enables the official `typescript-lsp`, `code-review`, `github`, `claude-md-management`, `commit-commands`, `pr-review-toolkit` and `code-simplifier` plugins. The `@enfect/claude` plugin (Effect guidance and post-write pattern checks) is meant to be enabled there too, pinned to a reviewed commit.

## Session notes

- Work in a worktree under `.claude/worktrees/<name>`, the only checkouts besides this one the fallow gate audits.
- This file is `.claude/CLAUDE.md`; there is no root `CLAUDE.md`. Don't let `fallow agent install` or `fallow hooks install` create one or append `@AGENTS.md` to this file: it already imports `AGENTS.md`, and fallow's generated block belongs in `AGENTS.md`.
- In a Claude Code on the web session, `gh` reaches GitHub's REST API only (no GraphQL), so `gh pr create` fails; open PRs with `gh api repos/thomasfosterau/effect-wikimedia/pulls -X POST`.

@../AGENTS.md

@../CONTRIBUTING.md

@../README.md
