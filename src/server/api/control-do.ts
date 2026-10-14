import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState } from '@cloudflare/workers-types'
import { ApiControlStore } from './control-store.js'
export interface SavedResponse {
  status: number
  body: string
  headers: Record<string, string>
}
// DO RPC methods delegate to the same SQLite implementation tested locally.
export class ApiControl extends DurableObject<unknown> {
  private store: ApiControlStore
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx as never, env)
    this.store = new ApiControlStore(ctx.storage.sql as never)
  }
  reserveObjects(id: string, objects: { hash: string; size: number }[], initial: { hash: string; size: number }[], limit: number) { return this.store.reserveObjects(id, objects, initial, limit) }
  finishObjects(id: string, accepted: boolean) { this.store.finishObjects(id, accepted) }
  rate(now = Date.now(), limit = 10000) { return this.store.rate(now, limit) }
  reserveBytes(id: string, bytes: number, initial: number, limit: number) { return this.store.reserveBytes(id, bytes, initial, limit) }
  releaseBytes(id: string) { this.store.releaseBytes(id) }
  begin(key: string, fingerprint: string) { return this.store.begin(key, fingerprint) }
  activate(key: string, claim: string) { return this.store.activate(key, claim) }
  finish(key: string, claim: string, response: SavedResponse) { this.store.finish(key, claim, response) }
  release(key: string, claim: string) { this.store.release(key, claim) }
}
