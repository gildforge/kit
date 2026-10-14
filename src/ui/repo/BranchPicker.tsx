'use client'

import { channelObjectURL } from './ChannelModal.js'
import { useRouter } from 'next/navigation'
import s from '../../render/styles/repo.module.css'

export function BranchPicker({ owner, repo, current, branches, tags }: {
  owner: string; repo: string; current: string; branches: string[]; tags: string[]
}) {
  const router = useRouter()
  return (
    <label className={s.control}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 3-11 6" />
      </svg>
      <span className="sr-only">Branch or tag</span>
      <select value={current} onChange={(e) => {const target=`/${owner}/${repo}?ref=${encodeURIComponent(e.target.value)}`;if(location.pathname===`/${owner}/${repo}/agents`)router.replace(channelObjectURL(`/${owner}/${repo}`,target));else router.push(target)}}>
        <optgroup label="Branches">{branches.map((b) => <option key={b} value={b}>{b}</option>)}</optgroup>
        {tags.length > 0 && <optgroup label="Tags">{tags.map((t) => <option key={t} value={t}>{t}</option>)}</optgroup>}
      </select>
    </label>
  )
}
