const ICONS: Record<string, [string, string]> = {
  ts: ['TS', '#3178c6'],
  tsx: ['TS', '#3178c6'],
  js: ['JS', '#c9a227'],
  mjs: ['JS', '#c9a227'],
  jsx: ['JS', '#c9a227'],
  json: ['{}', '#c9a227'],
  jsonc: ['{}', '#c9a227'],
  md: ['M', '#4d8fe0'],
  yml: ['!', '#a070d0'],
  yaml: ['!', '#a070d0'],
  toml: ['T', '#a070d0'],
  rs: ['RS', '#dea584'],
  css: ['#', '#663399'],
  html: ['<>', '#e34c26'],
  sql: ['DB', '#e38c00'],
  sh: ['$', '#5aa050'],
  lock: ['≡', 'var(--ink-faint)'],
  gitignore: ['◆', 'var(--ink-faint)'],
  LICENSE: ['§', 'var(--accent)'],
}

export function fileIcon(name: string) {
  const ext = name.includes('.') ? name.split('.').pop()! : name
  return ICONS[ext] ?? ICONS[name] ?? ['•', 'var(--ink-faint)']
}

export const Folder = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    aria-hidden="true"
    style={{ flex: 'none' }}
  >
    <path
      d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"
      fill="#c9a24a"
    />
  </svg>
)
