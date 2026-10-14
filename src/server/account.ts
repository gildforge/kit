// The Cloudflare account whose Artifacts hold the repositories. An install
// names it in the Worker var CLOUDFLARE_ACCOUNT_ID; gild.gg predates the var.
// One Worker serves one account, so the entry remembers it per isolate and
// code without bindings in hand (Durable Objects, helpers) reads it here.
const KEY = Symbol.for('gild.account')
const CONTEXT = Symbol.for('__cloudflare-context__')
type Global = { [KEY]?: string; [CONTEXT]?: { env?: AccountEnv } }
export interface AccountEnv { CLOUDFLARE_ACCOUNT_ID?: string }

export const GILD_GG_ACCOUNT = '08b93c93f8b7adc43678e9afba31e4ee'

/** Called by a Worker entry (and each Durable Object) with its bindings. */
export function rememberAccount(env: AccountEnv | undefined) {
  if (env?.CLOUDFLARE_ACCOUNT_ID) (globalThis as Global)[KEY] = env.CLOUDFLARE_ACCOUNT_ID
}

export function accountId(env?: AccountEnv): string {
  const g = globalThis as Global
  return env?.CLOUDFLARE_ACCOUNT_ID || g[CONTEXT]?.env?.CLOUDFLARE_ACCOUNT_ID || g[KEY] || GILD_GG_ACCOUNT
}

export const artifactsApi = (env?: AccountEnv) => `https://api.cloudflare.com/client/v4/accounts/${accountId(env)}`
export const artifactsGit = (env?: AccountEnv) => `https://${accountId(env)}.artifacts.cloudflare.net/git`
