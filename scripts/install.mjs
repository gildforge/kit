// Install (or upgrade) gild into a Cloudflare account from a terminal, the
// same steps gild desktop runs:
//   CLOUDFLARE_API_TOKEN=… node scripts/install.mjs <account-id> <owner> <email> [name]
// The owner key is ~/.ssh/id_ed25519.pub. Prints the instance URL; the owner
// token goes to the file named by GILD_TOKEN_FILE (default: not saved).
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { install } from '../dist/install/index.js'

const [accountId, ownerName, email, name] = process.argv.slice(2)
const token = process.env.CLOUDFLARE_API_TOKEN
if (!token || !accountId || !ownerName || !email) {
  console.error('usage: CLOUDFLARE_API_TOKEN=… node scripts/install.mjs <account-id> <owner> <email> [name]')
  process.exit(2)
}
const root = new URL('../template/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('worker/manifest.json', root), 'utf8'))
const result = await install({
  token, accountId, name,
  owner: { name: ownerName, email, publicKey: readFileSync(`${homedir()}/.ssh/id_ed25519.pub`, 'utf8') },
  template: { manifest, read: async path => readFileSync(new URL(path, root)) },
  fetch,
  onProgress: p => console.log(`${p.state === 'done' ? '✓' : '…'} ${p.step}${p.detail ? `: ${p.detail}` : ''}`),
})
if (process.env.GILD_TOKEN_FILE) writeFileSync(process.env.GILD_TOKEN_FILE, result.token + '\n', { mode: 0o600 })
console.log(result.url)
