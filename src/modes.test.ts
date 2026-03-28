import { describe, it, expect } from "vitest"
import { buildCommand } from "./modes.js"

describe("buildCommand", () => {
  const home = "/Users/testuser"

  it("code mode opens VSCode with workdirs", () => {
    const cmd = buildCommand("code", ["/work/a", "/work/b"], home, false, [])
    expect(cmd.bin).toContain("Visual Studio Code")
    expect(cmd.args).toContain("--no-sandbox")
    expect(cmd.args).toContain("/work/a")
    expect(cmd.args).toContain("/work/b")
  })

  it("code mode with --profile-sandbox adds data/extensions dirs", () => {
    const cmd = buildCommand("code", ["/work/a"], home, true, [])
    expect(cmd.args).toContain("--user-data-dir")
    expect(cmd.args).toContain("--extensions-dir")
    expect(cmd.args.some(a => a.includes(".vscode-sandbox"))).toBe(true)
  })

  it("term mode launches login shell", () => {
    const cmd = buildCommand("term", ["/work/a"], home, false, [])
    expect(cmd.args).toEqual(["-l"])
  })

  it("claude mode launches claude CLI", () => {
    const cmd = buildCommand("claude", ["/work/a"], home, false, [])
    expect(cmd.bin).toBe("claude")
  })

  it("exec mode passes the command through", () => {
    const cmd = buildCommand("exec", ["/work/a"], home, false, ["python", "train.py"])
    expect(cmd.bin).toBe("python")
    expect(cmd.args).toEqual(["train.py"])
  })
})
