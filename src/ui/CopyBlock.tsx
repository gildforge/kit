'use client'

import { useState } from 'react'

/** A terminal command block with a copy button beside it (not overlaying text). */
export function CopyBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
      <pre
        style={{
          flex: 1, margin: 0, padding: '10px 12px', borderRadius: 6, fontSize: 12.5,
          background: 'var(--bg)', border: '1px solid var(--rule)', overflowX: 'auto',
        }}
      >
        {command}
      </pre>
      <button
        onClick={() => {
          navigator.clipboard.writeText(command)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
        style={{
          border: '1px solid var(--rule)', background: 'var(--panel)', borderRadius: 6,
          padding: '0 12px', fontSize: 11.5, cursor: 'pointer', color: 'var(--ink-soft)',
          fontFamily: 'inherit', flexShrink: 0,
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  )
}
