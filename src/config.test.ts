import { describe, it, expect, vi, beforeEach } from "vitest"
import { loadConfig, getAvailableApps, getValidModes, BUILTIN_APPS } from "./config.js"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      if (p.endsWith(".bxconfig.toml")) return (vi as any).__configExists ?? false
      return true
    }),
    readFileSync: vi.fn((p: string) => {
      if (p.endsWith(".bxconfig.toml")) return (vi as any).__configContent ?? ""
      return actual.readFileSync(p)
    }),
  }
})

function setConfig(content: string) {
  ;(vi as any).__configExists = true
  ;(vi as any).__configContent = content
}

function clearConfig() {
  ;(vi as any).__configExists = false
  ;(vi as any).__configContent = ""
}

describe("loadConfig", () => {
  beforeEach(() => clearConfig())

  it("returns empty apps when no config file exists", () => {
    const config = loadConfig("/Users/test")
    expect(config.apps).toEqual({})
  })

  it("parses valid TOML with apps section", () => {
    setConfig(`
[apps.cursor]
bundle = "com.todesktop.230313mzl4w4u92"
binary = "Contents/MacOS/Cursor"
args = ["--no-sandbox"]

[apps.zed]
path = "/Applications/Zed.app/Contents/MacOS/zed"
`)
    const config = loadConfig("/Users/test")
    expect(config.apps.cursor).toEqual({
      mode: undefined,
      bundle: "com.todesktop.230313mzl4w4u92",
      binary: "Contents/MacOS/Cursor",
      path: undefined,
      fallback: undefined,
      args: ["--no-sandbox"],
      passPaths: undefined,
      paths: undefined,
      background: undefined,
    })
    expect(config.apps.zed?.path).toBe("/Applications/Zed.app/Contents/MacOS/zed")
  })

  it("handles malformed TOML gracefully", () => {
    setConfig("this is not valid toml [[[")
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const config = loadConfig("/Users/test")
    expect(config.apps).toEqual({})
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("failed to parse"))
    spy.mockRestore()
  })

  it("parses top-level sections as apps", () => {
    setConfig(`
[cursor]
bundle = "com.todesktop.230313mzl4w4u92"
binary = "Contents/MacOS/Cursor"
`)
    const config = loadConfig("/Users/test")
    expect(config.apps.cursor?.bundle).toBe("com.todesktop.230313mzl4w4u92")
    expect(config.apps.cursor?.binary).toBe("Contents/MacOS/Cursor")
  })

  it("apps section takes precedence over top-level", () => {
    setConfig(`
[cursor]
path = "/from-top-level"

[apps.cursor]
path = "/from-apps"
`)
    const config = loadConfig("/Users/test")
    expect(config.apps.cursor?.path).toBe("/from-apps")
  })

  it("mixes top-level and apps sections", () => {
    setConfig(`
[zed]
path = "/Applications/Zed.app/Contents/MacOS/zed"

[apps.cursor]
bundle = "com.cursor"
`)
    const config = loadConfig("/Users/test")
    expect(config.apps.zed?.path).toBe("/Applications/Zed.app/Contents/MacOS/zed")
    expect(config.apps.cursor?.bundle).toBe("com.cursor")
  })

  it("parses numeric passPaths", () => {
    setConfig(`
[myapp]
path = "/test/app"
passPaths = 2
`)
    const config = loadConfig("/Users/test")
    expect(config.apps.myapp.passPaths).toBe(2)
  })

  it("parses array passPaths", () => {
    setConfig(`
[myapp]
path = "/test/app"
passPaths = ["~/work/a", "~/work/b"]
`)
    const config = loadConfig("/Users/test")
    expect(config.apps.myapp.passPaths).toEqual(["~/work/a", "~/work/b"])
  })

  it("reads legacy passWorkdirs as fallback", () => {
    setConfig(`
[myapp]
path = "/test/app"
passWorkdirs = 2
`)
    const config = loadConfig("/Users/test")
    expect(config.apps.myapp.passPaths).toBe(2)
  })

  it("reads legacy workdirs as fallback for paths", () => {
    setConfig(`
[myapp]
path = "/test/app"
workdirs = ["~/work/a"]
`)
    const config = loadConfig("/Users/test")
    expect(config.apps.myapp.paths).toEqual(["~/work/a"])
  })

  it("passPaths takes precedence over legacy passWorkdirs", () => {
    setConfig(`
[myapp]
path = "/test/app"
passWorkdirs = 2
passPaths = 1
`)
    const config = loadConfig("/Users/test")
    expect(config.apps.myapp.passPaths).toBe(1)
  })

  it("handles config without apps section", () => {
    setConfig(`
[other]
key = "value"
`)
    const config = loadConfig("/Users/test")
    expect(config.apps).toEqual({})
  })
})

