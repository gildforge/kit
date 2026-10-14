'use client'

import { useState } from 'react'

/** One install line with a copy button, deka.gg style. */
export function InstallLine({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <p className="mono-dim" style={{ margin: '0 0 6px', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</p>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          border: '1px solid var(--rule)', borderRadius: 8, background: 'var(--bg-soft)',
          padding: '10px 12px',
        }}
      >
        <code style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflowX: 'auto', whiteSpace: 'nowrap' }}>$ {command}</code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(command)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
          style={{
            border: '1px solid var(--rule)', background: 'none', borderRadius: 6,
            padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: 'var(--ink-soft)',
            fontFamily: 'inherit', flexShrink: 0,
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
    </div>
  )
}
