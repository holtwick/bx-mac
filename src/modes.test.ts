import { describe, it, expect, vi } from "vitest"
import { buildCommand, getActivationCommand, hasAppSandboxEntitlement } from "./modes.js"
import type { AppDefinition } from "./config.js"
import { BUILTIN_APPS } from "./config.js"

// Use builtin apps for tests, with fallback paths that may not exist on CI
const testApps: Record<string, AppDefinition> = {
  ...BUILTIN_APPS,
  // Override with explicit paths so tests don't depend on mdfind
  code: { ...BUILTIN_APPS.code, path: "/test/VSCode/Electron" },
  xcode: { ...BUILTIN_APPS.xcode, path: "/test/Xcode" },
  custom: { path: "/test/CustomApp", args: ["--flag"] },
  customNoPaths: { path: "/test/CustomNoPaths", passPaths: false },
  customFirstPath: { path: "/test/CustomFirst", passPaths: 1 },
  customFirstTwo: { path: "/test/CustomFirstTwo", passPaths: 2 },
  customExplicitPaths: { path: "/test/CustomExplicit", passPaths: ["~/work/a", "~/work/b"] },
  gram: { path: "/Applications/Gram.app" },
}

// Mock resolveAppPath to return the explicit path directly
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js")
  return {
    ...actual,
    resolveAppPath: (app: AppDefinition) => app.path ?? app.fallback ?? null,
  }
})

describe("buildCommand", () => {
  const home = "/Users/testuser"

  it("code mode opens VSCode with workdirs", () => {
    const cmd = buildCommand("code", ["/work/a", "/work/b"], home, false, [], testApps)
    expect(cmd.bin).toBe("/test/VSCode/Electron")
    expect(cmd.args).toContain("--no-sandbox")
    expect(cmd.args).toContain("/work/a")
    expect(cmd.args).toContain("/work/b")
  })

  it("code mode with --vscode-user adds data/extensions dirs", () => {
    const cmd = buildCommand("code", ["/work/a"], home, true, [], testApps)
    expect(cmd.args).toContain("--user-data-dir")
    expect(cmd.args).toContain("--extensions-dir")
    expect(cmd.args.some(a => a.includes(".vscode-sandbox"))).toBe(true)
  })

  it("term mode launches login shell", () => {
    const cmd = buildCommand("term", ["/work/a"], home, false, [], testApps)
    expect(cmd.args).toEqual(["-l"])
  })

  it("claude mode launches claude CLI", () => {
    const cmd = buildCommand("claude", ["/work/a"], home, false, [], testApps)
    expect(cmd.bin).toBe("claude")
  })

  it("exec mode passes the command through", () => {
    const cmd = buildCommand("exec", ["/work/a"], home, false, ["python", "train.py"], testApps)
    expect(cmd.bin).toBe("python")
    expect(cmd.args).toEqual(["train.py"])
  })

  it("xcode mode resolves app path without opening workdir by default", () => {
    const cmd = buildCommand("xcode", ["/work/project"], home, false, [], testApps)
    expect(cmd.bin).toBe("/test/Xcode")
    expect(cmd.args).not.toContain("/work/project")
  })

  it("xcode mode accepts explicit open target after --", () => {
    const cmd = buildCommand("xcode", ["/work/project"], home, false, ["MyApp.xcworkspace"], testApps)
    expect(cmd.bin).toBe("/test/Xcode")
    expect(cmd.args).toContain("MyApp.xcworkspace")
    expect(cmd.args).not.toContain("/work/project")
  })

  it("custom app mode uses path and args", () => {
    const cmd = buildCommand("custom", ["/work/a"], home, false, [], testApps)
    expect(cmd.bin).toBe("/test/CustomApp")
    expect(cmd.args).toContain("--flag")
    expect(cmd.args).toContain("/work/a")
  })

  it("custom app can disable forwarding paths via passPaths=false", () => {
    const cmd = buildCommand("customNoPaths", ["/work/a"], home, false, [], testApps)
    expect(cmd.bin).toBe("/test/CustomNoPaths")
    expect(cmd.args).not.toContain("/work/a")
  })

  it("passPaths=1 passes only the first path", () => {
    const cmd = buildCommand("customFirstPath", ["/work/a", "/work/b", "/work/c"], home, false, [], testApps)
    expect(cmd.bin).toBe("/test/CustomFirst")
    expect(cmd.args).toContain("/work/a")
    expect(cmd.args).not.toContain("/work/b")
    expect(cmd.args).not.toContain("/work/c")
  })

  it("passPaths=2 passes the first two paths", () => {
    const cmd = buildCommand("customFirstTwo", ["/work/a", "/work/b", "/work/c"], home, false, [], testApps)
    expect(cmd.bin).toBe("/test/CustomFirstTwo")
    expect(cmd.args).toContain("/work/a")
    expect(cmd.args).toContain("/work/b")
    expect(cmd.args).not.toContain("/work/c")
  })

  it("passPaths as array passes explicit paths with ~ resolved", () => {
    const cmd = buildCommand("customExplicitPaths", ["/work/x", "/work/y"], home, false, [], testApps)
    expect(cmd.bin).toBe("/test/CustomExplicit")
    expect(cmd.args).toContain("/Users/testuser/work/a")
    expect(cmd.args).toContain("/Users/testuser/work/b")
    expect(cmd.args).not.toContain("/work/x")
    expect(cmd.args).not.toContain("/work/y")
  })

  it("normalizes .app path to executable for custom app", () => {
    const cmd = buildCommand("gram", ["/work/a"], home, false, [], testApps)
    expect(cmd.bin).toBe("/Applications/Gram.app/Contents/MacOS/Gram")
  })
})

describe("getActivationCommand", () => {
  it("returns open -b command when bundle id is available", () => {
    const cmd = getActivationCommand("xcode", testApps)
    expect(cmd).toEqual({
      bin: "/usr/bin/open",
      args: ["-b", "com.apple.dt.Xcode"],
    })
  })

  it("returns null for builtin shell modes", () => {
    expect(getActivationCommand("term", testApps)).toBeNull()
  })

  it("returns open -a for custom app configured as .app path", () => {
    const cmd = getActivationCommand("gram", testApps)
    expect(cmd).toEqual({
      bin: "/usr/bin/open",
      args: ["-a", "/Applications/Gram.app"],
    })
  })
})

describe("hasAppSandboxEntitlement", () => {
  it("detects app sandbox when plist has true value", () => {
    const xml = `
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key>
  <true/>
</dict></plist>`
    expect(hasAppSandboxEntitlement(xml)).toBe(true)
  })

  it("does not detect app sandbox when plist has false value", () => {
    const xml = `
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key>
  <false/>
</dict></plist>`
    expect(hasAppSandboxEntitlement(xml)).toBe(false)
  })

  it("detects app sandbox in key-value style output", () => {
    const text = "com.apple.security.app-sandbox = true"
    expect(hasAppSandboxEntitlement(text)).toBe(true)
  })
})
