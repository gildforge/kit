import type { caller, capabilities, mayWrite } from '../access.js'
import type { actionEnv, dispatch, runQueue } from './service.js'
export interface ActionDependencies {
  caller: typeof caller
  capabilities: typeof capabilities
  mayWrite: typeof mayWrite
  runQueue: typeof runQueue
  actionEnv: typeof actionEnv
  dispatch: typeof dispatch
}
