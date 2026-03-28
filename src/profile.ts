import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const PROTECTED_DOTDIRS = [
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
 * Parse ~/.bxallow and return a set of all allowed directories.
 */
export function parseAllowedDirs(home: string, workDir: string): Set<string> {
  const allowed = new Set([workDir])
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
 */
export function collectIgnoredPaths(home: string, workDir: string): string[] {
  const ignored: string[] = PROTECTED_DOTDIRS.map((d) => join(home, d))

  for (const [filePath, baseDir] of [
    [join(home, ".bxignore"), home],
    [join(workDir, ".bxignore"), workDir],
  ]) {
    for (const line of parseLines(filePath)) {
      for (const match of globSync(line, { cwd: baseDir })) {
        ignored.push(resolve(baseDir, match))
      }
    }
  }

  return ignored
}

/**
 * Generate the SBPL sandbox profile string.
 */
export function generateProfile(workDir: string, blockedDirs: string[], ignoredPaths: string[]): string {
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
; Working directory: ${workDir}

(version 1)
(allow default)

; Blocked directories (auto-generated from $HOME contents)
(deny file*
${denyRules}
)
${ignoredRules}
`
}
