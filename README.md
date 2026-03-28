# bx

Launch VSCode, a terminal, Claude Code, or any command in a macOS sandbox. Your tools can only see the project you're working on — not your private files, SSH keys, or other repositories.

## Why?

AI-powered coding tools like Claude Code, Copilot, or Cline run with broad file system access. A misguided tool call or hallucinated path could accidentally read your SSH keys, credentials, tax documents, or private photos.

**bx** wraps any application in a macOS sandbox (`sandbox-exec`) that blocks access to everything except the project directory you explicitly specify. No containers, no VMs, no setup — just one command.

## What it does

- Blocks access to `~/Documents`, `~/Desktop`, `~/Downloads`, and all other personal folders
- Blocks access to sibling projects — only the directory you specify is accessible
- Protects sensitive dotdirs like `~/.ssh`, `~/.gnupg`, `~/.docker`, `~/.cargo` by default
- Keeps VSCode, extensions, shell, Node.js, and other tooling fully functional
- Generates sandbox rules dynamically based on your actual `$HOME` contents
- Supports `.bxignore` to hide secrets like `.env` files within a project
- Supports `~/.bxallow` to grant access to shared utility directories

## What it doesn't do

- **No network restrictions** — API calls, git push/pull, npm install all work normally
- **No process isolation** — this is file-level sandboxing, not a container
- **No protection against root/sudo** — the sandbox applies to the user-level process
- **macOS only** — relies on `sandbox-exec` which is an Apple-specific technology
- **Not a security guarantee** — `sandbox-exec` is undocumented and may have limitations; treat this as a safety net, not a vault

## Requirements

- macOS (tested on Sequoia / macOS 15)
- Node.js >= 22
- Visual Studio Code installed in `/Applications` (for `code` mode)

## Install

```bash
# Homebrew
brew install holtwick/tap/bx

# npm
npm install -g bx-mac

# From source
git clone https://github.com/holtwick/bx-mac.git
cd bx-mac
pnpm install && pnpm build
pnpm link -g
```

## Quick start

```bash
# Launch VSCode with sandbox protection
bx ~/work/my-project
```

That's it. VSCode opens with full access to `~/work/my-project` and nothing else.

## Modes

```bash
bx [workdir]                            # VSCode (default)
bx code [workdir]                       # VSCode (explicit)
bx term [workdir]                       # sandboxed login shell ($SHELL -l)
bx claude [workdir]                     # Claude Code CLI
bx exec [workdir] -- command [args...]  # arbitrary command
```

If no directory is given, the current directory is used.

### Examples

```bash
# Work on a project in a sandboxed terminal
bx term ~/work/my-project

# Let Claude Code work on a project without access to anything else
bx claude ~/work/my-project

# Run a script in a sandbox
bx exec ~/work/my-project -- python train.py

# VSCode with verbose output
bx --verbose ~/work/my-project
```

## Options

| Option | Description |
|---|---|
| `--verbose` | Print the generated sandbox profile to stderr |
| `--profile-sandbox` | Use an isolated VSCode profile (separate extensions and settings, `code` mode only) |

## Configuration

bx uses three optional config files, all with the same format: one entry per line, `#` for comments.

### `~/.bxallow`

Allow extra directories beyond the working directory. Paths are relative to `$HOME`.

```gitignore
# Shared shell scripts and utilities
work/bin
# Shared libraries used across projects
shared/libs
```

### `~/.bxignore`

Block additional dotdirs or files in your home. Paths are relative to `$HOME`.

```gitignore
# Cloud provider credentials
.aws
.azure
.kube
.config/gcloud
```

These are blocked **in addition** to the built-in protected list:

> `.Trash` `.ssh` `.gnupg` `.docker` `.zsh_sessions` `.cargo` `.gradle` `.gem`

### `<project>/.bxignore`

Block paths within the working directory itself. Supports glob patterns.

```gitignore
# Environment files with secrets
.env
.env.*

# Credentials and keys
secrets/
**/*.pem
**/*.key
```

## How it works

bx generates a macOS sandbox profile at launch time:

1. **Scan** `$HOME` for non-hidden directories
2. **Block** each one individually with a `(deny file* (subpath ...))` rule
3. **Skip** the working directory, `~/Library`, dotfiles, and any paths from `~/.bxallow`
4. **Descend** into parent directories of allowed paths to block only siblings (because SBPL deny rules always override allow rules — you can't deny a parent and allow a child)
5. **Append** deny rules for protected dotdirs and `.bxignore` entries
6. **Write** the profile to `/tmp`, launch VSCode via `sandbox-exec`, clean up on exit

### Why not a simple deny-all + allow?

Apple's Sandbox Profile Language (SBPL) has a critical quirk: **`deny` always wins over `allow`**, regardless of rule order. This means:

```scheme
;; Does NOT work — the deny still blocks myproject
(deny file* (subpath "/Users/me/work"))
(allow file* (subpath "/Users/me/work/myproject"))
```

Additionally, a broad `(deny file* (subpath HOME))` breaks `kqueue`/FSEvents file watchers and SQLite `fcntl` locks, causing VSCode errors even for paths that should be allowed.

bx avoids both issues by **never denying a parent of an allowed path**. Instead, it walks the directory tree and denies only the specific siblings that should be blocked.

## Tips

**See what's happening:** Use `--verbose` to inspect the generated profile before trusting it with sensitive work.

**Test the sandbox:** Try reading a blocked file from VSCode's terminal:

```bash
cat ~/Documents/something.txt   # Should fail with "Operation not permitted"
cat ~/Desktop/file.txt           # Should fail
ls ~/work/other-project/         # Should fail
```

## Safety checks

bx detects and prevents problematic scenarios:

- **Sandbox nesting:** If `CODEBOX_SANDBOX=1` is set (automatically passed to child processes), bx refuses to start — nested `sandbox-exec` causes silent failures.
- **Unknown sandbox:** On startup, bx probes `~/Documents`, `~/Desktop`, and `~/Downloads`. If any return `EPERM`, another sandbox is already active — bx aborts.
- **VSCode terminal:** If `VSCODE_PID` is set, bx warns that it will launch a *new* instance, not sandbox the current one.

## Known limitations

- **File watcher warnings:** VSCode may log `EPERM` errors for `fs.watch()` on some paths. These are cosmetic and don't affect functionality.
- **SQLite warnings:** `state.vscdb` errors may appear in logs when VSCode's state database paths are affected. Extensions still work correctly.
- **`sandbox-exec` is undocumented:** Apple provides no official documentation for SBPL. The tool works in practice but could change with OS updates.

## License

MIT — see [LICENSE](LICENSE).
