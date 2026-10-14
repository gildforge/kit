import {
  repoShape,
  user,
  issueShape,
  pullShape,
  commentShape,
  reviewShape,
} from '../api/shapes.js'
import { routes } from '../../engine/api/contract.js'
import type { Context } from '../api/dispatch.js'
import type { Issue, Comment } from '../issues.js'
import type { Pull, Review } from '../pulls.js'
import type { Commit } from '../../engine/repo-index-store.js'
import type { Report } from '../cqx-wasm.js'
import type { Emission } from '../../engine/api/events-contract.js'
export function context(repository: string): Context {
  const [owner, repo] = repository.split('/')
  return {
    request: new Request('https://gild.gg'),
    route: routes.find((r) => r.id === 'repo')!,
    params: { owner, repo },
    body: {},
    query: {},
    principal: {
      id: 'event',
      name: 'gild',
      publicKey: '',
      scopes: null,
      repos: null,
    },
  }
}
export function common(repository: string, by: string) {
  const c = context(repository),
    { created_at, updated_at, ...repo } = repoShape(
      c,
      c.params.owner,
      c.params.repo,
      'main',
    )
  return {
    repository: { ...repo, owner: { ...repo.owner, name: repo.owner.login } },
    sender: user(c, by),
  }
}
export function pullPayload(
  repository: string,
  pull: Pull,
  refs: Record<string, string> = {},
) {
  const c = context(repository)
  return pullShape(
    c,
    pull,
    repoShape(c, c.params.owner, c.params.repo, pull.base),
    refs[pull.head] ?? '0'.repeat(40),
    refs[pull.base] ?? '0'.repeat(40),
  )
}
export type MetadataSnapshot = Record<string, unknown>
export function metadataEvents(
  before: MetadataSnapshot,
  after: MetadataSnapshot,
  repository: string,
  by: string,
  refs: Record<string, string> = {},
): Emission[] {
  const out: Emission[] = [],
    c = context(repository),
    add = (event: Emission['event'], payload: Record<string, unknown>) =>
      out.push({
        id: crypto.randomUUID(),
        event,
        repository,
        payload: { ...common(repository, by), ...payload },
      })
  for (const [path, value] of Object.entries(after)) {
    const m = /^\.gild\/(\d+)\/(issue|pr)\/(issue|pr)\.json$/.exec(path)
    if (!m) continue
    const item = value as Issue | Pull,
      old = before[path] as typeof item | undefined,
      n = Number(m[1]),
      pr = m[2] === 'pr',
      shape = pr
        ? pullPayload(repository, item as Pull, refs)
        : issueShape(c, item as Issue),
      property = pr ? 'pull_request' : 'issue',
      type = pr ? 'pull_request' : 'issues',
      payload = { number: n, [property]: shape }
    if (!old) add(type, { action: 'opened', ...payload })
    else {
      if (old.state !== item.state)
        add(type, {
          action: item.state === 'open' ? 'reopened' : 'closed',
          ...payload,
        })
      const changes = Object.fromEntries(
        ['title', 'body', ...(pr ? ['base'] : [])].flatMap((key) => {
          const a = old as unknown as Record<string, unknown>,
            b = item as unknown as Record<string, unknown>
          return a[key] !== b[key] ? [[key, { from: a[key] }]] : []
        }),
      )
      if (Object.keys(changes).length)
        add(type, { action: 'edited', changes, ...payload })
      if (!pr) {
        const a = old as Issue,
          b = item as Issue
        for (const name of b.labels.filter((l) => !a.labels.includes(l)))
          add('issues', { action: 'labeled', label: { name }, ...payload })
        for (const name of a.labels.filter((l) => !b.labels.includes(l)))
          add('issues', { action: 'unlabeled', label: { name }, ...payload })
        if (a.claim?.by !== b.claim?.by)
          add('issues', {
            action: b.claim ? 'assigned' : 'unassigned',
            assignee: user(c, b.claim?.by ?? a.claim!.by),
            ...payload,
          })
      }
    }
    const folder = `.gild/${n}/${pr ? 'pr' : 'issue'}/`
    for (const [file, v] of Object.entries(after).filter(
      ([file]) => file.startsWith(folder) && !(file in before),
    )) {
      const name = file.slice(folder.length)
      if (name.startsWith('c-')) {
        const comment = v as Comment & {
          path?: string
          line?: number
          side?: string
          commit_id?: string
        }
        if (comment.path)
          add('pull_request_review_comment', {
            action: 'created',
            ...payload,
            comment: {
              ...commentShape(c, n, comment),
              path: comment.path,
              line: comment.line,
              side: comment.side,
              commit_id: comment.commit_id,
            },
          })
        else
          add('issue_comment', {
            action: 'created',
            issue: pr
              ? {
                  ...issueShape(c, {
                    ...item,
                    state: item.state === 'merged' ? 'closed' : item.state,
                    labels: [],
                    claim: null,
                  } as Issue),
                  pull_request: {
                    url: (shape as ReturnType<typeof pullShape>).url,
                    html_url: shape.html_url,
                  },
                }
              : shape,
            comment: commentShape(c, n, comment),
          })
      }
      if (name.startsWith('r-'))
        add('pull_request_review', {
          action: 'submitted',
          ...payload,
          review: reviewShape(c, n, v as Review),
        })
    }
    if (pr)
      for (const [file, v] of Object.entries(after).filter(
        ([file]) => file.startsWith(`.gild/${n}/log/`) && !(file in before),
      )) {
        const log = v as { kind: string; by: string }
        if (['queued', 'dequeued', 'conflicts'].includes(log.kind)) {
          const action = log.kind === 'conflicts' ? 'conflicted' : log.kind
          add('pull_request', { action, ...payload })
          add('merge_queue', {
            action,
            number: n,
            queue: after['.gild/queue.json'] ?? [],
            pull_request: shape,
          })
        }
      }
  }
  // Closing a queued pull removes it from the queue even when the caller
  // used the GitHub PATCH endpoint rather than the explicit dequeue route.
  const a = (before['.gild/queue.json'] as number[]) ?? [],
    b = (after['.gild/queue.json'] as number[]) ?? []
  for (const number of a.filter((n) => !b.includes(n)))
    if (
      !out.some((e) => e.event === 'merge_queue' && e.payload.number === number)
    )
      add('merge_queue', { action: 'dequeued', number, queue: b })
  return out
}
export function pushEvent(
  repository: string,
  id: string,
  update: { ref: string; before: string; sha: string },
  by: string,
  commit: Commit | null,
  commits: { commit: Commit; files: import('../compare.js').FileDiff[] }[] = [],
  forced = false,
): Emission {
  const zero = '0'.repeat(40),
    entry = (c: Commit, files: import('../compare.js').FileDiff[]) => ({
      id: c.hash,
      tree_id: c.tree,
      message: c.message,
      timestamp: new Date(c.time * 1000).toISOString(),
      url: `https://gild.gg/${repository}/commit/${c.hash}`,
      author: { name: c.author_name, email: c.author_email },
      committer: {
        name: c.committer_name ?? c.author_name,
        email: c.committer_email ?? c.author_email,
      },
      added: files.filter((f) => f.status === 'added').map((f) => f.path),
      removed: files.filter((f) => f.status === 'removed').map((f) => f.path),
      modified: files.filter((f) => f.status === 'modified').map((f) => f.path),
    })
  return {
    id,
    event: 'push',
    repository,
    payload: {
      ...common(repository, by),
      ref: update.ref,
      before: update.before,
      after: update.sha,
      created: update.before === zero,
      deleted: update.sha === zero,
      forced,
      compare: `https://gild.gg/${repository}/compare/${update.before}...${update.sha}`,
      pusher: { name: by },
      commits: commits
        .slice()
        .reverse()
        .map((c) => entry(c.commit, c.files)),
      head_commit: commit
        ? entry(
            commit,
            commits.find((c) => c.commit.hash === commit.hash)?.files ?? [],
          )
        : null,
    },
  }
}
export function healthEvent(
  repository: string,
  sha: string,
  before: string | null,
  current: Report | null,
  previous: Report | null,
  build = '',
): Emission {
  const categories = [
    'quality',
    'containment',
    'legibility',
    'security',
    'modularity',
  ] as const
  const allRules = [
    ...new Map(
      [...(previous?.rules ?? []), ...(current?.rules ?? [])].map((r) => [
        r.rule,
        r,
      ]),
    ).values(),
  ]
  const scores = categories
    .map((category) => ({
      category,
      before: previous?.scores[category] ?? null,
      after: current?.scores[category] ?? null,
      rules: allRules
        .filter(
          (r) =>
            r.category === category &&
            (current?.rules.find((p) => p.rule === r.rule && p.language === r.language)?.deducted ?? 0) !==
              (previous?.rules.find((p) => p.rule === r.rule && p.language === r.language)?.deducted ?? 0),
        )
        .map((r) => ({
          rule: r.rule,
          describes: r.describes,
          deducted:
            current?.rules.find((p) => p.rule === r.rule && p.language === r.language)?.deducted ?? 0,
          previous_deducted:
            previous?.rules.find((p) => p.rule === r.rule && p.language === r.language)?.deducted ?? 0,
          findings: (
            current?.rules.find((p) => p.rule === r.rule && p.language === r.language)?.findings ?? []
          ).slice(0, 20),
        })),
    }))
    .filter((s) => !current?.incomplete && !previous?.incomplete && (s.before !== s.after || s.rules.length))
  return {
    id: `health:${repository}:${before}:${sha}:${build}`,
    event: 'health_changed',
    repository,
    payload: { ...common(repository, 'gild'), before, after: sha, scores },
  }
}
