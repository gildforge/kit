import { getCloudflareContext } from './context.js'
import { flushAgentEvents } from './events/d1-outbox.js'
import type { EventBindings } from './events/binding.js'
import type { D1Database } from '@cloudflare/workers-types'
async function scheduleAgentEvents() {
  try {
    const { env, ctx } = await getCloudflareContext()
    ctx.waitUntil(
      flushAgentEvents(env as unknown as EventBindings & { DB: D1Database }),
    )
  } catch {
    /* The cron drains the transactional outbox after a transient scheduling failure. */
  }
}
// Agents join the way a machine joins a tailnet:
//
//   1. The agent makes its own ed25519 key and files a request naming the
//      person it works for (and, optionally, a repo and what it wants to do
//      there). It gets back an approval link to show that person.
//   2. The person, or an agent they made an approver, approves or denies.
//   3. The agent signs `gild-agent-join:<id>` with its key and collects its
//      API token, once. Nothing secret is stored or sent in a link.
//
// An approver agent can only hand out what it already holds in that repo,
// so delegating approvals never widens anyone's access.
import { AGENT_LABEL_RE, NAME_RE, store, type AgentRequest } from './backend.js'
import {
  GRANTS,
  capabilities,
  isAgent,
  mayWrite,
  setAgentGrants,
  type Grant,
} from './access.js'
import { grantScopes } from '../engine/api/scopes.js'
import { createToken } from './tokens.js'
import { verifyChallenge } from '../engine/verify.js'
import { mayRead } from './repo-read.js'
import { readyIndex } from './repo-index.js'
import { ago } from '../engine/time.js'
import { fingerprint } from '../engine/fingerprint.js'

const TTL_MS = 60 * 60 * 1000
const MAX_PENDING = 10

export class JoinError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export const joinChallenge = (id: string) => `gild-agent-join:${id}`

export function effectiveStatus(
  r: AgentRequest,
): AgentRequest['status'] | 'expired' {
  if (r.status === 'pending' && Date.now() - Date.parse(r.createdAt) > TTL_MS)
    return 'expired'
  return r.status
}

export async function fileRequest(input: {
  sponsor?: string
  label?: string
  publicKey?: string
  repo?: string
  grants?: string[]
  note?: string
}) {
  const sponsor = (input.sponsor ?? '').replace(/^@/, '').toLowerCase()
  const label = (input.label ?? '').toLowerCase()
  if (!NAME_RE.test(sponsor))
    throw new JoinError(
      'name the person you work for: sponsor is their gild name',
      400,
    )
  if (!AGENT_LABEL_RE.test(label))
    throw new JoinError(
      'agent names are 1 to 31 lowercase letters, digits or dashes',
      400,
    )
  if (!(input.publicKey ?? '').startsWith('ed25519:'))
    throw new JoinError(
      'publicKey must be your ed25519 key (ed25519:<base64>)',
      400,
    )
  const repo = input.repo ? input.repo.replace(/^@/, '').toLowerCase() : null
  if (
    repo &&
    !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,62}$/.test(repo)
  )
    throw new JoinError('repo must be owner/name', 400)
  const grants = [
    ...new Set(
      (input.grants ?? []).filter((g): g is Grant =>
        (GRANTS as string[]).includes(g),
      ),
    ),
  ]

  const st = await store()
  if (!(await st.getClaim(sponsor)))
    throw new JoinError(`nobody has claimed @${sponsor}`, 404)
  const existing = await st.getAgent(`${sponsor}/${label}`)
  // Revocation preserves this identity's name, key, tokens and grant history.
  // Reuse needs a separate generation lifecycle; never approve a dead record.
  if (existing)
    throw new JoinError(
      `@${sponsor}/${label} already exists; pick another name`,
      409,
    )
  if (
    (await st.pendingRequestsFor(sponsor)).filter(
      (r) => effectiveStatus(r) === 'pending',
    ).length >= MAX_PENDING
  ) {
    throw new JoinError(
      `@${sponsor} already has ${MAX_PENDING} requests waiting`,
      429,
    )
  }
  const result = await st.createAgentRequest({
    id: crypto.randomUUID().replaceAll('-', '').slice(0, 20),
    sponsor,
    label,
    publicKey: input.publicKey!,
    repo,
    grants,
    note: (input.note ?? '').slice(0, 280) || null,
  })
  await scheduleAgentEvents()
  return result
}

/** May `name` decide this request: the sponsor, or one of the sponsor's live approver agents. */
export async function mayDecide(r: AgentRequest, name: string | null) {
  if (!name) return false
  if (name === r.sponsor) return true
  if (!isAgent(name)) return false
  const agent = await (await store()).getAgent(name)
  return (
    !!agent && !agent.revokedAt && agent.approver && agent.sponsor === r.sponsor
  )
}

