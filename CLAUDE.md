# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository contains a macOS sandbox solution to launch applications in a protected environment. The home directory is locked down – only the explicitly provided working directory is accessible. Supports VSCode, terminal shells, Claude Code CLI, and arbitrary commands.

## Files

- **`src/index.ts`** — Main source (TypeScript). Scans `$HOME`, generates a sandbox profile dynamically, and launches the target application inside `sandbox-exec`.
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
bx term [workdir]                           # sandboxed login shell
bx claude [workdir]                         # Claude Code CLI
bx exec [workdir] -- command [args...]      # arbitrary command

# Options (work with all modes)
bx --verbose term ~/work/my-project         # print generated .sb profile
bx code --profile-sandbox ~/work/my-project # isolated VSCode profile
```

### Configuration files

All config files use one entry per line. Empty lines and `#` comments are ignored.

**`~/.bxignore`** — Unified sandbox rules (paths relative to `$HOME`):

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

**`<workdir>/.bxignore`** — Block paths within the project (relative to workdir, supports globs):

```gitignore
.env
.env.*
secrets/
**/*.pem
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
|---|---|
| `~/Documents`, `~/Desktop`, `~/Downloads`, ... | **blocked** |
| Other projects (siblings of working dir) | **blocked** |
| Working directory | **full** |
| `rw:` dirs in `~/.bxignore` | **full** |
| `ro:` dirs in `~/.bxignore` | **read-only** |
| `~/.*/` (dotfiles/dotdirs) | **full** (except protected ones) |
| `~/Library` | **full** |
| Built-in protected dotdirs | **blocked** |
| Plain paths in `.bxignore` | **blocked** |
