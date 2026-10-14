import {PREPARED_CONVERSATION_OPERATIONS,type PreparedConversations} from '../prepared-conversations.js'
import {PREPARED_CONTENT_OPERATIONS,type PreparedRepositoryContent} from '../prepared-repository-content.js'
import {preparedRefsResponse} from './prepared-refs.js'
import {preparedHealth} from './prepared-health.js'
import type {PreparedReadModels,PreparedRepositoryAccess} from '../prepared-read-models.js'
import {PreparationPending,PREPARED_REPO_READ_OPERATIONS} from '../prepared-read-models.js'
import { PRIVATE_OPERATIONS } from '../collaborators.js'
import { metadataOperationPath, recoverableMetadataRoutes, setMetadataOperationSnapshot } from '../../engine/metadata-operation.js'
import { DIR, readJson } from '../../engine/meta-files.js'
import { ORCHESTRATOR_OPERATIONS } from '../../engine/api/orchestrator-contract.js'
import { revokeTree } from '../orchestrators.js'
import type { Report } from '../cqx-wasm.js'
import { repoState } from '../repo-state.js'
import { ownerNameAvailable } from '../../engine/backend-names.js'
import { changeMembership, SETTINGS_OPERATIONS } from '../settings.js'
import { sessionHandler } from './sessions.js'
import { mayRead, mayContribute, repoAccess, privateAcl } from '../repo-read.js'
import { contributorPath } from '../privacy-http.js'
import { ACCOUNT_OPERATIONS, accountOperation } from '../accounts.js'
import type { ForgeStore } from '../backend.js'
import type { Index } from './indexed.js'
import {
  SHA,
  resolve,
  snapshot,
  entries,
  raw,
  changes,
  comparison,
} from './indexed.js'
import type { Context, Result } from './dispatch.js'
import { paginationOffset, paginate } from './dispatch.js'
import { ApiError, requireFound } from '../../engine/api/errors.js'
import { SCOPES, permitsRepo, hasScope, grantScopes } from '../../engine/api/scopes.js'
import {
  apiURL,
  repoPath,
  repoShape,
  issueShape,
  pullShape,
  commentShape,
  commitShape,
  reviewShape,
  labelShape,
} from './shapes.js'
import type { Issue, Comment } from '../issues.js'
import type { Pull, Review } from '../pulls.js'
import type { MetaIndex } from '../metastore.js'
import { user } from './shapes.js'
import type { InlineComment } from './metadata.js'
export interface Services {
  /** Account lifecycle (lib/accounts.ts). */
  accounts?: { db: import('@cloudflare/workers-types').D1Database; store: ForgeStore }
  /** Code search over the D1 index (lib/search-index.ts), when bound. */
  search?: (input: { q: string; viewer: string | null; page: number; limit: number; mayRead(repository: string): Promise<boolean> }) => Promise<import('../search-index.js').IndexedResult>
  readModels?: PreparedReadModels
  contentReads?: PreparedRepositoryContent
  conversationReads?: PreparedConversations
  channel?: (c:Context)=>Promise<Result>
  orchestrators?: (c:Context)=>Promise<Result>
  importAuthorize?: (c:Context)=>Promise<void>
  imports?: (c:Context)=>Promise<Result>
  privacy?: (c: Context) => Promise<Result>
  runners?: (c: Context) => Promise<Result>
  settings?: (c: Context) => Promise<Result>

