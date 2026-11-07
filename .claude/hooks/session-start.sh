#!/usr/bin/env bash
#
# Provision a checkout for NON-INTERACTIVE use.
#
# The Claude Code SessionStart hook (see .claude/settings.json). Copied in
# shape from `thomasfosterau/effect-ext`, the shared library standard.
#
# ## Vite+ first
#
# Every documented command here goes through `vp`. In the Vite+ devcontainer
# image the global launcher is put on PATH by `~/.bashrc` *below* Debian's
# interactive guard, so it is missing for every non-interactive shell (an
# agent's tool call), and on the remote/web runner there is no global
# launcher at all; this script cannot export into its caller. So Vite+
# (`vp`) is the one tool it guarantees, and everything else is reached
# through it. The global CLI is installed at exactly the `vite-plus` version pinned in
# `pnpm-workspace.yaml`'s catalog, using the official installer, which takes
# the release from the npm registry, refuses a package without npm provenance
# and checks its SHA-512 `dist.integrity`. It installs under
# `$VP_HOME` (else `~/.local/share/vite-plus`) and touches no shell profile, so `vp` and `vpx`
# are then linked into `~/.local/bin`, which is on PATH in this image (a
# symlink to the real binary survives where an `export` cannot). Where the
# harness offers `$CLAUDE_ENV_FILE`, `~/.local/bin` is also exported for the
# session, belt and braces.
#
# From there:
#
# - `vp install --frozen-lockfile` installs the dependencies.
# - The global `vp` delegates development commands to the project-local
#   `vite-plus`, including inside `.claude/worktrees/*`, so each checkout runs
#   its own pinned toolchain (and its own vitest, gardeneria #1663) without a
#   shim.
# - Project tools run through Vite+: `vp exec fallow …` for fallow (the commit
#   gate does the same), `vpx <file>.ts` for TypeScript scripts. Nothing else
#   is put on PATH: no shim walks a directory tree, and nothing runs a
#   `node_modules/.bin` the session did not install.
#
# Earlier versions of this hook wrote a `vp` shim that walked up from `$PWD`
# and a `fallow` re-exec shim (#219) into `~/.local/bin`, exported
# `node_modules/.bin` through `$CLAUDE_ENV_FILE`, and before that symlinked
# into `node_modules`; those are removed or replaced when found (only ones
# this hook made: a symlink into a `node_modules`, or a file carrying one of
# its `# generated-by:` markers).
#
# If the installer cannot run (no network to vite.plus / viteplus.dev, or the
# catalog pin cannot be read), `vp` falls back to a one-line re-exec of this
# project's own `node_modules/vite-plus/bin/vp`, and the hook says so.
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
# Untrusted-content note: the only value read from the repository is the
# `vite-plus` catalog version, and it is used only when it is a plain
# `MAJOR.MINOR.PATCH`. It takes no input from issue or PR bodies, or anything
# an agent could have been persuaded to write earlier in a session. Do not add
# other input without revisiting this note — it runs on every session start.

set -uo pipefail

log() { printf '[session-start] %s\n' "$1" >&2; }

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
LOCAL_BIN="${HOME:-/home/vp}/.local/bin"

mkdir -p "$LOCAL_BIN" 2>/dev/null || log "cannot create $LOCAL_BIN; continuing"

# The installer installs under `$VP_HOME` when it is set (the Vite+ dev
# container image sets VP_HOME=/home/vp/.vite-plus and ships the CLI there),
# else under `~/.local/share/vite-plus`. Look where it put it, or the pin check
# never matches and the hook reinstalls and falls back on every run.
VP_GLOBAL_BIN="${VP_HOME:-${HOME:-/home/vp}/.local/share/vite-plus}/bin"
# Matches every marker this hook has written (the old `vp` and `fallow`
# re-exec shims included) and the fallback shim below.
SHIM_MARKER="# generated-by: .claude/hooks/session-start.sh"

made_by_hook() {
  grep -qF "$SHIM_MARKER" "$1" 2>/dev/null
}

# Replace $dest with a symlink to $src unless $dest is a real file this hook
# did not make (something deliberately installed it).
link_to() {
  src="$1"
  dest="$2"
  if [ -e "$dest" ] && [ ! -L "$dest" ] && ! made_by_hook "$dest"; then
    return 0
  fi
  ln -sfn "$src" "$dest" 2>/dev/null || log "could not link $(basename "$dest")"
}

