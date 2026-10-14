// The repo-as-a-treemap layout shared by Glance (where a change landed) and
// the Agents map (who is working where): one function, so the two maps can't
// drift. Laid out in a W×H box and drawn in percentages.
import { squarify, type Rect } from './treemap.js'

export const W = 160
export const H = 100
const HEADER = 4.2

// Generated lockfiles are huge and nobody reviews them by eye; they'd crowd
// the map, so they're left off it (their lines still count in the totals).
export const LOCKFILE = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/

export interface MapItem { path: string; lines: number; /** what lights the tile (lines changed) */ weight: number }
export interface Group<T> { name: string; dir: boolean; items: T[]; lines: number; weight: number }

const pct = (n: number) => `${+n.toFixed(3)}%`
/** A rect as CSS percentages of the map. */
export const box = (r: Rect) => ({ left: pct((r.x / W) * 100), top: pct((r.y / H) * 100), width: pct((r.w / W) * 100), height: pct((r.h / H) * 100) })
/** Which way a hover card opens, away from the map's nearest edges. */
export const tipSides = (r: Rect) => ({ below: r.y < 22, left: r.x + r.w / 2 > W / 2 })

/** The folder to zoom into, if it's really a folder in this tree. */
export function cleanRoot(dir: string | undefined, paths: { path: string }[]) {
  const d = (dir ?? '').replace(/^\/+|\/+$/g, '')
  return d && paths.some((s) => s.path.startsWith(`${d}/`)) ? d : ''
}

/** Top-level groups under `root` (folders and loose files), each a squarified
 *  box, with every file squarified inside its folder. */
export function layoutRepo<T extends MapItem>(all: T[], root: string) {
  const prefix = root ? `${root}/` : ''
  const inRoot = all.filter((i) => i.path.startsWith(prefix) && !LOCKFILE.test(i.path))
  const groups = new Map<string, Group<T>>()
  for (const i of inRoot) {
    const rest = i.path.slice(prefix.length)
    const slash = rest.indexOf('/')
    const name = slash < 0 ? rest : rest.slice(0, slash)
    const grp = groups.get(name) ?? { name, dir: slash >= 0, items: [], lines: 0, weight: 0 }
    grp.items.push(i); grp.lines += i.lines; grp.weight += i.weight
    groups.set(name, grp)
  }
  const ordered = [...groups.values()].sort((a, b) => b.lines - a.lines)
  const groupRects = squarify(ordered.map((x) => x.lines), { x: 0, y: 0, w: W, h: H })
  const tiles: { item: T; rect: Rect; name: string }[] = []
  const heads: { group: Group<T>; rect: Rect; labelled: boolean; dir: string }[] = []
  ordered.forEach((grp, gi) => {
    const r = groupRects[gi]
    if (!grp.dir) { tiles.push({ item: grp.items[0], rect: r, name: grp.name }); return }
    const labelled = r.h > HEADER * 2.6 && r.w > 14
    heads.push({ group: grp, rect: r, labelled, dir: prefix + grp.name })
    const pad = 0.35
    const inner = { x: r.x + pad, y: r.y + (labelled ? HEADER : pad), w: r.w - pad * 2, h: r.h - (labelled ? HEADER : pad) - pad }
    const items = [...grp.items].sort((a, b) => b.lines - a.lines)
    squarify(items.map((i) => i.lines), inner).forEach((rect, k) => tiles.push({ item: items[k], rect, name: items[k].path.split('/').pop()! }))
  })
  return { tiles, heads, inRoot, prefix }
}
