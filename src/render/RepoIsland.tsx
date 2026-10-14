import type { ReactNode } from 'react'
/** Explicit public props survive publication without Next's Flight runtime. */
export function RepoIsland({
  kind,
  props,
  children,
}: {
  kind: 'actions' | 'agents' | 'create' | 'sidebar'
  props: object
  children: ReactNode
}) {
  return (
    <div
      data-repo-island={kind}
      style={
        ['create', 'sidebar'].includes(kind)
          ? { display: 'contents' }
          : undefined
      }
    >
      <script
        data-island-props=""
        type="application/json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(props).replaceAll('<', '\\u003c'),
        }}
      />
      <div
        data-island-body=""
        style={
          ['create', 'sidebar'].includes(kind)
            ? { display: 'contents' }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  )
}
