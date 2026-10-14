import { getCloudflareContext } from '../context.js'
import { hubFrom, type EventBindings } from './binding.js'
export type { Hub, EventBindings } from './binding.js'
export async function hub() {
  return hubFrom((await getCloudflareContext()).env as unknown as EventBindings)
}
