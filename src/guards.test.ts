import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync, accessSync as realAccessSync, constants } from "node:fs"
import { join } from "node:path"

let mockAccessSync: ReturnType<typeof vi.fn> | null = null

vi.mock("node:fs", async (importOriginal) => {
  const orig: any = await importOriginal()
  return {
    ...orig,
    accessSync: (...args: any[]) => {
      if (mockAccessSync) return mockAccessSync(...args)
      return orig.accessSync(...args)
    },
  }
})

import { checkWorkDirs, checkOwnSandbox, checkVSCodeTerminal, checkExternalSandbox } from "./guards.js"

const tmpBase = join("/tmp", `bx-test-guards-${process.pid}`)

beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation((code?: any) => {
    throw new Error(`process.exit(${code})`)
  })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.CODEBOX_SANDBOX
  delete process.env.VSCODE_PID
  mockAccessSync = null
  rmSync(tmpBase, { recursive: true, force: true })
})

describe("checkOwnSandbox", () => {
  it("exits when CODEBOX_SANDBOX is '1'", () => {
    process.env.CODEBOX_SANDBOX = "1"
    expect(() => checkOwnSandbox()).toThrow("process.exit(1)")
  })

  it("does nothing when CODEBOX_SANDBOX is not set", () => {
    delete process.env.CODEBOX_SANDBOX
    expect(() => checkOwnSandbox()).not.toThrow()
  })

  it("does nothing when CODEBOX_SANDBOX is '0'", () => {
    process.env.CODEBOX_SANDBOX = "0"
    expect(() => checkOwnSandbox()).not.toThrow()
  })
})

describe("checkVSCodeTerminal", () => {
  it("warns when VSCODE_PID is set", () => {
    process.env.VSCODE_PID = "12345"
    checkVSCodeTerminal()

    const allArgs = (console.error as any).mock.calls.map((c: any) => c[0]).join("\n")
    expect(allArgs).toContain("VSCode terminal")
  })

  it("does nothing when VSCODE_PID is not set", () => {
    delete process.env.VSCODE_PID
    checkVSCodeTerminal()
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe("checkWorkDirs", () => {
  const home = join(tmpBase, "home")

  beforeEach(() => {
    mkdirSync(join(home, "work", "project"), { recursive: true })
  })

  it("accepts a valid workdir inside HOME", () => {
    expect(() => checkWorkDirs([join(home, "work", "project")], home)).not.toThrow()
  })

  it("accepts multiple valid workdirs", () => {
    mkdirSync(join(home, "work", "other"), { recursive: true })
    expect(() => checkWorkDirs([
      join(home, "work", "project"),
      join(home, "work", "other"),
    ], home)).not.toThrow()
  })

  it("rejects HOME itself", () => {
    expect(() => checkWorkDirs([home], home)).toThrow("process.exit(1)")
  })

  it("rejects a path outside HOME", () => {
    expect(() => checkWorkDirs(["/tmp/project"], home)).toThrow("process.exit(1)")
  })

  it("rejects a sibling of HOME", () => {
    expect(() => checkWorkDirs([join(tmpBase, "other")], home)).toThrow("process.exit(1)")
  })

  it("rejects parent of HOME", () => {
    expect(() => checkWorkDirs([tmpBase], home)).toThrow("process.exit(1)")
  })

  it("rejects if any one workdir is invalid", () => {
    expect(() => checkWorkDirs([
      join(home, "work", "project"),
      "/tmp/bad",
    ], home)).toThrow("process.exit(1)")
  })

  it("rejects self-protected dir via .bxprotect", () => {
    const dir = join(home, "work", "project")
    writeFileSync(join(dir, ".bxprotect"), "")
    expect(() => checkWorkDirs([dir], home)).toThrow("process.exit(1)")
  })

  it("rejects self-protected dir via .bxignore with /", () => {
    const dir = join(home, "work", "project")
    writeFileSync(join(dir, ".bxignore"), "/\n")
    expect(() => checkWorkDirs([dir], home)).toThrow("process.exit(1)")
  })

  it("rejects self-protected dir via .bxignore with .", () => {
    const dir = join(home, "work", "project")
    writeFileSync(join(dir, ".bxignore"), ".\n")
    expect(() => checkWorkDirs([dir], home)).toThrow("process.exit(1)")
  })
})

describe("checkExternalSandbox", () => {
  it("does not exit when probed dirs are accessible", () => {
    mockAccessSync = vi.fn(() => {})
    expect(() => checkExternalSandbox()).not.toThrow()
  })

  it("exits when a probed dir returns EPERM", () => {
    const err: any = new Error("EPERM")
    err.code = "EPERM"
    mockAccessSync = vi.fn(() => { throw err })
    expect(() => checkExternalSandbox()).toThrow("process.exit(1)")
  })

  it("ignores non-EPERM errors (e.g. ENOENT)", () => {
    const err: any = new Error("ENOENT")
    err.code = "ENOENT"
    mockAccessSync = vi.fn(() => { throw err })
    expect(() => checkExternalSandbox()).not.toThrow()
  })
})
