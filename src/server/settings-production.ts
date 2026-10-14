import { d1Store } from './drivers/d1.js'
import * as git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import { getCloudflareContext } from './context.js'
import { store } from './backend.js'
import {
  nsFor,
  rawRepo,
  rawToken,
  rawRemote,
  rawListRepos,
} from './artifacts.js'
import { mirrorGit } from '../engine/git-mirror.js'
import { hub } from './events/emit.js'
import { settingsService, type LifecycleTransport } from './settings.js'
import type { Context } from './api/dispatch.js'
export async function lifecycleTransport(bindings?: {
  DB: import('@cloudflare/workers-types').D1Database
}): Promise<LifecycleTransport> {
  const st = bindings
    ? (await import('./drivers/d1.js')).d1Store(bindings.DB)
    : await store()
  const physical = async (key: string) => {
    const [owner, repo] = key.split('/')
    const kind =
      (await st.getOrg(await st.settings.canonical(owner))) ||
      (await st.orgMembers(await st.settings.canonical(owner))).length
        ? 'org'
        : 'user'
    return { ns: nsFor(owner, kind), repo }
  }
  const env = bindings ?? (await getCloudflareContext()).env
  const credential = (env as unknown as { ARTIFACTS_TOKEN?: string })
    .ARTIFACTS_TOKEN
  return {
    async renderSettings(key) {
      const ns = (
        env as unknown as {
          REPO_INDEX: {
            idFromName(id: string): unknown
            get(id: unknown): { renderSettings(): Promise<void> }
          }
        }
      ).REPO_INDEX
      await ns
        .get(ns.idFromName((await st.settings.state(key)).id))
        .renderSettings()
    },
    async branches(owner, repo) {
      const p = await physical(`${owner}/${repo}`),
        token = await rawToken(p.ns, p.repo, 'read', credential)
      return (
        await git.listServerRefs({
          http,
          url: rawRemote(p.ns, p.repo),
          onAuth: () => ({
            username: 'x',
            password: token.plaintext.split('?')[0],
          }),
        })
      )
        .filter(
          (r) =>
            r.ref.startsWith('refs/heads/') && r.ref !== 'refs/heads/_meta',
        )
        .map((r) => r.ref.slice(11))
    },
    async defaultBranch(key, branch) {
      const ns = (
        env as unknown as {
          REPO_INDEX: {
            idFromName(id: string): unknown
            get(id: unknown): { defaultBranch(branch: string): Promise<void> }
          }
        }
      ).REPO_INDEX
      await ns
        .get(ns.idFromName((await st.settings.state(key)).id))
        .defaultBranch(branch)
    },
    async resumeRename(id) {
      const ns = (
        env as unknown as {
          SETTINGS_RENAME: {
            idFromName(id: string): unknown
            get(id: unknown): { wake(id: string): Promise<void> }
          }
        }
      ).SETTINGS_RENAME
      await ns.get(ns.idFromName(id)).wake(id)
    },
    async startRename(job) {
      const ns = (
        env as unknown as {
          SETTINGS_RENAME: {
            idFromName(id: string): unknown
            get(id: unknown): {
              start(job: import('./settings-rename.js').RenameJob): Promise<void>
            }
          }
        }
      ).SETTINGS_RENAME
      await ns.get(ns.idFromName(job.id)).start(job)
    },
    list: async (owner) =>
      rawListRepos(
        nsFor(owner, (await st.getOrg(owner)) ? 'org' : 'user'),
        credential,
      ),
    exists: async (owner, repo) => {
      const p = await physical(`${owner}/${repo}`)
      return rawRepo(p.ns, p.repo, 'GET', undefined, credential)
    },
    async copy(from, to) {
      const source = await physical(from),
        [owner, repo] = to.split('/'),
        target = {
          ns: nsFor(
            owner,
            (await st.getOrg(from.split('/')[0])) ? 'org' : 'user',
          ),
          repo,
        }
      const info = await rawRepo(
        source.ns,
        source.repo,
        'GET',
        undefined,
        credential,
      )
      await rawRepo(
        target.ns,
        target.repo,
        'POST',
        {
          name: repo,
          description: info.description,
          default_branch: info.default_branch,
        },
        credential,
      )
      try {
        await mirrorGit(
          rawRemote(source.ns, source.repo),
          rawRemote(target.ns, target.repo),
          (await rawToken(source.ns, source.repo, 'read', credential))
            .plaintext,
          (await rawToken(target.ns, target.repo, 'write', credential))
            .plaintext,
        )
      } catch (e) {
        await rawRepo(target.ns, target.repo, 'DELETE', undefined, credential)
        throw e
      }
    },
    async rebind(key, id) {
      const env = bindings ?? (await getCloudflareContext()).env,
        e = env as unknown as {
          REPO_INDEX: {
            idFromName(s: string): unknown
            get(id: unknown): {
              address(owner: string, repo: string): Promise<void>
            }
          }
          RUN_QUEUE: {
            idFromName(s: string): unknown
            get(id: unknown): {
              init(owner: string, repo: string): Promise<void>
            }
          }
        }
      const [owner, repo] = key.split('/')
      await e.REPO_INDEX.get(e.REPO_INDEX.idFromName(id)).address(owner, repo)
      await e.RUN_QUEUE.get(e.RUN_QUEUE.idFromName(id)).init(owner, repo)
      const imports=(env as unknown as {REPO_IMPORT?:{idFromName(s:string):unknown;get(id:unknown):{address(key:string):Promise<void>}}}).REPO_IMPORT
      await imports?.get(imports.idFromName(id)).address(key)
    },
    async suspend(_key, id) {
      const env = bindings ?? (await getCloudflareContext()).env,
        ns = (
          env as unknown as {
            RUN_QUEUE: {
              idFromName(s: string): unknown
              get(id: unknown): { suspend(): Promise<void> }
            }
          }
        ).RUN_QUEUE
      await ns.get(ns.idFromName(id)).suspend()
      const imports=(env as unknown as {REPO_IMPORT?:{idFromName(s:string):unknown;get(id:unknown):{suspend():Promise<void>}}}).REPO_IMPORT
      await imports?.get(imports.idFromName(id)).suspend()
    },
    async discard(key, org) {
      const [owner, repo] = key.split('/'),
        credential = (
          bindings as unknown as { ARTIFACTS_TOKEN?: string } | undefined
        )?.ARTIFACTS_TOKEN
      await rawRepo(
        nsFor(owner, org ? 'org' : 'user'),
        repo,
        'DELETE',
        undefined,
        credential,
      ).catch((e) => {
        if (!/not found/i.test(String(e))) throw e
      })
    },
    async renameHooks(from, to) {
      const env = bindings ?? (await getCloudflareContext()).env,
        ns = (
          env as unknown as {
            RUNNER_POOL?: {
              idFromName(s: string): unknown
              get(id: unknown): {
                renameScope(from: string, to: string): Promise<void>
              }
            }
          }
        ).RUNNER_POOL,
        owner = from.split('/')[0],
        id = (
          await d1Store(
            (
              env as unknown as {
                DB: import('@cloudflare/workers-types').D1Database
              }
            ).DB,
          ).settings.state(owner)
        ).id
      await ns?.get(ns.idFromName(id)).renameScope(from, to)
      await (
        bindings
          ? (await import('./events/binding.js')).hubFrom(bindings as never)
          : await hub()
      ).renameScope(from, to)
    },
    async purge(key, id) {
      const env = bindings ?? (await getCloudflareContext()).env,
        e = env as unknown as {
          DB: import('@cloudflare/workers-types').D1Database
          REPO_INDEX: {
            idFromName(s: string): unknown
            get(id: unknown): { purge(): Promise<void> }
          }
          RUN_QUEUE: {
            idFromName(s: string): unknown
            get(id: unknown): { purge(): Promise<void> }
          }
        }
      if (!key.includes('/')) {
        const ns = (
          env as unknown as {
            RUNNER_POOL?: {
              idFromName(s: string): unknown
              get(id: unknown): { purge(): Promise<void> }
            }
          }
        ).RUNNER_POOL
        await ns?.get(ns.idFromName(id)).purge()
      }
      if (key.includes('/')) {
        const p = await physical(key)
        await rawRepo(
          p.ns,
          p.repo,
          'DELETE',
          undefined,
          (env as unknown as { ARTIFACTS_TOKEN?: string }).ARTIFACTS_TOKEN,
        ).catch((e) => {
          if (!/not found/i.test(String(e))) throw e
        })
        await e.REPO_INDEX.get(e.REPO_INDEX.idFromName(id)).purge()
        await e.RUN_QUEUE.get(e.RUN_QUEUE.idFromName(id)).purge()
        const search = (env as unknown as { SEARCH_DB?: import('@cloudflare/workers-types').D1Database }).SEARCH_DB
        if (search) await (await import('./search-index.js')).removeSearch(search, id)
        const imports=(env as unknown as {REPO_IMPORT?:{idFromName(s:string):unknown;get(id:unknown):{purge():Promise<void>}}}).REPO_IMPORT
        await imports?.get(imports.idFromName(id)).purge()
        await e.DB.prepare('DELETE FROM action_secrets WHERE repo=?')
          .bind(id)
          .run()
        const logs = (
          env as unknown as {
            ACTION_LOGS?: import('@cloudflare/workers-types').R2Bucket
          }
        ).ACTION_LOGS
        if (logs) {
          let cursor: string | undefined
          do {
            const page = await logs.list({ prefix: id + '/', cursor })
            if (page.objects.length)
              await logs.delete(page.objects.map((o) => o.key))
            cursor = page.truncated ? page.cursor : undefined
          } while (cursor)
        }
        // Cache keys are namespaced by owner/repo; immutable values need no re-key.
        await e.DB.batch([
          e.DB.prepare('DELETE FROM cqx_scores WHERE substr(key,1,?)=?').bind(
            key.length + 1,
            key + '@',
          ),
          e.DB.prepare('DELETE FROM change_cache WHERE instr(key,?)>0').bind(
            ':' + key + ':',
          ),
        ])
      }
      await e.DB.prepare(
        'DELETE FROM api_tokens WHERE EXISTS (SELECT 1 FROM json_each(api_tokens.repos) WHERE value=? COLLATE NOCASE OR (?=1 AND substr(lower(value),1,?)=?))',
      )
        .bind(key, +!key.includes('/'), key.length + 1, key.toLowerCase() + '/')
        .run()
      await (
        bindings
          ? (await import('./events/binding.js')).hubFrom(bindings as never)
          : await hub()
      ).purgeScope(key)
    },
  }
}
export async function settingsHandler(c: Context) {
  return settingsService(await store(), await lifecycleTransport())(c)
}
