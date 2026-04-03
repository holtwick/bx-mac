import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

export const PROTECTED_DOTDIRS = [
  ".Trash",
  ".ssh",
  ".gnupg",
  ".docker",
  ".zsh_sessions",
  ".cargo",
  ".gradle",
  ".gem",
]

export const PROTECTED_HOME_DOTFILES = [
  ".zsh_history",
  ".zsh_sessions",
  ".bash_history",
  ".sh_history",
  ".node_repl_history",
  ".python_history",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".extra",
]


export const PROTECTED_LIBRARY_DIRS = [
  "Accounts",
  "Calendars",
  "CallServices",
  "CloudStorage",
  "Contacts",
  "Cookies",
  "Finance",
  "FinanceBackup",
  "Google",
  "HomeKit",
  "IdentityServices",
  // "Keychains",
  "Mail",
  "Messages",
  "Mobile Documents",
  "News",
  "Passes",
  "PersonalizationPortrait",
  "Photos",
  "Safari",
  "SafariSafeBrowsing",
  "Sharing",
  "Suggestions",
  "Thunderbird",
  "WebKit",
  "com.apple.appleaccountd",
  "com.apple.iTunesCloud",
]

export const PROTECTED_CONTAINER_PATTERNS = [
  "com.bitwarden.*",
  "com.agilebits.*",
  "com.1password.*",
  "com.moneymoney-app.*",
]

// --- Line / file parsing helpers ---

function parseLines(filePath: string): string[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
}

/**
 * Convert a .bxignore line to a glob pattern (.gitignore semantics):
 *
 *   "/foo"       → anchored to base dir       → "foo"
 *   "foo/bar"    → relative path, use as-is    → "foo/bar"
 *   "foo"        → no slash, match recursively → "** /foo"
 *   "secrets/"   → trailing slash = dir marker, still recursive
 */
function toGlobPattern(line: string): string {
  if (line.startsWith("/")) return line.slice(1)

  const withoutTrailingSlash = line.endsWith("/") ? line.slice(0, -1) : line
  if (withoutTrailingSlash.includes("/")) return line

  return `**/${line}`
}

function resolveGlobMatches(pattern: string, baseDir: string): string[] {
  return globSync(toGlobPattern(pattern), { cwd: baseDir })
    .map((match) => resolve(baseDir, match))
}

// --- Self-protection detection ---

/**
 * A directory is self-protected if it contains a `.bxprotect` file
 * or a `.bxignore` with a bare `/` entry.  Self-protected directories
 * are blocked entirely — they cannot be used as workdirs and are
 * denied inside workdir trees.
 */
export function isSelfProtected(dir: string): boolean {
  if (existsSync(join(dir, ".bxprotect"))) return true
  return parseLines(join(dir, ".bxignore")).some((l) => l === "/" || l === ".")
}

// --- Ignore file collection ---

function applyIgnoreFile(filePath: string, baseDir: string, ignored: string[]) {
  for (const line of parseLines(filePath)) {
    if (line === "/" || line === ".") continue // handled by isSelfProtected
    ignored.push(...resolveGlobMatches(line, baseDir))
  }
}

function collectIgnoreFilesRecursive(dir: string, ignored: string[]) {
  if (isSelfProtected(dir)) {
    ignored.push(dir)
    return
  }

  const ignoreFile = join(dir, ".bxignore")
  if (existsSync(ignoreFile)) {
    applyIgnoreFile(ignoreFile, dir, ignored)
  }

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules") continue
    const fullPath = join(dir, name)
    try {
      if (statSync(fullPath).isDirectory()) {
        collectIgnoreFilesRecursive(fullPath, ignored)
      }
    } catch {
      // Permission denied or similar — skip
    }
  }
}

// --- Home config (RW/RO entries) ---

export interface HomeConfig {
  allowed: Set<string>
  readOnly: Set<string>
}

const ACCESS_PREFIX_RE = /^(RW|RO):(.+)$/i

export function parseHomeConfig(home: string, workDirs: string[]): HomeConfig {
  const allowed = new Set(workDirs)
  const readOnly = new Set<string>()

  for (const line of parseLines(join(home, ".bxignore"))) {
    const match = line.match(ACCESS_PREFIX_RE)
    if (!match) continue

    const [, prefix, rawPath] = match
    const absolute = resolve(home, rawPath.trim())
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue

    if (prefix.toUpperCase() === "RW") {
      allowed.add(absolute)
    } else {
      readOnly.add(absolute)
    }
  }

  return { allowed, readOnly }
}

// --- Blocked directory collection ---

function isAllowedOrAncestor(fullPath: string, allowedDirs: Set<string>): "allowed" | "ancestor" | "none" {
  if (allowedDirs.has(fullPath)) return "allowed"
  const prefix = fullPath + "/"
  for (const dir of allowedDirs) {
    if (dir.startsWith(prefix)) return "ancestor"
  }
  return "none"
}

