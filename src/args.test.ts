import { describe, it, expect, vi, afterEach } from "vitest"

import { parseArgs, parseSubcommand } from "./args.js"

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
    expect(result.appArgs).toEqual(["python", "train.py"])
  })

  it("parses app arguments after -- for app modes", () => {
    argv("xcode", "/tmp/project", "--", "MyApp.xcworkspace")
    const result = parseArgs(ALL_MODES)
    expect(result.mode).toBe("xcode")
    expect(result.workArgs).toEqual(["/tmp/project"])
    expect(result.appArgs).toEqual(["MyApp.xcworkspace"])
  })

  it("parses --verbose flag", () => {
    argv("--verbose", "term", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.verbose).toBe(true)
    expect(result.mode).toBe("term")
  })

  it("parses --vscode-user flag (bare)", () => {
    argv("--vscode-user", "code", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.vscodeUser).toBe(true)
    expect(result.mode).toBe("code")
    expect(result.workArgs).toEqual(["/tmp/project"])
  })

  it("parses --vscode-user with path", () => {
    argv("--vscode-user", "~/my-profile", "code", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.vscodeUser).toBe("~/my-profile")
    expect(result.mode).toBe("code")
    expect(result.workArgs).toEqual(["/tmp/project"])
  })

  it("parses --vscode-user-data alias", () => {
    argv("--vscode-user-data", "code", "/tmp/project")
    const result = parseArgs(ALL_MODES)
    expect(result.vscodeUser).toBe(true)
  })

  it("parses --vscode-user=path equals syntax", () => {
    argv("--vscode-user=/custom/profile", "code", "/tmp")
    const result = parseArgs(ALL_MODES)
    expect(result.vscodeUser).toBe("/custom/profile")
    expect(result.mode).toBe("code")
    expect(result.workArgs).toEqual(["/tmp"])
  })

  it("parses --vscode-user=~/path equals syntax", () => {
    argv("--vscode-user=~/my-profile", "code", "/tmp")
    const result = parseArgs(ALL_MODES)
    expect(result.vscodeUser).toBe("~/my-profile")
    expect(result.mode).toBe("code")
    expect(result.workArgs).toEqual(["/tmp"])
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

describe("parseSubcommand", () => {
  const originalArgv = process.argv

  afterEach(() => {
    process.argv = originalArgv
  })

  function argv(...args: string[]) {
    process.argv = ["node", "bx.js", ...args]
  }

  it("no args => launch", () => {
    argv()
    const result = parseSubcommand()
    expect(result.subcommand).toBe("launch")
  })

  it("unknown arg => launch (pass-through)", () => {
    argv("code", "/tmp/project")
    const result = parseSubcommand()
    expect(result.subcommand).toBe("launch")
  })

  it("inspect <path> => inspect with inspectPath", () => {
    argv("inspect", "/Users/test/.aws")
    const result = parseSubcommand()
    expect(result.subcommand).toBe("inspect")
    expect(result.inspectPath).toBe("/Users/test/.aws")
  })

  it("inspect with no path => exit 1", () => {
    argv("inspect")
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, "error").mockImplementation(() => { })
    expect(() => parseSubcommand()).toThrow("process.exit(1)")
  })

  it("inspect --help => exit 0", () => {
    argv("inspect", "--help")
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, "log").mockImplementation(() => { })
    expect(() => parseSubcommand()).toThrow("process.exit(0)")
  })

  it("snapshot => snapshot subcommand", () => {
    argv("snapshot")
    const result = parseSubcommand()
    expect(result.subcommand).toBe("snapshot")
  })

  it("snapshot --help => exit 0", () => {
    argv("snapshot", "--help")
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, "log").mockImplementation(() => { })
    expect(() => parseSubcommand()).toThrow("process.exit(0)")
  })

  it("diff => diff subcommand, exitCode false", () => {
    argv("diff")
    const result = parseSubcommand()
    expect(result.subcommand).toBe("diff")
    expect(result.exitCode).toBe(false)
  })

  it("diff --exit-code => diff subcommand, exitCode true", () => {
    argv("diff", "--exit-code")
    const result = parseSubcommand()
    expect(result.subcommand).toBe("diff")
    expect(result.exitCode).toBe(true)
  })

  it("diff --help => exit 0", () => {
    argv("diff", "--help")
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, "log").mockImplementation(() => { })
    expect(() => parseSubcommand()).toThrow("process.exit(0)")
  })
})
