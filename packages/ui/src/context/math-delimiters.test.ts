import { expect, test } from "bun:test"
import { normalizeMathDelimiters } from "./math-delimiters"

test("native runtime inline and display math render through the existing pipeline", () => {
  expect(normalizeMathDelimiters(String.raw`Energy \(E = \frac12 mv^2\).`)).toBe(String.raw`Energy $E = \frac12 mv^2$.`)
  expect(normalizeMathDelimiters("\\[E =\nm c^2\\]")).toBe("$$E =\nm c^2$$")
})
test("code, incomplete streams, escaped delimiters, and existing dollar math stay literal", () => {
  for (const value of [
    String.raw`\(unfinished`,
    String.raw`\[unfinished`,
    String.raw`$x^2$ costs $20`,
    String.raw`\\(literal\\)`,
    "`\\(code\\)`",
    "```tex\n\\[code\\]\n```",
    "~~~tex\n\\[code\\]\n~~~",
  ])
    expect(normalizeMathDelimiters(value)).toBe(value)
})