export function collectBlockedDirs(
  parentDir: string,
  home: string,
  scriptDir: string,
  allowedDirs: Set<string>,
): string[] {
  const blocked: string[] = []

  for (const name of readdirSync(parentDir)) {
    if (name.startsWith(".")) continue

    const fullPath = join(parentDir, name)

    let isDir: boolean
    try {
      isDir = statSync(fullPath).isDirectory()
    } catch {
      continue
    }

    if (parentDir === home && name === "Library") continue
    if (scriptDir.startsWith(fullPath + "/") || scriptDir === fullPath) continue

    // Files cannot be ancestors — block them directly
    if (!isDir) {
      blocked.push(fullPath)
      continue
    }

    const status = isAllowedOrAncestor(fullPath, allowedDirs)
    if (status === "allowed") continue
    if (status === "ancestor") {
      blocked.push(...collectBlockedDirs(fullPath, home, scriptDir, allowedDirs))
      continue
    }

    blocked.push(fullPath)
  }

  return blocked
}

// --- Ignored path collection ---

function collectProtectedContainers(home: string): string[] {
  const containerDirs = ["Containers", "Group Containers"]
  const matched: string[] = []
  for (const dir of containerDirs) {
    const base = join(home, "Library", dir)
    if (!existsSync(base)) continue
    for (const pattern of PROTECTED_CONTAINER_PATTERNS) {
      matched.push(...globSync(pattern, { cwd: base }).map((m) => join(base, m)))
    }
  }
  return matched
}

export function collectIgnoredPaths(home: string, workDirs: string[]): string[] {
  const ignored: string[] = [
    ...PROTECTED_DOTDIRS.map((d) => join(home, d)),
    ...PROTECTED_HOME_DOTFILES.map((f) => join(home, f)),
    ...PROTECTED_LIBRARY_DIRS.map((d) => join(home, "Library", d)),
    ...new Set(collectProtectedContainers(home)),
  ]

  // Global ~/.bxignore — only plain deny lines (skip RW:/RO: prefixed)
  const globalIgnore = join(home, ".bxignore")
  if (existsSync(globalIgnore)) {
    const denyLines = parseLines(globalIgnore).filter((l) => !ACCESS_PREFIX_RE.test(l))
    for (const line of denyLines) {
      ignored.push(...resolveGlobMatches(line, home))
    }
  }

  for (const workDir of workDirs) {
    collectIgnoreFilesRecursive(workDir, ignored)
  }

  return ignored
}

// --- SBPL profile generation ---

function sbplEscape(path: string): string {
  return path
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

function sbplSubpath(path: string): string {
  return `  (subpath "${sbplEscape(path)}")`
}

function sbplLiteral(path: string): string {
  return `  (literal "${sbplEscape(path)}")`
}

function sbplPathRule(path: string): string {
  let isDir = false
  try { isDir = existsSync(path) && statSync(path).isDirectory() } catch { }
  return isDir ? sbplSubpath(path) : sbplLiteral(path)
}

function sbplDenyBlock(comment: string, verb: string, rules: string[]): string {
  const unique = [...new Set(rules)]
  if (unique.length === 0) return ""
  return `\n; ${comment}\n(deny ${verb}\n${unique.join("\n")}\n)\n`
}

export function collectSystemDenyPaths(home: string): string[] {
  const paths: string[] = []

  // Block /Volumes (external drives, TimeMachine, NAS mounts)
  if (existsSync("/Volumes")) {
    paths.push("/Volumes")
  }

  // Block other users' home directories, but not our own
  try {
    for (const name of readdirSync("/Users")) {
      const userDir = join("/Users", name)
      if (userDir === home || name === "Shared") continue
      try {
        if (statSync(userDir).isDirectory()) {
          paths.push(userDir)
        }
      } catch { /* permission denied */ }
    }
  } catch { /* /Users not readable */ }

  return paths
}

export function generateProfile(
  workDirs: string[],
  blockedDirs: string[],
  ignoredPaths: string[],
  readOnlyDirs: string[] = [],
  home: string = "",
): string {
  const blockedRules = sbplDenyBlock(
    "Blocked paths (auto-generated from $HOME contents)",
    "file*",
    blockedDirs.map(sbplPathRule),
  )

  const ignoredRules = sbplDenyBlock(
    "Hidden paths from .bxignore",
    "file*",
    ignoredPaths.map(sbplPathRule),
  )

  const readOnlyRules = sbplDenyBlock(
    "Read-only directories",
    "file-write*",
    readOnlyDirs.map(sbplSubpath),
  )

  const systemRules = home
    ? sbplDenyBlock("System-level restrictions", "file*", collectSystemDenyPaths(home).map(sbplSubpath))
    : ""

  return `; Auto-generated sandbox profile
; Working directories: ${workDirs.join(", ")}

(version 1)
(allow default)
${blockedRules}${ignoredRules}${readOnlyRules}${systemRules}
`
}
