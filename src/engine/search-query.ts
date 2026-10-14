// GitHub-style code queries. The AST is also used to narrow SQLite candidates;
// final evaluation always uses the original query, never FTS token semantics.
import { RE2JS } from 're2js'

export type Atom = { op: 'term'; field: string; value: string; form: 'literal' | 'word' | 'regex' }
export type Query = Atom | { op: 'and'; left: Query; right: Query } | { op: 'or'; left: Query; right: Query } | { op: 'not'; child: Query }
const FIELDS = new Set(['repo', 'org', 'user', 'language', 'path', 'content', 'is', 'symbol', 'branch', 'ref'])
export function regex(value: string) {
  // RE2 is linear time and rejects look-around/backreferences. User patterns
  // must never block the one event loop shared by every reader of this repo.
  return RE2JS.compile(value, RE2JS.CASE_INSENSITIVE | RE2JS.MULTILINE)
}
export function parseQuery(input: string): { query: Query; fallback: boolean } {
  try {
    if (input.length > 2048) throw new Error('query too long')
    let i = 0
    const tokens: (Atom | string)[] = []
    while (i < input.length) {
      if (/\s/.test(input[i])) { i++; continue }
      if ('()'.includes(input[i])) { tokens.push(input[i++]); continue }
      const qualifier = input.slice(i).match(/^([a-z]+):/i)
      const field = qualifier?.[1].toLowerCase() ?? ''
      if (qualifier) { if (!FIELDS.has(field)) throw new Error('unknown qualifier'); i += qualifier[0].length }
      let value = '', form: Atom['form'] = 'word'
      if (input[i] === '"') {
        form = 'literal'; i++
        while (i < input.length && input[i] !== '"') {
          if (input[i] === '\\' && ['"', '\\'].includes(input[i + 1])) i++
          value += input[i++]
        }
        if (input[i++] !== '"') throw new Error('unclosed quote')
      } else if (input[i] === '/' && (field !== 'path' || hasRegexEnd(input, i))) {
        form = 'regex'; i++
        while (i < input.length && input[i] !== '/') {
          if (input[i] === '\\' && i + 1 < input.length) value += input[i++]
          value += input[i++]
        }
        if (input[i++] !== '/') throw new Error('unclosed regex')
        regex(value)
      } else {
        while (i < input.length && !/[\s()]/.test(input[i])) {
          if (input[i] === '"') throw new Error('quote within word')
          if (input[i] === '\\' && ['"', '\\'].includes(input[i + 1])) i++
          value += input[i++]
        }
      }
      if (!value || (i < input.length && !/[\s)]/.test(input[i]))) throw new Error('missing separator')
      tokens.push(!field && form === 'word' && ['AND', 'OR', 'NOT'].includes(value) ? value : { op: 'term', field, value, form })
    }
    let p = 0
    function unary(): Query {
      const t = tokens[p++]
      if (t === 'NOT') return { op: 'not', child: unary() }
      if (t === '(') { const q = or(); if (tokens[p++] !== ')') throw new Error('missing )'); return q }
      if (!t || typeof t === 'string') throw new Error('missing operand')
      return t
    }
    function and(): Query {
      let q = unary()
      while (p < tokens.length && tokens[p] !== ')' && tokens[p] !== 'OR') {
        if (tokens[p] === 'AND') p++
        q = { op: 'and', left: q, right: unary() }
      }
      return q
    }
    function or(): Query {
      let q = and()
      while (tokens[p] === 'OR') { p++; q = { op: 'or', left: q, right: and() } }
      return q
    }
    const query = or()
    if (p !== tokens.length) throw new Error('trailing token')
    return { query, fallback: false }
  } catch {
    return { query: { op: 'term', field: '', value: input, form: 'literal' }, fallback: true }
  }
}
function hasRegexEnd(input: string, start: number) {
  for (let i = start + 1; i < input.length; i++) {
    if (input[i] === '\\') { i++; continue }
    if (input[i] === '/' && (i + 1 === input.length || /[\s)]/.test(input[i + 1]))) return true
  }
  return false
}
export function atoms(q: Query, positive = true): Atom[] {
  if (q.op === 'term') return positive ? [q] : []
  if (q.op === 'not') return atoms(q.child, !positive)
  return [...atoms(q.left, positive), ...atoms(q.right, positive)]
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function glob(value: string) {
  const anchored = value.startsWith('/')
  let out = anchored ? '^' : '(?:^|/)'
  value = value.replace(/^\//, '')
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '*' && value[i + 1] === '*') {
      i++
      if (value[i + 1] === '/') { i++; out += '(?:.*/)?' } else out += '.*'
    } else if (value[i] === '*') out += '[^/]*'
    else if (value[i] === '?') out += '[^/]'
    else out += escape(value[i])
  }
  // RE2 (linear time) like every other pattern a user types: a glob such as
  // a*a*a*… must not be able to backtrack the Worker into a timeout.
  const re = RE2JS.compile(out + '$', RE2JS.CASE_INSENSITIVE)
  return { test: (path: string) => re.matcher(path).find() }
}
export interface Document {
  repo: string; ownerKind: 'org' | 'user'; ref: string; refKind?: 'branch' | 'tag'; path: string; language: string; content: string
  symbols: { name: string; kind: string; line: number }[]
}
export function ranges(a: Atom, text: string): [number, number][] {
  const out: [number, number][] = []
  if (a.form === 'regex') {
    const m = regex(a.value).matcher(text)
    while (m.find() && out.length < 100) if (m.end() > m.start()) out.push([m.start(), m.end()])
  } else if (a.value) {
    const lower = text.toLowerCase(), term = a.value.toLowerCase()
    for (let pos = 0; out.length < 100;) {
      const at = lower.indexOf(term, pos)
      if (at < 0) break
      out.push([at, at + term.length]); pos = at + term.length
    }
  }
  return out
}
export function matches(q: Query, d: Document): boolean {
  if (q.op === 'and') return matches(q.left, d) && matches(q.right, d)
  if (q.op === 'or') return matches(q.left, d) || matches(q.right, d)
  if (q.op === 'not') return !matches(q.child, d)
  const value = q.value.toLowerCase()
  const has = (s: string) => q.form === 'regex' ? regex(q.value).matcher(s).find() : s.toLowerCase().includes(value)
  switch (q.field) {
    case 'repo': return d.repo.toLowerCase() === value
    case 'org': case 'user': return d.ownerKind === q.field && d.repo.split('/')[0].toLowerCase() === value
    case 'language': return (d.language || 'Other').toLowerCase() === value
    case 'branch': return d.refKind !== 'tag' && d.ref.toLowerCase() === value
    case 'ref': return d.ref.toLowerCase() === value
    case 'path': return q.form === 'word' && /[*?]/.test(q.value) ? glob(q.value).test(d.path) : has(d.path)
    case 'content': return has(d.content)
    case 'symbol': return d.symbols.some((s) => q.form === 'regex' ? has(s.name) : s.name.toLowerCase().startsWith(value))
    case 'is': return value === 'vendored' ? /(^|\/)(vendor|node_modules)\//i.test(d.path)
      : value === 'generated' && (/(^|\/)(dist|build|generated)\//i.test(d.path) || /(?:@generated|auto[- ]generated|do not edit)/i.test(d.content.slice(0, 2000)))
    default: return has(d.path) || has(d.content)
  }
}
export interface SearchLine { line: number; text: string; ranges: [number, number][] }
export function snippets(q: Query, d: Document): SearchLine[] {
  const found = atoms(q).filter((a) => !a.field || a.field === 'content').flatMap((a) => ranges(a, d.content))
  for (const a of atoms(q).filter((a) => a.field === 'symbol')) {
    for (const s of d.symbols) if (matches(a, { ...d, symbols: [s] })) {
      const start = d.content.split('\n').slice(0, s.line - 1).join('\n').length + (s.line > 1 ? 1 : 0)
      found.push([start, start + (d.content.split('\n')[s.line - 1]?.length ?? 0)])
    }
  }
  const result: SearchLine[] = []
  let offset = 0
  for (const [i, text] of d.content.split('\n').entries()) {
    const lineRanges = found.filter(([a, b]) => a < offset + text.length && b > offset)
      .map(([a, b]): [number, number] => [Math.max(0, a - offset), Math.min(text.length, b - offset)])
    if (lineRanges.length) {
      // Trim long lines around the first match, retaining UTF-16 offsets for React.
      const start = Math.max(0, lineRanges[0][0] - 100), end = start + 300
      result.push({ line: i + 1, text: text.slice(start, end), ranges: lineRanges.filter(([a]) => a < end).map(([a, b]) => [Math.max(0, a - start), Math.min(end, b) - start]) })
    }
    offset += text.length + 1
    if (result.length === 5) break
  }
  return result.length ? result : [{ line: 1, text: d.content.split('\n')[0]?.slice(0, 300) ?? '', ranges: [] }]
}
