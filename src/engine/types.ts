// Shapes the views and the server share. The stores that fill them live
// in the site; these are only the data as it crosses into a view.

export interface Commit { hash: string; tree: string; parents: string[]; author_name: string; author_email: string; time: number; message: string; committer_name?: string; committer_email?: string; committer_time?: number }

export interface Entry { name: string; type: 'tree' | 'blob' | 'commit'; mode: string; child: string }

export interface BlobInfo { hash: string; size: number; lines: number; language: string; binary: number; content: string | null; raw?: string; symbols: { name: string; kind: string; line: number }[] }

export interface IndexRef { name: string; kind: 'branch' | 'tag'; hash: string }

export interface FileDiff {
  path: string
  status: 'added' | 'removed' | 'modified'
  additions: number
  deletions: number
  hunks: { oldStart: number; newStart: number; lines: string[] }[]
  note?: string
}

export interface Change {
  /** The commit compared against (merge base or parent); null for a root commit. */
  from: string | null
  to: string
  files: FileDiff[]
  truncated: boolean
  total: number
  sizes: { path: string; lines: number }[]
}

export interface ProfilePicture {
  url: string | null
  source: 'Uploaded' | 'Gravatar' | 'None'
}

export interface ListingFacts {
  language: { name: string; color: string } | null
  license: string | null
  updated: number
  weeks: Record<string, number>
}

export interface ListingSnapshot {
  note?:string|null
  tip: string | null
  meta: string | null
  facts: ListingFacts | null
  /** Commit that actually produced facts; absent legacy provenance is unknown. */
  factsTip?: string | null
  updated: number | null
  issues: number
  pulls: number
  acl: {
    schema?: number
    visibility?: string
    private?: boolean
    read?: string[]
    write?: string[]
    owners?: string[]
    agents?: Record<string, unknown>
  }
}

export type Status =
  | 'queued'
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
