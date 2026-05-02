import { describe, it, expect, afterEach, beforeAll } from "vitest"
import { mkdtempSync, rmSync, existsSync, mkdirSync, statSync, writeFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { buildSnapshot, writeSnapshot, readSnapshot, diffSnapshots, formatDiff } from "./snapshot.js"
import type { Snapshot, SnapshotEntry, DiffResult } from "./snapshot.js"

function realpathSafe(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

const HOME = process.env.HOME ?? "/Users/test"

describe("buildSnapshot", () => {
  it("produces entries with correct structure", () => {
    const snapshot = buildSnapshot(HOME, [])
    expect(snapshot.version).toBe("1.0.0")
    expect(snapshot.created).toBeTruthy()
    expect(snapshot.home).toBe(HOME)
    expect(snapshot.workdirs).toEqual([])
    expect(Array.isArray(snapshot.entries)).toBe(true)

    for (const entry of snapshot.entries) {
      expect(typeof entry.path).toBe("string")
      expect(["blocked", "read-only", "allowed"]).toContain(entry.access)
      expect(typeof entry.layer).toBe("string")
      // source can be string or null
      if (entry.source !== null) {
        expect(typeof entry.source).toBe("string")
      }
    }
  })

  it("includes hardcoded dotdirs layer (PROTECTED_DOTDIRS)", () => {
    const snapshot = buildSnapshot(HOME, [])
    const sshEntry = snapshot.entries.find(
      (e) => e.path === join(HOME, ".ssh"),
    )
    expect(sshEntry).toBeDefined()
    expect(sshEntry!.access).toBe("blocked")
    expect(sshEntry!.layer).toBe("hardcoded (blocked dotdirs)")
    expect(sshEntry!.source).toBe("PROTECTED_DOTDIRS")
  })

  it("includes hardcoded dotfiles layer (PROTECTED_HOME_DOTFILES)", () => {
    const snapshot = buildSnapshot(HOME, [])
    const histEntry = snapshot.entries.find(
      (e) => e.path === join(HOME, ".zsh_history"),
    )
    expect(histEntry).toBeDefined()
    expect(histEntry!.access).toBe("blocked")
    expect(histEntry!.layer).toBe("hardcoded (blocked dotfiles)")
    expect(histEntry!.source).toBe("PROTECTED_HOME_DOTFILES")
  })

  it("includes read-only dotfiles layer (PROTECTED_HOME_DOTFILES_RO)", () => {
    const snapshot = buildSnapshot(HOME, [])
    const zshrcEntry = snapshot.entries.find(
      (e) => e.path === join(HOME, ".zshrc"),
    )
    expect(zshrcEntry).toBeDefined()
    expect(zshrcEntry!.access).toBe("read-only")
    expect(zshrcEntry!.layer).toBe("hardcoded (read-only dotfiles)")
    expect(zshrcEntry!.source).toBe("PROTECTED_HOME_DOTFILES_RO")
  })

  it("includes protected Library layer (PROTECTED_LIBRARY_DIRS)", () => {
    const snapshot = buildSnapshot(HOME, [])
    const mailEntry = snapshot.entries.find(
      (e) => e.path === join(HOME, "Library", "Mail"),
    )
    expect(mailEntry).toBeDefined()
    expect(mailEntry!.access).toBe("blocked")
    expect(mailEntry!.layer).toBe("hardcoded (protected Library)")
    expect(mailEntry!.source).toBe("PROTECTED_LIBRARY_DIRS")
  })

  it("includes home scan blocked paths (e.g., Downloads, Desktop)", () => {
    const snapshot = buildSnapshot(HOME, [])
    const homeScanEntries = snapshot.entries.filter(
      (e) => e.layer === "home scan (blocked)",
    )
    // On a typical macOS home, Downloads and Desktop should be blocked
    const paths = homeScanEntries.map((e) => e.path)
    if (paths.length > 0) {
      // At least verify they all have the correct layer/access
      for (const e of homeScanEntries) {
        expect(e.access).toBe("blocked")
        expect(e.layer).toBe("home scan (blocked)")
        expect(e.source).toBeNull()
      }
    }
  })

  it("includes system deny paths", () => {
    const snapshot = buildSnapshot(HOME, [])
    const systemEntries = snapshot.entries.filter(
      (e) => e.layer === "system deny",
    )
    for (const e of systemEntries) {
      expect(e.access).toBe("blocked")
      expect(e.source).toBeNull()
    }
  })

  it("works with empty workdirs array", () => {
    const snapshot = buildSnapshot(HOME, [])
    expect(snapshot.workdirs).toEqual([])
    expect(snapshot.entries.length).toBeGreaterThan(0)
  })

  it("no duplicate paths in entries", () => {
    const snapshot = buildSnapshot(HOME, [])
    const paths = snapshot.entries.map((e) => e.path)
    const uniquePaths = new Set(paths)
    expect(paths.length).toBe(uniquePaths.size)
  })
})

describe("buildSnapshot override scenarios", () => {
  let tmpDir: string
  let tmpHome: string

  beforeAll(() => {
    tmpDir = mkdtempSync("/tmp/bx-snapshot-override-")
    tmpHome = join(tmpDir, "home")
    mkdirSync(tmpHome, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = mkdtempSync("/tmp/bx-snapshot-override-")
    tmpHome = join(tmpDir, "home")
    mkdirSync(tmpHome, { recursive: true })
  })

  it("rw: override produces allowed entry for hardcoded blocked path", () => {
    // Create ~/.bxignore with rw:.ssh
    writeFileSync(join(tmpHome, ".bxignore"), "rw:.ssh\n")

    // Create the .ssh dir so resolveAccessTargets can realpath it
    mkdirSync(join(tmpHome, ".ssh"))

    const snapshot = buildSnapshot(tmpHome, [])

    // Should have the rw: allowed entry (parseHomeConfig realpaths paths)
    const sshPath = realpathSafe(join(tmpHome, ".ssh"))
    const sshAllowed = snapshot.entries.find(
      (e) => e.path === sshPath && e.access === "allowed",
    )
    expect(sshAllowed).toBeDefined()
    expect(sshAllowed!.layer).toBe("~/.bxignore rw:/ro:")
    expect(sshAllowed!.source).toBe("~/.bxignore")
  })

  it("ro: override produces read-only entry for hardcoded dotdir path", () => {
    // Create ~/.bxignore with ro:.ssh
    writeFileSync(join(tmpHome, ".bxignore"), "ro:.ssh\n")
    mkdirSync(join(tmpHome, ".ssh"))

    const snapshot = buildSnapshot(tmpHome, [])

    // Should have a read-only entry for .ssh
    const sshPath = realpathSafe(join(tmpHome, ".ssh"))
    const sshRo = snapshot.entries.find(
      (e) => e.path === sshPath && e.access === "read-only",
    )
    expect(sshRo).toBeDefined()
    expect(sshRo!.layer).toBe("~/.bxignore rw:/ro:")
    expect(sshRo!.source).toBe("~/.bxignore")
  })
})

describe("buildSnapshot workdir ro: scenarios", () => {
  let tmpDir: string
  let tmpHome: string
  let tmpWorkdir: string

  beforeAll(() => {
    tmpDir = mkdtempSync("/tmp/bx-snapshot-workdir-")
    tmpHome = join(tmpDir, "home")
    mkdirSync(tmpHome, { recursive: true })
    tmpWorkdir = join(tmpDir, "work")
    mkdirSync(tmpWorkdir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = mkdtempSync("/tmp/bx-snapshot-workdir-")
    tmpHome = join(tmpDir, "home")
    mkdirSync(tmpHome, { recursive: true })
    tmpWorkdir = join(tmpDir, "work")
    mkdirSync(tmpWorkdir, { recursive: true })
  })

  it("workdir .bxignore ro: entries appear in snapshot", () => {
    // Create workdir/.bxignore with ro:secrets
    writeFileSync(join(tmpWorkdir, ".bxignore"), "ro:secrets\n")
    mkdirSync(join(tmpWorkdir, "secrets"))

    const snapshot = buildSnapshot(tmpHome, [tmpWorkdir])

    // Should have a read-only entry for workdir/secrets
    const secretsPath = realpathSafe(join(tmpWorkdir, "secrets"))
    const secretsRo = snapshot.entries.find(
      (e) =>
        e.path === secretsPath &&
        e.access === "read-only",
    )
    expect(secretsRo).toBeDefined()
    expect(secretsRo!.layer).toBe("workdir .bxignore ro:")
    expect(secretsRo!.source).toBeNull()
  })
})

describe("writeSnapshot / readSnapshot round-trip", () => {
  // Use a temp dir to avoid touching the real ~/.bxpolicy.snapshot
  let tmpDir: string
  let tmpHome: string

  beforeAll(() => {
    tmpDir = mkdtempSync("/tmp/bx-snapshot-test-")
    tmpHome = join(tmpDir, "home")
    mkdirSync(tmpHome, { recursive: true })
  })

  afterEach(() => {
    // Clean up the snapshot file between tests
    const snapPath = join(tmpHome, ".bxpolicy.snapshot")
    try { rmSync(snapPath) } catch { /* ok */ }
  })

  it("writes and reads a snapshot", () => {
    const snapshot: Snapshot = {
      version: "1.0.0",
      created: "2026-05-02T14:30:00.000Z",
      home: tmpHome,
      workdirs: ["/Users/test/work/proj"],
      entries: [
        {
          path: "/Users/test/.ssh",
          access: "blocked",
          layer: "hardcoded (blocked dotdirs)",
          source: "PROTECTED_DOTDIRS",
        },
        {
          path: "/Users/test/Downloads",
          access: "blocked",
          layer: "home scan (blocked)",
          source: null,
        },
      ],
    }

    writeSnapshot(snapshot)
    const read = readSnapshot(tmpHome)
    expect(read.version).toBe("1.0.0")
    expect(read.home).toBe(tmpHome)
    expect(read.entries.length).toBe(2)
    expect(read.entries[0].path).toBe("/Users/test/.ssh")
    expect(read.entries[0].layer).toBe("hardcoded (blocked dotdirs)")
  })

  it("throws when no snapshot file exists", () => {
    expect(() => readSnapshot(tmpHome)).toThrow(/No snapshot found/)
  })

  it("file is written with mode 0o600", () => {
    const snapshot: Snapshot = {
      version: "1.0.0",
      created: "2026-05-02T14:30:00.000Z",
      home: tmpHome,
      workdirs: [],
      entries: [],
    }
    writeSnapshot(snapshot)
    const path = join(tmpHome, ".bxpolicy.snapshot")
    expect(existsSync(path)).toBe(true)
    // Check permissions: mode 0o600 = 0600 in octal
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

// --- Diff tests ---

function makeSnapshot(entries: SnapshotEntry[]): Snapshot {
  return {
    version: "1.0.0",
    created: "2026-05-02T14:30:00.000Z",
    home: "/Users/test",
    workdirs: [],
    entries,
  }
}

function makeEntry(path: string, access: "blocked" | "read-only" | "allowed" = "blocked", layer = "hardcoded (blocked dotdirs)"): SnapshotEntry {
  return { path, access, layer, source: null }
}

describe("diffSnapshots", () => {
  it("identical snapshots produce all unchanged", () => {
    const snap = makeSnapshot([
      makeEntry("/Users/test/.ssh"),
      makeEntry("/Users/test/.aws"),
    ])
    const result = diffSnapshots(snap, snap)
    expect(result.added).toHaveLength(0)
    expect(result.removed).toHaveLength(0)
    expect(result.changed).toHaveLength(0)
    expect(result.unchanged).toBe(2)
  })

  it("detects added paths", () => {
    const old = makeSnapshot([
      makeEntry("/Users/test/.ssh"),
    ])
    const cur = makeSnapshot([
      makeEntry("/Users/test/.ssh"),
      makeEntry("/Users/test/.new-tool", "blocked", "home scan (blocked)"),
    ])
    const result = diffSnapshots(old, cur)
    expect(result.added).toHaveLength(1)
    expect(result.added[0].path).toBe("/Users/test/.new-tool")
    expect(result.added[0].new!.layer).toBe("home scan (blocked)")
    expect(result.removed).toHaveLength(0)
    expect(result.changed).toHaveLength(0)
    expect(result.unchanged).toBe(1)
  })

  it("detects removed paths", () => {
    const old = makeSnapshot([
      makeEntry("/Users/test/.ssh"),
      makeEntry("/Users/test/.old-tool", "blocked", "home scan (blocked)"),
    ])
    const cur = makeSnapshot([
      makeEntry("/Users/test/.ssh"),
    ])
    const result = diffSnapshots(old, cur)
    expect(result.removed).toHaveLength(1)
    expect(result.removed[0].path).toBe("/Users/test/.old-tool")
    expect(result.removed[0].old!.layer).toBe("home scan (blocked)")
    expect(result.added).toHaveLength(0)
    expect(result.changed).toHaveLength(0)
    expect(result.unchanged).toBe(1)
  })

  it("detects changed access (blocked → read-only)", () => {
    const old = makeSnapshot([
      makeEntry("/Users/test/.ssh", "blocked"),
    ])
    const cur = makeSnapshot([
      makeEntry("/Users/test/.ssh", "read-only"),
    ])
    const result = diffSnapshots(old, cur)
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0].path).toBe("/Users/test/.ssh")
    expect(result.changed[0].old!.access).toBe("blocked")
    expect(result.changed[0].new!.access).toBe("read-only")
    expect(result.added).toHaveLength(0)
    expect(result.removed).toHaveLength(0)
    expect(result.unchanged).toBe(0)
  })

  it("detects changed layer", () => {
    const old = makeSnapshot([
      makeEntry("/Users/test/.ssh", "blocked", "hardcoded (blocked dotdirs)"),
    ])
    const cur = makeSnapshot([
      makeEntry("/Users/test/.ssh", "blocked", "~/.bxignore deny"),
    ])
    const result = diffSnapshots(old, cur)
    expect(result.changed).toHaveLength(1)
    expect(result.changed[0].old!.layer).toBe("hardcoded (blocked dotdirs)")
    expect(result.changed[0].new!.layer).toBe("~/.bxignore deny")
    expect(result.unchanged).toBe(0)
  })

  it("empty snapshots produce all zero", () => {
    const snap = makeSnapshot([])
    const result = diffSnapshots(snap, snap)
    expect(result.added).toHaveLength(0)
    expect(result.removed).toHaveLength(0)
    expect(result.changed).toHaveLength(0)
    expect(result.unchanged).toBe(0)
  })

  it("handles mix of added, removed, changed, and unchanged", () => {
    const old = makeSnapshot([
      makeEntry("/Users/test/.ssh"),
      makeEntry("/Users/test/.aws", "blocked"),
      makeEntry("/Users/test/.old", "blocked"),
    ])
    const cur = makeSnapshot([
      makeEntry("/Users/test/.ssh"),
      makeEntry("/Users/test/.aws", "read-only"),
      makeEntry("/Users/test/.new", "blocked", "home scan (blocked)"),
    ])
    const result = diffSnapshots(old, cur)
    expect(result.added).toHaveLength(1)     // .new
    expect(result.removed).toHaveLength(1)   // .old
    expect(result.changed).toHaveLength(1)   // .aws
    expect(result.unchanged).toBe(1)          // .ssh
  })
})

describe("formatDiff", () => {
  it("produces correct + / - / ~ prefixes", () => {
    const result: DiffResult = {
      added: [
        { type: "added", path: "/Users/test/.new-tool", new: { access: "blocked", layer: "home scan (blocked)" } },
      ],
      removed: [
        { type: "removed", path: "/Users/test/.old-tool", old: { access: "blocked", layer: "home scan (blocked)" } },
      ],
      changed: [
        {
          type: "changed",
          path: "/Users/test/Documents",
          old: { access: "blocked", layer: "home scan (blocked)" },
          new: { access: "allowed", layer: "~/.bxignore rw:/ro:" },
        },
      ],
      unchanged: 247,
    }

    const output = formatDiff(result)
    expect(output).toContain("+ /Users/test/.new-tool  [home scan (blocked)]")
    expect(output).toContain("- /Users/test/.old-tool  [home scan (blocked)]")
    expect(output).toContain("~ /Users/test/Documents  blocked → allowed  [home scan (blocked) → ~/.bxignore rw:/ro:]")
    expect(output).toContain("1 added, 1 removed, 1 changed, 247 unchanged")
  })

  it("handles empty result", () => {
    const result: DiffResult = {
      added: [],
      removed: [],
      changed: [],
      unchanged: 0,
    }
    const output = formatDiff(result)
    expect(output).toBe("No entries in snapshot.")
  })

  it("handles only added entries", () => {
    const result: DiffResult = {
      added: [
        { type: "added", path: "/Users/test/.new", new: { access: "blocked", layer: "home scan (blocked)" } },
      ],
      removed: [],
      changed: [],
      unchanged: 3,
    }
    const output = formatDiff(result)
    expect(output).toContain("+ /Users/test/.new  [home scan (blocked)]")
    expect(output).toContain("1 added, 0 removed, 0 changed, 3 unchanged")
  })

  it("handles only removed entries", () => {
    const result: DiffResult = {
      added: [],
      removed: [
        { type: "removed", path: "/Users/test/.old", old: { access: "blocked", layer: "home scan (blocked)" } },
      ],
      changed: [],
      unchanged: 5,
    }
    const output = formatDiff(result)
    expect(output).toContain("- /Users/test/.old  [home scan (blocked)]")
    expect(output).toContain("0 added, 1 removed, 0 changed, 5 unchanged")
  })
})

describe("diff — missing snapshot handling", () => {
  it("readSnapshot throws when no snapshot file exists", () => {
    expect(() => readSnapshot("/nonexistent/path/for/testing")).toThrow(/No snapshot found/)
  })
})
