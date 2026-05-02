import { existsSync, globSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import {
  PROTECTED_DOTDIRS,
  PROTECTED_HOME_DOTFILES,
  PROTECTED_HOME_DOTFILES_RO,
  PROTECTED_LIBRARY_DIRS,
  PROTECTED_CONTAINER_PATTERNS,
  isSelfProtected,
} from "./profile.js"

// --- Types ---

export type AccessLevel = "blocked" | "read-only" | "allowed"

export interface RuleMatch {
  path: string
  access: AccessLevel
  layer: string
  source: {
    type: "hardcoded" | "file"
    value: string
  } | null
}

// --- Layer labels (consistent with spec § Data Model) ---

const LAYER_HARDCODED_DOTDIRS = "hardcoded (blocked dotdirs)"
const LAYER_HARDCODED_DOTFILES = "hardcoded (blocked dotfiles)"
const LAYER_HARDCODED_DOTFILES_RO = "hardcoded (read-only dotfiles)"
const LAYER_HARDCODED_LIBRARY = "hardcoded (protected Library)"
const LAYER_HARDCODED_CONTAINERS = "hardcoded (protected containers)"
const LAYER_HOME_BXIGNORE_DENY = "~/.bxignore deny"
const LAYER_HOME_BXIGNORE_ACCESS = "~/.bxignore rw:/ro:"
const LAYER_WORKDIR_BXIGNORE_DENY = "workdir .bxignore deny"
const LAYER_WORKDIR_BXIGNORE_RO = "workdir .bxignore ro:"
const LAYER_HOME_SCAN_BLOCKED = "home scan (blocked)"
const LAYER_SYSTEM_DENY = "system deny"
const LAYER_WORKDIR_MEMBER = "workdir member"
const LAYER_DEFAULT_ALLOW = "default allow"

// --- Helpers ---

/**
 * Like parseLines in profile.ts but preserves line numbers for source annotations.
 */
function parseLinesWithLineNumbers(filePath: string): Array<{ line: string; num: number }> {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((l, i) => ({ line: l.trim(), num: i + 1 }))
    .filter(({ line }) => line && !line.startsWith("#"))
}

function toGlobPattern(line: string): string {
  if (line.startsWith("/")) return line.slice(1)

  const withoutTrailingSlash = line.endsWith("/") ? line.slice(0, -1) : line
  if (withoutTrailingSlash.includes("/")) return line

  return `**/${line}`
}

const ACCESS_PREFIX_RE = /^(RW|RO):(.+)$/i

/**
 * Expand home-relative paths. ~/foo → /Users/x/foo, ~ → /Users/x
 */
function expandHomePath(home: string, raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === "~") return home
  if (trimmed.startsWith("~/")) return join(home, trimmed.slice(2))
  return resolve(home, trimmed)
}

/**
 * Like fs.realpathSync but returns the input path on error (e.g., ENOENT).
 * Consistency with profile.ts realpathSafe.
 */
