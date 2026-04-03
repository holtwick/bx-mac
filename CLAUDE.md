# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository contains a macOS sandbox solution to launch applications in a protected environment. The home directory is locked down – only the explicitly provided working directory is accessible. Supports VSCode, terminal shells, Claude Code CLI, and arbitrary commands.

## Files

- **`src/index.ts`** — Main entry point. Orchestrates config loading, sandbox profile generation, and launches the target app via `sandbox-exec`.
- **`src/config.ts`** — App configuration: TOML config loading, built-in app definitions, auto-discovery via `mdfind`.
- **`src/args.ts`** — CLI argument parsing with dynamic mode validation.
- **`src/modes.ts`** — Command building for all modes (shell builtins + configured apps).
- **`src/profile.ts`** — Sandbox profile generation: home scanning, blocklist assembly, SBPL output.
- **`src/guards.ts`** — Safety checks: sandbox nesting, external sandbox detection, workdir validation, app-already-running.
- **`src/drytree.ts`** — `--dry` tree output: visual display of protected/accessible paths.
- **`src/help.ts`** — `--help` output.
- **`src/fmt.ts`** — Terminal formatting helpers (colors, icons, labels).
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
bx --background code ~/work/my-project      # run in background, log to /tmp
bx --vscode-user code ~/work/my-project      # isolated app profile (default path)
bx --vscode-user ~/my-profile code ~/work/my-project # isolated app profile (custom path)
bx xcode ~/work/my-ios-app -- MyApp.xcworkspace # sandbox dir + explicit open target
```

### Configuration files

**`~/.bxconfig.toml`** — App definitions (TOML format). Each `[<name>]` section becomes a mode usable as `bx <name> [workdir...]`. Built-in apps (`code`, `xcode`) are always available and can be overridden here.

```toml
# Override built-in app path
[code]
path = "/usr/local/bin/code"

# Add a new app (auto-discovered via bundle ID)
[cursor]
bundle = "com.todesktop.230313mzl4w4u92"
binary = "Contents/MacOS/Cursor"
args = ["--no-sandbox"]

# Add a new app (explicit path, no discovery)
[zed]
path = "/Applications/Zed.app/Contents/MacOS/zed"

# Workdir shortcut — inherits everything from "code"
[myproject]
mode = "code"
paths = ["~/work/my-project", "~/work/shared-lib"]
```

Available fields per app:

| Field | Description |
| --- | --- |
| `mode` | Inherit from another app definition (e.g. `"code"`, `"cursor"`) |
| `path` | Explicit absolute path to the executable (highest priority) |
| `bundle` | macOS bundle identifier for auto-discovery via `mdfind` |
| `binary` | Relative path to executable inside the `.app` bundle |
| `fallback` | Absolute fallback path if discovery fails |
| `args` | Extra arguments always passed to the app |
| `passPaths` | Paths passed as launch args (`true`/`false`/`N`/`["~/p1", "~/p2"]`) |
| `paths` | Default working directories when none given on CLI (supports `~/` paths and `*` globs) |
| `background` | Run the app detached in the background, output to log file (`true`/`false`) |
| `profile` | Use an isolated app profile (`true` = default `~/.vscode-sandbox`, `"path"` = custom path) |

App resolution order: `path` (explicit) → `bundle` + `binary` (mdfind auto-discovery) → `fallback` (hardcoded). See `bxconfig.example.toml` for all options.

When overriding a built-in app, only the fields you specify are replaced — the rest (e.g. `bundle`, `args`) are kept from the built-in definition. When using `mode`, all fields from the referenced app are inherited; own fields override inherited ones.

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

**`<dir>/.bxprotect`** — Marker file (can be empty). When present in a directory, that directory is completely blocked. If placed in a workdir, `bx` refuses to launch. Useful for protecting sensitive project directories without editing `~/.bxignore`.

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

# Self-protect: a bare "/" or "." blocks the entire containing directory
/                 # makes this directory (and all contents) inaccessible
.                 # same effect — shorthand alternative
```

### Built-in protected dotdirs

These are always blocked, regardless of configuration:

**Dotdirs:** `.ssh`, `.gnupg`, `.docker`, `.zsh_sessions`, `.cargo`, `.gradle`, `.gem`