describe("getAvailableApps", () => {
  it("returns builtin apps when config is empty", () => {
    const apps = getAvailableApps({ apps: {} })
    expect(apps.code).toBeDefined()
    expect(apps.code.bundle).toBe("com.microsoft.VSCode")
    expect(apps.xcode).toBeDefined()
  })

  it("merges config apps over builtins", () => {
    const apps = getAvailableApps({
      apps: {
        code: { path: "/custom/vscode" },
        myapp: { path: "/custom/myapp" },
      },
    })
    // Config override merges with builtin
    expect(apps.code.path).toBe("/custom/vscode")
    expect(apps.code.bundle).toBe("com.microsoft.VSCode") // preserved from builtin
    // New app added
    expect(apps.myapp.path).toBe("/custom/myapp")
  })

  it("resolves mode references to inherit app fields", () => {
    const apps = getAvailableApps({
      apps: {
        myproject: { mode: "code", paths: ["~/work/my-project"] },
      },
    })
    expect(apps.myproject.bundle).toBe("com.microsoft.VSCode")
    expect(apps.myproject.binary).toBe("Contents/MacOS/Electron")
    expect(apps.myproject.paths).toEqual(["~/work/my-project"])
    expect(apps.myproject.mode).toBeUndefined()
  })

  it("resolves chained mode references", () => {
    const apps = getAvailableApps({
      apps: {
        cursor: { bundle: "com.cursor", binary: "Contents/MacOS/Cursor", args: ["--no-sandbox"] },
        myproject: { mode: "cursor", paths: ["~/work/proj"] },
      },
    })
    expect(apps.myproject.bundle).toBe("com.cursor")
    expect(apps.myproject.args).toEqual(["--no-sandbox"])
    expect(apps.myproject.paths).toEqual(["~/work/proj"])
  })

  it("own fields override inherited fields", () => {
    const apps = getAvailableApps({
      apps: {
        mycode: { mode: "code", args: ["--disable-gpu"] },
      },
    })
    expect(apps.mycode.bundle).toBe("com.microsoft.VSCode")
    expect(apps.mycode.args).toEqual(["--disable-gpu"])
  })

  it("inherits passPaths from referenced app", () => {
    const apps = getAvailableApps({
      apps: {
        myxcode: { mode: "xcode", paths: ["~/work/ios"] },
      },
    })
    expect(apps.myxcode.passPaths).toBe(false)
  })

  it("warns on unknown mode reference", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const apps = getAvailableApps({
      apps: {
        broken: { mode: "nonexistent", paths: ["~/work"] },
      },
    })
    expect(apps.broken.paths).toEqual(["~/work"])
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("not found"))
    spy.mockRestore()
  })

  it("warns on circular mode references", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const apps = getAvailableApps({
      apps: {
        a: { mode: "b" },
        b: { mode: "a" },
      },
    })
    expect(apps.a).toBeDefined()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("circular"))
    spy.mockRestore()
  })
})

describe("getValidModes", () => {
  it("includes builtin modes and app names", () => {
    const apps = getAvailableApps({ apps: { myapp: { path: "/x" } } })
    const modes = getValidModes(apps)
    expect(modes).toContain("term")
    expect(modes).toContain("claude")
    expect(modes).toContain("exec")
    expect(modes).toContain("code")
    expect(modes).toContain("xcode")
    expect(modes).toContain("myapp")
  })
})
