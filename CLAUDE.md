# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository contains a macOS sandbox solution to launch applications in a protected environment. The home directory is locked down – only the explicitly provided working directory is accessible. Supports VSCode, terminal shells, Claude Code CLI, and arbitrary commands.

## Files

- **`src/index.ts`** — Main source (TypeScript). Scans `$HOME`, generates a sandbox profile dynamically, and launches the target application inside `sandbox-exec`.
- **`src/config.ts`** — App configuration: TOML config loading, built-in app definitions, auto-discovery via `mdfind`.
- **`src/args.ts`** — CLI argument parsing with dynamic mode validation.
- **`src/modes.ts`** — Command building for all modes (shell builtins + configured apps).
- **`bxconfig.example.toml`** — Example config with all built-in apps and common extras.
- **`rolldown.config.ts`** — Rolldown bundler config. Builds `dist/bx.js` (ESM, Node shebang).
- **`dist/bx.js`** — Built CLI entry point (generated, not committed).

## Build

```bash
pnpm install
pnpm build        # rolldown → dist/bx.js
pnpm link -g      # install "bx" command globally
```

## Usage

```bash
bx [workdir]                                # VSCode (default mode)
bx code [workdir]                           # VSCode (explicit)
bx xcode [workdir] [-- project-or-workspace] # Xcode
bx term [workdir]                           # sandboxed login shell
bx claude [workdir]                         # Claude Code CLI
bx exec [workdir] -- command [args...]      # arbitrary command

# Custom apps from ~/.bxconfig.toml become modes automatically:
bx cursor [workdir] [-- app-args...]       # if configured
bx zed [workdir]                            # if configured

# Options (work with all modes)
bx --dry ~/work/my-project                  # show what will be protected
bx --verbose term ~/work/my-project         # print generated .sb profile
bx code --profile-sandbox ~/work/my-project # isolated VSCode profile
bx xcode ~/work/my-ios-app -- MyApp.xcworkspace # sandbox dir + explicit open target
```

### Configuration files

**`~/.bxconfig.toml`** — App definitions (TOML format). Each `[apps.<name>]` section becomes a mode usable as `bx <name> [workdir...]`. Built-in apps (`code`, `xcode`) are always available and can be overridden here.

```toml
# Override built-in app path
[apps.code]
path = "/usr/local/bin/code"

# Add a new app (auto-discovered via bundle ID)
[apps.cursor]
bundle = "com.todesktop.230313mzl4w4u92"
binary = "Contents/MacOS/Cursor"
args = ["--no-sandbox"]

# Add a new app (explicit path, no discovery)
[apps.zed]
path = "/Applications/Zed.app/Contents/MacOS/zed"
```

Available fields per app:

| Field | Description |
| --- | --- |
| `path` | Explicit absolute path to the executable (highest priority) |
| `bundle` | macOS bundle identifier for auto-discovery via `mdfind` |
| `binary` | Relative path to executable inside the `.app` bundle |
| `fallback` | Absolute fallback path if discovery fails |
| `args` | Extra arguments always passed to the app |

App resolution order: `path` (explicit) → `bundle` + `binary` (mdfind auto-discovery) → `fallback` (hardcoded). See `bxconfig.example.toml` for all options.

When overriding a built-in app, only the fields you specify are replaced — the rest (e.g. `bundle`, `args`) are kept from the built-in definition.

**`~/.bxignore`** — Unified sandbox rules (paths relative to `$HOME`). One entry per line, empty lines and `#` comments are ignored:

```gitignore
# Block sensitive paths (default, no prefix)
.aws
.kube
.config/sensitive-app

# Allow read-write access to additional directories
rw:work/bin
rw:shared/libs

# Allow read-only access (can read but not modify)
ro:reference/docs
ro:shared/toolchain
```

**`<workdir>/.bxignore`** — Block paths within the project (supports globs, `.gitignore`-style matching):

```gitignore
# Patterns without "/" match recursively in all subdirectories
.env              # blocks .env everywhere in the project tree
.env.*            # blocks .env.local, sub/.env.production, etc.
*.pem             # blocks all .pem files at any depth

# Leading "/" anchors to the workdir root only
/.env             # blocks only <workdir>/.env, not sub/.env

# Patterns with "/" (non-leading, non-trailing) are relative to workdir
config/secrets    # blocks <workdir>/config/secrets, not sub/config/secrets

# Trailing "/" marks directories (does not affect matching scope)
secrets/          # blocks secrets/ directories at any depth
```

### Built-in protected dotdirs

These are always blocked, regardless of configuration:

`.Trash`, `.ssh`, `.gnupg`, `.docker`, `.zsh_sessions`, `.cargo`, `.gradle`, `.gem`

## Architecture

### Key constraint: SBPL deny always wins over allow

Apple Sandbox Profile Language (SBPL) evaluates `deny` rules with higher priority than `allow` rules, regardless of order. This means:

```scheme
;; THIS DOES NOT WORK — deny wins, ~/work/myproject is still blocked
(deny file* (subpath "/Users/x/work"))
(allow file* (subpath "/Users/x/work/myproject"))
```

Therefore, we **cannot** use a broad deny on a parent directory and then allow a child. Instead, we must deny sibling directories individually, leaving the allowed path untouched.

### Blocklist approach (not allowlist)

A broad `(deny file* (subpath HOME))` also breaks `kqueue`/FSEvents and SQLite `fcntl` locks under `sandbox-exec`, even for paths excluded via `require-not`. This causes VSCode file watchers and `state.vscdb` to fail.

The solution is a **blocklist**: individually deny only the directories that should be protected, leaving everything else at the default `(allow default)`.

### How the profile is generated

1. Parse `~/.bxignore` for `rw:` (read-write) and `ro:` (read-only) entries
2. Scan `$HOME` for non-dot directories (skip `Library` and the script's own directory)
3. For each directory: if an allowed or read-only path is inside it, **descend** and block only its siblings — never deny a parent of an accessible path
4. Dotfiles (`~/.*/`) and `~/Library` are always accessible (VSCode, Node, shell, and other tools depend on them)
5. Built-in protected dotdirs are always denied
6. Plain lines in `~/.bxignore` and `<workdir>/.bxignore` add further deny rules
7. `ro:` directories get a `deny file-write*` rule (read allowed, write blocked)
8. The generated profile is written to `/tmp` and cleaned up on exit

### What is protected

| Path | Access |
| --- | --- |
| `~/Documents`, `~/Desktop`, `~/Downloads`, ... | **blocked** |
| Other projects (siblings of working dir) | **blocked** |
| Working directory | **full** |
| `rw:` dirs in `~/.bxignore` | **full** |
| `ro:` dirs in `~/.bxignore` | **read-only** |
| `~/.*/` (dotfiles/dotdirs) | **full** (except protected ones) |
| `~/Library` | **full** |
| Built-in protected dotdirs | **blocked** |
| Plain paths in `.bxignore` | **blocked** |
