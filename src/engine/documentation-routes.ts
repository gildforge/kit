/** Finite build-owned documents. Neither content nor filenames come from a request. */
export const documentationRoutes = [
  { path: '/docs/api', id: 'api', source: 'app/(marketing)/docs/api/page.tsx' },
  { path: '/docs/api/sessions', id: 'sessions', source: 'app/(marketing)/docs/api/sessions/page.tsx' },
] as const
export function documentationAsset(build: string, id: string) {
  return `/_next/static/${encodeURIComponent(build)}/gild-documents/${id}.html`
}
