import type { AgentRequest } from '../backend.js'
import type { Emission } from '../../engine/api/events-contract.js'
import { common } from './payloads.js'
export function agentEvent(
  request: AgentRequest,
  action: 'opened' | 'approved' | 'denied',
  by: string,
): Emission {
  const { publicKey, tokenIssued, ...safe } = request
  return {
    id: `agent-request:${request.id}:${action}`,
    event: 'agent_request',
    repository: request.repo,
    audience: request.sponsor,
    payload: {
      ...(request.repo ? common(request.repo, by) : {}),
      action,
      agent: `${request.sponsor}/${request.label}`,
      request: safe,
    },
  }
}
