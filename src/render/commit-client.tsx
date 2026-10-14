import g from './styles/glance.module.css'
import { createRoot, type Root } from 'react-dom/client'
import { CommitActions } from './Actions.js'
import { SessionReceipts } from './SessionReceipts.js'
import type { Receipt } from '../engine/sessions-contract.js'
import type { Status } from '../engine/types.js'
const roots = new WeakMap<Element, Root>()
function mount(target: Element, view: React.ReactNode) {
  let root = roots.get(target)
  if (!root) {
    root = createRoot(target)
    roots.set(target, root)
  }
  root.render(view)
}
export function mountCommit(
  repository: string,
  sha: string,
  runs: { id: number; status: Status; workflow: { file: string } }[],
  receipts: Receipt[],
) {
  const [owner, repo] = repository.split('/'),
    actions = document.querySelector('[data-live-actions]'),
    sessions = document.querySelector('[data-live-receipts]')
  if (actions)
    mount(
      actions,
      <CommitActions owner={owner} repo={repo} sha={sha} runs={runs} />,
    )
  if (sessions)
    mount(
      sessions,
      <SessionReceipts
        receipts={receipts}
        fileHref={(path) => `?file=${encodeURIComponent(path)}#diffs`}
      />,
    )
  const read = new Set(receipts.flatMap((r) => r.files.read)),
    written = new Set(receipts.flatMap((r) => r.files.written))
  document
    .querySelectorAll<HTMLElement>('[data-receipt-path]')
    .forEach((tile) => {
      const path = tile.dataset.receiptPath
      if (!path) return
      tile.dataset.receiptRead = String(read.has(path))
      tile.dataset.receiptWritten = String(written.has(path))
      tile.classList.toggle(g.read, read.has(path))
      tile.classList.toggle(g.written, written.has(path))
    })
}
