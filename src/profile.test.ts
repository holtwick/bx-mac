import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { collectBlockedDirs, generateProfile, PROTECTED_DOTDIRS } from "./profile.js"

describe("PROTECTED_DOTDIRS", () => {
  it("includes essential sensitive directories", () => {
    expect(PROTECTED_DOTDIRS).toContain(".ssh")
    expect(PROTECTED_DOTDIRS).toContain(".gnupg")
    expect(PROTECTED_DOTDIRS).toContain(".docker")
    expect(PROTECTED_DOTDIRS).toContain(".cargo")
  })
})

describe("collectBlockedDirs", () => {
  const tmpBase = join("/tmp", `bx-test-${process.pid}`)
  const home = join(tmpBase, "home")

  beforeEach(() => {
    // Create a fake HOME with some directories
    mkdirSync(join(home, "Documents"), { recursive: true })
    mkdirSync(join(home, "Desktop"), { recursive: true })
    mkdirSync(join(home, "Downloads"), { recursive: true })
    mkdirSync(join(home, "Library"), { recursive: true })
    mkdirSync(join(home, "work", "project-a"), { recursive: true })
    mkdirSync(join(home, "work", "project-b"), { recursive: true })
    mkdirSync(join(home, ".config"), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it("blocks sibling directories but not the allowed workdir", () => {
    const workDir = join(home, "work", "project-a")
    const allowed = new Set([workDir])
    const blocked = collectBlockedDirs(home, home, "/fake/script", allowed)

    expect(blocked).toContain(join(home, "Documents"))
    expect(blocked).toContain(join(home, "Desktop"))
    expect(blocked).toContain(join(home, "Downloads"))
    expect(blocked).not.toContain(workDir)
    // Parent "work" should not be blocked (it contains an allowed child)
    expect(blocked).not.toContain(join(home, "work"))
    // But sibling project should be blocked
    expect(blocked).toContain(join(home, "work", "project-b"))
  })

  it("does not block Library", () => {
    const allowed = new Set([join(home, "work", "project-a")])
    const blocked = collectBlockedDirs(home, home, "/fake/script", allowed)

    expect(blocked).not.toContain(join(home, "Library"))
  })

  it("skips dotdirs", () => {
    const allowed = new Set([join(home, "work", "project-a")])
    const blocked = collectBlockedDirs(home, home, "/fake/script", allowed)

    expect(blocked).not.toContain(join(home, ".config"))
  })

  it("handles multiple allowed dirs", () => {
    const allowed = new Set([
      join(home, "work", "project-a"),
      join(home, "work", "project-b"),
    ])
    const blocked = collectBlockedDirs(home, home, "/fake/script", allowed)

    expect(blocked).not.toContain(join(home, "work", "project-a"))
    expect(blocked).not.toContain(join(home, "work", "project-b"))
    expect(blocked).toContain(join(home, "Documents"))
  })

  it("returns only absolute paths", () => {
    const allowed = new Set([join(home, "work", "project-a")])
    const blocked = collectBlockedDirs(home, home, "/fake/script", allowed)

    for (const dir of blocked) {
      expect(dir.startsWith("/")).toBe(true)
    }
  })
})

describe("generateProfile", () => {
  it("produces valid SBPL with version and allow default", () => {
    const profile = generateProfile(
      ["/Users/test/work"],
      ["/Users/test/Documents", "/Users/test/Desktop"],
      ["/Users/test/.ssh"],
    )

    expect(profile).toContain("(version 1)")
    expect(profile).toContain("(allow default)")
  })

  it("includes deny rules for blocked dirs", () => {
    const profile = generateProfile(
      ["/Users/test/work"],
      ["/Users/test/Documents", "/Users/test/Desktop"],
      [],
    )

    expect(profile).toContain('(subpath "/Users/test/Documents")')
    expect(profile).toContain('(subpath "/Users/test/Desktop")')
  })

  it("includes deny rules for ignored paths", () => {
    const profile = generateProfile(
      ["/Users/test/work"],
      [],
      ["/Users/test/.ssh", "/Users/test/.gnupg"],
    )

    expect(profile).toContain('"/Users/test/.ssh"')
    expect(profile).toContain('"/Users/test/.gnupg"')
  })

  it("lists working directories in comment", () => {
    const profile = generateProfile(
      ["/Users/test/a", "/Users/test/b"],
      [],
      [],
    )

    expect(profile).toContain("; Working directories: /Users/test/a, /Users/test/b")
  })
})
