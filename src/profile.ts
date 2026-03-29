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

// --- Ignore file collection ---

function applyIgnoreFile(filePath: string, baseDir: string, ignored: string[]) {
  for (const line of parseLines(filePath)) {
    ignored.push(...resolveGlobMatches(line, baseDir))
  }
}

function collectIgnoreFilesRecursive(dir: string, ignored: string[]) {
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

  // Deprecated: migrate ~/.bxallow entries as RW
  const bxallowPath = join(home, ".bxallow")
  if (existsSync(bxallowPath)) {
    console.error("sandbox: WARNING — ~/.bxallow is deprecated. Move entries to ~/.bxignore with RW: prefix.")
    for (const line of parseLines(bxallowPath)) {
      const absolute = resolve(home, line)
      if (existsSync(absolute) && statSync(absolute).isDirectory()) {
        allowed.add(absolute)
      }
    }
  }

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
    if (!isDir) continue
    if (parentDir === home && name === "Library") continue
    if (scriptDir.startsWith(fullPath + "/") || scriptDir === fullPath) continue

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

export function collectIgnoredPaths(home: string, workDirs: string[]): string[] {
  const ignored: string[] = PROTECTED_DOTDIRS.map((d) => join(home, d))

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
  return path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function sbplSubpath(path: string): string {
  return `  (subpath "${sbplEscape(path)}")`
}

function sbplLiteral(path: string): string {
  return `  (literal "${sbplEscape(path)}")`
}

function sbplPathRule(path: string): string {
  let isDir = false
  try { isDir = existsSync(path) && statSync(path).isDirectory() } catch {}
  return isDir ? sbplSubpath(path) : sbplLiteral(path)
}

function sbplDenyBlock(comment: string, verb: string, rules: string[]): string {
  if (rules.length === 0) return ""
  return `\n; ${comment}\n(deny ${verb}\n${rules.join("\n")}\n)\n`
}

export function generateProfile(
  workDirs: string[],
  blockedDirs: string[],
  ignoredPaths: string[],
  readOnlyDirs: string[] = [],
): string {
  const blockedRules = sbplDenyBlock(
    "Blocked directories (auto-generated from $HOME contents)",
    "file*",
    blockedDirs.map(sbplSubpath),
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

  return `; Auto-generated sandbox profile
; Working directories: ${workDirs.join(", ")}

(version 1)
(allow default)
${blockedRules}${ignoredRules}${readOnlyRules}
`
}
