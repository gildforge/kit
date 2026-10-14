import { z } from 'zod'
import { sessionState } from '../sessions-contract.js'
export const channelState = sessionState
export type ChannelState = z.output<typeof channelState>
export { stateLabel } from './label.js'
