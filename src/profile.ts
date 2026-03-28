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
 * Apply a single .bxignore file: resolve glob patterns relative to baseDir.
 */
function applyIgnoreFile(filePath: string, baseDir: string, ignored: string[]) {
  for (const line of parseLines(filePath)) {
    for (const match of globSync(line, { cwd: baseDir })) {
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

/**
 * Parse ~/.bxallow and return a set of all allowed directories.
 */
export function parseAllowedDirs(home: string, workDirs: string[]): Set<string> {
  const allowed = new Set(workDirs)
  for (const line of parseLines(join(home, ".bxallow"))) {
    const absolute = resolve(home, line)
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      allowed.add(absolute)
    }
  }
  return allowed
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

    if (!statSync(fullPath).isDirectory()) continue
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
 * Searches ~/.bxignore and recursively through all workdirs.
 */
export function collectIgnoredPaths(home: string, workDirs: string[]): string[] {
  const ignored: string[] = PROTECTED_DOTDIRS.map((d) => join(home, d))

  // Global ~/.bxignore
  applyIgnoreFile(join(home, ".bxignore"), home, ignored)

  // Recursive .bxignore in each workdir and its subdirectories
  for (const workDir of workDirs) {
    collectIgnoreFilesRecursive(workDir, ignored)
  }

  return ignored
}

/**
 * Generate the SBPL sandbox profile string.
 */
export function generateProfile(workDirs: string[], blockedDirs: string[], ignoredPaths: string[]): string {
  const denyRules = blockedDirs
    .map((dir) => `  (subpath "${dir}")`)
    .join("\n")

  const ignoredRules = ignoredPaths.length > 0
    ? `\n; Hidden paths from .bxignore\n(deny file*\n${ignoredPaths.map((p) => {
        const isDir = existsSync(p) && statSync(p).isDirectory()
        return isDir ? `  (subpath "${p}")` : `  (literal "${p}")`
      }).join("\n")}\n)\n`
    : ""

  return `; Auto-generated sandbox profile
; Working directories: ${workDirs.join(", ")}

(version 1)
(allow default)

; Blocked directories (auto-generated from $HOME contents)
(deny file*
${denyRules}
)
${ignoredRules}
`
}
