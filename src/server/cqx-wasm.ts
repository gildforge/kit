// Core coordinates one shared layout and one final, line-weighted score.
// C-family parsers live exclusively in gild-cqx-heavy, reached lazily via RPC.
import { BUILD, checked, loadModule, snapshot, type HeavyBinding, type HeavySession, type SourceFile } from './cqx-module.js'
import { moduleFor } from '../engine/cqx-reads.js'
import { heavyWithinLimits, type CFamilyIssue } from './cqx-heavy-limits.js'
export { BUILD } from './cqx-module.js'

export * from '../engine/cqx-report.js'
import { scoreUnavailable, type Report } from '../engine/cqx-report.js'

declare global { var __cqxWasm: WebAssembly.Module | undefined }

let compiled: Promise<WebAssembly.Module> | null = null
function wasmModule() {
  if (globalThis.__cqxWasm) return Promise.resolve(globalThis.__cqxWasm)
  compiled ??= (async () => {
    const { readFile } = await import('node:fs/promises')
    return WebAssembly.compile(await readFile(new URL('../../cqx/core.wasm', import.meta.url)))
  })()
  return compiled
}

async function heavyBinding(): Promise<HeavyBinding> {
  const { getCloudflareContext } = await import('./context.js')
  const { env } = await getCloudflareContext()
  const binding = (env as unknown as { CQX_HEAVY?: HeavyBinding }).CQX_HEAVY
  if (!binding) throw new Error('cqx: CQX_HEAVY service binding is required for C/C++/C#')
  return binding
}

/** Mirrors the release loader's phases; remote instances keep their parsed
 * trees until quoting is complete. No C-family WASM enters the main bundle. */
export async function scoreFiles(files: SourceFile[], config: string | null, label: string, heavy?: HeavyBinding, omittedHeavy?: CFamilyIssue): Promise<Report> {
  const normalized = new Map<string, string>()
  for (const f of files) normalized.set(f.path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, ''), f.text)
  const all = [...normalized].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, text]) => ({ path, text }))
  const foreign = all.filter(f => moduleFor(f.path) !== 'core')
  const selected = (['c', 'csharp'] as const).filter(id => foreign.some(f => moduleFor(f.path) === id))
  if (omittedHeavy) return partial(omittedHeavy)
  if (!heavyWithinLimits(foreign)) return partial('c-family-too-large')
  async function partial(reason: CFamilyIssue): Promise<Report> {
    // Start afresh: no partially gathered or emitted foreign trees survive.
    let report: Report
    try {
      report = await scoreFiles(all.filter(f => moduleFor(f.path) === 'core'), config, label)
    } catch (error) {
      if (!/no Cargo\.toml/.test((error as Error).message)) throw error
      report = scoreUnavailable()
    }
    return { ...(report.lines > 0 ? report : scoreUnavailable()), calibrated: config !== null, incomplete: reason }
  }
  class HeavyFailure extends Error {}
  async function remote<T>(call: () => Promise<T>): Promise<T> {
    try { return await call() } catch { throw new HeavyFailure() }
  }
  const core = loadModule(await wasmModule(), 'core')
  // Empty foreign sources retain header dialect and implicit target discovery.
  snapshot(core, label, all.map(f => ({ ...f, text: moduleFor(f.path) === 'core' ? f.text : '' })))
  const metadata = checked(core.call('cqx_manifests'), 'manifests')
  snapshot(core, label, all.filter(f => moduleFor(f.path) === 'core'))
  const sessions: HeavySession[] = []
  try {
    if (selected.length) {
      const binding = heavy ?? await remote(heavyBinding)
      for (const id of selected) sessions.push(await remote(() => binding.open(id, all.filter(f => moduleFor(f.path) === id), label, BUILD)))
    }
    core.api.cqx_merge_reset()
    checked(core.call('cqx_merge_add', checked(core.call('cqx_gather', metadata), 'core gather')), 'core merge')
    for (const session of sessions) checked(core.call('cqx_merge_add', await remote(async () => checked(await session.gather(metadata), 'heavy gather'))), 'heavy merge')
    const shared = checked(core.call('cqx_merge_done'), 'resolve')
    core.api.cqx_fold_reset()
    checked(core.call('cqx_fold_add', checked(core.call('cqx_emit', shared), 'core emit')), 'core fold')
    for (const session of sessions) checked(core.call('cqx_fold_add', await remote(async () => checked(await session.emit(shared), 'heavy emit'))), 'heavy fold')
    const finalized = JSON.parse(checked(core.call('cqx_finalize', label, config ?? ''), 'score'))
    let json = checked(core.call('cqx_quote', finalized.report_json), 'core quote')
    for (const session of sessions) json = await remote(async () => checked(await session.quote(json), 'heavy quote'))
    const parsed = JSON.parse(json)
    return { lines: parsed.lines, scores: parsed.scores, rules: parsed.rules, languages: parsed.languages, calibrated: config !== null }
  } catch (error) {
    if (!(error instanceof HeavyFailure)) throw error
    return partial('c-family-unavailable')
  } finally {
    // Disposal must not hide either a report or the original failure.
    for (const session of sessions) {
      try { session[Symbol.dispose]() } catch {}
    }
  }
}
