import { d1Settings } from '../settings-store.js'
import type { D1Database } from '@cloudflare/workers-types'
import type { Values } from '../../engine/actions/workflow.js'
export interface SecretEnv {
  DB: D1Database
  ACTIONS_SECRET_KEY?: string
}
const enc = new TextEncoder()
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
async function key(env: Pick<SecretEnv, 'ACTIONS_SECRET_KEY'>) {
  if (!env.ACTIONS_SECRET_KEY)
    throw new Error(
      'Needs Sami: ACTIONS_SECRET_KEY on gild-site/Worker (32 random bytes, base64)',
    )
  const raw = bytes(env.ACTIONS_SECRET_KEY)
  if (raw.length !== 32)
    throw new Error('ACTIONS_SECRET_KEY must be 32 bytes in base64')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}
export async function encrypt(
  env: Pick<SecretEnv, 'ACTIONS_SECRET_KEY'>,
  aad: string,
  value: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
      await key(env),
      enc.encode(value),
    )
  return `${b64(iv)}.${b64(new Uint8Array(cipher))}`
}
export async function decrypt(
  env: Pick<SecretEnv, 'ACTIONS_SECRET_KEY'>,
  aad: string,
  cipher: string,
) {
  const [iv, data] = cipher.split('.')
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(iv), additionalData: enc.encode(aad) },
      await key(env),
      bytes(data),
    ),
  )
}
export async function putSecret(
  env: SecretEnv,
  repo: string,
  name: string,
  value: string,
) {
  repo = (await d1Settings(env.DB).state(repo)).id
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) || name === 'GITHUB_TOKEN')
    throw new Error('secret name must be uppercase; GITHUB_TOKEN is reserved')
  if (typeof value !== 'string' || !value || enc.encode(value).length > 16_384)
    throw new Error('secret value must contain 1 to 16384 bytes')
  const cipher = await encrypt(env, `${repo}:${name}`, value)
  await env.DB.prepare(
    'INSERT OR REPLACE INTO action_secrets(repo,name,cipher,updated) VALUES (?,?,?,?)',
  )
    .bind(repo, name, cipher, Date.now())
    .run()
}
export async function secretNames(env: SecretEnv, repo: string) {
  repo = (await d1Settings(env.DB).state(repo)).id
  return (
    await env.DB.prepare(
      'SELECT name,updated FROM action_secrets WHERE repo=? ORDER BY name',
    )
      .bind(repo)
      .all<{ name: string; updated: number }>()
  ).results
}
export async function deleteSecret(env: SecretEnv, repo: string, name: string) {
  repo = (await d1Settings(env.DB).state(repo)).id
  await env.DB.prepare('DELETE FROM action_secrets WHERE repo=? AND name=?')
    .bind(repo, name)
    .run()
}
export async function repoSecrets(
  env: SecretEnv,
  repo: string,
): Promise<Values> {
  repo = (await d1Settings(env.DB).state(repo)).id
  const rows = (
    await env.DB.prepare('SELECT name,cipher FROM action_secrets WHERE repo=?')
      .bind(repo)
      .all<{ name: string; cipher: string }>()
  ).results
  return Object.fromEntries(
    await Promise.all(
      rows.map(async (r) => [
        r.name,
        await decrypt(env, `${repo}:${r.name}`, r.cipher),
      ]),
    ),
  )
}
export function maskValues(secrets: Values): string[] {
  // Mask raw values, individual multiline lines and common encodings. No secret
  // values, even mask lists, are persisted unencrypted in the DO.
  return [
    ...new Set(
      Object.values(secrets).flatMap((s) => [
        s,
        ...s.split(/\r?\n/).filter(Boolean),
        encodeURIComponent(s),
        b64(enc.encode(s)),
      ]),
    ),
  ].filter(Boolean)
}
