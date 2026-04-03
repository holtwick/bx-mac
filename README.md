# 📦 bx

[![npm version](https://img.shields.io/npm/v/bx-mac?color=blue)](https://www.npmjs.com/package/bx-mac)
[![npm downloads](https://img.shields.io/npm/dm/bx-mac)](https://www.npmjs.com/package/bx-mac)
[![license](https://img.shields.io/github/license/holtwick/bx-mac)](https://github.com/holtwick/bx-mac/blob/master/LICENSE)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/holtwick/bx-mac)

> **Put your AI in a box.** Launch VSCode, Claude Code, a terminal, or any command in a macOS sandbox — your tools can only see the project you're working on.

## 🤔 Why?

AI-powered coding tools like Claude Code, Copilot, or Cline run with **broad file system access**. A misguided tool call or hallucinated path could accidentally read your SSH keys, credentials, tax documents, or private photos.

**bx** wraps any application in a macOS sandbox (`sandbox-exec`) that blocks access to everything except the project directory you explicitly specify. No containers, no VMs, no setup — just one command.

```bash
bx ~/work/my-project
```

That's it. 🎉 VSCode opens with full access to `~/work/my-project` and nothing else. Read [the blog post](https://holtwick.de/blog/bx-sandbox) for more background on the motivation behind bx.

Need multiple directories? No problem:

```bash
bx ~/work/my-project ~/work/shared-lib
```

## ✅ What it does

- 🔒 Blocks `~/Documents`, `~/Desktop`, `~/Downloads`, and all other personal folders
- 🚧 Blocks sibling projects — only the directory you specify is accessible
- 🛡️ Protects sensitive dotdirs like `~/.ssh`, `~/.gnupg`, `~/.docker`, `~/.cargo`
- 🏛️ Opinionated protection for `~/Library` — blocks privacy-sensitive subdirectories (Mail, Messages, Photos, Safari, Contacts, …) and containers of password managers/finance apps, while keeping tooling-relevant paths accessible
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
- **Not dynamic** — the sandbox profile is a snapshot of `$HOME` at launch time; directories or files created later are **not** automatically blocked
- **File names visible** — blocked files cannot be read or written, but their names still appear in directory listings (a kernel-level `readdir` constraint, same as `chmod 000`)
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

**Requirements:** macOS (only tested on Tahoe 26.4, feedback welcome), Node.js >= 22

## 🚀 Modes

| Command | What it launches |
| --- | --- |
| `bx [workdir...]` | 🖥️ VSCode (default) |
| `bx code [workdir...]` | 🖥️ VSCode (explicit) |
| `bx xcode [workdir...] [-- project-or-workspace]` | 🛠️ Xcode |
| `bx term [workdir...]` | 💻 Sandboxed login shell (`$SHELL -l`) |
| `bx claude [workdir...]` | 🤖 Claude Code CLI |
| `bx exec [workdir...] -- cmd` | ⚡ Any command you want |
| `bx <app> [workdir...] [-- app-args...]` | 🔌 Any app from `~/.bxconfig.toml` |

If no directory is given, the current directory is used. All modes accept multiple directories.

For app modes, values before `--` define the sandbox scope (`workdir...`). Values after `--` are passed to the app as launch arguments.

For `xcode`, this distinction is important: the sandbox workdir is **not** passed as an Xcode open argument. Use `--` if you want to open a specific `.xcworkspace` or `.xcodeproj`.

This behavior is configurable per app via `passPaths` in `~/.bxconfig.toml` (default: `true`, built-in `xcode` default: `false`).

GUI app modes are activated in the foreground on launch (best effort), so the opened app should become the frontmost app.

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

# 🛠️ Xcode (built-in) — sandbox only, open picker/restore state
bx xcode ~/work/my-ios-app

# 🛠️ Xcode with explicit project/workspace to open
bx xcode ~/work/my-ios-app -- MyApp.xcworkspace

# 🔌 Custom apps from ~/.bxconfig.toml
bx cursor ~/work/my-project
bx zed ~/work/my-project

# ⚡ Run a script in a sandbox
bx exec ~/work/my-project -- python train.py

# 🔀 Run in the background (terminal stays free)
bx --background code ~/work/my-project

# 🔍 Preview what will be protected (no launch)
bx --dry ~/work/my-project

# 🔍 See the generated sandbox profile
bx --verbose ~/work/my-project

# 🔄 Use an isolated app profile
bx --vscode-user code ~/work/my-project
```

## ⚙️ Options

| Option | Description |
| --- | --- |
| `--dry` | Show a tree of all protected, read-only, and accessible paths — don't launch anything |
| `--verbose` | Print the generated sandbox profile plus launch details (binary, arguments, cwd, focus command) |
| `--background` | Run the app detached in the background (like `nohup &`), output goes to `/tmp/bx-<pid>.log` |
| `--vscode-user [path]` | Use an isolated app profile (default: `~/.vscode-sandbox`, or specify a custom path) |

On normal runs, bx also prints a short policy summary (number of workdirs, blocked directories, hidden paths, and read-only directories).

## 📝 Configuration

### `~/.bxconfig.toml`

App definitions in TOML format. Each `[<name>]` section becomes a CLI mode — use it as `bx <name> [workdir...]`. Built-in apps (`code`, `xcode`) are always available and can be overridden.

```toml
# Add Cursor (auto-discovered via macOS Spotlight)
[cursor]
bundle = "com.todesktop.230313mzl4w4u92"
binary = "Contents/MacOS/Cursor"
args = ["--no-sandbox"]

# Add Zed (explicit path, no discovery)
[zed]
path = "/Applications/Zed.app/Contents/MacOS/zed"

# Override built-in VSCode path
[code]
path = "/usr/local/bin/code"
```

| Field | Description |
| --- | --- |
| `mode` | Inherit from another app (e.g. `"code"`, `"cursor"`) — only `paths` / overrides needed |
| `bundle` | macOS bundle identifier — used with `mdfind` to find the app automatically |
| `binary` | Relative path to the executable inside the `.app` bundle |
| `path` | Absolute path to the executable **or** `.app` bundle (highest priority, skips discovery) |
| `fallback` | Absolute fallback path if `mdfind` discovery fails |
| `args` | Extra arguments always passed to the app |
| `passPaths` | Paths passed as app launch args (`true`/`false`/`N`/`["~/p1", "~/p2"]`) |
| `paths` | Default working directories when none are given on the CLI (supports `~/` paths and `*` globs) |
| `background` | Run the app detached in the background by default (`true`/`false`) |
| `profile` | Use an isolated app profile (`true` = `~/.vscode-sandbox`, `"path"` = custom path) |

**Resolution order:** `path` → `mdfind` by `bundle` + `binary` → `fallback`

`passPaths` controls launch argument behavior and is independent of sandbox scope. Even with `passPaths = false`, the provided `workdir...` still defines what the sandbox can access. Use `passPaths = 1` to pass only the first path as a launch argument, or `passPaths = ["~/specific/path"]` to pass explicit paths instead of workdirs.

**Workdir shortcuts with `mode`** let you create named entries that inherit everything from an existing app — just set `mode` and `paths`:

```toml
# "bx myproject" opens VSCode with these directories
[myproject]
mode = "code"
paths = ["~/work/my-project", "~/work/shared-lib"]

# "bx ios" opens Xcode with this directory
[ios]
mode = "xcode"
paths = ["~/work/my-ios-app"]
```

Running `bx myproject` inherits VSCode's bundle, binary, args, and everything else — no need to repeat the full app configuration. Own fields override inherited ones, so you can still customize specific settings. Chaining is supported (e.g. `myproject` → `cursor` → `code`).

**Preconfigured paths** also work directly on app definitions:

```toml
[code]
paths = ["~/work/my-project", "~/work/shared-lib"]
```

Running `bx code` (without arguments) will then open VSCode with both directories sandboxed. CLI arguments always override configured paths.

When overriding a built-in app, only the specified fields are replaced — unset fields keep their defaults. See [`bxconfig.example.toml`](bxconfig.example.toml) for a complete reference.

> **💡 Finding a bundle ID:** Run `osascript -e 'id of app "AppName"'` to get the bundle ID of any installed app. Using `bundle` instead of `path` is recommended — it survives app updates, relocations, and name changes.

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

Deny rules are applied **in addition** to the built-in protected lists:

> 🔒 **Dotdirs:** `.ssh` `.gnupg` `.docker` `.zsh_sessions` `.cargo` `.gradle` `.gem`
>
> 🏛️ **Library (opinionated):** `Accounts` `Calendars` `Contacts` `Cookies` `Finance` `Mail` `Messages` `Mobile Documents` `Photos` `Safari` and [others (see full list)](src/profile.ts) — plus containers of password managers & finance apps

### `<project>/.bxignore`

Block paths within the working directory. Uses [`.gitignore`-style pattern matching](https://git-scm.com/docs/gitignore#_pattern_format):

| Pattern | Matches | Why |
| --- | --- | --- |
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

### Self-protecting directories

You can make any directory protect itself — no global configuration needed. There are two ways:

**Option 1: `.bxignore` with `/` or `.`**

Create a `.bxignore` file containing a bare `/` or `.`:

```gitignore
.
```

This blocks the entire directory and everything inside it. You can combine it with other patterns (they become redundant since the whole directory is blocked).

**Option 2: `.bxprotect` marker file**

Create an empty `.bxprotect` file:

```bash
touch ~/work/secret-project/.bxprotect
```

Both methods have the same effect:

- **Inside a workdir:** If a subdirectory is self-protected, it is completely blocked (deny) and bx does not recurse into it.
- **As a workdir:** If you try to open a self-protected directory with `bx`, it refuses to launch with a clear error message.

## 🔧 How it works

bx generates a macOS sandbox profile at launch time:

1. **Scan** `$HOME` for non-hidden directories
2. **Block** each one individually with `(deny file* (subpath ...))`
3. **Skip** all working directories, `~/Library`, dotfiles, and `rw:`/`ro:` paths from `~/.bxignore`
4. **Descend** into parent directories of allowed paths to block only siblings (because SBPL deny rules always override allow rules)
5. **Protect** an opinionated set of `~/Library` subdirectories (Mail, Messages, Photos, Safari, Contacts, Calendars, …) and app containers matching known password managers and finance apps (1Password, Bitwarden, MoneyMoney, …)
6. **Append** deny rules for protected dotdirs, plain entries in `~/.bxignore`, and `.bxignore` files found recursively in each working directory
7. **Apply** `(deny file-write*)` rules for `ro:` directories (read allowed, write blocked)
8. **Write** the profile to `/tmp`, launch the app via `sandbox-exec`, clean up on exit

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
- **🧩 App already sandboxed:** For GUI app modes, bx inspects app entitlements (best effort) and warns if Apple App Sandbox is enabled, since nested sandboxing can cause startup/access issues.
- **🔁 App already running:** If the target app is already running, bx warns that the new workspace would open in the existing (unsandboxed) instance and asks for confirmation. This is important because Electron apps like VSCode, Cursor, etc. always reuse the running process — `sandbox-exec` has no effect on the already-running instance.

### Single-instance apps

Most GUI editors (VSCode, Cursor, Xcode, Zed) are **single-instance apps** — launching them a second time just sends the path to the running process. This means you **cannot run two separately sandboxed instances** of the same app.

**To work on multiple projects**, specify all directories at launch:

```bash
bx code ~/work/project-a ~/work/project-b
```

Or preconfigure them in `~/.bxconfig.toml`:

```toml
[code]
paths = ["~/work/project-a", "~/work/project-b"]
```

For VSCode specifically, `--vscode-user` forces a separate Electron process via an isolated `--user-data-dir`, but this means separate extensions and settings. You can specify a custom path (`--vscode-user ~/my-profile`) or use the default (`--vscode-user` alone uses `~/.vscode-sandbox`). This can also be configured per app in `~/.bxconfig.toml` via the `profile` field.

## 💡 Tips

**Verify it works** — try reading a blocked file from the sandboxed terminal:

```bash
cat ~/Documents/something.txt   # ❌ Operation not permitted
cat ~/Desktop/file.txt           # ❌ Operation not permitted
ls ~/work/other-project/         # ❌ Operation not permitted
cat ./src/index.ts               # ✅ Works!
```

## ⚠️ Known limitations

- **⚠️ Sandbox profile is static:** The sandbox rules are generated **once at launch** by scanning the current state of `$HOME`. Directories or files created **after** the sandbox starts are **not protected** — for example, if a tool creates `~/new-project/` while the sandbox is running, that directory will be fully accessible. Similarly, project-level `.bxignore` patterns only match files that exist at launch time; files matching a blocked pattern (e.g. `.env`) that are created later will **not** be denied. Re-run `bx` to pick up changes.
- **File watcher warnings:** VSCode may log `EPERM` for `fs.watch()` on some paths — cosmetic only
- **SQLite warnings:** `state.vscdb` errors may appear in logs — extensions still work
- **`sandbox-exec` is undocumented:** Apple could change behavior with OS updates

## 🤖 Built-in sandboxing in AI tools

Some AI coding tools ship with their own sandboxing. bx complements these by providing a **uniform, tool-independent** layer that works across all applications — including editors, shells, and custom commands:

- [Claude Code](https://code.claude.com/docs/en/sandboxing) — built-in sandbox for file and command restrictions
- [Gemini CLI](https://geminicli.com/docs/cli/sandbox/) — sandbox mode for file system access control
- [OpenAI Codex](https://developers.openai.com/codex/concepts/sandboxing) — containerized sandboxing for code execution
- [VS Code Copilot](https://code.visualstudio.com/docs/copilot/agents/agent-tools#_sandbox-agent-commands) — agent sandbox mode (preview) that restricts write access to the working directory and blocks network access for terminal commands (`chat.agent.sandbox` setting)

These are great when available, but they only protect within their own tool. bx wraps the entire process — so even if a tool's built-in sandbox is misconfigured, disabled, or absent, your files stay protected.

## 🔗 Alternatives

- [Agent Safehouse](https://agent-safehouse.dev/) — macOS kernel-level sandboxing for LLM coding agents via `sandbox-exec`. Deny-first model that blocks write access outside the project directory.

## 💛 Sponsor

If you find bx useful, consider supporting its development:

[GitHub Sponsors](https://github.com/sponsors/holtwick) - [Liberapay](https://liberapay.com/holtwick) - [Buy Me a Coffee](https://buymeacoffee.com/holtwick) - [Patreon](https://patreon.com/holtwick) - [Open Collective](https://opencollective.com/holtwick)

Also check out my other projects: [Receipts](https://receipts-app.com) - [PDFify](https://pdfify.app)

## 📄 License

MIT — see [LICENSE](LICENSE).
