/** Normalize the TeX delimiters emitted by native runtimes for the existing
 * dollar-delimited renderer. Code and stored message content remain unchanged. */
export function normalizeMathDelimiters(markdown: string) {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((segment, index) => {
      if (index % 2) return segment
      return segment
        .replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g, (_, math) => `$$${math}$$`)
        .replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g, (_, math) => `$${math}$`)
    })
    .join("")
}
