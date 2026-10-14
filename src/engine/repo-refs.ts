import { visibleImportRef } from './import/visibility.js'
export interface Refs {
  branches: { name: string; oid: string }[]
  tags: { name: string; oid: string }[]
  defaultBranch: string
  meta: string | null
}
export function refsFromAdvertisement(refs: { ref: string; oid: string; target?: string; peeled?: string }[], internalPrefix?:string): Refs {
  const branches = refs.filter((r) => r.ref.startsWith('refs/heads/') && r.ref !== 'refs/heads/_meta' && visibleImportRef(r.ref.slice(11),internalPrefix)).map((r) => ({ name: r.ref.slice(11), oid: r.oid }))
  const tags = refs.filter((r) => r.ref.startsWith('refs/tags/')).map((r) => ({ name: r.ref.slice(10), oid: r.peeled ?? r.oid })).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
  return { branches, tags, defaultBranch: refs.find((r) => r.ref === 'HEAD')?.target?.replace('refs/heads/', '') ?? branches[0]?.name ?? 'main', meta: refs.find((r) => r.ref === 'refs/heads/_meta')?.oid ?? null }
}

/** Same branch, tag and `_meta` tips. */
export function sameTips(a: Refs, b: Refs) {
  const key = (r: Refs) => JSON.stringify([
    [...r.branches].sort((x, y) => x.name.localeCompare(y.name)).map((x) => [x.name, x.oid]),
    [...r.tags].sort((x, y) => x.name.localeCompare(y.name)).map((x) => [x.name, x.oid]),
    r.meta ?? null,
  ])
  return key(a) === key(b)
}
