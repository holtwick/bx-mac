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
      bundle: "com.todesktop.230313mzl4w4u92",
      binary: "Contents/MacOS/Cursor",
      path: undefined,
      fallback: undefined,
      args: ["--no-sandbox"],
      passWorkdirs: undefined,
    })
    expect(config.apps.zed?.path).toBe("/Applications/Zed.app/Contents/MacOS/zed")
  })

  it("handles malformed TOML gracefully", () => {
    setConfig("this is not valid toml [[[")
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const config = loadConfig("/Users/test")
    expect(config.apps).toEqual({})
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("warning"))
    spy.mockRestore()
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
