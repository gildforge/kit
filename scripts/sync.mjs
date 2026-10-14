// Local iteration: build, then copy the package into a consumer's
// node_modules exactly as an install would lay it out (no symlink, so
// bundlers and path-keyed class names behave as they do with a release).
//   npm run sync -- ../site
import { execFileSync } from 'node:child_process'
import { cpSync, rmSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
const site = process.argv[2]
if (!site) throw new Error('usage: npm run sync -- <consumer checkout>')
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' })
const into = resolve(site, 'node_modules/@gildforge/kit')
rmSync(into, { recursive: true, force: true }); mkdirSync(into, { recursive: true })
for (const f of ['dist', 'src', 'cqx', 'template', 'package.json', 'README.md', 'LICENSE']) cpSync(f, resolve(into, f), { recursive: true })
console.log('kit synced into', into)
