'use client'

import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

export function ThemeScript() {
  const code = `(function(){try{var t=localStorage.getItem('gild.theme')||'dark';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t==='light'?'light':'dark';}catch(e){document.documentElement.dataset.theme='dark';}})()`
  return <script dangerouslySetInnerHTML={{ __html: code }} />
}

function initialTheme(): Theme {
  const resolved = document.documentElement.dataset.theme
  try {
    const stored = localStorage.getItem('gild.theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch { /* Use the palette already resolved by ThemeScript. */ }
  return resolved === 'light' ? 'light' : 'dark'
}

function useTheme() {
  // Hydrate the button's server markup before loading the client preference.
  // The root palette is already correct: never apply a guessed default here.
  const [theme, setTheme] = useState<Theme | null>(null)
  useEffect(() => { setTheme(initialTheme()) }, [])
  useEffect(() => {
    if (theme !== 'system') return
    const media = matchMedia('(prefers-color-scheme: dark)'),
      apply = () => {
        document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
      }
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  const choice = theme ?? 'dark'
  const update = (next: Theme) => {
    setTheme(next)
    try { localStorage.setItem('gild.theme', next) } catch { /* Choice still applies in this tab. */ }
    document.documentElement.dataset.theme =
      next === 'system'
        ? matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : next
  }
  return { theme: choice, update }
}
export function ThemeSelect() {
  const { theme, update } = useTheme()
  return <select aria-label="Theme" value={theme} onChange={e => update(e.target.value as Theme)}>
    <option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option>
  </select>
}
export function ThemeToggle() {
  const { theme: choice, update } = useTheme()
  const cycle = () => update(choice === 'dark' ? 'light' : choice === 'light' ? 'system' : 'dark')
  return (
    <button
      onClick={cycle}
      aria-label={`theme: ${choice} (click to change)`}
      title={`theme: ${choice}`}
      style={{
        background: 'none',
        border: '1px solid var(--rule)',
        borderRadius: '50%',
        width: 28,
        height: 28,
        cursor: 'pointer',
        color: 'var(--ink-soft)',
        fontSize: 14,
      }}
    >
      {choice === 'dark' ? '☾' : choice === 'light' ? '☀' : '◐'}
    </button>
  )
}
