// ABI adapter shared by the coordinator and the internal heavy Worker.
import { connect } from '../../cqx/cqx-loader.mjs'
import pin from '../../cqx/integrity.json' with { type: 'json' }
export {BUILD} from './cqx-version.js'
export type ModuleId = 'core' | 'c' | 'csharp'
export type SourceFile = { path: string; text: string }
export type Host = ReturnType<typeof connect>

/** No partial score on an extraction, merge or scoring error. */
export function checked(text: string | undefined, operation: string): string {
  if (text === undefined) throw new Error(`cqx ${operation}: missing output`)
  for (const line of text.split('\n').filter(Boolean)) {
    const item = JSON.parse(line)
    if (item.error || item.t === 'error') throw new Error(`cqx ${operation}: ${item.error ?? item.message}`)
  }
  return text
}

export function loadModule(module: WebAssembly.Module, id: ModuleId): Host {
  const host = connect(new WebAssembly.Instance(module, { cqx: { parsing_total() {}, parsed_one() {} } }))
  const info = JSON.parse(checked(host.call('cqx_module_info'), 'identity'))
  if (info.module !== id || info.version !== pin.version || info.abi_version !== 1)
    throw new Error(`cqx ${id}: binary version/ABI/identity mismatch`)
  return host
}

export function snapshot(host: Host, label: string, files: SourceFile[]) {
  host.call('cqx_reset', label)
  for (const f of files) host.call('cqx_add_file', f.path, f.text)
}

/** One RPC target owns one fresh WASM instance, disposed after the scan. */
export interface HeavySession extends Disposable {
  gather(metadata: string): Promise<string>
  emit(shared: string): Promise<string>
  quote(report: string): Promise<string>
}
export interface HeavyBinding {
  open(id: 'c' | 'csharp', files: SourceFile[], label: string, build: string): Promise<HeavySession>
}
