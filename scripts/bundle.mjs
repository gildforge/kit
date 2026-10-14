// Prebuild the Worker an install uploads: wrangler bundles dist/server/worker.js
// exactly as `wrangler deploy -c template/wrangler.jsonc` would, into
// template/worker/, and manifest.json restates template/wrangler.jsonc for the
// installer (src/install), so both deploy paths read one description.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'

const out = 'template/worker'
rmSync(out, { recursive: true, force: true })
execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', 'worker', '-c', 'template/wrangler.jsonc'], { stdio: 'inherit' })
// wrangler writes the modules beside the config (template/worker) and its
// README against the working directory; neither README ships.
rmSync(`${out}/README.md`, { force: true })
rmSync('worker', { recursive: true, force: true })
for (const f of readdirSync(out)) if (f.endsWith('.map')) rmSync(`${out}/${f}`)

const jsonc = readFileSync('template/wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')
const w = JSON.parse(jsonc)
const files = readdirSync(out).sort()
const manifest = {
  name: w.name,
  main: 'worker.js',
  modules: files.filter(f => f.endsWith('.js') || f.endsWith('.wasm')).map(f => ({ name: f, type: f.endsWith('.wasm') ? 'wasm' : 'esm' })),
  compatibility_date: w.compatibility_date,
  compatibility_flags: w.compatibility_flags ?? [],
  limits: w.limits,
  vars: w.vars ?? {},
  r2_buckets: w.r2_buckets ?? [],
  d1_databases: (w.d1_databases ?? []).map(d => ({
    binding: d.binding, database_name: d.database_name, migrations_dir: d.migrations_dir,
    migrations: readdirSync(`template/${d.migrations_dir}`).filter(f => f.endsWith('.sql')).sort(),
  })),
  durable_objects: w.durable_objects?.bindings ?? [],
  migrations: w.migrations ?? [],
  queues: { producers: w.queues?.producers ?? [], consumers: w.queues?.consumers ?? [] },
  crons: w.triggers?.crons ?? [],
}
if (!files.includes('worker.js')) throw new Error('wrangler wrote no worker.js')
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n')
console.log(`template/worker: ${manifest.modules.map(m => m.name).join(', ')}`)
