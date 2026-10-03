#!/usr/bin/env bash
#
# Provision a checkout for NON-INTERACTIVE use.
#
# The Claude Code SessionStart hook (see .claude/settings.json). Copied in
# shape from `thomasfosterau/effect-drizzle-ext`, the shared library standard,
# minus the tools this single-package repo does not carry (fallow, tsx).
#
# ## The problem it solves
#
# Every documented command here goes through `vp` (`vp check`, `vp run test`,
# `vp run build`), and `vp` is a devDependency: it exists only in
# `node_modules/.bin`, which is on nobody's PATH, and only after an install.
# In the Vite+ devcontainer image the global launcher is put on PATH by
# `~/.bashrc` *below* Debian's interactive guard, so it is correct for a human
# at a prompt and missing for every non-interactive shell, which is what an
# agent's tool call is. On the remote/web runner there is no global launcher
# at all.
#
# Rather than fight PATH — which this script cannot export into its caller —
# it links the tools into `~/.local/bin`, a directory already on PATH in both
# environments and writable by the session user. A symlink survives where an
# `export` cannot. Where the harness offers `$CLAUDE_ENV_FILE`, the same
# directories are also exported for the session, belt and braces.
#
# ## Node, and why this repairs rather than clobbers
#
# In the Vite+ image `~/.vite-plus/bin/node` is a shim pointing at the `vp`
# launcher, which resolves a Node version and installs it under
# `~/.vite-plus/js_runtime`. That directory is `root:root` from image build
# while the session user is `vp`, so when the resolved version drifts past the
# cached one the shim fails (`vp: Failed to install Node …: Permission
# denied`). Anything routed through `vp` still works; bare `node` does not.
# This script therefore *tests* `node --version` and only replaces the shim
# when it is already broken, pointing it at a real cached binary. A working
# shim (or a real `node`, as on the remote runner) is left alone.
#
# ## Secrets
#
# This hook hydrates NO secrets. Nothing in this repo needs any: the tests
# run against recorded fixtures with the network stubbed, and publishing is
# done by the Release workflow via OIDC.
#
# ## Contract
#
# Idempotent, and never fatal. Every failure path logs and continues, because
# the SessionStart hook must not block a session and a half-provisioned
# checkout is more useful than a session that refused to start. Callers that
# want hard failure should check the tools themselves afterwards.
#
# Untrusted-content note: this script reads only fixed, hardcoded paths. It
# takes no input from repo content, issue or PR bodies, or anything an agent
# could have been persuaded to write earlier in a session. Do not add such
# input without revisiting this note — it runs on every session start.

set -uo pipefail

log() { printf '[session-start] %s\n' "$1" >&2; }

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LOCAL_BIN="${HOME:-/home/vp}/.local/bin"

mkdir -p "$LOCAL_BIN" 2>/dev/null || log "cannot create $LOCAL_BIN; continuing"

# `vp` gets a re-exec shim rather than a plain symlink. A symlink always
# resolves to $PROJECT_DIR's node_modules/vite-plus, even when invoked with
# cwd inside a `.claude/worktrees/*` checkout — so the CLI process loads the
# primary tree's vitest while the worktree's test modules resolve the
# worktree's own copy. Two physical instances of the same vitest version
# corrupt its module-level suite-collector state, and every describe() in the
# worktree throws `Cannot read properties of undefined (reading 'config')`
# (gardeneria #1663). The shim instead walks up from $PWD for the nearest
# project-local vite-plus and re-execs that, falling back to the primary
# checkout's when none is found above cwd.
VP_SHIM_MARKER="# generated-by: .claude/hooks/session-start.sh (vp re-exec shim, gardeneria issue #1663)"
write_vp_shim() {
  dest="$LOCAL_BIN/vp"
  # Leave a real, non-generated file alone: something deliberately installed
  # it. A stale symlink or a shim we generated earlier is fair game to
  # regenerate — the embedded fallback path can change across containers.
  if [ -e "$dest" ] && [ ! -L "$dest" ] \
    && ! grep -qF "$VP_SHIM_MARKER" "$dest" 2>/dev/null; then
    return 0
  fi
  cat >"$dest.tmp" <<SHIM
#!/usr/bin/env bash
$VP_SHIM_MARKER
dir="\$PWD"
while [ -n "\$dir" ]; do
  if [ -x "\$dir/node_modules/vite-plus/bin/vp" ]; then
    exec "\$dir/node_modules/vite-plus/bin/vp" "\$@"
  fi
  [ "\$dir" = "/" ] && break
  dir="\$(dirname "\$dir")"
done
exec "$PROJECT_DIR/node_modules/vite-plus/bin/vp" "\$@"
SHIM
  chmod +x "$dest.tmp" 2>/dev/null && mv -f "$dest.tmp" "$dest" 2>/dev/null \
    || { rm -f "$dest.tmp" 2>/dev/null; log "could not write vp shim"; }
}

