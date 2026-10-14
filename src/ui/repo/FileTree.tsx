'use client'

import Link from '../Link.js'
import { useState } from 'react'
import s from '../../render/styles/repo.module.css'

export interface Entry { name: string; hash: string; type: 'blob' | 'tree' | 'commit' }

import {fileIcon,Folder} from '../../render/file-icons.js'

/** VS Code-style tree. Folders load on first open; files are links, so the
 *  open file is in the URL and the server renders it in place of the README. */
export function FileTree({
  owner, repo, refName, initial, selected,
}: {
  owner: string
  repo: string
  refName: string
  /** Directory path ('' = root) → its entries, for every folder that starts open. */
  initial: Record<string, Entry[]>
  selected: string | null
}) {
  const [dirs, setDirs] = useState<Record<string, Entry[]>>(initial)
  const [open, setOpen] = useState<Record<string, boolean>>(
    Object.fromEntries(Object.keys(initial).filter(Boolean).map((d) => [d, true])),
  )
  const [loading, setLoading] = useState<string | null>(null)

  async function toggle(path: string, hash: string) {
    if (open[path]) return setOpen({ ...open, [path]: false })
    if (!dirs[path]) {
      setLoading(path)
      try {
        const res = await fetch(`/api/repos/${owner}/${repo}/tree?hash=${hash}`)
        if (!res.ok) return
        const entries = (await res.json()) as Entry[]
        setDirs((d) => ({ ...d, [path]: entries }))
      } finally {
        setLoading(null)
      }
    }
    setOpen((o) => ({ ...o, [path]: true }))
  }

  const rows: React.ReactNode[] = []
  const walk = (dir: string, depth: number) => {
    for (const e of dirs[dir] ?? []) {
      if (e.type === 'commit') continue // submodule: nothing to show here
      const path = dir ? `${dir}/${e.name}` : e.name
      const pad = { paddingLeft: 10 + depth * 14 }
      if (e.type === 'tree') {
        rows.push(
          <button key={path} type="button" className={s.row} style={pad} onClick={() => toggle(path, e.hash)} aria-expanded={!!open[path]}>
            <span className={s.chev}>{loading === path ? '…' : open[path] ? '▾' : '▸'}</span>
            <Folder />
            <span className={s.label}>{e.name}</span>
          </button>,
        )
        if (open[path]) walk(path, depth + 1)
      } else {
        const [glyph, color] = fileIcon(e.name)
        const q = new URLSearchParams({ ref: refName, path })
        rows.push(
          <Link key={path} href={`/${owner}/${repo}?${q}`} className={`${s.row} ${selected === path ? s.rowOn : ''}`} style={pad} scroll={false}>
            <span className={s.chev} />
            <span className={s.icon} style={{ color }}>{glyph}</span>
            <span className={s.label}>{e.name}</span>
          </Link>,
        )
      }
    }
  }
  walk('', 0)

  return <nav aria-label="Files" className={s.tree}>{rows}</nav>
}
