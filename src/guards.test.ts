import { describe, it, expect, vi, beforeEach } from "vitest"

// We test checkWorkDirs by importing it directly.
// The other guards rely on process.env/process.exit and filesystem probes,
// so we mock process.exit to capture the abort.

import { checkWorkDirs } from "./guards.js"

describe("checkWorkDirs", () => {
  const home = "/Users/testuser"

  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, "error").mockImplementation(() => { })
  })

  it("accepts a valid workdir inside HOME", () => {
    expect(() => checkWorkDirs([`${home}/projects/myapp`], home)).not.toThrow()
  })

  it("accepts multiple valid workdirs", () => {
    expect(() => checkWorkDirs([
      `${home}/projects/a`,
      `${home}/work/b`,
    ], home)).not.toThrow()
  })

  it("rejects HOME itself", () => {
    expect(() => checkWorkDirs([home], home)).toThrow("process.exit(1)")
  })

  it("rejects a path outside HOME", () => {
    expect(() => checkWorkDirs(["/tmp/project"], home)).toThrow("process.exit(1)")
  })

  it("rejects a sibling of HOME", () => {
    expect(() => checkWorkDirs(["/Users/other"], home)).toThrow("process.exit(1)")
  })

  it("rejects parent of HOME", () => {
    expect(() => checkWorkDirs(["/Users"], home)).toThrow("process.exit(1)")
  })

  it("rejects if any one workdir is invalid", () => {
    expect(() => checkWorkDirs([
      `${home}/projects/ok`,
      "/tmp/bad",
    ], home)).toThrow("process.exit(1)")
  })
})
