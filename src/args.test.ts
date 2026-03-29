import { describe, it, expect, vi, afterEach } from "vitest"

import { parseArgs } from "./args.js"

const ALL_MODES = ["code", "xcode", "term", "claude", "exec"]

describe("parseArgs", () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  function argv(...args: string[]) {
    process.argv = ["node", "bx.js", ...args]
  }

  it("defaults to code mode with cwd", () => {
    argv()
    const result = parseArgs(ALL_MODES)
    expect(result.mode).toBe("code")
    expect(result.workArgs).toEqual(["."])
  })

  it("parses explicit code mode", () => {
    argv("code", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.mode).toBe("code")
    expect(result.workArgs).toEqual(["/tmp/project"])
  })

  it("parses term mode", () => {
    argv("term", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.mode).toBe("term")
    expect(result.workArgs).toEqual(["/tmp/project"])
  })

  it("parses claude mode", () => {
    argv("claude", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.mode).toBe("claude")
    expect(result.workArgs).toEqual(["/tmp/project"])
  })

  it("parses xcode as a dynamic app mode", () => {
    argv("xcode", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.mode).toBe("xcode")
    expect(result.workArgs).toEqual(["/tmp/project"])
  })

  it("parses custom app mode from config", () => {
    argv("cursor", "/tmp/project")
    const result = parseArgs([...ALL_MODES, "cursor"])
    expect(result.mode).toBe("cursor")
    expect(result.workArgs).toEqual(["/tmp/project"])
  })

  it("treats unknown first arg as workdir, not mode", () => {
    argv("/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.mode).toBe("code")
    expect(result.workArgs).toEqual(["/tmp/project"])
  })

  it("parses multiple workdirs", () => {
    argv("code", "/tmp/a", "/tmp/b", "/tmp/c")
    const result = parseArgs(ALL_MODES)
    expect(result.mode).toBe("code")
    expect(result.workArgs).toEqual(["/tmp/a", "/tmp/b", "/tmp/c"])
  })

  it("parses exec mode with command after --", () => {
    argv("exec", "/tmp/project", "--", "python", "train.py")
    const result = parseArgs(ALL_MODES)
    expect(result.mode).toBe("exec")
    expect(result.workArgs).toEqual(["/tmp/project"])
    expect(result.execCmd).toEqual(["python", "train.py"])
  })

  it("parses --verbose flag", () => {
    argv("--verbose", "term", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.verbose).toBe(true)
    expect(result.mode).toBe("term")
  })

  it("parses --profile-sandbox flag", () => {
    argv("--profile-sandbox", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.profileSandbox).toBe(true)
  })

  it("exec mode without -- aborts", () => {
    argv("exec", "/tmp/project")
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, "error").mockImplementation(() => { })
    expect(() => parseArgs(ALL_MODES)).toThrow("process.exit(1)")
  })
})
