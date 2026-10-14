import type { ForgeEvents } from './hub-do.js'
import type { Emission } from '../../engine/api/events-contract.js'
export type Hub = {
  [
    K in
      | 'renameScope'
      | 'purgeScope'
      | 'list'
      | 'get'
      | 'create'
      | 'patch'
      | 'remove'
      | 'deliveries'
      | 'delivery'
      | 'redeliver'
      | 'ping'
      | 'emit'
      | 'read'
      | 'sequence'
      | 'attempt'
      | 'deadLetter'
  ]: (
    ...args: Parameters<ForgeEvents[K]>
  ) => Promise<Awaited<ReturnType<ForgeEvents[K]>>>
}
export interface EventBindings {
  EVENTS?: { idFromName(name: string): unknown; get(id: unknown): Hub }
}
export function hubFrom(env: EventBindings) {
  if (!env.EVENTS) throw Error('EVENTS binding is required')
  return env.EVENTS.get(env.EVENTS.idFromName('forge-v1'))
}
export async function emit(event: Emission, env: EventBindings) {
  return hubFrom(env).emit(event)
}
