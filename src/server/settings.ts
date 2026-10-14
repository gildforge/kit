import type { RenameJob } from './settings-rename.js'
import { webpBytes, pictureHash } from '../engine/profile.js'
import type { ForgeStore, OrgRole } from './backend.js'
import { ownerNameAvailable, repoNameAvailable } from '../engine/backend-names.js'
import { ApiError } from '../engine/api/errors.js'
import { RESTORE_MS, type Profile } from './settings-store.js'
import type { Context, Result } from './api/dispatch.js'
export const SETTINGS_OPERATIONS = [
  'updatePicture',
  'deletePicture',
  'updateOrgPicture',
  'deleteOrgPicture',
  'profile',
  'updateProfile',
  'updateOrgProfile',
  'orgProfile',
  'putMembership',
  'deleteMembership',
  'leaveOrg',
  'renameOrg',
  'renameStatusOrg',
  'archiveOrg',
  'deleteOrg',
  'restoreOrg',
  'renameRepo',
  'renameStatusRepo',
  'archiveRepo',
  'deleteRepo',
  'restoreRepo',
  'updateRepository',
] as const
const error = (status: number, message: string): never => {
  throw new ApiError(status, message)
}
export async function orgAccess(
  st: ForgeStore,
  org: string,
  name: string | null,
  ownerOnly = false,
) {
  if (!name || name.includes('/')) error(404, 'Not Found')
  const role = await st.orgRole(org, name!)
  if (ownerOnly ? role !== 'owner' : role !== 'owner' && role !== 'admin')
    error(404, 'Not Found')
  return role!
}
export async function repoAccess(
  st: ForgeStore,
  owner: string,
  name: string | null,
  ownerOnly = false,
) {
  if (!name || name.includes('/')) error(404, 'Not Found')
  if (await st.getClaim(owner)) {
    if (name !== owner) error(404, 'Not Found')
    return 'owner' as const
  }
  return orgAccess(st, owner, name, ownerOnly)
}
/** Browser and v1 membership writes share this guard, including the old POST. */
export async function changeMembership(
  st: ForgeStore,
  org: string,
  actor: string,
  member: string,
  role: OrgRole | null,
  leave = false,
) {
  const mine = await st.orgRole(org, actor),
    old = await st.orgRole(org, member)
  // SETTINGS_ADMIN_GUARD
  if (!leave && mine !== 'owner' && mine !== 'admin') error(404, 'Not Found')
  if (leave && (actor !== member || !old)) error(404, 'Not Found')
  if (!leave && (old === 'owner' || role === 'owner') && mine !== 'owner')
    error(403, 'Only an owner can change owner membership')
  // SETTINGS_LAST_OWNER_GUARD
  if (
    old === 'owner' &&
    role !== 'owner' &&
    (await st.orgMembers(org)).filter((m) => m.role === 'owner').length === 1
  )
    error(409, 'The last owner cannot leave, be demoted, or be removed')
  try {
    if (role) {
      if (!(await st.getClaim(member)))
        error(404, 'Member has not claimed a name')
      await st.addOrgMember(org, member, role)
    } else {
      if (!old) error(404, 'Not Found')
      await st.removeOrgMember(org, member)
    }
  } catch (e) {
    if (/Last owner/.test(String(e)))
      error(409, 'The last owner cannot leave, be demoted, or be removed')
    throw e
  }
  return { ok: true as const, org, member, role }
}
export interface LifecycleTransport {
  renderSettings?(key:string):Promise<void>
  branches(owner: string, repo: string): Promise<string[]>
  defaultBranch(key: string, branch: string): Promise<void>
  startRename(job: RenameJob): Promise<void>
  resumeRename(id: string): Promise<void>
  list(owner: string): Promise<{ name: string; description: string | null }[]>
  exists(owner: string, repo: string): Promise<unknown>
  copy(from: string, to: string): Promise<void>
  rebind(key: string, id: string): Promise<void>
  suspend(key: string, id: string): Promise<void>
  discard(key: string, org: boolean): Promise<void>
  purge(key: string, id: string): Promise<void>
  renameHooks(from: string, to: string): Promise<void>
}
export function settingsService(st: ForgeStore, transport: LifecycleTransport) {
  async function lock(key: string, work: () => Promise<unknown>) {
    await st.settings.lock(key)
    try {
      // All public mutations hold expiring leases. A copy never races a push.
      for (let i = 0; !(await st.settings.drained(key)); i++) {
        if (i >= 100)
          error(409, 'An active write is still running; retry shortly')
        await new Promise((r) => setTimeout(r, 50))
      }
      return await work()
    } finally {
      await st.settings.unlock(await st.settings.canonical(key))
    }
  }
  return async (c: Context): Promise<Result> => {
    const id = c.route.id,
      b = c.body,
      name = c.principal.name,
      org = c.params.org,
      owner = org ?? c.params.owner,
      repo = c.params.repo,
      key = org ?? `${owner}/${repo}`
    if (c.principal.repos !== null && !repo)
      error(
        403,
        'Account and organization settings require an unrestricted token',
      )
    if (
      id === 'profile' ||
      id === 'updateProfile' ||
      id === 'updatePicture' ||
      id === 'deletePicture'
    ) {
      if (!name || name.includes('/') || !(await st.getClaim(name)))
        error(404, 'Not Found')
      if (id === 'updateProfile')
        await st.settings.saveProfile(name, {
          ...(await st.settings.profile(name)),
          ...b,
        } as Profile)
      if (id === 'updatePicture') {
        const bytes = webpBytes(b.data),
          hash = await pictureHash(bytes)
        await st.settings.savePicture(hash, bytes)
        await st.settings.saveProfile(name, {
          ...(await st.settings.profile(name)),
          picture: '/avatars/' + hash,
        })
      }
      if (id === 'deletePicture')
        await st.settings.saveProfile(name, {
          ...(await st.settings.profile(name)),
          picture: null,
        })
      return { data: await st.settings.profile(name) }
    }
    if (id === 'leaveOrg') {
      return { data: await changeMembership(st, org, name, name, null, true) }
    }
    const danger = /^(rename|archive|delete|restore)(Org|Repo)$/.test(id)
    // SETTINGS_OWNER_GUARD
    if (org) await orgAccess(st, org, name, danger)
    else await repoAccess(st, owner, name, danger)
    const current = await st.settings.state(key),
      orgState = await st.settings.state(owner)
    if (current.deletedAt !== null || orgState.deletedAt !== null) {
      if (
        !id.startsWith('restore') ||
        current.deletedAt === null ||
        Date.now() >= current.deletedAt + RESTORE_MS ||
        (!org && orgState.deletedAt !== null)
      )
        error(404, 'Not Found')
    } else if (id.startsWith('restore')) error(409, 'This item is not deleted')
    if (org && !id.startsWith('restore') && !(await st.getOrg(org)))
      error(404, 'Not Found')
    if (repo && !id.startsWith('restore')) await transport.exists(owner, repo)
    if (['putMembership', 'deleteMembership'].includes(id))
      return {
        data: await changeMembership(
          st,
          org,
          name,
          c.params.name,
          id === 'deleteMembership' ? null : b.role,
        ),
      }
    if (
      id === 'orgProfile' ||
      id === 'updateOrgProfile' ||
      id === 'updateOrgPicture' ||
      id === 'deleteOrgPicture'
    ) {
      if (id === 'updateOrgProfile') {
        await st.settings.saveProfile(org, {
          ...(await st.settings.profile(org)),
          ...b,
        } as Profile)
        if (b.description !== undefined)
          await st.updateOrgDescription(org, b.description)
      }
      if (id === 'updateOrgPicture') {
        const bytes = webpBytes(b.data),
          hash = await pictureHash(bytes)
        await st.settings.savePicture(hash, bytes)
        await st.settings.saveProfile(org, {
          ...(await st.settings.profile(org)),
          picture: '/avatars/' + hash,
        })
      }
      if (id === 'deleteOrgPicture')
        await st.settings.saveProfile(org, {
          ...(await st.settings.profile(org)),
          picture: null,
        })
      return { data: await st.settings.profile(org) }
    }
    if (id === 'updateRepository') {
      if (b.defaultBranch !== undefined) {
        if (!(await transport.branches(owner, repo)).includes(b.defaultBranch))
          error(422, 'Choose an existing code branch')
        await transport.defaultBranch(key, b.defaultBranch)
        current.defaultBranch = b.defaultBranch
      }
      if (b.description !== undefined) current.description = b.description
      await st.settings.putState(current)
      await transport.renderSettings?.(key)
      return { data: { ok: true } }
    }
    if (id.startsWith('renameStatus')) {
      return { data: { job: await st.settings.renameJob(current.id) } }
    }
    if (id.startsWith('rename')) {
      const next = b.name.toLowerCase(),
        to = org ? next : `${owner}/${next}`,
        orgOwner = !!org || !!(await st.getOrg(owner))
      if (org ? !ownerNameAvailable(next) : !repoNameAvailable(next))
        error(422, 'Invalid or reserved name')
      if (next === (org ?? repo)) error(409, 'Name is unchanged')
      const reclaim =
        current.previous.includes(to) &&
        (await st.settings.canonical(to)) === key
      if (
        !reclaim &&
        (org ? await st.nameTaken(next) : await st.settings.reserved(to))
      )
        error(409, 'Name is already taken or reserved')
      if (repo && !reclaim) {
        try {
          await transport.exists(owner, next)
          error(409, 'Name is already taken')
        } catch (e) {
          if (e instanceof ApiError && e.status !== 404) throw e
          if (!(e instanceof ApiError) && !/not found/i.test(String(e))) throw e
        }
      }
      await st.settings.reserve(to, reclaim ? key : undefined)
      let locked = false
      try {
        await st.settings.lock(key)
        locked = true
        const job: RenameJob = {
          id: current.id,
          from: key,
          to,
          org: !!org,
          orgOwner,
          phase: 'waiting',
          repos: [],
          copied: 0,
          rebound: 0,
          error: null,
        }
        await transport.startRename(job)
      } catch (e) {
        // An RPC can fail after the receiver persisted the job. Keep its fence;
        // the configured cron re-arms any persisted job whose alarm was lost.
        const pending = locked ? await st.settings.renameJob(current.id) : null
        if (
          pending?.from === key &&
          pending.to === to &&
          !['complete', 'failed'].includes(pending.phase)
        )
          return { status: 202, data: { ok: true, name: next } }
        if (locked) await st.settings.unlock(key)
        await st.settings.unreserve(to)
        throw e
      }
      return { status: 202, data: { ok: true, name: next } }
    }
    if (id.startsWith('archive')) {
      await lock(key, async () => {
        if (b.archived) {
          const repos = org ? await transport.list(org) : [{ name: repo }]
          for (const r of repos) {
            const child = await st.settings.state(
              org ? `${org}/${r.name}` : key,
            )
            await transport.suspend(child.key, child.id)
          }
        }
        const s = await st.settings.state(key)
        s.archived = b.archived
        await st.settings.putState(s)
      })
      return { data: { ok: true } }
    }
    if (id.startsWith('delete')) {
      if (b.confirm !== key) error(422, `Type ${key} to confirm deletion`)
      await lock(key, async () => {
        const repos = org ? await transport.list(org) : [{ name: repo }]
        for (const r of repos) {
          const child = await st.settings.state(org ? `${org}/${r.name}` : key)
          await st.settings.putState(child)
          await transport.suspend(child.key, child.id)
        }
        const s = await st.settings.state(key)
        s.deletedAt = Date.now()
        await st.settings.putState(s)
      })
      return {
        data: {
          ok: true,
          restoreUntil: new Date(Date.now() + RESTORE_MS).toISOString(),
        },
      }
    }
    if (id.startsWith('restore')) {
      current.deletedAt = null
      await st.settings.putState(current)
      await transport.renderSettings?.(key)
      return { data: { ok: true } }
    }
    return error(404, 'Not Found')
  }
}
export async function purgeDeleted(
  st: ForgeStore,
  t: LifecycleTransport,
  now = Date.now(),
) {
  for (const item of await st.settings.garbage()) {
    let lease: string | null = null
    try {
      lease = await st.settings.lease(item.key)
      if (!lease) continue
      await t.discard(item.key, item.org)
      await st.settings.clean(item.key)
    } catch (e) {
      console.error('Rename cleanup failed', item.key, e)
    } finally {
      if (lease)
        try {
          await st.settings.release(lease)
        } catch (e) {
          console.error('Cleanup lease release failed', item.key, e)
        }
    }
  }
  const states = await st.settings.states()
  for (const s of states
    .filter((s) => s.deletedAt !== null && s.deletedAt + RESTORE_MS <= now)
    .sort((a, b) => a.key.length - b.key.length)) {
    if (
      s.key.includes('/') &&
      states.some(
        (o) =>
          !o.key.includes('/') &&
          o.deletedAt !== null &&
          s.key.startsWith(o.key + '/'),
      )
    )
      continue
    const org = !s.key.includes('/'),
      children = org ? states.filter((c) => c.key.startsWith(s.key + '/')) : [s]
    let failed = false
    for (const child of children) {
      for (const key of [child.key, ...child.previous]) {
        try {
          await t.purge(key, child.id)
        } catch (e) {
          failed = true
          console.error('Deleted repository purge failed', key, e)
        }
      }
    }
    if (org)
      for (const key of [s.key, ...s.previous]) {
        try {
          await t.purge(key, s.id)
        } catch (e) {
          failed = true
          console.error('Deleted owner purge failed', key, e)
        }
      }
    if (!failed) {
      try {
        await st.settings.forget(s.key, org)
      } catch (e) {
        console.error('Deleted item cleanup failed', s.key, e)
      }
    }
  }
}
