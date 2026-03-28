# 📦 bx

> **Put your AI in a box.** Launch VSCode, Claude Code, a terminal, or any command in a macOS sandbox — your tools can only see the project you're working on.

## 🤔 Why?

AI-powered coding tools like Claude Code, Copilot, or Cline run with **broad file system access**. A misguided tool call or hallucinated path could accidentally read your SSH keys, credentials, tax documents, or private photos.

**bx** wraps any application in a macOS sandbox (`sandbox-exec`) that blocks access to everything except the project directory you explicitly specify. No containers, no VMs, no setup — just one command.

```bash
bx ~/work/my-project
```

That's it. 🎉 VSCode opens with full access to `~/work/my-project` and nothing else.

Need multiple directories? No problem:

```bash
bx ~/work/my-project ~/work/shared-lib
```

## ✅ What it does

- 🔒 Blocks `~/Documents`, `~/Desktop`, `~/Downloads`, and all other personal folders
- 🚧 Blocks sibling projects — only the directory you specify is accessible
- 🛡️ Protects sensitive dotdirs like `~/.ssh`, `~/.gnupg`, `~/.docker`, `~/.cargo`
- ⚙️ Keeps VSCode, extensions, shell, Node.js, and other tooling fully functional
- 🔍 Generates sandbox rules dynamically based on your actual `$HOME` contents
- 📝 Supports `.bxignore` files (searched recursively) to hide secrets like `.env` files within a project
- 📂 Supports `rw:` and `ro:` prefixes in `~/.bxignore` to grant read-write or read-only access to extra directories
- 🗂️ Supports multiple working directories in a single sandbox

## 🚫 What it doesn't do

- **No network restrictions** — API calls, git push/pull, npm install all work normally
- **No process isolation** — this is file-level sandboxing, not a container
- **No protection against root/sudo** — the sandbox applies to the user-level process
- **macOS only** — relies on `sandbox-exec` (Apple-specific)
- **Not a vault** — `sandbox-exec` is undocumented; treat this as a safety net, not a guarantee

## 📥 Install

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

**Requirements:** macOS (tested on Sequoia 15), Node.js >= 22

## 🚀 Modes

| Command | What it launches |
|---|---|
| `bx [workdir...]` | 🖥️ VSCode (default) |
| `bx code [workdir...]` | 🖥️ VSCode (explicit) |
| `bx term [workdir...]` | 💻 Sandboxed login shell (`$SHELL -l`) |
| `bx claude [workdir...]` | 🤖 Claude Code CLI |
| `bx exec [workdir...] -- cmd` | ⚡ Any command you want |

If no directory is given, the current directory is used. All modes accept multiple directories.

### Examples

```bash
# 🖥️ VSCode with sandbox protection
bx ~/work/my-project

# 📂 Multiple working directories
bx ~/work/my-project ~/work/shared-lib

# 💻 Work on a project in a sandboxed terminal
bx term ~/work/my-project

# 🤖 Let Claude Code work on a project — nothing else visible
bx claude ~/work/my-project

# ⚡ Run a script in a sandbox
bx exec ~/work/my-project -- python train.py

# 🔍 Preview what will be protected (no launch)
bx --dry ~/work/my-project

# 🔍 See the generated sandbox profile
bx --verbose ~/work/my-project
```

## ⚙️ Options

| Option | Description |
|---|---|
| `--dry` | Show a tree of all protected, read-only, and accessible paths — don't launch anything |
| `--verbose` | Print the generated sandbox profile to stderr |
| `--profile-sandbox` | Use an isolated VSCode profile (separate extensions/settings, `code` mode only) |

## 📝 Configuration

bx uses two optional config files — one entry per line, `#` for comments. Project `.bxignore` files are discovered recursively.

### `~/.bxignore`

Unified sandbox rules for your home directory. Paths relative to `$HOME`. Each line is either a deny rule (no prefix) or an access grant (`rw:` / `ro:` prefix, case-insensitive).

```gitignore
# Block additional sensitive paths (no prefix = deny)
.aws
.azure
.kube
.config/gcloud

# Allow read-write access to extra directories
rw:work/bin
rw:shared/libs

# Allow read-only access (can read but not modify)
ro:reference/docs
ro:shared/toolchain
```