  packageWrite?: (c:Context)=>Promise<Result>
  store: ForgeStore
  index(owner: string, repo: string): Promise<Index | null>
  catalog(owner?: string): Promise<
    {
      owner: string
      name: string
      description?: string | null
      created_at?: string
      updated_at?: string
      default_branch: string
    }[]
  >
  createToken(
    name: string,
    key: string,
    options: { scopes: string[]; repos?: string[]; label: string },
  ): Promise<string>
  writes: {
    claim: (typeof import('../issues.js'))['changeIssue']
    dequeue: (typeof import('../pulls.js'))['dequeuePull']
    grants: (typeof import('../access.js'))['setAgentGrants']
    repository: (typeof import('../repos-write.js'))['createRepository']
    issue: (typeof import('./metadata.js'))['createIssueRecord']
    update: (typeof import('./metadata.js'))['updateItem']
    inline: (typeof import('./metadata.js'))['addInlineComment']
    comment: (typeof import('../issues.js'))['addComment']
    pull: (typeof import('../pulls.js'))['createPull']
    pullComment: (typeof import('../pulls.js'))['commentOnPull']
    review: (typeof import('../pulls.js'))['reviewPull']
    queue: (typeof import('../pulls.js'))['enqueuePull']
    fileRequest: (typeof import('../agentRequests.js'))['fileRequest']
    decide: (typeof import('../agentRequests.js'))['decide']
  }
  health(
    index: Index,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<Report | null>
  events(context: Context): Promise<Result>
  actions(context: Context): Promise<Result>
}
export function service(s: Services) {
  const preparedRepositoryOperation=(id:string)=>([...(PREPARED_REPO_READ_OPERATIONS as readonly string[]),...PREPARED_CONTENT_OPERATIONS,...PREPARED_CONVERSATION_OPERATIONS]).includes(id)
  // Request-local authorization snapshot; never cached across requests/viewers.
  const preparedAccess=new WeakMap<Request,PreparedRepositoryAccess>()
  const repository = async (
    c: Context,
    owner: string,
    name: string,
    branch: string,
    info?: Parameters<typeof repoShape>[4],
  ) => {
    // The repository's shape needs its settings, access and stars, never its
    // index: waiting for a ready index here made a just-created repository
    // answer 503 "indexing" although it existed (13 Oct).
    const state = await repoState(s.store, owner, name)
    const acl = (await repoAccess(s, owner, name))?.acl ?? {
      visibility: 'private',
    }
    if (acl.visibility === 'private' || acl.private === true)
      c.privateRead = true
    return repoShape(c, owner, name, branch, {
      ...info,
      private: acl.visibility === 'private' || acl.private === true,
      stargazers_count: await s.store.starCount(state.id),
    })
  }
  const readRequest = async (c: Context, r: { repo: string | null }) => {
    if (!r.repo) return true
    const [owner, repo] = r.repo.split('/'),
      policy = await repoAccess(s, owner, repo)
    if (!policy || !(await mayRead(s, owner, repo, c.principal.name, policy)))
      return false
    if (policy.pending || privateAcl(policy.acl)) {
      if (
        !hasScope(c.principal, 'repo:read') ||
        !permitsRepo(c.principal, owner, repo)
      )
        return false
      c.privateRead = true
    }
    return true
  }
  const indexFor = async (c: Context) => {
    const index = await s.index(c.params.owner, c.params.repo)
    if (!index) throw new ApiError(503, 'Repository is indexing; retry shortly')
    return index
  }
  const meta = async (index: Index) =>
    JSON.parse(
      (await index.metaFile('.gild/index.json')) ??
        '{"issues":[],"pulls":[],"queue":[]}',
    ) as MetaIndex
  const pullData = async (c: Context, index: Index, p: Pull, comments = 0) => {
    const refs = await index.refs(),
      head = await resolve(index, p.head),
      base = await resolve(index, p.base)
    return pullShape(
      c,
      p,
      await repository(
        c,
        c.params.owner,
        c.params.repo,
        refs.defaultBranch,
        (await s.catalog(c.params.owner)).find((r) => r.name === c.params.repo),
      ),
      head,
      base,
      comments,
    )
  }
  const detail = async (c: Context, index: Index, kind: 'issue' | 'pr') =>
    requireFound(await index.metaItem(Number(c.params.number), kind))
  const files = async (
    c: Context,
    index: Index,
    change: Awaited<ReturnType<typeof changes>>,
  ) =>
    Promise.all(
      change.files.map(async (f) => ({
        sha:
          (await index.file(f.path, change.to))?.hash ??
          (change.from
            ? (await index.file(f.path, change.from))?.hash
            : undefined) ??
          change.to,
        filename: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.additions + f.deletions,
        patch: f.hunks.length
          ? f.hunks
              .map(
                (h) =>
                  `@@ -${h.oldStart} +${h.newStart} @@\n${h.lines.join('\n')}`,
              )
              .join('\n')
          : undefined,
        blob_url: apiURL(
          c,
          `${repoPath(c)}/contents/${f.path}?ref=${change.to}`,
        ),
        raw_url: apiURL(
          c,
          `${repoPath(c)}/contents/${f.path}?ref=${change.to}`,
        ),
        contents_url: apiURL(c, `${repoPath(c)}/contents/${f.path}`),
      })),
    )
  async function authorize(c: Context) {
    if (['ownerRepoCards','publicDisplayProfile','viewerContext'].includes(c.route.id)) return
    if(preparedRepositoryOperation(c.route.id)){
      if(!s.readModels)throw new PreparationPending()
      const access=preparedAccess.get(c.request)??await s.readModels.repositoryAccess(c.principal,c.params.owner,c.params.repo)
      preparedAccess.set(c.request,access)
      c.privateRead=access.private;return
    }

    const id = c.route.id,
      { owner, repo } = c.params,
      name = c.principal.name
    if(id.startsWith('import')) {if(!s.importAuthorize)throw new ApiError(503,'Import service unavailable');await s.importAuthorize(c);return}
    if (owner && repo && !['runner', 'registration'].includes(name)) {
      const policy = await repoAccess(s, owner, repo)
      if (!policy || !(await mayRead(s, owner, repo, name || null, policy)))
        throw new ApiError(404, 'Repository not found')
      if (policy.pending || privateAcl(policy.acl)) {
        if (
          !hasScope(c.principal, 'repo:read') ||
          !permitsRepo(c.principal, owner, repo)
        )
          throw new ApiError(404, 'Repository not found')
        c.privateRead = true
      }
    }
    if ((PRIVATE_OPERATIONS as readonly string[]).includes(id)) return
    if (
      name.includes('/') &&
      [
        'tokens',
        'createToken',
        'deleteToken',
        'agents',
        'deleteAgent',
        'updateAgent',
      ].includes(id)
    )
      throw new ApiError(403, 'A person is required')
    if (id === 'createToken') {
      if (
        c.body.scopes.some(
          (scope: (typeof SCOPES)[number]) => !hasScope(c.principal, scope),
        )
      )
        throw new ApiError(403, 'Cannot grant scopes you do not hold')
      if (
        c.principal.repos !== null &&
        (!c.body.repos ||
          c.body.repos.some((r: string) => {
            const [owner, repo] = r.split('/')
            return !permitsRepo(c.principal, owner, repo)
          }))
      )
        throw new ApiError(403, 'Cannot widen the repository allow-list')
    }
    if (
      [
        'createOrg',
        'addOrgMember',
        'createRepository',
        'createOrgRepository',
      ].includes(id) &&
      name.includes('/')
    )
      throw new ApiError(403, 'A person is required')
    if (
      ['createRepository', 'createOrgRepository'].includes(id) &&
      !permitsRepo(
        c.principal,
        id === 'createRepository' ? name : c.params.org,
        c.body.name,
      )
    )
      throw new ApiError(403, 'Repository is outside this token allow-list')
    if (
      ['createOrg', 'addOrgMember', 'updateAgent', 'deleteAgent'].includes(
        id,
      ) &&
      c.principal.repos !== null
    )
      throw new ApiError(
        403,
        'Organization and agent administration requires an unrestricted token',
      )
    if (
      id === 'agentRequest' &&
      name.includes('/') &&
      !(await s.store.getAgent(name))?.approver
    )
      throw new ApiError(403, 'Approver agent required')
    if (id.startsWith('org') && id.includes('Hook')) {
      if (
        name.includes('/') ||
        c.principal.repos !== null ||
        !['owner', 'admin'].includes(
          (await s.store.orgRole(c.params.org, name)) ?? '',
        )
      )
        throw new ApiError(
          403,
          'Organization owner or admin with an unrestricted token required',
        )
    }
    if (id.startsWith('repo') && id.includes('Hook')) {
      if (!(await mayRead(s, owner, repo, name || null)))
        throw new ApiError(404, 'Repository not found')
      if (
        name.includes('/') ||
        !(
          owner === name ||
          ['owner', 'admin'].includes(
            (await s.store.orgRole(owner, name)) ?? '',
          )
        )
      )
        throw new ApiError(403, 'Repository writer required')
      return
    }
    if ((SETTINGS_OPERATIONS as readonly string[]).includes(id)) return
    if (/^(org|user)Pool/.test(id)) return
    if (
      ['runner', 'registration'].includes(name) &&
      (id.startsWith('runner') || id === 'actionRegister')
    )
      return
    if (!owner || !repo) return
    // An index stub can exist before the repository does. Never write orphan stars.
    if (
      ['star', 'unstar', 'stargazers'].includes(id) &&
      !(await s.catalog(owner)).some((r) => r.name === repo)
    )
      throw new ApiError(404, 'Repository not found')
    if (!(await mayRead(s, owner, repo, name || null)))
      throw new ApiError(404, 'Repository not found')
    if (id.startsWith('channel')) return
    // The orchestrator service authorizes its own operations (grants, children, suspension).
    if ((ORCHESTRATOR_OPERATIONS as readonly string[]).includes(id)) return
    const index = await indexFor(c),
      acl = JSON.parse((await index.metaFile('.gild/acl.json')) ?? '{}') as {
        agents?: Record<string, string[]>
      }
    const grants = acl.agents?.[`@${name}`] ?? []
    if (
      name.includes('/') &&
      c.route.method !== 'GET' &&
      c.route.scope &&
      !grantScopes(grants).includes(c.route.scope)
    )
      throw new ApiError(403, 'Scope is capped by current agent grants')
    const writer =
      !name.includes('/') &&
      (owner === name ||
        ['owner', 'admin'].includes(
          (await s.store.orgRole(owner, name)) ?? '',
        ) ||
        (
          JSON.parse((await index.metaFile('.gild/acl.json')) ?? '{}').write ??
          []
        ).includes(`@${name}`))
    if (id === 'updateAgentPackage' && !writer)throw new ApiError(403,'Repository writer required')
    if (id.startsWith('repo') && id.includes('Hook') && !writer)
      throw new ApiError(403, 'Repository writer required')
    if (
      ['mergePull', 'dequeuePull'].includes(id) &&
      !writer &&
      !grants.includes('queue')
    )
      throw new ApiError(403, 'Requires the queue grant')
    if (
      id === 'createReview' &&
      !writer &&
      name.includes('/') &&
      !grants.includes('review')
    )
      throw new ApiError(403, 'Requires the review grant')
    if (id === 'updateIssue' || id === 'updatePull') {
      const found = await detail(
        c,
        index,
        id === 'updateIssue' &&
          (await index.metaItem(Number(c.params.number), 'issue'))
          ? 'issue'
          : 'pr',
      )
      if (!writer && found.item.author !== name)
        throw new ApiError(
          403,
          'Only the author or a repository writer may update this item',
        )
      if (c.body.labels && !writer)
        throw new ApiError(403, 'Labels require repository write access')
    }
    if (
      id === 'setRepoAgent' &&
      !(
        owner === name ||
        ['owner', 'admin'].includes((await s.store.orgRole(owner, name)) ?? '')
      )
    )
      throw new ApiError(403, 'Repository writer required')
    if (id === 'claimIssue') {
      const found = await detail(c, index, 'issue')
      if (
        c.body.action === 'claim'
          ? !writer && !grants.includes('pr')
          : !writer && found.item.claim?.by !== name
      )
        throw new ApiError(403, 'Cannot change this issue claim')
    }
    if (id === 'createIssue' && c.body.labels?.length && !writer)
      throw new ApiError(403, 'Labels require repository write access')
  }
  async function execute(c: Context): Promise<Result> {
    if (['ownerRepoCards','publicDisplayProfile','viewerContext'].includes(c.route.id)) {
      if (!s.readModels) throw new PreparationPending()
      const data=c.route.id==='ownerRepoCards' ? await s.readModels.ownerRepoCards(c.principal,c.params.owner,c.query.page,c.query.per_page)
        : c.route.id==='publicDisplayProfile' ? await s.readModels.publicProfile(c.principal,c.params.owner)
        : await s.readModels.viewerContext(c.principal,c.query.owner,c.query.repo)
      return {data,noStore:true}
    }

    const id = c.route.id,
      { owner, repo } = c.params,
      b = c.body,
      q = c.query,
      name = c.principal.name,
      n = Number(c.params.number)
    if ((ACCOUNT_OPERATIONS as readonly string[]).includes(id)) {
      if (!s.accounts) throw new ApiError(503, 'Accounts are unavailable')
      return { data: await accountOperation(c, s.accounts, (status, message) => { throw new ApiError(status, message) }), noStore: true }
    }
    if(preparedRepositoryOperation(id)){
      if(!s.readModels)throw new PreparationPending()
      if((PREPARED_CONVERSATION_OPERATIONS as readonly string[]).includes(id)){
        if(!s.conversationReads)throw new PreparationPending()
        return s.conversationReads.read(c)
      }
      if((PREPARED_CONTENT_OPERATIONS as readonly string[]).includes(id)){
        if(!s.contentReads)throw new PreparationPending()
        return s.contentReads.response(c)
      }
      if(id==='commitChanges'||id==='pullChanges'){
        return {data:await s.readModels.repositoryDiff(c.principal,owner,repo,id==='commitChanges'?'commit':'pull',c.params.sha??c.params.number,preparedAccess.get(c.request)),
          immutable:id==='commitChanges'&&SHA.test(c.params.sha)}
      }
      if(id==='health'||id==='healthAt'){
        const result=await preparedHealth(s.readModels,c.principal,owner,repo,c.params.sha??q.ref,preparedAccess.get(c.request))
        return {data:result.data,noStore:result.noStore,immutable:!result.noStore&&SHA.test(c.params.sha??q.ref??'')}
      }
      return preparedRefsResponse(c,await s.readModels.repositoryRefs(c.principal,owner,repo,preparedAccess.get(c.request)))
    }
    if(id==='updateAgentPackage'){if(!s.packageWrite)throw new ApiError(503,'Package save unavailable');return s.packageWrite(c)}
    if(id.startsWith('channel')) {if(!s.channel) throw new ApiError(503,'Channel service unavailable');return s.channel(c)}
    if ((ORCHESTRATOR_OPERATIONS as readonly string[]).includes(id)) {
      if (!s.orchestrators) throw new ApiError(503, 'Orchestrator service unavailable')
      return s.orchestrators(c)
    }
    if(id.startsWith('import')) {if(!s.imports) throw new ApiError(503,'Import service unavailable');return s.imports(c)}
    if ((PRIVATE_OPERATIONS as readonly string[]).includes(id)) {
      if (!s.privacy) throw new ApiError(503, 'Access storage unavailable')
      return s.privacy(c)
    }
    if ((SETTINGS_OPERATIONS as readonly string[]).includes(id)) {
      if (!s.settings) throw new ApiError(503, 'Settings storage unavailable')
      return s.settings(c)
    }
    if (['star', 'unstar', 'stargazers'].includes(id)) {
      const key = (await repoState(s.store, owner, repo)).id
      if (id === 'stargazers')
        return paginate(
          (await s.store.stargazers(key)).map((r) => user(c, r.name)),
          c,
        )
      await s.store[id === 'star' ? 'star' : 'unstar'](key, name)
      return { data: null }
    }
    if (id === 'events' || id.includes('Hook')) return s.events(c)
    if (/^(org|user)Pool/.test(id)) return s.runners!(c)
    if (id.startsWith('action') || id.startsWith('runner')) return s.actions(c)

    const tokenView = (
      t: Awaited<ReturnType<ForgeStore['listApiTokens']>>[number],
    ) => ({
      id: t.id,
      label: t.label,
      scopes: t.scopes ?? [...SCOPES],
      repos: t.repos,
      created_at: new Date(t.createdAt).toISOString(),
      expires_at: new Date(t.expiresAt).toISOString(),
    })
    if (id === 'createRepository' || id === 'createOrgRepository') {
      const repoOwner = id === 'createRepository' ? name : c.params.org,
        created = await s.writes.repository(
          name,
          repoOwner,
          b.name,
          b.description,
          b.private ?? false,
        )
      if (b.private) c.privateRead = true
      return {
        data: await repository(
          c,
          repoOwner,
          created.name,
          created.default_branch,
          created,
        ),
      }
    }
    if (id === 'org' || id === 'orgMembers') {
      const org = requireFound(await s.store.getOrg(c.params.org))
      return id === 'org'
        ? {
            data: {
              ...user(c, org.name, true),
              description: org.description,
              created_at: org.createdAt,
            },
          }
        : paginate(
            (await s.store.orgMembers(org.name)).map((m) => user(c, m.member)),
            c,
          )
    }
    if (id === 'updateAgent') {
      const agent = requireFound(
        await s.store.getAgent(`${name}/${c.params.label}`),
      )
      if (agent.revokedAt) throw new ApiError(404, 'Not Found')
      await s.store.setApprover(agent.name, b.approver)
      return { data: { ok: true } }
    }
    if (id === 'agentRequest') {
      const r = requireFound(await s.store.getAgentRequest(c.params.id))
      if (!(await readRequest(c, r))) throw new ApiError(404, 'Not Found')
      if (r.sponsor !== name.split('/')[0])
        throw new ApiError(403, 'Sponsor required')
      return { data: r }
    }
    if (id === 'orgs') return { data: await s.store.orgsFor(name) }
    if (id === 'createOrg') {
      if (!ownerNameAvailable(b.name))
        throw new ApiError(422, 'Invalid organization name')
      if (await s.store.nameTaken(b.name))
        throw new ApiError(409, 'Name is already taken')
      await s.store.createOrg(b.name, b.description ?? null, name)
      return { data: requireFound(await s.store.getOrg(b.name)) }
    }
    if (id === 'addOrgMember') {
      await changeMembership(s.store, c.params.org, name, b.member, b.role)
      return {
        data: { ok: true, org: c.params.org, member: b.member, role: b.role },
      }
    }
    if (id === 'tokens')
      return { data: (await s.store.listApiTokens(name)).map(tokenView) }
    if (id === 'createToken') {
      const token = await s.createToken(
          name,
          c.principal.publicKey,
          b as { scopes: string[]; label: string; repos?: string[] },
        ),
        { hashToken } = await import('../token-verifier.js')
      const t = requireFound(await s.store.getApiToken(await hashToken(token)))
      return {
        data: { ...tokenView({ ...t, id: await hashToken(token) }), token },
      }
    }
    if (id === 'deleteToken') {
      if (!(await s.store.deleteApiToken(name, c.params.id)))
        throw new ApiError(404, 'Not Found')
      return { data: { ok: true } }
    }
    if (id === 'agents') return { data: await s.store.agentsFor(name) }
    if (id === 'deleteAgent') {
      const agent = await s.store.getAgent(`${name}/${c.params.label}`)
      requireFound(agent)
      // Revoking an agent revokes every child it spawned, recursively.
      await revokeTree(s.store, agent!.name)
      return { data: { ok: true } }
    }
    if (id === 'agentRequests') {
      if (name.includes('/') && !(await s.store.getAgent(name))?.approver)
        throw new ApiError(403, 'Approver agent required')
      const rows = await s.store.pendingRequestsFor(
        name.includes('/') ? name.split('/')[0] : name,
      )
      return {
        data: (
          await Promise.all(
            rows.map(async (r) => ((await readRequest(c, r)) ? r : null)),
          )
        ).filter((r) => r !== null),
        noStore: true,
      }
    }
    if (id === 'createAgentRequest')
      return { data: await s.writes.fileRequest(b) }
    if (id === 'decideAgentRequest') {
      const request = requireFound(await s.store.getAgentRequest(c.params.id))
      if (!(await readRequest(c, request))) throw new ApiError(404, 'Not Found')
      return {
        data: await s.writes.decide(c.params.id, name, b.decision, b.grants),
      }
    }
    if (['repos', 'ownerRepos', 'orgRepos'].includes(id)) {
      const catalog = (
          await Promise.all(
            (await s.catalog(id === 'repos' ? undefined : owner)).map(
              async (r) =>
                (await mayRead(s, r.owner, r.name, name || null)) ? r : null,
            ),
          )
        ).filter((r) => r !== null),
        mine =
          id === 'repos'
            ? new Set([
                name,
                ...(await s.store.orgsFor(name)).map((o) => o.name),
              ])
            : null
      return paginate(
        await Promise.all(
          catalog
            .filter(
              (r) =>
                (!mine ||
                  mine.has(r.owner) ||
                  (name.includes('/') &&
                    c.principal.repos?.includes(`${r.owner}/${r.name}`))) &&
                permitsRepo(c.principal, r.owner, r.name),
            )
            .map((r) => repository(c, r.owner, r.name, r.default_branch, r)),
        ),
        c,
      )
    }
    if (id === 'searchCode' && s.search) {
      // One D1 query over every readable repository (lib/search-index.ts).
      const offset = paginationOffset(c), viewer = name || null
      const found = await s.search({
        q: q.q, viewer, page: Math.floor(offset / q.per_page) + 1, limit: q.per_page,
        mayRead: async (full) => {
          const [owner, repo] = full.split('/')
          return permitsRepo(c.principal, owner, repo) && (await mayRead(s, owner, repo, viewer))
        },
      })
      if (found.hits.some((h) => h.private)) c.privateRead = true
      const origin = new URL(c.request.url).origin
      const items = found.hits.map((h) => {
        const [owner, repo] = h.repo.split('/')
        return {
          name: h.path.split('/').pop(),
          path: h.path,
          sha: h.blob,
          repository: repoShape(c, owner, repo, h.ref, { private: h.private }),
          url: apiURL(c, `/repos/${h.repo}/contents/${h.path}?ref=${h.commit}`),
          html_url: `${origin}/${h.repo}/blob/${h.commit}/${h.path}`,
          text_matches: h.lines.map((l) => ({
            fragment: l.text,
            matches: l.ranges.map((indices) => ({ indices, text: l.text.slice(...indices) })),
          })),
        }
      })
      const page = paginate(items, c, found.count, true)
      return { data: { total_count: found.count, incomplete_results: !!found.partial, items: page.data }, headers: page.headers }
    }
    if (id === 'searchCode') {
      const catalog = (
          await Promise.all(
            (await s.catalog()).map(async (r) =>
              (await mayRead(s, r.owner, r.name, name || null)) ? r : null,
            ),
          )
        ).filter((r) => r !== null),
        offset = paginationOffset(c),
        items: unknown[] = [],
        result = { total_count: 0, incomplete_results: false, items }
      for (const r of catalog.filter((r) =>
        permitsRepo(c.principal, r.owner, r.name),
      )) {
        if (
          (await repoAccess(s, r.owner, r.name))?.acl.visibility === 'private'
        )
          c.privateRead = true
        const index = await s.index(r.owner, r.name)
        if (!index) {
          result.incomplete_results = true
          continue
        }
        const found = await index.search(
          q.q,
          {
            repo: `${r.owner}/${r.name}`,
            ownerKind: (await s.store.getOrg(r.owner)) ? 'org' : 'user',
          },
          undefined,
          Math.max(1, q.per_page - items.length),
          Math.max(0, offset - result.total_count),
        )
        const relevant =
          offset < result.total_count + found.count && items.length < q.per_page
        result.total_count += found.count
        result.incomplete_results ||= Boolean(found.partial)
        for (const hit of relevant ? found.hits : []) {
          const path = hit.path,
            hash = await resolve(index, hit.ref),
            sha = requireFound(await index.file(path, hash)).hash
          items.push({
            name: path.split('/').pop(),
            path,
            sha,
            repository: await repository(
              c,
              r.owner,
              r.name,
              (await index.refs()).defaultBranch,
              r,
            ),
            url: apiURL(
              c,
              `/repos/${r.owner}/${r.name}/contents/${path}?ref=${hash}`,
            ),
            html_url: `${new URL(c.request.url).origin}/${r.owner}/${r.name}/blob/${hash}/${path}`,
            text_matches: hit.lines.map((l) => ({
              fragment: l.text,
              matches: l.ranges.map((indices) => ({
                indices,
                text: l.text.slice(...indices),
              })),
            })),
          })
        }
      }
      const page = paginate(items, c, result.total_count, true)
      return { data: { ...result, items: page.data }, headers: page.headers }
    }
    if (id.endsWith('Session') || id.endsWith('Sessions'))
      return sessionHandler(c, await indexFor(c))
    const index = await indexFor(c),
      refs = await index.refs(),
      path = repoPath(c)
    if (id === 'repo')
      return {
        data: await repository(
          c,
          owner,
          repo,
          refs.defaultBranch,
          (await s.catalog(owner)).find((r) => r.name === repo),
        ),
      }
    if (id === 'commits') {
      const hash = await resolve(index, q.sha)
      if (!(await index.ensureHistory(hash)))
        throw new ApiError(503, 'Commit history is indexing; retry shortly')
      const log = await index.apiLog(hash, q.per_page, paginationOffset(c)),
        missing = log.commits.filter((c) => c.committer_name === undefined)
      if (missing.length) {
        for (const c of missing) await index.hydrate(c.hash)
        throw new ApiError(503, 'Commit records are indexing; retry shortly')
      }
      return {
        ...paginate(
          log.commits.map((h) => commitShape(c, h)),
          c,
          log.total,
          true,
        ),
        immutable: SHA.test(q.sha ?? ''),
      }
    }
    if (id === 'blob')
      return {
        data: {
          sha: c.params.sha,
          url: apiURL(c, `${path}/git/blobs/${c.params.sha}`),
          encoding: 'base64',
          ...(await raw(index, c.params.sha)),
        },
        immutable: SHA.test(c.params.sha),
      }
    if (id === 'tree') {
      if (
        SHA.test(c.params.sha) &&
        !(await index.tree(c.params.sha)) &&
        !(await index.commit(c.params.sha))
      ) {
        const state = await index.requestObject('tree', c.params.sha)
        if (state === 'pending')
          throw new ApiError(503, 'Tree is indexing; retry shortly')
      }
      const hash =
        SHA.test(c.params.sha) && (await index.tree(c.params.sha))
          ? c.params.sha
          : (await snapshot(index, await resolve(index, c.params.sha))).tree
      return {
        data: {
          sha: hash,
          url: apiURL(c, `${path}/git/trees/${hash}`),
          tree: (await entries(index, hash, q.recursive !== undefined)).map(
            (e) => ({
              ...e,
              url: apiURL(
                c,
                `${path}/git/${e.type === 'tree' ? 'trees' : 'blobs'}/${e.sha}`,
              ),
            }),
          ),
          truncated: false,
        },
        immutable: SHA.test(c.params.sha),
      }
    }
    if (id === 'contents' || id === 'contentsRoot') {
      const hash = await resolve(index, q.ref),
        commit = await snapshot(index, hash),
        filePath = c.params.path ?? '',
        parts = filePath.split('/').filter(Boolean)
      let tree = commit.tree,
        entry:
          | {
              name: string
              type: 'tree' | 'blob' | 'commit'
              mode: string
              child: string
            }
          | undefined
      for (const [i, part] of parts.entries()) {
        entry = requireFound(
          (await index.tree(tree))?.find((e) => e.name === part),
        )
        if (i < parts.length - 1 && entry.type !== 'tree')
          throw new ApiError(404, 'Not Found')
        tree = entry.child
      }
      const shape = async (
        e: { name: string; type: 'tree' | 'blob' | 'commit'; child: string },
        prefix: string,
        full = false,
      ) => {
        const p = prefix + e.name,
          blob = e.type === 'blob' ? await raw(index, e.child, hash) : null
        return {
          type:
            e.type === 'tree'
              ? 'dir'
              : e.type === 'commit'
                ? 'submodule'
                : 'file',
          name: e.name,
          path: p,
          sha: e.child,
          size: blob?.size ?? 0,
          url: apiURL(c, `${path}/contents/${p}?ref=${hash}`),
          html_url: `${new URL(c.request.url).origin}/${owner}/${repo}/blob/${hash}/${p}`,
          git_url: apiURL(
            c,
            `${path}/git/${e.type === 'tree' ? 'trees' : 'blobs'}/${e.child}`,
          ),
          download_url:
            e.type === 'blob'
              ? apiURL(c, `${path}/contents/${p}?ref=${hash}`)
              : null,
          ...(full && blob
            ? { encoding: 'base64', content: blob.content }
            : {}),
        }
      }
      const data =
        entry && entry.type !== 'tree'
          ? await shape(
              entry,
              parts.slice(0, -1).join('/') + (parts.length > 1 ? '/' : ''),
              true,
            )
          : await Promise.all(
              requireFound(await index.tree(tree)).map((e) =>
                shape(e, filePath ? filePath + '/' : ''),
              ),
            )
      return { data, immutable: SHA.test(q.ref ?? '') }
    }
    if (id === 'commit' || id === 'commitChanges') {
      const hash = await resolve(index, c.params.sha),
        commit = requireFound(await index.commit(hash)),
        change = await changes(index, commit.parents[0] ?? null, hash)
      const fileList = await files(c, index, change)
      return {
        data:
          id === 'commitChanges'
            ? change
            : {
                ...commitShape(c, commit),
                files: fileList,
                stats: {
                  additions: fileList.reduce((n, f) => n + f.additions, 0),
                  deletions: fileList.reduce((n, f) => n + f.deletions, 0),
                  total: fileList.reduce((n, f) => n + f.changes, 0),
                },
              },
        immutable: SHA.test(c.params.sha),
      }
    }
    if (id === 'compare') {
      const [base, head] = await Promise.all([
          resolve(index, c.params.base),
          resolve(index, c.params.head),
        ]),
        comp = await comparison(index, base, head),
        change = await changes(index, comp.mergeBase, head),
        page = paginate(
          comp.commits.map((h) => commitShape(c, h)),
          c,
        )
      return {
        data: {
          url: apiURL(c, `${path}/compare/${base}...${head}`),
          html_url: `${new URL(c.request.url).origin}/${owner}/${repo}/compare/${base}...${head}`,
          status:
            !comp.ahead && !comp.behind
              ? 'identical'
              : !comp.behind
                ? 'ahead'
                : !comp.ahead
                  ? 'behind'
                  : 'diverged',
          ahead_by: comp.ahead,
          behind_by: comp.behind,
          total_commits: comp.ahead,
          base_commit: commitShape(c, requireFound(await index.commit(base))),
          merge_base_commit: commitShape(
            c,
            requireFound(await index.commit(comp.mergeBase)),
          ),
          commits: page.data,
          files: await files(c, index, change),
        },
        headers: page.headers,
        immutable: SHA.test(c.params.base) && SHA.test(c.params.head),
      }
    }
    const metadata = await meta(index)
    if (id === 'repoAgents')
      return {
        data: {
          agents:
            JSON.parse((await index.metaFile('.gild/acl.json')) ?? '{}')
              .agents ?? {},
        },
      }
    if (id === 'setRepoAgent') {
      const agent = requireFound(await s.store.getAgent(b.agent))
      if (agent.revokedAt) throw new ApiError(404, 'Agent is revoked')
      await s.writes.grants(owner, repo, name, agent.name, b.grants)
      return { data: { ok: true, agent: agent.name, grants: b.grants } }
    }
    if (id === 'claimIssue') {
      if (!(await s.writes.claim(owner, repo, n, name, b.action)))
        throw new ApiError(409, 'Claim has already changed')
      return { data: { ok: true } }
    }
    if (id === 'dequeuePull') {
      await s.writes.dequeue(owner, repo, n, name)
      return { data: { ok: true } }
    }
    if (id === 'mergeQueue') return { data: { queue: metadata.queue } }
    if (id === 'labels') {
      const labels=JSON.parse(await index.metaFile('.gild/import/labels.json')??'{}') as Record<string,{name:string;color:string;description:string}>
      return paginate([...new Set([...Object.keys(labels),...metadata.issues.flatMap(i=>i.labels)])].map(l=>({...labelShape(c,l),...(labels[l]??{})})),c)
    }
    if (id === 'issues' || id === 'pulls') {
      const items: unknown[] = [],
        summaries = [
          ...metadata.issues.map((i) => ({ ...i, kind: 'issue' as const })),
          ...metadata.pulls.map((i) => ({ ...i, kind: 'pr' as const })),
        ]
          .filter((i) => id === 'issues' || i.kind === 'pr')
          .filter(
            (i) =>
              q.state === 'all' ||
              (i.state === 'merged' ? 'closed' : i.state) === q.state,
          )
          .sort((a, b) =>
            q.direction === 'asc' ? a.number - b.number : b.number - a.number,
          )
      for (const summary of summaries) {
        const found = requireFound(
          await index.metaItem(summary.number, summary.kind),
        )
        if (summary.kind === 'issue') {
          const item = found.item as Issue
          if (
            q.labels &&
            !q.labels.split(',').every((l: string) => item.labels.includes(l))
          )
            continue
          items.push(
            issueShape(c, item, found.comments.length, summary.updatedAt),
          )
        } else {
          const p = found.item as Pull,
            shaped = await pullData(c, index, p, found.comments.length)
          items.push(
            id === 'pulls'
              ? shaped
              : {
                  ...issueShape(
                    c,
                    {
                      ...p,
                      state: p.state === 'merged' ? 'closed' : p.state,
                      labels: [],
                      claim: null,
                    },
                    found.comments.length,
                    summary.updatedAt,
                  ),
                  pull_request: { url: shaped.url, html_url: shaped.html_url },
                },
          )
        }
      }
      items.sort((a, b) => {
        const x = a as { number: number; updated_at: string; comments: number },
          y = b as typeof x
        const delta =
          q.sort === 'updated'
            ? x.updated_at.localeCompare(y.updated_at)
            : q.sort === 'comments'
              ? x.comments - y.comments
              : x.number - y.number
        return q.direction === 'asc' ? delta : -delta
      })
      return paginate(items, c)
    }
    if (id === 'createIssue')
      return {
        data: issueShape(
          c,
          await s.writes.issue(owner, repo, name, b.title, b.body, b.labels),
        ),
      }
    if (id === 'createPull') {
      const head = b.head.includes(':') ? b.head.split(':') : [owner, b.head]
      if (head[0] !== owner)
        throw new ApiError(
          422,
          'Cross-repository pull requests are not supported',
        )
      const headSha = await resolve(index, head[1]), baseSha = await resolve(index, b.base)
      const refs = await index.refs(), repoSnapshot = await repository(c, owner, repo, refs.defaultBranch,
        (await s.catalog(owner)).find(r => r.name === repo))
      let creationData: unknown
      setMetadataOperationSnapshot(async (result, fs) => {
        const record = requireFound(await readJson<Pull>(fs, `${DIR}/.gild/${Number(result)}/pr/pr.json`))
        creationData = pullShape(c, record, repoSnapshot, headSha, baseSha, 0)
        return creationData
      })
      const number = await s.writes.pull(
        owner,
        repo,
        name,
        b.title,
        b.body,
        head[1],
        b.base,
      )
      return {
        data: creationData ?? await pullData(c, index, {
          schema: 1,
          number,
          title: b.title,
          body: b.body,
          head: head[1],
          base: b.base,
          author: name,
          state: 'open',
          createdAt: new Date().toISOString(),
        }),
      }
    }
    const isIssue = [
        'issue',
        'updateIssue',
        'issueComments',
        'createIssueComment',
      ].includes(id),
      kind = isIssue
        ? (await index.metaItem(n, 'issue'))
          ? 'issue'
          : 'pr'
        : 'pr',
      found = await detail(c, index, kind),
      item = found.item as Issue | Pull
    if (id === 'issue')
      return {
        data:
          kind === 'issue'
            ? issueShape(c, item as Issue, found.comments.length)
            : {
                ...issueShape(
                  c,
                  {
                    ...item,
                    state: item.state === 'merged' ? 'closed' : item.state,
                    labels: [],
                    claim: null,
                  } as Issue,
                  found.comments.length,
                ),
                pull_request: {
                  url: apiURL(c, `${path}/pulls/${n}`),
                  html_url: `${new URL(c.request.url).origin}/${owner}/${repo}/pulls/${n}`,
                },
              },
      }
    if (id === 'pull')
      return {
        data: await pullData(c, index, item as Pull, found.comments.length),
      }
    if (id === 'updateIssue' || id === 'updatePull') {
      if (b.base) await resolve(index, b.base)
      const updated = await s.writes.update(owner, repo, n, name, kind, b)
      return {
        data:
          kind === 'issue'
            ? issueShape(
                c,
                updated as Issue,
                found.comments.length,
                new Date().toISOString(),
              )
            : await pullData(c, index, updated as Pull, found.comments.length),
      }
    }
    if (id === 'issueComments')
      return paginate(
        found.comments.map((comment: Comment) => commentShape(c, n, comment)),
        c,
      )
    if (id === 'createIssueComment') {
      const id = await (
        kind === 'issue' ? s.writes.comment : s.writes.pullComment
      )(owner, repo, n, name, b.body)
      return {
        data: commentShape(c, n, {
          id,
          author: name,
          body: b.body,
          createdAt: new Date().toISOString(),
        }),
      }
    }
    if (id === 'pullComments')
      return paginate(
        found.comments
          .filter((r: Partial<InlineComment>) => r.path)
          .map((r: InlineComment) => ({
            ...commentShape(c, n, r),
            path: r.path,
            line: r.line,
            side: r.side,
            commit_id: r.commit_id,
          })),
        c,
      )
    if (id === 'createPullComment') {
      const current = await resolve(index, (item as Pull).head)
      if (b.commit_id !== current)
        throw new ApiError(
          422,
          'commit_id must be the current pull request head',
        )
      const target =
        b.side === 'LEFT'
          ? (
              await comparison(
                index,
                await resolve(index, (item as Pull).base),
                current,
              )
            ).mergeBase
          : current
      const file = requireFound(
        (await entries(index, (await snapshot(index, target)).tree, true)).find(
          (f) => f.path === b.path && f.type === 'blob',
        ),
      )
      const blob = await raw(index, file.sha, target)
      if (
        b.line >
        Buffer.from(blob.content, 'base64').toString().split('\n').length
      )
        throw new ApiError(422, 'Line is outside the file')
      const comment = await s.writes.inline(
        owner,
        repo,
        n,
        name,
        b as Omit<InlineComment, 'id' | 'author' | 'createdAt'>,
      )
      return {
        data: {
          ...commentShape(c, n, comment),
          path: comment.path,
          line: comment.line,
          side: comment.side,
          commit_id: comment.commit_id,
        },
      }
    }
    if (id === 'pullReviews')
      return paginate(
        found.reviews.map((r: Review) => reviewShape(c, n, r)),
        c,
      )
    if (id === 'createReview') {
      const verdict =
          b.event === 'APPROVE'
            ? 'approve'
            : b.event === 'REQUEST_CHANGES'
              ? 'changes'
              : 'comment',
        id = await s.writes.review(owner, repo, n, name, verdict, b.body)
      return {
        data: reviewShape(c, n, {
          id,
          author: name,
          body: b.body,
          createdAt: new Date().toISOString(),
          verdict,
          headOid: await resolve(index, (item as Pull).head),
        }),
      }
    }
    if (id === 'mergePull') {
      const head = await resolve(index, (item as Pull).head)
      if (b.sha && b.sha !== head)
        throw new ApiError(409, 'Head SHA does not match')
      await s.writes.queue(owner, repo, n, name)
      return {
        data: {
          sha: null,
          merged: false,
          queued: true,
          message:
            'Pull request enqueued on the gild merge queue; merge is asynchronous',
        },
      }
    }
    if (id === 'pullChanges' || id === 'pullFiles') {
      const p = item as Pull,
        [head, base] = await Promise.all([
          resolve(index, p.head),
          resolve(index, p.base),
        ]),
        comp = await comparison(index, base, head),
        change = await changes(index, comp.mergeBase, head)
      return id === 'pullChanges'
        ? { data: change }
        : paginate(await files(c, index, change), c)
    }
    throw new ApiError(404, 'Not Found')
  }
  async function reconcile(c: Context): Promise<Result | null> {
    if (!c.operationId || !recoverableMetadataRoutes.has(c.route.id)) return null
    const index = await s.index(c.params.owner, c.params.repo)
    if (!index) return null
    const saved = await index.metaFile(metadataOperationPath(c.operationId))
    if (!saved) return null
    const { result, data } = JSON.parse(saved)
    if (c.route.id === 'createIssue') return { data: issueShape(c, result as Issue) }
    if (c.route.id === 'createPull') {
      // A number alone cannot reconstruct creation after branches/PRs change.
      return data ? { data } : null
    }
    const number = Number(c.params.number)
    if (c.route.id === 'createIssueComment') {
      const found = await index.metaItem(number, 'issue') ?? await index.metaItem(number, 'pr')
      const comment = found?.comments.find((c: Comment) => c.id === result)
      return comment ? { data: commentShape(c, number, comment) } : null
    }
    const comment = result as InlineComment
    return { data: { ...commentShape(c, number, comment), path: comment.path, line: comment.line, side: comment.side, commit_id: comment.commit_id } }
  }
  return {
    authorize,
    execute,
    reconcile,
    readAccess: async (
      principal: import('../../engine/api/scopes.js').Principal,
      owner: string,
      repo: string,
      operation?:string,
      request?:Request,
    ): Promise<'public' | 'private'> => {
      // Actions, Agents and Score: contributors only, read as a private repository.
      if (request && contributorPath(new URL(request.url)) && !['runner', 'registration'].includes(principal.name)) {
        if (operation && preparedRepositoryOperation(operation)) {
          if (!s.readModels) throw new PreparationPending()
          const access = await s.readModels.repositoryAccess(principal, owner, repo)
          if (!access.contributor) throw new ApiError(404, 'Repository not found')
          preparedAccess.set(request, access)
        } else if (!(await mayContribute(s, owner, repo, principal.name || null)))
          throw new ApiError(404, 'Repository not found')
        return 'private'
      }
      if(operation&&preparedRepositoryOperation(operation)){
        if(!s.readModels)throw new PreparationPending()
        const access=await s.readModels.repositoryAccess(principal,owner,repo)
        if(request)preparedAccess.set(request,access)
        return access.private?'private':'public'
      }
      // Runner credentials are separately validated and restricted to runner RPCs.
      if(principal.id.startsWith('import:'))return 'private'
      if (['runner', 'registration'].includes(principal.name)) return 'public'
      const policy = await repoAccess(s, owner, repo)
      if (
        !policy ||
        !(await mayRead(s, owner, repo, principal.name || null, policy))
      )
        throw new ApiError(404, 'Repository not found')
      if (policy.pending || privateAcl(policy.acl)) {
        if (
          !hasScope(principal, 'repo:read') ||
          !permitsRepo(principal, owner, repo)
        )
          throw new ApiError(404, 'Repository not found')
        return 'private'
      }
      return 'public'
    },
  }
}