# Remove a PATH entry an earlier version of this hook created.
remove_old_link() {
  dest="$LOCAL_BIN/$1"
  if [ -L "$dest" ]; then
    case "$(readlink "$dest")" in
      */node_modules/*) rm -f "$dest" 2>/dev/null && log "removed old $1 link" ;;
    esac
  elif [ -f "$dest" ] && made_by_hook "$dest"; then
    rm -f "$dest" 2>/dev/null && log "removed old $1 shim"
  fi
}

# ── 1. Vite+ at the catalog pin ──────────────────────────────────────────────
VP_PIN="$(sed -nE 's/^  vite-plus: "?([0-9]+\.[0-9]+\.[0-9]+)"?$/\1/p' "$PROJECT_DIR/pnpm-workspace.yaml" 2>/dev/null | head -1)"
VP_HAVE="$("$VP_GLOBAL_BIN/vp" --version 2>/dev/null | sed -nE '1s/^vp v([0-9.]+).*$/\1/p')"
if [ -z "$VP_PIN" ]; then
  log "could not read the vite-plus catalog pin; not installing Vite+"
elif [ "$VP_HAVE" != "$VP_PIN" ]; then
  log "installing Vite+ $VP_PIN (have: ${VP_HAVE:-none})…"
  if command -v curl >/dev/null 2>&1 \
    && curl -fsSL https://vite.plus | VP_VERSION="$VP_PIN" bash >/dev/null 2>&1; then
    log "Vite+ $VP_PIN installed"
  else
    log "Vite+ installer failed (is vite.plus / viteplus.dev reachable?); continuing"
  fi
fi

remove_old_link fallow
remove_old_link tsx
if [ -x "$VP_GLOBAL_BIN/vp" ]; then
  link_to "$VP_GLOBAL_BIN/vp" "$LOCAL_BIN/vp"
  link_to "$VP_GLOBAL_BIN/vpx" "$LOCAL_BIN/vpx"
else
  # Fallback: the project's own pinned copy, by its fixed path.
  log "global Vite+ unavailable; \`vp\` runs $PROJECT_DIR's node_modules copy"
  for name in vp vpx; do
    dest="$LOCAL_BIN/$name"
    if [ -e "$dest" ] && [ ! -L "$dest" ] && ! made_by_hook "$dest"; then
      continue
    fi
    target="$PROJECT_DIR/node_modules/vite-plus/bin/$name"
    [ "$name" = vpx ] && target="$PROJECT_DIR/node_modules/.bin/vpx"
    printf '#!/usr/bin/env bash\n%s (%s fallback)\nexec "%s" "$@"\n' \
      "$SHIM_MARKER" "$name" "$target" >"$dest.tmp" \
      && chmod +x "$dest.tmp" && mv -f "$dest.tmp" "$dest" \
      || { rm -f "$dest.tmp" 2>/dev/null; log "could not write the $name fallback"; }
  done
fi

# Where the harness persists session environment (Claude Code on the web),
# put ~/.local/bin on PATH for every later tool call as well. Harmless where
# the variable is unset. The line is written once: the file outlives a
# resume, so appending on every run would stack copies of it (#230).
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  ENV_LINE="$(printf 'export PATH="%s:$PATH"' "$LOCAL_BIN")"
  if ! grep -qxF "$ENV_LINE" "$CLAUDE_ENV_FILE" 2>/dev/null; then
    printf '%s\n' "$ENV_LINE" >>"$CLAUDE_ENV_FILE" 2>/dev/null \
      || log "could not append to CLAUDE_ENV_FILE"
  fi
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
# as `trunk` breakage. `--frozen-lockfile` is a sub-second no-op when in sync.
# It is the same frozen install CI runs (.github/actions/setup), so a session
# sees exactly the tree CI will verify. `vp install` uses the `packageManager`
# pin.
if [ -f "$PROJECT_DIR/pnpm-lock.yaml" ]; then
  log "syncing dependencies against the lockfile…"
  # The fallback `vp` points into node_modules, which may not exist yet, so
  # only the global CLI installs; without it, pnpm does.
  if [ -x "$VP_GLOBAL_BIN/vp" ]; then
    (cd "$PROJECT_DIR" && "$VP_GLOBAL_BIN/vp" install --frozen-lockfile >/dev/null 2>&1) \
      || log "dependency install failed; continuing"
  elif command -v corepack >/dev/null 2>&1; then
    (cd "$PROJECT_DIR" && corepack pnpm install --frozen-lockfile >/dev/null 2>&1) \
      || log "dependency install failed; continuing"
  else
    (cd "$PROJECT_DIR" && pnpm install --frozen-lockfile >/dev/null 2>&1) \
      || log "dependency install failed; continuing"
  fi
fi

exit 0
