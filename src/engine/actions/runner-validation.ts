import { ApiError } from '../api/errors.js'
import {runnerRegistration,runnerGroup,groupInput} from '../api/runner-contract.js'
export {runnerRegistration,runnerGroup,groupInput}
export function validateRunner(data: unknown) {
  const result = runnerRegistration.safeParse(data)
  if (!result.success) throw new ApiError(422, 'invalid runner name, OS, arch or labels')
  return result.data
}
export function validateGroup(data: unknown, patch: boolean) {
  const result = (patch ? groupInput.partial() : groupInput).safeParse(data)
  if (!result.success) throw new ApiError(422, 'Invalid runner group body')
  return result.data
}
