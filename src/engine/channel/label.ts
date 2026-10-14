import type { ChannelState } from './state.js'
/** Pure presentation; schema validation stays on the API boundary. */
export function stateLabel(state: ChannelState) {
  if (state.status === 'waiting') return '◐ waiting'
  if (state.status === 'busy' || state.status === 'tool_start')
    return '● busy' + (state.tool ? ` · ${state.tool}` : '')
  if (['idle', 'tool_end', 'ended'].includes(state.status)) return '○ idle'
  return '○ unknown'
}
