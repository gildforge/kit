import { parseWorkflow, type Workflow } from './workflow.js'
import type { ObjectSource } from '../repo-indexer.js'
export interface TreeSource {
  commit: (sha: string) => Promise<{ tree: string }>
  tree: ObjectSource['tree']
}
interface WorkflowSource extends TreeSource {
  blob: ObjectSource['blob']
}
export async function loadWorkflows(
  source: WorkflowSource,
  sha: string,
): Promise<Workflow[]> {
  let root = (await source.commit(sha)).tree
  for (const name of ['.github', 'workflows']) {
    const found = (await source.tree(root)).find(
      (e) => e.name === name && e.type === 'tree',
    )
    if (!found) return []
    root = found.child
  }
  const files = (await source.tree(root)).filter(
    (e) => e.type === 'blob' && /\.ya?ml$/.test(e.name),
  )
  if (files.length > 64)
    throw new Error('Actions supports at most 64 workflows per repo')
  return Promise.all(
    files.map(async (f) => {
      const b = await source.blob(f.child)
      if (b.length > 128 * 1024 || b.includes(0))
        return {
          file: f.name,
          name: f.name,
          triggers: {},
          env: {},
          jobs: [],
          error: 'workflow must be text under 128 KiB',
        }
      return parseWorkflow(f.name, new TextDecoder().decode(b))
    }),
  )
}
export async function changedPaths(
  from: TreeSource | null,
  before: string | null,
  to: TreeSource,
  sha: string,
): Promise<string[]> {
  const left = from && before ? (await from.commit(before)).tree : null,
    right = (await to.commit(sha)).tree,
    paths: string[] = []
  const walk = async (a: string | null, b: string | null, prefix: string) => {
    if (a === b) return
    const [aa, bb] = await Promise.all([
        a && from ? from.tree(a) : [],
        b ? to.tree(b) : [],
      ]),
      names = new Set([...aa, ...bb].map((e) => e.name))
    for (const n of names) {
      const x = aa.find((e) => e.name === n),
        y = bb.find((e) => e.name === n)
      if (x?.child === y?.child) continue
      if (x?.type === 'tree' || y?.type === 'tree') {
        await walk(
          x?.type === 'tree' ? x.child : null,
          y?.type === 'tree' ? y.child : null,
          `${prefix}${n}/`,
        )
        if ((x && x.type !== 'tree') || (y && y.type !== 'tree'))
          paths.push(prefix + n)
      } else paths.push(prefix + n)
    }
  }
  await walk(left, right, '')
  return paths.sort()
}

/** Breadth-first ancestry for the small-repo PR subset. Cached commit headers
 * avoid full clones; a bounded graph fails visibly rather than guessing. */
export async function mergeBase(
  head: string,
  base: string,
  read: (hash: string) => Promise<{ parents: string[] }>,
): Promise<string | null> {
  const left = new Set<string>(),
    right = new Set<string>()
  let a = [head],
    b = [base],
    count = 0
  while (a.length || b.length) {
    for (const [queue, own, other] of [
      [a, left, right],
      [b, right, left],
    ] as const)
      for (const h of queue) {
        if (other.has(h)) return h
        own.add(h)
      }
    const next = async (queue: string[], own: Set<string>) => {
      const out: string[] = []
      for (const h of queue) {
        if (++count > 5000)
          throw new Error('PR ancestry exceeds the 5000-commit Actions limit')
        for (const p of (await read(h)).parents)
          if (!own.has(p)) {
            own.add(p)
            out.push(p)
          }
      }
      return [...new Set(out)]
    }
    a = await next(a, left)
    b = await next(b, right)
  }
  return null
}
