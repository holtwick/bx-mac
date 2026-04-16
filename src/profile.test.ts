import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { collectBlockedDirs, collectIgnoredPaths, collectReadOnlyDotfiles, generateProfile, isSelfProtected, parseHomeConfig, PROTECTED_DOTDIRS, PROTECTED_HOME_DOTFILES, PROTECTED_HOME_DOTFILES_RO, PROTECTED_LIBRARY_DIRS } from "./profile.js"

describe("PROTECTED_DOTDIRS", () => {
  it("includes essential sensitive directories", () => {
    expect(PROTECTED_DOTDIRS).toContain(".Trash")
    expect(PROTECTED_DOTDIRS).toContain(".ssh")
    expect(PROTECTED_DOTDIRS).toContain(".gnupg")
    expect(PROTECTED_DOTDIRS).toContain(".docker")
    expect(PROTECTED_DOTDIRS).toContain(".cargo")
  })

  it("includes cloud credential directories", () => {
    expect(PROTECTED_DOTDIRS).toContain(".aws")
    expect(PROTECTED_DOTDIRS).toContain(".azure")
    expect(PROTECTED_DOTDIRS).toContain(".azd")
    expect(PROTECTED_DOTDIRS).toContain(".kube")
    expect(PROTECTED_DOTDIRS).toContain(".config/gcloud")
  })
})

describe("PROTECTED_HOME_DOTFILES_RO", () => {
  it("includes shell init files", () => {
    expect(PROTECTED_HOME_DOTFILES_RO).toContain(".zshrc")
    expect(PROTECTED_HOME_DOTFILES_RO).toContain(".zprofile")
    expect(PROTECTED_HOME_DOTFILES_RO).toContain(".zshenv")
    expect(PROTECTED_HOME_DOTFILES_RO).toContain(".bashrc")
    expect(PROTECTED_HOME_DOTFILES_RO).toContain(".bash_profile")
    expect(PROTECTED_HOME_DOTFILES_RO).toContain(".profile")
  })
})

describe("PROTECTED_HOME_DOTFILES", () => {
  it("includes sensitive dotfiles", () => {
    expect(PROTECTED_HOME_DOTFILES).toContain(".zsh_history")
    expect(PROTECTED_HOME_DOTFILES).toContain(".bash_history")
    expect(PROTECTED_HOME_DOTFILES).toContain(".netrc")
    expect(PROTECTED_HOME_DOTFILES).toContain(".git-credentials")
    expect(PROTECTED_HOME_DOTFILES).toContain(".npmrc")
  })
})