Deny rules are applied **in addition** to the built-in protected list:

> 🔒 `.Trash` `.ssh` `.gnupg` `.docker` `.zsh_sessions` `.cargo` `.gradle` `.gem`

### `<project>/.bxignore`

Block paths within the working directory. Uses [`.gitignore`-style pattern matching](https://git-scm.com/docs/gitignore#_pattern_format):

| Pattern | Matches | Why |
|---|---|---|
| `.env` | `.env` at any depth | No `/` → recursive |
| `.env.*` | `.env.local`, `sub/.env.production` | No `/` → recursive |
| `*.pem` | `key.pem`, `sub/deep/cert.pem` | No `/` → recursive |
| `secrets/` | `secrets/` at any depth | Trailing `/` is a dir marker, not a path separator |
| `/.env` | Only `<workdir>/.env` | Leading `/` → anchored to root |
| `config/secrets` | Only `<workdir>/config/secrets` | Contains `/` → relative to workdir |

bx searches for `.bxignore` files **recursively** through the entire project tree (skipping `.`-prefixed dirs and `node_modules`), so you can place them in subdirectories to hide secrets close to where they live.

```gitignore
.env
.env.*
secrets/
*.pem
*.key
```

For example, a monorepo might have:

```text
my-project/.bxignore          # top-level rules
my-project/services/api/.bxignore   # API-specific secrets
my-project/deploy/.bxignore         # deployment credentials
```

Each `.bxignore` resolves its patterns relative to its own directory.

## 🔧 How it works

bx generates a macOS sandbox profile at launch time:

1. **Scan** `$HOME` for non-hidden directories
2. **Block** each one individually with `(deny file* (subpath ...))`
3. **Skip** all working directories, `~/Library`, dotfiles, and `rw:`/`ro:` paths from `~/.bxignore`
4. **Descend** into parent directories of allowed paths to block only siblings (because SBPL deny rules always override allow rules)
5. **Append** deny rules for protected dotdirs, plain entries in `~/.bxignore`, and `.bxignore` files found recursively in each working directory
6. **Apply** `(deny file-write*)` rules for `ro:` directories (read allowed, write blocked)
7. **Write** the profile to `/tmp`, launch the app via `sandbox-exec`, clean up on exit

### Why not a simple deny-all + allow?

Apple's SBPL has a critical quirk: **`deny` always wins over `allow`**, regardless of rule order:

```scheme
;; ❌ Does NOT work — the deny still blocks myproject
(deny file* (subpath "/Users/me/work"))
(allow file* (subpath "/Users/me/work/myproject"))
```

Additionally, a broad `(deny file* (subpath HOME))` breaks `kqueue`/FSEvents file watchers and SQLite locks, causing VSCode errors.

bx avoids both issues by **never denying a parent of an allowed path** — it walks the directory tree and blocks only the specific siblings.

## 🛡️ Safety checks

bx detects and prevents problematic scenarios:

- **🔄 Sandbox nesting:** If `CODEBOX_SANDBOX=1` is set (auto-propagated), bx refuses to start — nested sandboxes cause silent failures.
- **🔍 Unknown sandbox:** On startup, bx probes `~/Documents`, `~/Desktop`, `~/Downloads`. If any return `EPERM`, another sandbox is active — bx aborts.
- **⚠️ VSCode terminal:** If `VSCODE_PID` is set, bx warns that it will launch a *new* instance, not sandbox the current one.

## 💡 Tips

**Verify it works** — try reading a blocked file from the sandboxed terminal:

```bash
cat ~/Documents/something.txt   # ❌ Operation not permitted
cat ~/Desktop/file.txt           # ❌ Operation not permitted
ls ~/work/other-project/         # ❌ Operation not permitted
cat ./src/index.ts               # ✅ Works!
```

## ⚠️ Known limitations

- **File watcher warnings:** VSCode may log `EPERM` for `fs.watch()` on some paths — cosmetic only
- **SQLite warnings:** `state.vscdb` errors may appear in logs — extensions still work
- **`sandbox-exec` is undocumented:** Apple could change behavior with OS updates

## 📄 License

MIT — see [LICENSE](LICENSE).
