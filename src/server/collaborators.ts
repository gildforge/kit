import type { Context, Result } from './api/dispatch.js'
import type { ForgeStore } from './backend.js'
import { ApiError } from '../engine/api/errors.js'
import { permitsRepo } from '../engine/api/scopes.js'
import {
  mayRead,
  repoAccess,
  privateAcl,
  type ReadServices,
} from './repo-read.js'
export interface Invitation {
  id: string
  repo: string
  invitee: string
  permission: 'read' | 'write'
  inviter: string
  created_at: string
}
export const PRIVATE_OPERATIONS = [
  'repoVisibility',
  'setRepoVisibility',
  'collaborators',
  'addCollaborator',
  'removeCollaborator',
  'repositoryInvitations',
  'acceptRepositoryInvitation',
  'declineRepositoryInvitation',
] as const
export interface PrivacyWrites {
  acl(
    owner: string,
    repo: string,
    by: string,
    change: (
      acl: import('./repo-list-snapshot.js').ListingSnapshot['acl'],
    ) => void,
  ): Promise<void>
}
export function privacyHandler(
  s: ReadServices & { store: ForgeStore },
  writes: PrivacyWrites,
) {
  return async (c: Context): Promise<Result> => {
    const id = c.route.id,
      name = c.principal.name.toLowerCase(),
      { owner, repo } = c.params
    if (name.includes('/')) throw new ApiError(403, 'A person is required')
    const invitationTarget = async (i: Invitation) => {
      const state = await s.store.settings.byId(i.repo)
      if (!state || state.deletedAt !== null) return null
      const [owner, repo] = state.key.split('/')
      return permitsRepo(c.principal, owner, repo) ? { owner, repo } : null
    }
    if (id === 'repositoryInvitations') {
      // A pending invitation grants no read access. Only opaque invitation IDs
      // and the proposed role are shown before acceptance.
      const invitations = await s.store.invitations(undefined, name)
      const allowed = c.principal.repos === null ? invitations :
        (await Promise.all(invitations.map(async i =>
          await invitationTarget(i) ? i : null))).filter(i => i !== null)
      return {
        data: allowed.map((i) => ({
          id: i.id,
          permission: i.permission,
        })),
        noStore: true,
      }
    }
    if (
      id === 'acceptRepositoryInvitation' ||
      id === 'declineRepositoryInvitation'
    ) {
      const i = (await s.store.invitations(undefined, name)).find(
        (i) => i.id === c.params.id,
      )
      if (!i) throw new ApiError(404, 'Invitation not found')
      // Opaque invitation URLs have no owner/repo dispatch parameters. Resolve
      // the current entity before either scoped write; pending invites grant no
      // access beyond the token's allow-list. Unrestricted decline still permits
      // cleanup of a stale/deleted invitation, as before.
      const target = id === 'acceptRepositoryInvitation' || c.principal.repos !== null
        ? await invitationTarget(i) : null
      if (!target && (id === 'acceptRepositoryInvitation' || c.principal.repos !== null))
        throw new ApiError(404, 'Invitation not found')
      if (id === 'acceptRepositoryInvitation') {
        const { owner: o, repo: r } = target!
        // Revalidate the inviter on acceptance: demotion revokes stale invites.
        if (!(await admin(s.store, o, i.inviter)))
          throw new ApiError(404, 'Invitation not found')
        await writes.acl(o, r, name, (acl) => {
          acl.read = (acl.read ?? []).filter(
            (n) => n.toLowerCase() !== `@${name}`,
          )
          acl.write = (acl.write ?? []).filter(
            (n) => n.toLowerCase() !== `@${name}`,
          )
          ;(i.permission === 'write' ? acl.write : acl.read).push(`@${name}`)
        })
      }
      await s.store.removeInvitation(i.id)
      return { data: { ok: true }, noStore: true }
    }
    const policy = await repoAccess(s, owner, repo)
    if (!policy || !(await mayRead(s, owner, repo, name, policy)))
      throw new ApiError(404, 'Repository not found')
    if (id === 'repoVisibility')
      return {
        data: {
          visibility:
            policy.pending || privateAcl(policy.acl) ? 'private' : 'public',
        },
        noStore: true,
      }
    if (!['collaborators'].includes(id) && !(await admin(s.store, owner, name)))
      throw new ApiError(403, 'Repository owner or organization admin required')
    if (id === 'setRepoVisibility') {
      if (
        c.body.visibility === 'public' &&
        (policy.pending || privateAcl(policy.acl)) &&
        c.body.confirm !== `${owner}/${repo}`
      )
        throw new ApiError(422, `Confirm publication with ${owner}/${repo}`)
      await writes.acl(owner, repo, name, (acl) => {
        acl.visibility = c.body.visibility
        delete acl.private
      })
      if (c.body.visibility === 'private') c.privateRead = true
      return { data: { visibility: c.body.visibility }, noStore: true }
    }
    const state = await s.store.settings.state(`${owner}/${repo}`)
    if (id === 'collaborators')
      return {
        data: {
          collaborators: [
            ...(policy.acl.read ?? []),
            ...(policy.acl.write ?? []),
          ]
            .filter((n) => !n.includes('/'))
            .map((n) => ({
              login: n.replace(/^@/, ''),
              permission: policy.acl.write?.includes(n) ? 'write' : 'read',
            })),
          invitations: await s.store.invitations(state.id),
        },
        noStore: true,
      }
    const invitee = c.params.username.toLowerCase()
    if (!(await s.store.getClaim(invitee)))
      throw new ApiError(404, 'Gild name not found')
    if (invitee === owner.toLowerCase())
      throw new ApiError(422, 'The owner already has access')
    if (id === 'addCollaborator') {
      // Existing collaborators can change role immediately; new people accept.
      if (
        [...(policy.acl.read ?? []), ...(policy.acl.write ?? [])].some(
          (n) => n.toLowerCase() === `@${invitee}`,
        )
      ) {
        await writes.acl(owner, repo, name, (acl) => {
          acl.read = (acl.read ?? []).filter(
            (n) => n.toLowerCase() !== `@${invitee}`,
          )
          acl.write = (acl.write ?? []).filter(
            (n) => n.toLowerCase() !== `@${invitee}`,
          )
          ;(c.body.permission === 'write' ? acl.write : acl.read).push(
            `@${invitee}`,
          )
        })
      } else
        await s.store.inviteRepo({
          id: crypto.randomUUID(),
          repo: state.id,
          invitee,
          permission: c.body.permission,
          inviter: name,
          created_at: new Date().toISOString(),
        })
      return { data: { ok: true }, noStore: true }
    }
    await writes.acl(owner, repo, name, (acl) => {
      acl.read = (acl.read ?? []).filter(
        (n) => n.toLowerCase() !== `@${invitee}`,
      )
      acl.write = (acl.write ?? []).filter(
        (n) => n.toLowerCase() !== `@${invitee}`,
      )
    })
    for (const i of await s.store.invitations(state.id, invitee))
      await s.store.removeInvitation(i.id)
    return { data: { ok: true }, noStore: true }
  }
}
async function admin(st: ForgeStore, owner: string, name: string) {
  return (
    !name.includes('/') &&
    (owner.toLowerCase() === name.toLowerCase() ||
      ['owner', 'admin'].includes(
        (await st.orgRole(owner.toLowerCase(), name.toLowerCase())) ?? '',
      ))
  )
}