export async function decide(
  id: string,
  by: string | null,
  decision: 'approve' | 'deny',
  grants: string[] = [],
) {
  const st = await store()
  const r = await st.getAgentRequest(id)
  if (!r) throw new JoinError('no such request', 404)
  if (
    r.repo &&
    !(await mayRead(
      { store: st, index: readyIndex },
      r.repo.split('/')[0],
      r.repo.split('/')[1],
      by,
    ))
  )
    throw new JoinError('no such request', 404)
  const status = effectiveStatus(r)
  if (status !== 'pending')
    throw new JoinError(`this request is ${status}`, 409)
  if (!(await mayDecide(r, by)))
    throw new JoinError(
      `only @${r.sponsor} or an approver agent of theirs can decide this`,
      403,
    )

  if (decision === 'deny') {
    await st.decideAgentRequest(id, 'denied', by!, [])
    await scheduleAgentEvents()
    return { status: 'denied' as const }
  }

  const granted = [
    ...new Set(
      grants.filter((g): g is Grant => (GRANTS as string[]).includes(g)),
    ),
  ]
  if (r.repo && granted.length) {
    const [owner, repo] = r.repo.split('/')
    if (isAgent(by!)) {
      // An approver can only pass on what it holds itself.
      const own = (await capabilities(owner, repo, by)).grants
      const extra = granted.filter((g) => !own.has(g))
      if (extra.length)
        throw new JoinError(
          `@${by} doesn't hold ${extra.join(', ')} in ${r.repo}, so it can't grant it`,
          403,
        )
    } else if (!(await mayWrite(owner, by))) {
      throw new JoinError(`you can't grant access in ${r.repo}`, 403)
    }
  }

  const old = await st.getAgent(`${r.sponsor}/${r.label}`)
  if (old)
    throw new JoinError(`@${r.sponsor}/${r.label} already exists`, 409)
  if (!old) await st.createAgent(r.sponsor, r.label, r.publicKey, by!)
  await st.decideAgentRequest(id, 'approved', by!, granted)
  await scheduleAgentEvents()
  if (r.repo && granted.length) {
    const [owner, repo] = r.repo.split('/')
    await setAgentGrants(owner, repo, by!, `${r.sponsor}/${r.label}`, granted)
  }
  return {
    status: 'approved' as const,
    agent: `${r.sponsor}/${r.label}`,
    grants: granted,
  }
}

/** The agent's side: prove the key, get the token, once. */
export async function collect(id: string, signature: string) {
  const st = await store()
  const r = await st.getAgentRequest(id)
  if (!r) throw new JoinError('no such request', 404)
  if (!(await verifyChallenge(r.publicKey, joinChallenge(id), signature)))
    throw new JoinError('signature does not match the key in this request', 403)
  const status = effectiveStatus(r)
  if (status !== 'approved') return { status }
  const agent = await st.getAgent(`${r.sponsor}/${r.label}`)
  if (!agent || agent.revokedAt || agent.publicKey !== r.publicKey)
    throw new JoinError('no such request', 404)
  if (!(await st.takeRequestToken(id)))
    throw new JoinError('the token for this request was already collected', 409)
  const name = `${r.sponsor}/${r.label}`
  // The token's allow-list narrows it to the approved repo; it never grants
  // access. Every request re-checks mayRead, so freezing a moment's answer here
  // (a just-created repo's ACL is still pending, so it reads as private) would
  // only issue a permanently useless token.
  return {
    status,
    name,
    token: await createToken(name, r.publicKey, {
      scopes: grantScopes(r.grants),
      repos: r.repo ? [r.repo] : [],
    }),
    repo: r.repo,
    grants: r.grants,
  }
}

/** Pending requests a person can decide, shaped for the request cards. */
export async function requestsFor(person: string, repo?: string) {
  const st = await store()
  const pending = (await st.pendingRequestsFor(person)).filter(
    (r) => effectiveStatus(r) === 'pending' && (!repo || r.repo === repo),
  )
  const readable = (
    await Promise.all(
      pending.map(async (r) =>
        !r.repo ||
        (await mayRead(
          { store: st, index: readyIndex },
          r.repo.split('/')[0],
          r.repo.split('/')[1],
          person,
        ))
          ? r
          : null,
      ),
    )
  ).filter((r) => r !== null)
  return Promise.all(
    readable.map(async (r) => ({
      request: {
        id: r.id,
        sponsor: r.sponsor,
        label: r.label,
        key: await fingerprint(r.publicKey),
        repo: r.repo,
        grants: r.grants,
        note: r.note,
        createdAt: r.createdAt,
        age: ago(Date.parse(r.createdAt)),
      },
      canGrant: r.repo ? await mayWrite(r.repo.split('/')[0], person) : false,
    })),
  )
}