describe("PROTECTED_LIBRARY_DIRS", () => {
  it("includes sensitive Library subdirectories", () => {
    expect(PROTECTED_LIBRARY_DIRS).toContain("Mail")
    expect(PROTECTED_LIBRARY_DIRS).toContain("Messages")
    expect(PROTECTED_LIBRARY_DIRS).toContain("Safari")
    expect(PROTECTED_LIBRARY_DIRS).toContain("Cookies")
    expect(PROTECTED_LIBRARY_DIRS).toContain("Mobile Documents")
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

  it("blocks files in ancestor directories alongside sibling dirs", () => {
    // Create a file in the parent of the workdir
    writeFileSync(join(home, "work", "doc.pdf"), "")
    writeFileSync(join(home, "work", "notes.txt"), "")

    const workDir = join(home, "work", "project-a")
    const allowed = new Set([workDir])
    const blocked = collectBlockedDirs(home, home, "/fake/script", allowed)

    expect(blocked).toContain(join(home, "work", "doc.pdf"))
    expect(blocked).toContain(join(home, "work", "notes.txt"))
    expect(blocked).toContain(join(home, "work", "project-b"))
    expect(blocked).not.toContain(workDir)
  })

  it("blocks files at home level", () => {
    writeFileSync(join(home, "secret.txt"), "")

    const workDir = join(home, "work", "project-a")
    const allowed = new Set([workDir])
    const blocked = collectBlockedDirs(home, home, "/fake/script", allowed)

    expect(blocked).toContain(join(home, "secret.txt"))
  })

  it("returns only absolute paths", () => {
    const allowed = new Set([join(home, "work", "project-a")])
    const blocked = collectBlockedDirs(home, home, "/fake/script", allowed)

    for (const dir of blocked) {
      expect(dir.startsWith("/")).toBe(true)
    }
  })
})

describe("parseHomeConfig", () => {
  const tmpBase = join("/tmp", `bx-test-config-${process.pid}`)
  let home: string

  beforeEach(() => {
    mkdirSync(join(tmpBase, "home", "work", "project-a"), { recursive: true })
    home = realpathSync(join(tmpBase, "home"))
    mkdirSync(join(home, "shared", "libs"), { recursive: true })
    mkdirSync(join(home, "reference", "docs"), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it("parses RW: entries as allowed dirs", () => {
    writeFileSync(join(home, ".bxignore"), "RW:shared/libs\n")
    const { allowed, readOnly } = parseHomeConfig(home, [join(home, "work/project-a")])

    expect(allowed).toContain(join(home, "shared/libs"))
    expect(readOnly.size).toBe(0)
  })

  it("parses RO: entries as read-only dirs", () => {
    writeFileSync(join(home, ".bxignore"), "RO:reference/docs\n")
    const { allowed, readOnly } = parseHomeConfig(home, [join(home, "work/project-a")])

    expect(readOnly).toContain(join(home, "reference/docs"))
    expect(allowed).not.toContain(join(home, "reference/docs"))
  })

  it("is case-insensitive for prefixes", () => {
    writeFileSync(join(home, ".bxignore"), "rw:shared/libs\nro:reference/docs\n")
    const { allowed, readOnly } = parseHomeConfig(home, [join(home, "work/project-a")])

    expect(allowed).toContain(join(home, "shared/libs"))
    expect(readOnly).toContain(join(home, "reference/docs"))
  })

  it("ignores plain lines (deny rules)", () => {
    writeFileSync(join(home, ".bxignore"), ".aws\nRW:shared/libs\n")
    const { allowed, readOnly } = parseHomeConfig(home, [join(home, "work/project-a")])

    expect(allowed.size).toBe(2) // workdir + shared/libs
    expect(readOnly.size).toBe(0)
  })

  it("accepts files (not just directories) as RO/RW targets", () => {
    writeFileSync(join(home, ".npmrc"), "registry=...")
    writeFileSync(join(home, ".bxignore"), "ro:.npmrc\n")
    const { readOnly } = parseHomeConfig(home, [join(home, "work/project-a")])
    expect(readOnly).toContain(join(home, ".npmrc"))
  })

  it("expands ~ to $HOME in RW/RO entries", () => {
    writeFileSync(join(home, ".npmrc"), "registry=...")
    writeFileSync(join(home, ".bxignore"), "ro:~/.npmrc\n")
    const { readOnly } = parseHomeConfig(home, [join(home, "work/project-a")])
    expect(readOnly).toContain(join(home, ".npmrc"))
  })

  it("expands globs in RW/RO entries", () => {
    mkdirSync(join(home, "work", "project-b"), { recursive: true })
    mkdirSync(join(home, "work", "project-c"), { recursive: true })
    writeFileSync(join(home, ".bxignore"), "ro:work/project-*\n")
    const { readOnly } = parseHomeConfig(home, [])
    expect(readOnly).toContain(join(home, "work", "project-a"))
    expect(readOnly).toContain(join(home, "work", "project-b"))
    expect(readOnly).toContain(join(home, "work", "project-c"))
  })

  it("ignores RO entries pointing at non-existent paths", () => {
    writeFileSync(join(home, ".bxignore"), "ro:does-not-exist\n")
    const { readOnly } = parseHomeConfig(home, [])
    expect(readOnly.size).toBe(0)
  })

  it("always includes workDirs in allowed", () => {
    writeFileSync(join(home, ".bxignore"), "")
    const workDir = join(home, "work/project-a")
    const { allowed } = parseHomeConfig(home, [workDir])

    expect(allowed).toContain(workDir)
  })
})

describe("isSelfProtected", () => {
  const tmpBase = join("/tmp", `bx-test-selfprotect-${process.pid}`)

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it("returns true when .bxprotect exists", () => {
    const dir = join(tmpBase, "protected")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".bxprotect"), "")
    expect(isSelfProtected(dir)).toBe(true)
  })

  it("returns true when .bxignore contains /", () => {
    const dir = join(tmpBase, "protected")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".bxignore"), "/\n")
    expect(isSelfProtected(dir)).toBe(true)
  })

  it("returns true when .bxignore contains / among other entries", () => {
    const dir = join(tmpBase, "protected")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".bxignore"), ".env\n/\n*.pem\n")
    expect(isSelfProtected(dir)).toBe(true)
  })

  it("returns true when .bxignore contains .", () => {
    const dir = join(tmpBase, "protected")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".bxignore"), ".\n")
    expect(isSelfProtected(dir)).toBe(true)
  })

  it("returns false for regular .bxignore without /", () => {
    const dir = join(tmpBase, "normal")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, ".bxignore"), ".env\n*.pem\n")
    expect(isSelfProtected(dir)).toBe(false)
  })

  it("returns false when no marker files exist", () => {
    const dir = join(tmpBase, "empty")
    mkdirSync(dir, { recursive: true })
    expect(isSelfProtected(dir)).toBe(false)
  })
})

