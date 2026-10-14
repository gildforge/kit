import { runnerPool } from '../actions/pool-service.js'
import { actionHandler } from './actions.js'
import { runQueue, dispatch, actionEnv } from '../actions/service.js'
import { mayWrite } from '../access.js'
export const apiActions = actionHandler({
  inheritedRunners: async (owner, repo) =>
    (await (await runnerPool(owner)).overview(`${owner}/${repo}`)).runners,
  runQueue,
  dispatch,
  actionEnv,
  mayWrite,
})