# ── 1. `vp` for the non-interactive shell ────────────────────────────────────
write_vp_shim

# Where the harness persists session environment (Claude Code on the web),
# put the shim directory and the repo's own bins on PATH for every later tool
# call as well. Harmless where the variable is unset.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  printf 'export PATH="%s:%s/node_modules/.bin:$PATH"\n' "$LOCAL_BIN" "$PROJECT_DIR" >>"$CLAUDE_ENV_FILE" 2>/dev/null \
    || log "could not append to CLAUDE_ENV_FILE"
fi

# ── 2. Bare `node` (gardeneria #1462) ────────────────────────────────────────
# Only repair a shim that is already failing — see the header for why this is
# conditional. `command -v node` is not enough: the shim exists and resolves,
# then dies on use, so the version call is the real test.
if ! node --version >/dev/null 2>&1; then
  VP_BIN_DIR="${VP_HOME:-${HOME:-/home/vp}/.vite-plus}/bin"
  # Newest cached runtime wins; `sort -V` so 24.9 does not beat 24.18.
  REAL_NODE="$(
    find "${VP_HOME:-${HOME:-/home/vp}/.vite-plus}/js_runtime/node" \
      -maxdepth 3 -type f -name node -perm -u+x 2>/dev/null | sort -V | tail -1
  )"
  if [ -n "$REAL_NODE" ]; then
    log "bare \`node\` is broken; pointing it at $REAL_NODE"
    # The shim lives in a vp-owned directory even though the runtime cache
    # beneath it is root-owned, so this needs no privileges.
    ln -sfn "$REAL_NODE" "$VP_BIN_DIR/node" 2>/dev/null \
      || ln -sfn "$REAL_NODE" "$LOCAL_BIN/node" 2>/dev/null \
      || log "could not link node"
  else
    log "bare \`node\` is broken and no cached runtime was found; \`vp\`-routed commands still work"
  fi
fi

# ── 3. Dependencies ──────────────────────────────────────────────────────────
# Unconditional, not only when node_modules is absent: a prebaked container can
# carry a tree built from an OLDER lockfile, and stale dependencies masquerade
# as `trunk` breakage. `--frozen-lockfile` is a sub-second no-op when in sync, and
# it is the same install CI runs (.github/actions/setup), so a session sees
# exactly the tree CI will verify.
if [ -f "$PROJECT_DIR/pnpm-lock.yaml" ]; then
  log "syncing dependencies against the lockfile…"
  (cd "$PROJECT_DIR" && vp install --frozen-lockfile >/dev/null 2>&1) \
    || (cd "$PROJECT_DIR" && pnpm install --frozen-lockfile >/dev/null 2>&1) \
    || (cd "$PROJECT_DIR" && corepack pnpm install --frozen-lockfile >/dev/null 2>&1) \
    || log "dependency install failed; continuing"
  # node_modules/vite-plus only exists after the install, so re-run the shim
  # write in case the first pass found nothing to point at.
  write_vp_shim
fi

exit 0
