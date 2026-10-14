import type { Context, Result } from './dispatch.js'
import { paginate, paginationOffset } from './dispatch.js'
import { ApiError, requireFound } from '../../engine/api/errors.js'
import {
  sessionInput,
  receiptPayload,
  type Receipt,
} from '../../engine/sessions-contract.js'
import type { Index } from './indexed.js'
import { SHA, resolve } from './indexed.js'
export async function sessionHandler(
  c: Context,
  index: Index,
): Promise<Result> {
  const target = c.params.number
    ? `pull:${c.params.number}`
    : `commit:${c.params.sha}`
  if (c.params.number)
    requireFound(await index.metaItem(Number(c.params.number), 'pr'))
  else {
    if (!SHA.test(c.params.sha))
      throw new ApiError(422, 'Commit session targets require a full SHA')
    await resolve(index, c.params.sha)
  }
  if (c.route.method === 'GET') {
    const { per_page } = c.query,
      offset = paginationOffset(c)
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new ApiError(422, 'Invalid pagination cursor')
    const result = await index.sessionList(target, per_page, offset)
    return paginate(result.receipts, c, result.total, true)
  }
  if (!c.principal.name.includes('/'))
    throw new ApiError(403, 'Session receipts require an agent token')
  const input = sessionInput.parse(c.body)
  if (input.agent && input.agent !== c.principal.name)
    throw new ApiError(403, 'Reported agent must match the authenticated token')
  const id = input.id ?? crypto.randomUUID(),
    previous = await index.sessionGet(id),
    version = previous?.version ?? 0,
    at = new Date().toISOString()
  if (previous?.closed)
    throw new ApiError(409, 'Closed session receipts are immutable')
  const payload = receiptPayload.parse({
      ...input,
      ...(previous?.runtime && !input.runtime ? {runtime:previous.runtime} : {}),
      id,
      agent: c.principal.name,
      repository: `${c.params.owner}/${c.params.repo}`,
      target,
      created_at: previous?.created_at ?? at,
      updated_at: at,
      version: version + 1,
      closed: input.ended_at !== null,
    })
  const receipt: Receipt = { ...payload, reported_by: 'agent' }
  return { data: await index.sessionPut(receipt, version), status: 201 }
}