describe("collectIgnoredPaths", () => {
  const tmpBase = join("/tmp", `bx-test-ignore-${process.pid}`)
  const home = join(tmpBase, "home")
  const workDir = join(home, "work", "project")

  beforeEach(() => {
    mkdirSync(join(workDir, "sub", "deep"), { recursive: true })
    mkdirSync(join(home, ".ssh"), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it("includes protected Library subdirectories", () => {
    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(home, "Library", "Mail"))
    expect(ignored).toContain(join(home, "Library", "Safari"))
    expect(ignored).toContain(join(home, "Library", "Mobile Documents"))
  })

  it("includes protected home dotfiles", () => {
    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(home, ".zsh_history"))
    expect(ignored).toContain(join(home, ".netrc"))
    expect(ignored).toContain(join(home, ".git-credentials"))
  })

  it("includes cloud credential directories", () => {
    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(home, ".aws"))
    expect(ignored).toContain(join(home, ".azure"))
    expect(ignored).toContain(join(home, ".kube"))
    expect(ignored).toContain(join(home, ".config/gcloud"))
  })

  it("matches simple patterns recursively in workdir subdirectories", () => {
    // .env exists at root and in a subdirectory
    writeFileSync(join(workDir, ".env"), "SECRET=1")
    writeFileSync(join(workDir, "sub", ".env"), "SECRET=2")
    writeFileSync(join(workDir, ".bxignore"), ".env\n")

    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(workDir, ".env"))
    expect(ignored).toContain(join(workDir, "sub", ".env"))
  })

  it("matches glob patterns recursively in workdir subdirectories", () => {
    writeFileSync(join(workDir, "key.pem"), "")
    writeFileSync(join(workDir, "sub", "cert.pem"), "")
    writeFileSync(join(workDir, "sub", "deep", "other.pem"), "")
    writeFileSync(join(workDir, ".bxignore"), "*.pem\n")

    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(workDir, "key.pem"))
    expect(ignored).toContain(join(workDir, "sub", "cert.pem"))
    expect(ignored).toContain(join(workDir, "sub", "deep", "other.pem"))
  })

  it("patterns with a path separator are relative to base dir", () => {
    mkdirSync(join(workDir, "config", "secrets"), { recursive: true })
    mkdirSync(join(workDir, "sub", "config", "secrets"), { recursive: true })
    writeFileSync(join(workDir, ".bxignore"), "config/secrets\n")

    const ignored = collectIgnoredPaths(home, [workDir])
    // config/secrets contains a slash → relative to workdir, not recursive
    expect(ignored).toContain(join(workDir, "config", "secrets"))
    expect(ignored).not.toContain(join(workDir, "sub", "config", "secrets"))
  })

  it("trailing slash without path separator still matches recursively", () => {
    mkdirSync(join(workDir, "secrets"), { recursive: true })
    mkdirSync(join(workDir, "sub", "secrets"), { recursive: true })
    writeFileSync(join(workDir, ".bxignore"), "secrets/\n")

    const ignored = collectIgnoredPaths(home, [workDir])
    // secrets/ has no path separator (trailing / is a dir marker) → recursive
    expect(ignored).toContain(join(workDir, "secrets"))
    expect(ignored).toContain(join(workDir, "sub", "secrets"))
  })

  it("matches .env.* pattern recursively", () => {
    writeFileSync(join(workDir, ".env.local"), "")
    writeFileSync(join(workDir, "sub", ".env.production"), "")
    writeFileSync(join(workDir, ".bxignore"), ".env.*\n")

    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(workDir, ".env.local"))
    expect(ignored).toContain(join(workDir, "sub", ".env.production"))
  })

  it("leading / anchors pattern to workdir root only", () => {
    writeFileSync(join(workDir, ".env"), "SECRET=1")
    writeFileSync(join(workDir, "sub", ".env"), "SECRET=2")
    writeFileSync(join(workDir, ".bxignore"), "/.env\n")

    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(workDir, ".env"))
    expect(ignored).not.toContain(join(workDir, "sub", ".env"))
  })

  it("leading / with glob anchors to workdir root", () => {
    writeFileSync(join(workDir, "config.json"), "")
    writeFileSync(join(workDir, "sub", "config.json"), "")
    writeFileSync(join(workDir, ".bxignore"), "/*.json\n")

    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(workDir, "config.json"))
    expect(ignored).not.toContain(join(workDir, "sub", "config.json"))
  })

  it("explicit ** patterns still work", () => {
    writeFileSync(join(workDir, "sub", "deep", "test.pem"), "")
    writeFileSync(join(workDir, ".bxignore"), "**/*.pem\n")

    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(workDir, "sub", "deep", "test.pem"))
  })

  it("blocks subdirectory with .bxprotect", () => {
    const secret = join(workDir, "sub", "secret")
    mkdirSync(secret, { recursive: true })
    writeFileSync(join(secret, ".bxprotect"), "")

    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(secret)
  })

  it("blocks subdirectory with / in .bxignore", () => {
    const secret = join(workDir, "sub", "secret")
    mkdirSync(secret, { recursive: true })
    writeFileSync(join(secret, ".bxignore"), "/\n")

    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(secret)
  })

  it("does not recurse into self-protected subdirectories", () => {
    const secret = join(workDir, "sub", "secret")
    mkdirSync(join(secret, "nested"), { recursive: true })
    writeFileSync(join(secret, ".bxprotect"), "")
    writeFileSync(join(secret, "nested", ".bxignore"), ".env\n")
    writeFileSync(join(secret, "nested", ".env"), "KEY=1")

    const ignored = collectIgnoredPaths(home, [workDir])
    // The whole directory is blocked, but nested .env should not appear separately
    expect(ignored).toContain(secret)
    expect(ignored).not.toContain(join(secret, "nested", ".env"))
  })
})

