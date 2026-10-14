// tsc emits the JavaScript and declarations; stylesheets and the ambient
// module declarations are copied beside them, since tsc carries neither.
import { execFileSync } from 'node:child_process'
import { cpSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
rmSync('dist', { recursive: true, force: true })
execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' })
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
for (const f of walk('src')) if (f.endsWith('.css') || f.endsWith('.d.ts')) cpSync(f, f.replace(/^src/, 'dist'))
