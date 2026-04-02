import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expandGlobs } from "./paths.js"

describe("expandGlobs", () => {
  let tmp: string
  let home: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "bx-paths-test-"))
    home = join(tmp, "home")
    mkdirSync(home)
    mkdirSync(join(home, "work"))
    mkdirSync(join(home, "work", "project-a"))
    mkdirSync(join(home, "work", "project-b"))
    mkdirSync(join(home, "work", "other"))
    writeFileSync(join(home, "work", "file.txt"), "not a dir")
    mkdirSync(join(home, "docs"))
    mkdirSync(join(home, "docs", "notes"))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("passes through plain paths unchanged", () => {
    const result = expandGlobs(["/some/path", "/other"], home)
    expect(result).toEqual(["/some/path", "/other"])
  })

  it("expands ~ to home", () => {
    const result = expandGlobs(["~/docs"], home)
    expect(result).toEqual([join(home, "docs")])
  })

  it("expands * to all subdirectories", () => {
    const result = expandGlobs(["~/work/*"], home)
    expect(result.sort()).toEqual([
      join(home, "work", "other"),
      join(home, "work", "project-a"),
      join(home, "work", "project-b"),
    ])
  })

  it("does not match files, only directories", () => {
    const result = expandGlobs(["~/work/*"], home)
    expect(result).not.toContain(join(home, "work", "file.txt"))
  })

  it("expands prefix glob pattern", () => {
    const result = expandGlobs(["~/work/project-*"], home)
    expect(result.sort()).toEqual([
      join(home, "work", "project-a"),
      join(home, "work", "project-b"),
    ])
  })

  it("returns empty for non-existent parent directory", () => {
    const result = expandGlobs(["~/nonexistent/*"], home)
    expect(result).toEqual([])
  })

  it("returns empty when no directories match", () => {
    const result = expandGlobs(["~/work/zzz-*"], home)
    expect(result).toEqual([])
  })

  it("mixes plain paths and globs", () => {
    const result = expandGlobs(["/fixed/path", "~/work/project-*"], home)
    expect(result).toEqual([
      "/fixed/path",
      join(home, "work", "project-a"),
      join(home, "work", "project-b"),
    ])
  })
})
