import type { Entry, Commit, Change, ListingSnapshot } from './types.js'
import type { Report } from './cqx-report.js'
import type { Fragment } from '../render/address.js'

export interface RenderJob {
  entity: string
  repository: string
  oldTip: string | null
  newTip: string
  meta: string | null
  /** Cold reads enqueue an immutable artifact; they never execute its build. */
  item?: RenderItem
}
export interface FileAddress {
  path: string
  blob: string
  fragment: Fragment
  readme?: Fragment
  source: Fragment
  bytes: number
  text: boolean
}
export interface TipManifest {
  tree: string
  files: FileAddress[]
  treeHTML?: Record<string, string>
  trees: { path: string; hash: string }[]
  bundle: Fragment | null
}
export interface HomeData {
  repository: string
  ref: string
  commit: Commit | null
  meta: string | null
  branches: string[]
  tags: string[]
  description: string
  archived: boolean
  acl: ListingSnapshot['acl']
  issues: number
  pulls: number
  tree: Entry[]
  languages: { name: string; color: string; share: number }[]
  contributors: {
    name: string
    count: number
    picture?: import('./types.js').ProfilePicture
  }[]
  commits: number
  score: Report | null
}
export type RenderData =
  | {
      kind: 'blob'
      text: string | null
      bytes: number
      binary: boolean
      language: string
      markdown: boolean
    }
  | { kind: 'tree'; entries: Entry[] }
  | {
      kind: 'commit'
      commit: Commit
      change: Change
      report: Report | null
      before: Report | null
    }
  | { kind: 'home'; home: HomeData }
  | {
      kind: 'score'
      report: Report | null
      sha: string
      before?: Report | null
      review?: boolean
    }
  | { kind: 'glance'; change: Change }
  | { kind: 'manifest'; manifest: TipManifest }
  | { kind: 'source'; content: string; binary?: boolean }
  | {
      kind: 'bundle'
      manifest: TipManifest
      files: { blob: string; content: string; html: string }[]
    }
export interface RenderItem {
  fragment: Fragment
  path?: string
  sha: string
  ref?: string
}
export interface RenderPlan {
  scope: string
  items: RenderItem[]
  cursor: number | null
}
export interface PagePointer {
  version: string
  defaultBranch?: string
  entity: string
  repository: string
  scope: string
  tip: string
  meta: string | null
  ref: string
  path: string
  home: Fragment
  selected: Fragment | null
  score?: Fragment | null
  manifest: Fragment
  bundle: Fragment | null
  shell: Fragment
}