**Library (opinionated):** `Accounts`, `Calendars`, `Contacts`, `Cookies`, `Finance`, `Mail`, `Messages`, `Mobile Documents`, `Photos`, `Safari`, and others — plus app containers matching password managers and finance apps (1Password, Bitwarden, MoneyMoney)

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
2. Scan `$HOME` for non-dot entries (skip `Library` and the script's own directory)
3. For each entry:
   - **Files** are always blocked directly (via `literal` deny rule)
   - **Directories**: if an allowed or read-only path is inside, **descend** and block only siblings (both files and subdirectories) - never deny a parent of an accessible path
   - Otherwise the directory is blocked entirely (via `subpath` deny rule)
4. Dotfiles (`~/.*/`) and `~/Library` are generally accessible (VSCode, Node, shell, and other tools depend on them)
5. Opinionated protection for specific `~/Library` subdirs (Mail, Messages, Photos, Safari, ...) and app containers of password managers / finance apps
6. Built-in protected dotdirs are always denied
7. Plain lines in `~/.bxignore` and `<workdir>/.bxignore` add further deny rules
8. `ro:` directories get a `deny file-write*` rule (read allowed, write blocked)
9. The generated profile is written to `/tmp` and cleaned up on exit

**Key detail:** When descending into ancestor directories, both sibling files and sibling directories are blocked. For example, if the workdir is `~/Documents/work`, then `~/Documents/doc.pdf` is blocked with a `literal` rule and `~/Documents/other-project/` is blocked with a `subpath` rule. This ensures no loose files in parent directories are accessible.

**Note:** The profile is a snapshot at launch time. Files and directories created after the sandbox starts are not protected. Project-level `.bxignore` patterns only match paths that exist at launch.

### What is protected

| Path | Access |
| --- | --- |
| `~/Documents`, `~/Desktop`, `~/Downloads`, ... | **blocked** |
| Files in parent directories of working dir | **blocked** |
| Other projects (siblings of working dir) | **blocked** |
| Working directory | **full** |
| `rw:` dirs in `~/.bxignore` | **full** |
| `ro:` dirs in `~/.bxignore` | **read-only** |
| `~/.*/` (dotfiles/dotdirs) | **full** (except protected ones) |
| `~/Library` | **full** (except opinionated protected subdirs) |
| Built-in protected dotdirs | **blocked** |
| Protected Library subdirs (Mail, Photos, …) | **blocked** |
| Password manager / finance app containers | **blocked** |
| Plain paths in `.bxignore` | **blocked** |

---

## Output

- Answer is always line 1. Reasoning comes after, never before.
- No preamble. No "Great question!", "Sure!", "Of course!", "Certainly!", "Absolutely!".
- No hollow closings. No "I hope this helps!", "Let me know if you need anything!".
- No restating the prompt. If the task is clear, execute immediately.
- No explaining what you are about to do. Just do it.
- No unsolicited suggestions. Do exactly what was asked, nothing more.
- Structured output only: bullets, tables, code blocks. Prose only when explicitly requested.
- Return code first. Explanation after, only if non-obvious.
- No inline prose. Use comments sparingly - only where logic is unclear.
- No boilerplate unless explicitly requested.

## Token Efficiency

- Compress responses. Every sentence must earn its place.
- No redundant context. Do not repeat information already established in the session.
- No long intros or transitions between sections.
- Short responses are correct unless depth is explicitly requested.

## Typography - ASCII Only

- Do not use em dashes. Use hyphens instead.
- Do not use smart or curly quotes. Use straight quotes instead.
- Do not use the ellipsis character. Use three plain dots instead.
- Do not use Unicode bullets. Use hyphens or asterisks instead.
- Do not use non-breaking spaces.
- Do not modify content inside backticks. Treat it as a literal example.

## Sycophancy - Zero Tolerance

- Never validate the user before answering.
- Never say "You're absolutely right!" unless the user made a verifiable correct statement.
- Disagree when wrong. State the correction directly.
- Do not change a correct answer because the user pushes back.

## Accuracy and Speculation Control

- Never speculate about code, files, or APIs you have not read.
- If referencing a file or function: read it first, then answer.
- If unsure: say "I don't know." Never guess confidently.
- Never invent file paths, function names, or API signatures.
- If a user corrects a factual claim: accept it as ground truth for the entire session. Never re-assert the original claim.

## Code Output

- Return the simplest working solution. No over-engineering.
- No abstractions or helpers for single-use operations.
- No speculative features or future-proofing.
- No docstrings or comments on code that was not changed.
- Inline comments only where logic is non-obvious.
- Read the file before modifying it. Never edit blind.

## Warnings and Disclaimers

- No safety disclaimers unless there is a genuine life-safety or legal risk.
- No "Note that...", "Keep in mind that...", "It's worth mentioning..." soft warnings.
- No "As an AI, I..." framing.

## Session Memory

- Learn user corrections and preferences within the session.
- Apply them silently. Do not re-announce learned behavior.
- If the user corrects a mistake: fix it, remember it, move on.

## Scope Control

- Do not add features beyond what was asked.
- Do not refactor surrounding code when fixing a bug.
- Do not create new files unless strictly necessary.

## Code Rules

- Simplest working solution. No over-engineering.
- No abstractions for single-use operations.
- No speculative features or "you might also want..."
- Read the file before modifying it. Never edit blind.
- No docstrings or type annotations on code not being changed.
- No error handling for scenarios that cannot happen.
- Three similar lines is better than a premature abstraction.

## Review Rules

- State the bug. Show the fix. Stop.
- No suggestions beyond the scope of the review.
- No compliments on the code before or after the review.

## Debugging Rules

- Never speculate about a bug without reading the relevant code first.
- State what you found, where, and the fix. One pass.
- If cause is unclear: say so. Do not guess.

## ASCII Only

- No em dashes, smart quotes, Unicode bullets.
- Plain hyphens and straight quotes only.
- Code output must be copy-paste safe.

## Override Rule

User instructions always override this file.
