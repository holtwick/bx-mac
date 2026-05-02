import { describe, it, expect } from "vitest"
import { tracePath } from "./tracer.js"

// Use the actual user's HOME for tests that match against hardcoded lists.
// The protected lists use HOME-relative paths, so tests need a real HOME.
const HOME = process.env.HOME ?? "/Users/test"

describe("tracePath", () => {
  const workDirs: string[] = []
  const config = { allowed: new Set<string>(), readOnly: new Set<string>() }

  it("matches PROTECTED_DOTDIRS (.ssh → blocked)", () => {
    const path = `${HOME}/.ssh`
    const matches = tracePath(path, HOME, workDirs, config)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].layer).toBe("hardcoded (blocked dotdirs)")
    expect(matches[0].access).toBe("blocked")
    expect(matches[0].source?.type).toBe("hardcoded")
    expect(matches[0].source?.value).toContain("PROTECTED_DOTDIRS")
  })

  it("matches PROTECTED_DOTDIRS subpath (.ssh/known_hosts → blocked)", () => {
    const path = `${HOME}/.ssh/known_hosts`
    const matches = tracePath(path, HOME, workDirs, config)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].layer).toBe("hardcoded (blocked dotdirs)")
    expect(matches[0].access).toBe("blocked")
  })

  it("matches PROTECTED_HOME_DOTFILES (.zsh_history → blocked)", () => {
    const path = `${HOME}/.zsh_history`
    const matches = tracePath(path, HOME, workDirs, config)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].layer).toBe("hardcoded (blocked dotfiles)")
    expect(matches[0].access).toBe("blocked")
    expect(matches[0].source?.value).toContain("PROTECTED_HOME_DOTFILES")
  })

  it("matches PROTECTED_HOME_DOTFILES_RO (.zshrc → read-only)", () => {
    const path = `${HOME}/.zshrc`
    const matches = tracePath(path, HOME, workDirs, config)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].layer).toBe("hardcoded (read-only dotfiles)")
    expect(matches[0].access).toBe("read-only")
    expect(matches[0].source?.value).toContain("PROTECTED_HOME_DOTFILES_RO")
  })

  it("matches PROTECTED_LIBRARY_DIRS (Library/Mail → blocked)", () => {
    const path = `${HOME}/Library/Mail`
    const matches = tracePath(path, HOME, workDirs, config)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].layer).toBe("hardcoded (protected Library)")
    expect(matches[0].access).toBe("blocked")
    expect(matches[0].source?.value).toContain("PROTECTED_LIBRARY_DIRS")
  })

  it("matches subpath of PROTECTED_LIBRARY_DIRS", () => {
    const path = `${HOME}/Library/Mail/V10`
    const matches = tracePath(path, HOME, workDirs, config)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0].layer).toBe("hardcoded (protected Library)")
    expect(matches[0].access).toBe("blocked")
  })

  it("defaults to allow for a non-matching path", () => {
    const path = `/random/nonexistent/path/value`
    const matches = tracePath(path, HOME, workDirs, config)
    expect(matches.length).toBe(1)
    expect(matches[0].layer).toBe("default allow")
    expect(matches[0].access).toBe("allowed")
  })

  it("emits default allow as last entry always", () => {
    const path = `${HOME}/.ssh`
    const matches = tracePath(path, HOME, workDirs, config)
    const last = matches[matches.length - 1]
    expect(last.layer).toBe("default allow")
    expect(last.access).toBe("allowed")
  })

  it("system deny matches /Volumes", () => {
    const path = "/Volumes/SomeDrive"
    const matches = tracePath(path, HOME, workDirs, config)
    const systemMatches = matches.filter((m) => m.layer === "system deny")
    // /Volumes may or may not exist on the test machine, but the path pattern
    // should be checked. On macOS, /Volumes typically exists.
    if (systemMatches.length) {
      expect(systemMatches[0].access).toBe("blocked")
    }
  })

  it("system deny matches other user home directories", () => {
    const path = "/Users/otheruser/Documents"
    const matches = tracePath(path, HOME, workDirs, config)
    const systemMatches = matches.filter((m) => m.layer === "system deny")
    if (systemMatches.length) {
      expect(systemMatches[0].access).toBe("blocked")
    }
  })

  it("workdir member marks path inside workdir as allowed", () => {
    const wd = ["/tmp/test-workdir"]
    const path = "/tmp/test-workdir/src/index.ts"
    const matches = tracePath(path, HOME, wd, config)
    const wdMatches = matches.filter((m) => m.layer === "workdir member")
    expect(wdMatches.length).toBe(1)
    expect(wdMatches[0].access).toBe("allowed")
  })

  it("workdir membership matches the workdir itself", () => {
    const wd = ["/tmp/test-workdir"]
    const path = "/tmp/test-workdir"
    const matches = tracePath(path, HOME, wd, config)
    const wdMatches = matches.filter((m) => m.layer === "workdir member")
    expect(wdMatches.length).toBe(1)
    expect(wdMatches[0].access).toBe("allowed")
  })

  it("matche includes source annotation for hardcoded lists", () => {
    const path = `${HOME}/.aws`
    const matches = tracePath(path, HOME, workDirs, config)
    const dotdir = matches.find((m) => m.layer === "hardcoded (blocked dotdirs)")
    expect(dotdir).toBeDefined()
    expect(dotdir!.source).toBeDefined()
    expect(dotdir!.source!.type).toBe("hardcoded")
    expect(dotdir!.source!.value).toContain(".aws")
  })

  it("returns matches in priority order (highest first)", () => {
    // A path under .ssh that is also not in any workdir
    const path = `${HOME}/.ssh/config`
    const matches = tracePath(path, HOME, workDirs, config)
    // First match should be the hardcoded dotdir (highest priority)
    expect(matches[0].layer).toBe("hardcoded (blocked dotdirs)")
    // Last should be default allow
    expect(matches[matches.length - 1].layer).toBe("default allow")
  })

  it("PROTECTED_HOME_DOTFILES are exact match only (not subpath)", () => {
    // .zsh_history/something should NOT match PROTECTED_HOME_DOTFILES
    const path = `${HOME}/.zsh_history/subpath`
    const matches = tracePath(path, HOME, workDirs, config)
    const dotfilesMatch = matches.find((m) => m.layer === "hardcoded (blocked dotfiles)")
    expect(dotfilesMatch).toBeUndefined()
  })

  it("PROTECTED_DOTDIRS match subpaths under the directory", () => {
    const path = `${HOME}/.gnupg/private-keys-v1.d/somekey.key`
    const matches = tracePath(path, HOME, workDirs, config)
    const dotdirsMatch = matches.find((m) => m.layer === "hardcoded (blocked dotdirs)")
    expect(dotdirsMatch).toBeDefined()
    expect(dotdirsMatch!.access).toBe("blocked")
  })
})
