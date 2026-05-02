import { writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs"
import { join } from "node:path"

import {
  PROTECTED_DOTDIRS,
  PROTECTED_HOME_DOTFILES,
  PROTECTED_HOME_DOTFILES_RO,
  PROTECTED_LIBRARY_DIRS,
  parseHomeConfig,
  collectBlockedDirs,
  collectSystemDenyPaths,
  collectReadOnlyDotfiles,
  collectIgnoredPaths,
  collectProtectedContainers,
} from "./profile.js"

// --- Types ---

export type AccessLevel = "blocked" | "read-only" | "allowed"

export interface SnapshotEntry {
  path: string
  access: AccessLevel
  layer: string
  source: string | null
}

export interface Snapshot {
  version: string
  created: string
  home: string
  workdirs: string[]
  entries: SnapshotEntry[]
}

// --- Layer labels (must match tracer.ts for consistency) ---

const LAYER_HARDCODED_DOTDIRS = "hardcoded (blocked dotdirs)"
const LAYER_HARDCODED_DOTFILES = "hardcoded (blocked dotfiles)"
const LAYER_HARDCODED_DOTFILES_RO = "hardcoded (read-only dotfiles)"
const LAYER_HARDCODED_LIBRARY = "hardcoded (protected Library)"
const LAYER_HOME_BXIGNORE_DENY = "~/.bxignore deny"
const LAYER_HOME_BXIGNORE_ACCESS = "~/.bxignore rw:/ro:"
const LAYER_WORKDIR_BXIGNORE_DENY = "workdir .bxignore deny"
const LAYER_HOME_SCAN_BLOCKED = "home scan (blocked)"
const LAYER_SYSTEM_DENY = "system deny"

// --- Snapshot builder ---

/**
 * Build a Snapshot by enumerating each provenance layer independently.
 *
 * The function signature takes only (home, workDirs) and internally
 * computes allowed/readOnly sets via parseHomeConfig — snapshot building
 * does not depend on a specific app launch mode, so deriving these sets
 * internally is simpler for callers.
 *
 * We re-run each layer's collection logic separately rather than reusing
 * collectIgnoredPaths (which merges 5+ layers). This guarantees correct
 * provenance tagging at the cost of redundant work (~2x collection time,
 * well within the 2s budget).
 */
export function buildSnapshot(
  home: string,
  workDirs: string[],
): Snapshot {
  const entries: SnapshotEntry[] = []

  const rp = (p: string): string => {
    try { return realpathSync(p) } catch { return p }
  }
  const { allowed, readOnly } = parseHomeConfig(home, workDirs)
  const allAccessible = new Set([...allowed, ...readOnly])

  // Realpath'd workdirs for path prefix comparisons
  const realWorkDirs = workDirs.map(rp)

  // Layer 1: PROTECTED_DOTDIRS (blocked)
  for (const d of PROTECTED_DOTDIRS) {
    const p = join(home, d)
    entries.push({
      path: p,
      access: "blocked",
      layer: LAYER_HARDCODED_DOTDIRS,
      source: "PROTECTED_DOTDIRS",
    })
  }

  // Layer 2: PROTECTED_HOME_DOTFILES (blocked)
  for (const f of PROTECTED_HOME_DOTFILES) {
    const p = join(home, f)
    entries.push({
      path: p,
      access: "blocked",
      layer: LAYER_HARDCODED_DOTFILES,
      source: "PROTECTED_HOME_DOTFILES",
    })
  }

  // Layer 3: PROTECTED_HOME_DOTFILES_RO (read-only)
  // Use collectReadOnlyDotfiles so overridden paths are excluded.
  const roDfPaths = collectReadOnlyDotfiles(home, allAccessible)
  for (const p of roDfPaths) {
    entries.push({
      path: p,
      access: "read-only",
      layer: LAYER_HARDCODED_DOTFILES_RO,
      source: "PROTECTED_HOME_DOTFILES_RO",
    })
  }

  // Layer 4: PROTECTED_LIBRARY_DIRS (blocked)
  for (const d of PROTECTED_LIBRARY_DIRS) {
    const p = join(home, "Library", d)
    entries.push({
      path: p,
      access: "blocked",
      layer: LAYER_HARDCODED_LIBRARY,
      source: "PROTECTED_LIBRARY_DIRS",
    })
  }

  // Layer 5: PROTECTED_CONTAINER_PATTERNS (blocked)
  // Container dirs matching password-manager patterns under
  // ~/Library/Containers and ~/Library/Group Containers.
  const containerPaths = collectProtectedContainers(home)
  for (const p of containerPaths) {
    entries.push({
      path: p,
      access: "blocked",
      layer: "hardcoded (protected containers)",
      source: "PROTECTED_CONTAINER_PATTERNS",
    })
  }

  // --- Build a quick look-aside of global deny patterns for disambiguation ---
  const bxIgnorePath = join(home, ".bxignore")
  const globalDenyPatterns: string[] = []
  if (existsSync(bxIgnorePath)) {
    const lines = readFileSync(bxIgnorePath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
    const ACCESS_PREFIX_RE_HOME = /^(RW|RO):(.+)$/i
    for (const line of lines) {
      if (!ACCESS_PREFIX_RE_HOME.test(line)) {
        globalDenyPatterns.push(line)
      }
    }
  }

  // Strip leading/trailing slashes from a .bxignore pattern to get a
  // comparable bare name. Used by isGlobalDenyInWorkdir below.
  const trimToGlob = (pattern: string): string | null => {
    let p = pattern
    if (p.startsWith("/")) p = p.slice(1)
    if (p.endsWith("/")) p = p.slice(0, -1)
    return p || null
  }

  // Check if a path matches a ~/.bxignore plain deny pattern as applied
  // within a workdir (via resolveGlobMatchesBatch in collectIgnoredPaths).
  const isGlobalDenyInWorkdir = (p: string): boolean => {
    if (globalDenyPatterns.length === 0) return false
    for (const pattern of globalDenyPatterns) {
      const trimmed = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern
      const startsWithSlash = trimmed.startsWith("/")
      const segments = startsWithSlash ? [trimmed.slice(1)] : [trimmed, `**/${trimmed}`]
      for (const wd of workDirs) {
        for (const seg of segments) {
          const expected = seg.startsWith("**/") ? join(wd, seg.slice(3)) : join(wd, seg)
          if (p === expected || p.startsWith(expected + "/") || p.startsWith(expected)) {
            return true
          }
        }
      }
      // Also check direct home-level matches for completeness
      const globPattern = trimToGlob(trimmed)
      if (globPattern && p.startsWith(join(home, globPattern))) {
        return false // home-level match, not workdir-level
      }
    }
    return false
  }

  // Layer 6: ~/.bxignore plain deny lines — top-level home matches
  // Layer 7: ~/.bxignore rw:/ro: access overrides
  // Layer 8: workdir .bxignore deny
  //
  // collectIgnoredPaths merges layers 1-5 (hardcoded), 6-9 (bxignore).
  // We use it as the superset, then subtract hardcoded entries (layers 1-5)
  // that we've already tagged. The remaining entries come from bxignore layers.
  const allIgnored = collectIgnoredPaths(home, workDirs, allAccessible, readOnly)

  // Build a set of hardcoded paths we've already tagged in layers 1-5
  const hardcodedPaths = new Set<string>()
  for (const e of entries) {
    hardcodedPaths.add(e.path)
  }

  // Sets for later layers
  const blockedDirSet = new Set(collectBlockedDirs(home, home, "", allAccessible))
  const systemDenySet = new Set(collectSystemDenyPaths(home))
  const rwPaths = new Set(allowed)
  const roPaths = new Set(readOnly)

  for (const p of allIgnored) {
    if (hardcodedPaths.has(p)) continue

    // Determine provenance: rw:/ro: override, or bxignore deny
    if (rwPaths.has(p)) {
      entries.push({
        path: p,
        access: "allowed",
        layer: LAYER_HOME_BXIGNORE_ACCESS,
        source: "~/.bxignore",
      })
      hardcodedPaths.add(p)
    } else if (roPaths.has(p)) {
      entries.push({
        path: p,
        access: "read-only",
        layer: LAYER_HOME_BXIGNORE_ACCESS,
        source: "~/.bxignore",
      })
      hardcodedPaths.add(p)
    } else {
      // Must be a bxignore deny. Disambiguate:
      //   - ~/.bxignore plain deny applied within a workdir → "~/.bxignore deny"
      //   - workdir .bxignore deny                              → "workdir .bxignore deny"
      //   - ~/.bxignore plain deny at home level                → "~/.bxignore deny"
      let layer = LAYER_HOME_BXIGNORE_DENY

      // Check if path is under a workdir AND has a workdir-level .bxignore
      for (const wd of workDirs) {
        if (p.startsWith(wd + "/") || p === wd) {
          // Is it from a workdir-level .bxignore, or from global deny patterns
          // applied into this workdir? Check if a globalDenyPattern can reach it.
          if (isGlobalDenyInWorkdir(p)) {
            // Matched by ~/.bxignore plain deny line applied into a workdir
            layer = LAYER_HOME_BXIGNORE_DENY
          } else {
            // Workdir-level .bxignore deny
            layer = LAYER_WORKDIR_BXIGNORE_DENY
          }
          break
        }
      }

      entries.push({
        path: p,
        access: "blocked",
        layer,
        source: null,
      })
      hardcodedPaths.add(p)
    }
  }

  // --- Add ~/.bxignore rw:/ro: override entries that were excluded ---
  // from allIgnored (collectIgnoredPaths filters out overridden paths).
  // Also add workdir .bxignore ro: entries populated as a side-effect
  // into the readOnly Set by collectIgnoreFilesRecursive.

  // Step 6a: ~/.bxignore rw: overrides
  for (const p of allowed) {
    if (hardcodedPaths.has(p)) continue
    entries.push({
      path: p,
      access: "allowed",
      layer: LAYER_HOME_BXIGNORE_ACCESS,
      source: "~/.bxignore",
    })
    hardcodedPaths.add(p)
  }

  // Step 6b: ~/.bxignore ro: overrides (from parseHomeConfig) and
  // workdir .bxignore ro: entries (from collectIgnoreFilesRecursive side-effect).
  // These are paths matched by `ro:` directives either in ~/.bxignore or workdir.
  for (const p of readOnly) {
    if (hardcodedPaths.has(p)) continue
    // Determine origin: ~/.bxignore vs workdir .bxignore.
    // Compare against realpath'd workdirs since readOnly set entries are realpath'd.
    let layer: string
    let source: string | null
    const isUnderWorkdir = realWorkDirs.some(
      (wd) => p.startsWith(wd + "/") || p === wd,
    )
    if (isUnderWorkdir) {
      // Workdir .bxignore ro: entries cannot be from ~/.bxignore ro:
      // (parseHomeConfig only expands ~/-relative paths), so if it's
      // under a workdir, it came from collectIgnoreFilesRecursive.
      layer = "workdir .bxignore ro:"
      source = null
    } else {
      layer = LAYER_HOME_BXIGNORE_ACCESS
      source = "~/.bxignore"
    }
    entries.push({
      path: p,
      access: "read-only",
      layer,
      source,
    })
    hardcodedPaths.add(p)
  }

  // Layer 10: Home scan blocked dirs (add if not already present)
  for (const d of blockedDirSet) {
    if (hardcodedPaths.has(d)) continue
    entries.push({
      path: d,
      access: "blocked",
      layer: LAYER_HOME_SCAN_BLOCKED,
      source: null,
    })
    hardcodedPaths.add(d)
  }

  // Layer 11: System deny paths
  for (const d of systemDenySet) {
    if (hardcodedPaths.has(d)) continue
    entries.push({
      path: d,
      access: "blocked",
      layer: LAYER_SYSTEM_DENY,
      source: null,
    })
    hardcodedPaths.add(d)
  }

  // Layer 12: Workdir membership — add each workdir root
  for (const wd of workDirs) {
    if (hardcodedPaths.has(wd)) continue
    entries.push({
      path: wd,
      access: "allowed",
      layer: "workdir member",
      source: null,
    })
    hardcodedPaths.add(wd)
  }

  // --- Deduplicate by path, keeping highest priority (lowest layer number) ---
  // User-configured rw:/ro: overrides beat hardcoded defaults.
  // Hardcoded blocks beat automatic scans (home scan, system deny).
  const layerPriority: Record<string, number> = {
    // Override layers (highest priority — user explicit intent)
    [LAYER_HOME_BXIGNORE_ACCESS]: 1,     // ~/.bxignore rw:/ro:
    "workdir .bxignore ro:": 2,          // workdir .bxignore ro:
    // Hardcoded protection layers
    [LAYER_HARDCODED_DOTDIRS]: 5,
    [LAYER_HARDCODED_DOTFILES]: 6,
    [LAYER_HARDCODED_DOTFILES_RO]: 7,
    [LAYER_HARDCODED_LIBRARY]: 8,
    "hardcoded (protected containers)": 9,
    // bxignore deny layers
    [LAYER_HOME_BXIGNORE_DENY]: 10,
    [LAYER_WORKDIR_BXIGNORE_DENY]: 11,
    // Automatic scan layers (lowest priority)
    [LAYER_HOME_SCAN_BLOCKED]: 15,
    [LAYER_SYSTEM_DENY]: 16,
    "workdir member": 20,
  }

  const deduped = new Map<string, SnapshotEntry>()
  for (const e of entries) {
    const existing = deduped.get(e.path)
    if (!existing) {
      deduped.set(e.path, e)
    } else {
      const existingPrio = layerPriority[existing.layer] ?? 99
      const newPrio = layerPriority[e.layer] ?? 99
      if (newPrio < existingPrio) {
        deduped.set(e.path, e)
      }
    }
  }

  return {
    version: "1.0.0",
    created: new Date().toISOString(),
    home,
    workdirs: workDirs,
    entries: [...deduped.values()],
  }
}

// --- I/O ---

const SNAPSHOT_FILENAME = ".bxpolicy.snapshot"

/**
 * Write a Snapshot to ~/.bxpolicy.snapshot with secure permissions (0o600).
 * Overwrites any existing file.
 */
export function writeSnapshot(snapshot: Snapshot): void {
  const path = join(snapshot.home, SNAPSHOT_FILENAME)
  writeFileSync(path, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
}

/**
 * Read a snapshot from ~/.bxpolicy.snapshot.
 * Throws if the file does not exist or contains invalid JSON.
 * Emits a warning on stderr if the format version's major number differs from 1.
 */
export function readSnapshot(home: string): Snapshot {
  const path = join(home, SNAPSHOT_FILENAME)
  if (!existsSync(path)) {
    throw new Error(
      `No snapshot found at ${path}. Run 'bx snapshot' first.`,
    )
  }
  const raw = readFileSync(path, "utf-8")
  let snapshot: Snapshot
  try {
    snapshot = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in ${path}. Delete it and run 'bx snapshot' again.`)
  }
  // Version check: if major version differs, warn
  if (snapshot.version && snapshot.version.split(".")[0] !== "1") {
    console.error(
      `Warning: snapshot version ${snapshot.version} is from a different format version. Results may be inaccurate.`,
    )
  }
  return snapshot
}

// --- Diff ---

export interface DiffEntry {
  type: "added" | "removed" | "changed"
  path: string
  old?: { access: AccessLevel; layer: string }
  new?: { access: AccessLevel; layer: string }
}

export interface DiffResult {
  added: DiffEntry[]
  removed: DiffEntry[]
  changed: DiffEntry[]
  unchanged: number
}

/**
 * Compare two Snapshots and return structural differences.
 * Matches on `path` (exact string equality).
 */
export function diffSnapshots(old: Snapshot, current: Snapshot): DiffResult {
  const oldMap = new Map<string, SnapshotEntry>()
  const currentMap = new Map<string, SnapshotEntry>()

  for (const entry of old.entries) {
    oldMap.set(entry.path, entry)
  }
  for (const entry of current.entries) {
    currentMap.set(entry.path, entry)
  }

  const added: DiffEntry[] = []
  const removed: DiffEntry[] = []
  const changed: DiffEntry[] = []
  let unchanged = 0

  // Added: in current but not in old
  for (const [path, entry] of currentMap) {
    if (!oldMap.has(path)) {
      added.push({ type: "added", path, new: { access: entry.access, layer: entry.layer } })
    }
  }

  // Removed: in old but not in current
  for (const [path, entry] of oldMap) {
    if (!currentMap.has(path)) {
      removed.push({ type: "removed", path, old: { access: entry.access, layer: entry.layer } })
    }
  }

  // Changed: in both but different access or layer
  for (const [path, currentEntry] of currentMap) {
    const oldEntry = oldMap.get(path)
    if (oldEntry) {
      if (oldEntry.access !== currentEntry.access || oldEntry.layer !== currentEntry.layer) {
        changed.push({
          type: "changed",
          path,
          old: { access: oldEntry.access, layer: oldEntry.layer },
          new: { access: currentEntry.access, layer: currentEntry.layer },
        })
      } else {
        unchanged++
      }
    }
  }

  return { added, removed, changed, unchanged }
}

/**
 * Format a DiffResult as a human-readable unified-diff-like string.
 */
export function formatDiff(result: DiffResult): string {
  const lines: string[] = []

  for (const entry of result.added) {
    lines.push(`+ ${entry.path}  [${entry.new!.layer}]`)
  }
  for (const entry of result.removed) {
    lines.push(`- ${entry.path}  [${entry.old!.layer}]`)
  }
  for (const entry of result.changed) {
    lines.push(`~ ${entry.path}  ${entry.old!.access} → ${entry.new!.access}  [${entry.old!.layer} → ${entry.new!.layer}]`)
  }

  const total = result.added.length + result.removed.length + result.changed.length + result.unchanged
  if (total === 0) {
    lines.push("No entries in snapshot.")
  } else {
    lines.push(``)
    lines.push(`${result.added.length} added, ${result.removed.length} removed, ${result.changed.length} changed, ${result.unchanged} unchanged`)
  }

  return lines.join("\n")
}
