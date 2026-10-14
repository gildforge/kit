import type { MergePlan } from '../engine/merge-queue-store.js'
import type { D1Database } from '@cloudflare/workers-types'
import type { ChannelBindings } from './channel/binding.js'
import type { MetadataRuntime } from './metastore.js'
import type { RepoIndexRPC } from './repo-index.js'
import { d1Store } from './drivers/d1.js'
import { archiveConnection } from './actions/archive.js'
import type { Event } from '../engine/actions/workflow.js'
import type { Pull } from './pulls.js'
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { listRefs } from './repo-refs-live.js'

export interface MergeRuntime extends MetadataRuntime {
  plan(plan: MergePlan): Promise<void>
  planned(intent: string): Promise<MergePlan[]>
  gate(sha: string): Promise<{ ok: boolean }> | { ok: boolean }
  pushed(update: { ref: string; before: string; sha: string }, pulls: Pick<Pull, 'number'|'head'|'base'|'title'|'author'|'state'>[]): Promise<void>
}
export interface MergeBindings extends ChannelBindings {
  DB: D1Database
  ARTIFACTS_TOKEN?: string
  REPO_INDEX?: { idFromName(name: string): unknown; get(id: unknown): RepoIndexRPC }
}
/** Never obtains/synthesizes Next request context. Tokens remain in memory. */
export async function backgroundMergeRuntime(env: MergeBindings, owner: string, repo: string,
  queue: { gate(sha: string): {ok:boolean}; deliver(event: Event): Promise<void>; planMerge(plan:MergePlan):Promise<void>; plannedMerge(intent:string):MergePlan[] },
): Promise<MergeRuntime> {
  const store = d1Store(env.DB), identity = (await store.settings.state(`${owner}/${repo}`)).id
  if (!env.REPO_INDEX) throw Error('REPO_INDEX binding is required for merge recovery')
  const index = env.REPO_INDEX.get(env.REPO_INDEX.idFromName(identity))
  await index.address(owner, repo)
  const connections = new Map<string, Promise<{token:string;url:string}>>()
  const connection = (scope: 'read' | 'write') => {
    let found = connections.get(scope)
    if (!found) { found = archiveConnection(env, owner, repo, scope); connections.set(scope, found) }
    return found
  }
  return { store, index, channels: env, connection, liveRefs: () => listRefs(owner, repo, { connection, store, DB: env.DB }), gate: sha => queue.gate(sha), plan: plan => queue.planMerge(plan), planned: async intent => queue.plannedMerge(intent),
    pushed: async (update, pulls) => {
      await index.recordPush(`merge:${update.sha}`, [update], 'merge queue')
      await index.refresh(owner, repo)
      await queue.deliver({ name:'push', ...update, actor:'merge queue', title:'', repository:`${owner}/${repo}`,
        key:`push:${update.ref}:${update.before}:${update.sha}` })
      const changed = update.ref.replace(/^refs\/heads\//, '')
      const affected = pulls.filter(p => p.state === 'open' && p.head === changed)
      if (affected.length) {
        const conn = await connection('read')
        const refs = await git.listServerRefs({http,url:conn.url,onAuth:()=>({username:'x',password:conn.token})})
        for (const pull of affected) await queue.deliver({name:'pull_request',sha:update.sha,ref:update.ref,
          headRef:pull.head,baseRef:pull.base,before:refs.find(r=>r.ref===`refs/heads/${pull.base}`)?.oid,
          actor:'merge queue',title:pull.title,repository:`${owner}/${repo}`,action:'synchronize',pull:pull.number,
          key:`pr:${pull.number}:synchronize:${update.sha}`})
      }
    },
  }
}
