import { authorLabel } from '../../engine/import/source.js'
import type { Context } from './dispatch.js'
import type { Commit } from '../../engine/repo-index-store.js'
import type { Issue } from '../issues.js'
import type { Pull, Review } from '../pulls.js'
export const numericId = (input: string) => {
  let h = 2166136261
  for (const c of input) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}
export function origin(c: Context) {
  return new URL(c.request.url).origin
}
export function repoPath(c: Context) {
  return `/repos/${c.params.owner}/${c.params.repo}`
}
export function apiURL(c: Context, path: string) {
  return `${origin(c)}/api/v1${path}`
}
export function user(c: Context, name: string, org = false,source?:string) {
  const imported=/^(github|gitlab):(.*)$/.exec(name)
  if(imported) return {login:authorLabel(name),id:numericId(name),type:'User' as const,html_url:`${source?new URL(source).origin:imported[1]==='github'?'https://github.com':'https://gitlab.com'}/${encodeURIComponent(imported[2])}`}
  return {
    login: name,
    id: numericId(name),
    type: org
      ? ('Organization' as const)
      : name.includes('/')
        ? ('Bot' as const)
        : ('User' as const),
    html_url: `${origin(c)}/${name}`,
  }
}
export function repoShape(
  c: Context,
  owner: string,
  name: string,
  defaultBranch: string,
  info?: {
    stargazers_count?: number
    private?: boolean
    description?: string | null
    created_at?: string
    updated_at?: string
  },
) {
  const path = `/repos/${owner}/${name}`
  return {
    id: numericId(`${owner}/${name}`),
    name,
    full_name: `${owner}/${name}`,
    owner: user(c, owner),
    private: info?.private ?? false,
    stargazers_count: info?.stargazers_count ?? 0,
    description: info?.description ?? null,
    default_branch: defaultBranch,
    html_url: `${origin(c)}/${owner}/${name}`,
    url: apiURL(c, path),
    clone_url: `${origin(c)}/${owner}/${name}.git`,
    created_at: info?.created_at ?? new Date(0).toISOString(),
    updated_at: info?.updated_at ?? new Date(0).toISOString(),
  }
}
export function labelShape(c: Context, name: string) {
  return {
    id: numericId(repoPath(c) + name),
    name,
    color: 'ededed',
    description: null,
  }
}
export function issueShape(
  c: Context,
  i: Issue,
  comments = 0,
  updatedAt = i.imported?.updatedAt??i.createdAt,
) {
  return {
    id: numericId(`${repoPath(c)}:${i.number}`),
    number: i.number,
    title: i.title,
    body: i.body,
    user: user(c, i.author,false,i.imported?.url),
    state: i.state,
    labels: i.labels.map((l) => labelShape(c, l)),
    comments,
    created_at: i.createdAt,
    updated_at: updatedAt,
    closed_at: i.state === 'closed' ? i.imported?.closedAt??updatedAt : null,
    html_url: `${origin(c)}/${c.params.owner}/${c.params.repo}/issues/${i.number}`,
    url: apiURL(c, `${repoPath(c)}/issues/${i.number}`),
  }
}
export function pullShape(
  c: Context,
  p: Pull,
  repo: ReturnType<typeof repoShape>,
  head: string,
  base: string,
  comments = 0,
) {
  const path = `${repoPath(c)}/pulls/${p.number}`,
    html = `${origin(c)}/${c.params.owner}/${c.params.repo}/pulls/${p.number}`
  return {
    ...issueShape(
      c,
      {
        ...p,
        state: p.state === 'merged' ? 'closed' : p.state,
        labels: p.labels??[],
        claim: null,
      },
      comments,
    ),
    html_url: html,
    url: apiURL(c, path),
    head: {
      label: `${c.params.owner}:${p.head}`,
      ref: p.head,
      sha: head,
      repo,
    },
    base: {
      label: `${c.params.owner}:${p.base}`,
      ref: p.base,
      sha: base,
      repo,
    },
    merged: p.state === 'merged',
    merged_at: p.merged?.at ?? null,
    merge_commit_sha: p.merged?.commit ?? null,
    mergeable: p.conflicts ? false : null,
    draft: false,
    diff_url: apiURL(c, `${path}/files`),
    patch_url: apiURL(c, p.patchParts?`${repoPath(c)}/import/pulls/${p.number}/patch`:`${path}/files`),
  }
}
export function commentShape(
  c: Context,
  n: number,
  comment: { id: string; author: string; body: string; createdAt: string; imported?:{url:string;updatedAt:string} },
) {
  const id = numericId(comment.id)
  return {
    id,
    node_id: comment.id,
    user: user(c, comment.author,false,comment.imported?.url),
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.imported?.updatedAt??comment.createdAt,
    html_url: `${origin(c)}/${c.params.owner}/${c.params.repo}/issues/${n}#issuecomment-${id}`,
    url: apiURL(c, `${repoPath(c)}/issues/comments/${id}`),
  }
}
export function commitShape(c: Context, commit: Commit) {
  const path = repoPath(c),
    author = {
      name: commit.author_name,
      email: commit.author_email,
      date: new Date(commit.time * 1000).toISOString(),
    }
  return {
    sha: commit.hash,
    node_id: commit.hash,
    url: apiURL(c, `${path}/commits/${commit.hash}`),
    html_url: `${origin(c)}/${c.params.owner}/${c.params.repo}/commit/${commit.hash}`,
    commit: {
      message: commit.message,
      author,
      committer: {
        name: commit.committer_name ?? commit.author_name,
        email: commit.committer_email ?? commit.author_email,
        date: new Date(
          (commit.committer_time ?? commit.time) * 1000,
        ).toISOString(),
      },
      tree: {
        sha: commit.tree,
        url: apiURL(c, `${path}/git/trees/${commit.tree}`),
      },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: commit.parents.map((sha) => ({
      sha,
      url: apiURL(c, `${path}/commits/${sha}`),
      html_url: `${origin(c)}/${c.params.owner}/${c.params.repo}/commit/${sha}`,
    })),
  }
}
export function reviewShape(c: Context, n: number, r: Review) {
  return {
    id: numericId(r.id),
    user: user(c, r.author,false,r.imported?.url),
    body: r.body,
    state:
      r.verdict === 'approve'
        ? 'APPROVED'
        : r.verdict === 'changes'
          ? 'CHANGES_REQUESTED'
          : 'COMMENTED',
    submitted_at: r.createdAt,
    commit_id: r.headOid,
    html_url: `${origin(c)}/${c.params.owner}/${c.params.repo}/pulls/${n}#review-${r.id}`,
  }
}