describe("collectReadOnlyDotfiles", () => {
  it("returns absolute paths for shell init files", () => {
    const files = collectReadOnlyDotfiles("/Users/test")
    expect(files).toContain("/Users/test/.zshrc")
    expect(files).toContain("/Users/test/.bashrc")
    expect(files).toContain("/Users/test/.profile")
    expect(files).toContain("/Users/test/.config/fish/config.fish")
  })

  it("filters out paths overridden via ~/.bxignore", () => {
    const overrides = new Set(["/Users/test/.zshrc"])
    const files = collectReadOnlyDotfiles("/Users/test", overrides)
    expect(files).not.toContain("/Users/test/.zshrc")
    expect(files).toContain("/Users/test/.bashrc")
  })
})

describe("collectIgnoredPaths overrides", () => {
  const tmpBase = join("/tmp", `bx-test-overrides-${process.pid}`)
  let home: string
  let workDir: string

  beforeEach(() => {
    mkdirSync(join(tmpBase, "home", "work", "project"), { recursive: true })
    home = realpathSync(join(tmpBase, "home"))
    workDir = join(home, "work", "project")
  })

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it("removes hardcoded dotfiles when overridden", () => {
    const overrides = new Set([join(home, ".npmrc")])
    const ignored = collectIgnoredPaths(home, [workDir], overrides)
    expect(ignored).not.toContain(join(home, ".npmrc"))
    expect(ignored).toContain(join(home, ".netrc"))
  })

  it("removes hardcoded dotdirs when overridden", () => {
    const overrides = new Set([join(home, ".aws")])
    const ignored = collectIgnoredPaths(home, [workDir], overrides)
    expect(ignored).not.toContain(join(home, ".aws"))
    expect(ignored).toContain(join(home, ".kube"))
  })

  it("removes Library subdirs when overridden", () => {
    const overrides = new Set([join(home, "Library", "Mail")])
    const ignored = collectIgnoredPaths(home, [workDir], overrides)
    expect(ignored).not.toContain(join(home, "Library", "Mail"))
    expect(ignored).toContain(join(home, "Library", "Safari"))
  })

  it("workdir .bxignore ro: entries populate readOnly set", () => {
    mkdirSync(join(workDir, "vendor"), { recursive: true })
    writeFileSync(join(workDir, ".bxignore"), "ro:vendor\n")
    const readOnly = new Set<string>()
    collectIgnoredPaths(home, [workDir], new Set(), readOnly)
    expect(readOnly).toContain(join(workDir, "vendor"))
  })

  it("workdir .bxignore rw: entries are ignored (workdir is allowed by default)", () => {
    mkdirSync(join(workDir, "tools"), { recursive: true })
    writeFileSync(join(workDir, ".bxignore"), "rw:tools\n")
    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).not.toContain(join(workDir, "tools"))
  })

  it("end-to-end: ro: file override produces file-write* deny, no full deny", () => {
    writeFileSync(join(home, ".npmrc"), "registry=...")
    writeFileSync(join(home, ".bxignore"), "ro:.npmrc\n")
    const { allowed, readOnly } = parseHomeConfig(home, [workDir])
    const allAccessible = new Set([...allowed, ...readOnly])
    const ignored = collectIgnoredPaths(home, [workDir], allAccessible, readOnly)
    const profile = generateProfile([workDir], [], ignored, [...readOnly], home, [])
    expect(profile).toContain(`(deny file-write*\n  (literal "${join(home, ".npmrc")}")`)
    // The same path must NOT appear in a (deny file* ...) block
    const denyAllBlock = profile.match(/\(deny file\*\n([^)]*)\)/)?.[1] ?? ""
    expect(denyAllBlock).not.toContain(`"${join(home, ".npmrc")}"`)
  })

  it("removes plain ~/.bxignore deny lines when overridden", () => {
    mkdirSync(join(home, "secret"), { recursive: true })
    writeFileSync(join(home, ".bxignore"), "secret\n")
    const overrides = new Set([join(home, "secret")])
    const ignored = collectIgnoredPaths(home, [workDir], overrides)
    expect(ignored).not.toContain(join(home, "secret"))
  })

  it("plain ~/.bxignore patterns apply recursively inside workdirs", () => {
    mkdirSync(join(workDir, "secrets"), { recursive: true })
    mkdirSync(join(workDir, "sub", "secrets"), { recursive: true })
    writeFileSync(join(workDir, "key.pem"), "x")
    writeFileSync(join(home, ".bxignore"), "secrets/\n*.pem\n")
    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(workDir, "secrets"))
    expect(ignored).toContain(join(workDir, "sub", "secrets"))
    expect(ignored).toContain(join(workDir, "key.pem"))
  })

  it("plain ~/.bxignore patterns match at $HOME top level only (not recursive)", () => {
    mkdirSync(join(home, "secrets"), { recursive: true })
    mkdirSync(join(home, "nested", "secrets"), { recursive: true })
    writeFileSync(join(home, ".bxignore"), "secrets/\n")
    const ignored = collectIgnoredPaths(home, [workDir])
    expect(ignored).toContain(join(home, "secrets"))
    expect(ignored).not.toContain(join(home, "nested", "secrets"))
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

  it("includes deny rules for blocked dirs (subpath for dirs, literal for files)", () => {
    const profile = generateProfile(
      ["/Users/test/work"],
      ["/tmp", "/Users/test/Desktop"],
      [],
    )

    // /tmp exists and is a directory -> subpath
    expect(profile).toContain('(subpath "/tmp")')
    // /Users/test/Desktop does not exist -> literal
    expect(profile).toContain('(literal "/Users/test/Desktop")')
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

  it("includes deny file-write* rules for read-only dirs", () => {
    const profile = generateProfile(
      ["/Users/test/work"],
      ["/Users/test/Documents"],
      [],
      ["/Users/test/shared/libs"],
    )

    expect(profile).toContain("(deny file-write*")
    expect(profile).toContain('"/Users/test/shared/libs"')
    expect(profile).toContain("; Read-only paths")
  })

  it("omits read-only section when no RO dirs", () => {
    const profile = generateProfile(
      ["/Users/test/work"],
      ["/Users/test/Documents"],
      [],
      [],
    )

    expect(profile).not.toContain("deny file-write*")
    expect(profile).not.toContain("Read-only")
  })

  it("includes write-deny rules for read-only dotfiles", () => {
    const profile = generateProfile(
      ["/Users/test/work"],
      [],
      [],
      [],
      "",
      ["/Users/test/.zshrc", "/Users/test/.bashrc"],
    )

    expect(profile).toContain('(literal "/Users/test/.zshrc")')
    expect(profile).toContain('(literal "/Users/test/.bashrc")')
    expect(profile).toContain("(deny file-write*")
    expect(profile).toContain("write-protected against injection")
  })
})
