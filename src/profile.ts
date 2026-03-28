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

/**
 * Parse a config file with one entry per line (supports # comments).
 */
function parseLines(filePath: string): string[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
}

/**
 * Convert a .bxignore line to a glob pattern following .gitignore semantics:
 * - Leading "/" anchors to the base dir (stripped before globbing)
 * - Patterns without "/" (except trailing) match recursively via ** / prefix
 * - Patterns with "/" (non-leading, non-trailing) are relative to baseDir
 * - Trailing "/" marks directories only and doesn't count as path separator
 */
function toGlobPattern(line: string): string {
  // Leading "/" → anchored to base dir, use as-is (strip the slash)
  if (line.startsWith("/")) return line.slice(1)

  // Strip trailing "/" (directory marker) for the slash check
  const stripped = line.endsWith("/") ? line.slice(0, -1) : line

  // Contains "/" → already a relative path, use as-is
  if (stripped.includes("/")) return line

  // No slash → match anywhere in the tree
  return `**/${line}`
}

/**
 * Apply a single .bxignore file: resolve glob patterns relative to baseDir.
 */
function applyIgnoreFile(filePath: string, baseDir: string, ignored: string[]) {
  for (const line of parseLines(filePath)) {
    for (const match of globSync(toGlobPattern(line), { cwd: baseDir })) {
      ignored.push(resolve(baseDir, match))
    }
  }
}

/**
 * Recursively find and apply .bxignore files in a directory tree.
 */
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

export interface HomeConfig {
  allowed: Set<string>
  readOnly: Set<string>
}

/**
 * Parse ~/.bxignore for RW:/RO: prefixed lines and return allowed directories.
 * Lines without prefix are ignored here (handled by collectIgnoredPaths).
 * Also checks for deprecated ~/.bxallow and migrates its entries.
 */
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

  // Parse RW:/RO: entries from ~/.bxignore
  for (const line of parseLines(join(home, ".bxignore"))) {
    let prefix = ""
    let path = line
    const match = line.match(/^(RW|RO):(.+)$/i)
    if (match) {
      prefix = match[1].toUpperCase()
      path = match[2].trim()
    }

    if (!prefix) continue // plain deny lines handled elsewhere

    const absolute = resolve(home, path)
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue

    if (prefix === "RW") {
      allowed.add(absolute)
    } else {
      readOnly.add(absolute)
    }
  }

  return { allowed, readOnly }
}

/**
 * Recursively collect directories to block under parentDir.
 * Never blocks a parent of an allowed path — instead descends and blocks siblings.
 */
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
      continue // Permission denied or similar — skip
    }
    if (!isDir) continue
    if (parentDir === home && name === "Library") continue
    if (scriptDir.startsWith(fullPath + "/") || scriptDir === fullPath) continue
    if (allowedDirs.has(fullPath)) continue

    const hasAllowedChild = [...allowedDirs].some(
      (d) => d.startsWith(fullPath + "/")
    )
    if (hasAllowedChild) {
      blocked.push(...collectBlockedDirs(fullPath, home, scriptDir, allowedDirs))
      continue
    }

    blocked.push(fullPath)
  }

  return blocked
}

/**
 * Collect paths to deny from .bxignore files and built-in protected dotdirs.
 * Searches ~/.bxignore (skipping RW:/RO: lines) and recursively through all workdirs.
 */
export function collectIgnoredPaths(home: string, workDirs: string[]): string[] {
  const ignored: string[] = PROTECTED_DOTDIRS.map((d) => join(home, d))

  // Global ~/.bxignore — only plain lines (deny), skip RW:/RO: prefixed lines
  const globalIgnore = join(home, ".bxignore")
  if (existsSync(globalIgnore)) {
    const denyLines = parseLines(globalIgnore).filter((l) => !l.match(/^(RW|RO):/i))
    for (const line of denyLines) {
      for (const match of globSync(toGlobPattern(line), { cwd: home })) {
        ignored.push(resolve(home, match))
      }
    }
  }

  // Recursive .bxignore in each workdir and its subdirectories
  for (const workDir of workDirs) {
    collectIgnoreFilesRecursive(workDir, ignored)
  }

  return ignored
}

/**
 * Generate the SBPL sandbox profile string.
 */
export function generateProfile(workDirs: string[], blockedDirs: string[], ignoredPaths: string[], readOnlyDirs: string[] = []): string {
  const denyRules = blockedDirs
    .map((dir) => `  (subpath "${dir}")`)
    .join("\n")

  const ignoredRules = ignoredPaths.length > 0
    ? `\n; Hidden paths from .bxignore\n(deny file*\n${ignoredPaths.map((p) => {
        let isDir = false
        try { isDir = existsSync(p) && statSync(p).isDirectory() } catch {}
        return isDir ? `  (subpath "${p}")` : `  (literal "${p}")`
      }).join("\n")}\n)\n`
    : ""

  const readOnlyRules = readOnlyDirs.length > 0
    ? `\n; Read-only directories\n(deny file-write*\n${readOnlyDirs.map((dir) => `  (subpath "${dir}")`).join("\n")}\n)\n`
    : ""

  return `; Auto-generated sandbox profile
; Working directories: ${workDirs.join(", ")}

(version 1)
(allow default)

; Blocked directories (auto-generated from $HOME contents)
(deny file*
${denyRules}
)
${ignoredRules}${readOnlyRules}
`
}
