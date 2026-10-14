/** Issue numbers a PR closes when it merges: GitHub's keywords (close,
 *  closes, closed, fix, fixes, fixed, resolve, resolves, resolved) followed
 *  by #<n>, in its title or body. */
export function closingReferences(text: string): number[] {
  const found = new Set<number>()
  for (const m of text.matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#([1-9][0-9]{0,8})\b/gi,
  ))
    found.add(Number(m[1]))
  return [...found]
}