function realpathSafe(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/**
 * Check if a path is within or equal to a directory prefix.
 * Both arguments must be normalized absolute paths. `prefix` should be a
 * directory path that represents a genuine scope boundary (e.g., a workdir
 * or a protected directory). Passing root-level paths like HOME as `prefix`
 * can produce false positives when combined with ancestor walks.
 */
function isInOrUnder(target: string, prefix: string): boolean {
  return target === prefix || target.startsWith(prefix + "/")
}

// --- Layer evaluation functions ---

interface LayerCheckContext {
  targetPath: string
  home: string
  workDirs: string[]
  // Pre-parsed .bxignore lines
  homeBxignoreLines: Array<{ line: string; num: number }>
  // Pre-computed allowed/readOnly sets from parseHomeConfig
  allowed: Set<string>
  readOnly: Set<string>
  // Pre-computed home scan blocked set
  blockedHomeDirs: Set<string>
  // Pre-computed system deny paths
  systemDenyPaths: string[]
}

/**
 * Layers 1-4: Hardcoded lists — PROTECTED_DOTDIRS, PROTECTED_HOME_DOTFILES,
 * PROTECTED_HOME_DOTFILES_RO, PROTECTED_LIBRARY_DIRS.
 */
function checkHardcodedList(
  ctx: LayerCheckContext,
  entries: string[],
  layer: string,
  constName: string,
  access: AccessLevel,
  prefixTransform: (entry: string) => string,
  isSubdir: boolean,
): RuleMatch | null {
  for (const entry of entries) {
    const resolved = prefixTransform(entry)
    const match = isSubdir ? isInOrUnder(ctx.targetPath, resolved) : ctx.targetPath === resolved
    if (match) {
      return {
        path: ctx.targetPath,
        access,
        layer,
        source: { type: "hardcoded", value: `${constName} (${entry})` },
      }
    }
  }
  return null
}

/**
 * Layer 5: Protected container patterns under ~/Library/Containers and
 * ~/Library/Group Containers.
 */
function checkProtectedContainers(ctx: LayerCheckContext): RuleMatch | null {
  const containerDirs = ["Containers", "Group Containers"]
  for (const dir of containerDirs) {
    const base = join(ctx.home, "Library", dir)
    if (!existsSync(base)) continue
    for (const pattern of PROTECTED_CONTAINER_PATTERNS) {
      const matches = globSync(pattern, { cwd: base })
      for (const m of matches) {
        const resolved = join(base, m)
        if (isInOrUnder(ctx.targetPath, resolved)) {
          return {
            path: ctx.targetPath,
            access: "blocked",
            layer: LAYER_HARDCODED_CONTAINERS,
            source: { type: "hardcoded", value: `PROTECTED_CONTAINER_PATTERNS (${pattern})` },
          }
        }
      }
    }
  }
  return null
}

/**
 * Layer 6: ~/.bxignore plain deny lines (exclude rw:/ro: lines).
 * Check home-level (resolveTopLevelMatches) and workdir-level (resolveGlobMatchesBatch).
 * Also used per-workdir for layers 8-9.
 */
function checkBxignoreDeny(ctx: LayerCheckContext): RuleMatch | null {
  const denyLines = ctx.homeBxignoreLines.filter(({ line }) => !ACCESS_PREFIX_RE.test(line))
  if (denyLines.length === 0) return null

  // Home-level: top-level matches only
  for (const { line, num } of denyLines) {
    const pattern = toGlobPattern(line)
    try {
      const matches = globSync(pattern, { cwd: ctx.home })
      for (const m of matches) {
        const resolved = resolve(ctx.home, m)
        if (ctx.targetPath === resolved) {
          return {
            path: ctx.targetPath,
            access: "blocked",
            layer: LAYER_HOME_BXIGNORE_DENY,
            source: { type: "file", value: `~/.bxignore:${num}` },
          }
        }
      }
    } catch {
      // glob error — skip
    }
  }

  // Workdir-level: resolveGlobMatchesBatch
  for (const workDir of ctx.workDirs) {
    for (const { line, num } of denyLines) {
      const pattern = toGlobPattern(line)
      try {
        const matches = globSync(pattern, { cwd: workDir })
        for (const m of matches) {
          const resolved = resolve(workDir, m)
          if (ctx.targetPath === resolved) {
            return {
              path: ctx.targetPath,
              access: "blocked",
              layer: LAYER_HOME_BXIGNORE_DENY,
              source: { type: "file", value: `~/.bxignore:${num}` },
            }
          }
        }
      } catch {
        // glob error — skip
      }
    }
  }

  return null
}

/**
 * Layer 7: ~/.bxignore rw:/ro: access overrides from parseHomeConfig.
 */
function checkHomeBxignoreAccess(ctx: LayerCheckContext): RuleMatch | null {
  // rw: → allowed
  if (ctx.allowed.has(ctx.targetPath)) {
    // Find the line number
    const lineNum = findAccessLine(ctx.homeBxignoreLines, "rw", ctx.targetPath, ctx.home)
    return {
      path: ctx.targetPath,
      access: "allowed",
      layer: LAYER_HOME_BXIGNORE_ACCESS,
      source: lineNum ? { type: "file", value: `~/.bxignore:${lineNum}` } : null,
    }
  }
  // ro: → read-only
  if (ctx.readOnly.has(ctx.targetPath)) {
    const lineNum = findAccessLine(ctx.homeBxignoreLines, "ro", ctx.targetPath, ctx.home)
    return {
      path: ctx.targetPath,
      access: "read-only",
      layer: LAYER_HOME_BXIGNORE_ACCESS,
      source: lineNum ? { type: "file", value: `~/.bxignore:${lineNum}` } : null,
    }
  }
  return null
}

/**
 * Find the line number of an rw:/ro: access line that matches the target path.
 */
function findAccessLine(
  lines: Array<{ line: string; num: number }>,
  prefix: string,
  targetPath: string,
  home: string,
): number | null {
  for (const { line, num } of lines) {
    const match = line.match(ACCESS_PREFIX_RE)
    if (!match) continue
    const [, pfx, rawPath] = match
    if (pfx.toLowerCase() !== prefix.toLowerCase()) continue
    const expanded = expandHomePath(home, rawPath.trim())
    if (realpathSafe(expanded) === realpathSafe(targetPath)) return num
    // Also check glob matches in case resolveAccessTargets used glob
    if (existsSync(expanded)) continue // literal match already checked above
    try {
      const matches = globSync(rawPath.trim().replace(/^~\//, ""), { cwd: home })
      for (const m of matches) {
        const resolved = resolve(home, m)
        if (realpathSafe(resolved) === realpathSafe(targetPath)) return num
      }
    } catch { /* skip */ }
  }
  return null
}

/**
 * Layers 8-9: Workdir .bxignore deny and ro: lines.
 *
 * For performance, we don't do a full recursive walk. We check each workdir's
 * .bxignore (top-level only) and its subdirectory .bxignore files that could
 * match based on the target path prefix.
 */
function checkWorkdirBxignore(ctx: LayerCheckContext): RuleMatch[] {
  const results: RuleMatch[] = []

  for (const workDir of ctx.workDirs) {
    // Check workdir root .bxignore
    const ignoreFile = join(workDir, ".bxignore")
    if (!existsSync(ignoreFile)) continue

    const lines = parseLinesWithLineNumbers(ignoreFile)
    for (const { line, num } of lines) {
      if (line === "/" || line === ".") continue

      const accessMatch = line.match(ACCESS_PREFIX_RE)
      if (accessMatch) {
        const [, prefix, rawPath] = accessMatch
        if (prefix.toUpperCase() !== "RO") continue
        // ro: line — check if target matches
        const pattern = toGlobPattern(rawPath.trim())
        try {
          const matches = globSync(pattern, { cwd: workDir })
          for (const m of matches) {
            const resolved = resolve(workDir, m)
            if (resolved === ctx.targetPath) {
              results.push({
                path: ctx.targetPath,
                access: "read-only",
                layer: LAYER_WORKDIR_BXIGNORE_RO,
                source: { type: "file", value: `${workDir}/.bxignore:${num}` },
              })
            }
          }
        } catch { /* skip */ }
      } else {
        // deny line
        const pattern = toGlobPattern(line)
        try {
          const matches = globSync(pattern, { cwd: workDir })
          for (const m of matches) {
            const resolved = resolve(workDir, m)
            if (resolved === ctx.targetPath) {
              results.push({
                path: ctx.targetPath,
                access: "blocked",
                layer: LAYER_WORKDIR_BXIGNORE_DENY,
                source: { type: "file", value: `${workDir}/.bxignore:${num}` },
              })
            }
          }
        } catch { /* skip */ }
      }
    }

    // Also check subdirectory .bxignore files along the path prefix
    // Walk from workdir towards targetPath, checking .bxignore at each level
    if (!ctx.targetPath.startsWith(workDir + "/")) continue
    let currentDir = ctx.targetPath
    while (currentDir.startsWith(workDir + "/") && currentDir !== workDir) {
      currentDir = currentDir.substring(0, currentDir.lastIndexOf("/"))
      if (currentDir === workDir) break // already checked

      const subIgnore = join(currentDir, ".bxignore")
      if (existsSync(subIgnore) && !isSelfProtected(currentDir)) {
        const subLines = parseLinesWithLineNumbers(subIgnore)
        for (const { line, num } of subLines) {
          if (line === "/" || line === ".") continue

          const accessMatch = line.match(ACCESS_PREFIX_RE)
          if (accessMatch) {
            const [, prefix, rawPath] = accessMatch
            if (prefix.toUpperCase() !== "RO") continue
            const pattern = toGlobPattern(rawPath.trim())
            try {
              const matches = globSync(pattern, { cwd: currentDir })
              for (const m of matches) {
                const resolved = resolve(currentDir, m)
                if (resolved === ctx.targetPath) {
                  results.push({
                    path: ctx.targetPath,
                    access: "read-only",
                    layer: LAYER_WORKDIR_BXIGNORE_RO,
                    source: { type: "file", value: `${currentDir}/.bxignore:${num}` },
                  })
                }
              }
            } catch { /* skip */ }
          } else {
            const pattern = toGlobPattern(line)
            try {
              const matches = globSync(pattern, { cwd: currentDir })
              for (const m of matches) {
                const resolved = resolve(currentDir, m)
                if (resolved === ctx.targetPath) {
                  results.push({
                    path: ctx.targetPath,
                    access: "blocked",
                    layer: LAYER_WORKDIR_BXIGNORE_DENY,
                    source: { type: "file", value: `${currentDir}/.bxignore:${num}` },
                  })
                }
              }
            } catch { /* skip */ }
          }
        }
      }

      // If self-protected, stop walking up
      if (isSelfProtected(currentDir)) break
    }
  }

  return results
}

/**
 * Layer 10: Home scan (blocked) — check if targetPath is in or under
 * any top-level dir that would be blocked by collectBlockedDirs.
 *
 * Performance optimization: for a single path, we just check if its
 * parent (or ancestor up to home level) is a top-level $HOME directory
 * that would be blocked. We don't do the full recursive walk.
 */
function checkHomeScanBlocked(ctx: LayerCheckContext): RuleMatch | null {
  // Check if targetPath itself (or one of its ancestor dirs under HOME)
  // is a blocked directory.
  let current = ctx.targetPath
  while (current.startsWith(ctx.home + "/") || current === ctx.home) {
    if (current === ctx.home) break
    if (ctx.blockedHomeDirs.has(current)) {
      return {
        path: ctx.targetPath,
        access: "blocked",
        layer: LAYER_HOME_SCAN_BLOCKED,
        source: null,
      }
    }
    current = current.substring(0, current.lastIndexOf("/"))
  }

  return null
}

/**
 * Layer 11: System deny — /Volumes and other users' home directories.
 */
function checkSystemDeny(ctx: LayerCheckContext): RuleMatch | null {
  for (const denyPath of ctx.systemDenyPaths) {
    if (isInOrUnder(ctx.targetPath, denyPath)) {
      return {
        path: ctx.targetPath,
        access: "blocked",
        layer: LAYER_SYSTEM_DENY,
        source: null,
      }
    }
  }
  return null
}

/**
 * Layer 12: Workdir membership — path is within any workdir.
 */
function checkWorkdirMember(ctx: LayerCheckContext): RuleMatch | null {
  for (const workDir of ctx.workDirs) {
    if (isInOrUnder(ctx.targetPath, workDir)) {
      return {
        path: ctx.targetPath,
        access: "allowed",
        layer: LAYER_WORKDIR_MEMBER,
        source: null,
      }
    }
  }
  return null
}

/**
 * Layer 13: Default allow — always emitted if no effective match before it.
 */
function checkDefaultAllow(ctx: LayerCheckContext): RuleMatch {
  return {
    path: ctx.targetPath,
    access: "allowed",
    layer: LAYER_DEFAULT_ALLOW,
    source: null,
  }
}

// --- Collect blocked home dirs for layer 10 ---

/**
 * Lightweight version: collect top-level $HOME entries (files and dirs)
 * that would be blocked, for matching against a single targetPath.
 *
 * This is simpler than collectBlockedDirs — we just need to know which
 * top-level $HOME entries are blocked. We don't recurse into them.
 */
function collectBlockedHomeEntries(
  home: string,
  allowedDirs: Set<string>,
): Set<string> {
  const blocked = new Set<string>()
  const SCAN_EXCLUDE = new Set(["Library", "Applications"])
  // Also exclude protected entries that are handled by layers 1-4
  const PROTECTED_DIR_SET = new Set(PROTECTED_DOTDIRS.map((d) => join(home, d)))
  const PROTECTED_FILE_SET = new Set([
    ...PROTECTED_HOME_DOTFILES.map((f) => join(home, f)),
    ...PROTECTED_HOME_DOTFILES_RO.map((f) => join(home, f)),
  ])

  let entries: string[]
  try {
    entries = readdirSync(home)
  } catch {
    return blocked
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue
    if (SCAN_EXCLUDE.has(name)) continue

    const fullPath = join(home, name)
    // Skip protected entries already handled by hardcoded layers
    if (PROTECTED_DIR_SET.has(fullPath) || PROTECTED_FILE_SET.has(fullPath)) continue

    if (allowedDirs.has(fullPath)) continue
    // Also skip if any allowed dir is a child of this dir
    const isAllowedAncestor = [...allowedDirs].some((d) => d.startsWith(fullPath + "/"))
    if (isAllowedAncestor) continue

    try {
      if (statSync(fullPath).isDirectory()) {
        blocked.add(fullPath)
      } else {
        blocked.add(fullPath)
      }
    } catch {
      continue
    }
  }

  return blocked
}

// --- System deny ---

function collectSystemDenyPathsSimple(home: string): string[] {
  const paths: string[] = []

  if (existsSync("/Volumes")) {
    paths.push("/Volumes")
  }

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

// --- Main entry point ---

export function tracePath(
  targetPath: string,
  home: string,
  workDirs: string[],
  config: {
    allowed: Set<string>
    readOnly: Set<string>
  },
): RuleMatch[] {
  const matches: RuleMatch[] = []

  // Pre-parse ~/.bxignore
  const homeBxignoreLines = parseLinesWithLineNumbers(join(home, ".bxignore"))

  // Pre-compute blocked home dirs (layer 10)
  const blockedHomeDirs = collectBlockedHomeEntries(home, config.allowed)

  // Pre-compute system deny paths (layer 11)
  const systemDenyPaths = collectSystemDenyPathsSimple(home)

  const ctx: LayerCheckContext = {
    targetPath,
    home,
    workDirs,
    homeBxignoreLines,
    allowed: config.allowed,
    readOnly: config.readOnly,
    blockedHomeDirs,
    systemDenyPaths,
  }

  // Layer 1: PROTECTED_DOTDIRS (blocked)
  const l1 = checkHardcodedList(
    ctx,
    PROTECTED_DOTDIRS,
    LAYER_HARDCODED_DOTDIRS,
    "PROTECTED_DOTDIRS",
    "blocked",
    (e) => join(home, e),
    true,
  )
  if (l1) matches.push(l1)

  // Layer 2: PROTECTED_HOME_DOTFILES (blocked)
  const l2 = checkHardcodedList(
    ctx,
    PROTECTED_HOME_DOTFILES,
    LAYER_HARDCODED_DOTFILES,
    "PROTECTED_HOME_DOTFILES",
    "blocked",
    (e) => join(home, e),
    false,
  )
  if (l2) matches.push(l2)

  // Layer 3: PROTECTED_HOME_DOTFILES_RO (read-only)
  const l3 = checkHardcodedList(
    ctx,
    PROTECTED_HOME_DOTFILES_RO,
    LAYER_HARDCODED_DOTFILES_RO,
    "PROTECTED_HOME_DOTFILES_RO",
    "read-only",
    (e) => join(home, e),
    false,
  )
  if (l3) matches.push(l3)

  // Layer 4: PROTECTED_LIBRARY_DIRS (blocked)
  const l4 = checkHardcodedList(
    ctx,
    PROTECTED_LIBRARY_DIRS,
    LAYER_HARDCODED_LIBRARY,
    "PROTECTED_LIBRARY_DIRS",
    "blocked",
    (e) => join(home, "Library", e),
    true,
  )
  if (l4) matches.push(l4)

  // Layer 5: Protected container patterns
  const l5 = checkProtectedContainers(ctx)
  if (l5) matches.push(l5)

  // Layer 6: ~/.bxignore plain deny
  const l6 = checkBxignoreDeny(ctx)
  if (l6) matches.push(l6)

  // Layer 7: ~/.bxignore rw:/ro: access overrides
  const l7 = checkHomeBxignoreAccess(ctx)
  if (l7) matches.push(l7)

  // Layers 8-9: Workdir .bxignore deny and ro:
  const workdirResults = checkWorkdirBxignore(ctx)
  for (const r of workdirResults) {
    matches.push(r)
  }

  // Layer 10: Home scan (blocked)
  const l10 = checkHomeScanBlocked(ctx)
  if (l10) matches.push(l10)

  // Layer 11: System deny
  const l11 = checkSystemDeny(ctx)
  if (l11) matches.push(l11)

  // Layer 12: Workdir membership
  const l12 = checkWorkdirMember(ctx)
  if (l12) matches.push(l12)

  // Layer 13: Default allow (always last)
  const l13 = checkDefaultAllow(ctx)
  matches.push(l13)

  return matches
}
