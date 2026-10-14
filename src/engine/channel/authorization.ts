/** Cache only a successful authorization; concurrent fan-out shares its check.
 * Expiry is checked by the caller on every use. Access events clear this cache.
 */
export const AUTHORIZATION_MS = 5000
export class SocketAuthorization<T extends object> {
  private entries = new WeakMap<T, { until: number; check: Promise<boolean> }>()
  prime(socket:T, now=Date.now()) { this.entries.set(socket,{until:now+AUTHORIZATION_MS,check:Promise.resolve(true)}) }
  clear() { this.entries = new WeakMap() }
  async valid(socket: T, check: () => Promise<boolean>, now = Date.now()) {
    const cached = this.entries.get(socket)
    if (cached && now < cached.until) return cached.check
    const entry = { until: now + AUTHORIZATION_MS, check: Promise.resolve().then(check) }
    this.entries.set(socket, entry)
    try {
      const valid = await entry.check
      if (!valid && this.entries.get(socket) === entry) this.entries.delete(socket)
      return valid
    } catch (error) {
      if (this.entries.get(socket) === entry) this.entries.delete(socket)
      throw error
    }
  }
}
