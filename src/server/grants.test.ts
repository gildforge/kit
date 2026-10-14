import { test } from 'node:test'
import assert from 'node:assert/strict'
import { grantList } from '../../dist/server/access.js'
import { syncCoordinate } from '../../dist/server/orchestrators.js'
import { memoryStore } from '../../dist/server/drivers/memory.js'

test('grants read in today\'s names: queue is merge, unknown ones drop', () => {
  assert.deepEqual(grantList(['pr', 'queue', 'merge', 'admin', 'coordinate']), ['pr', 'merge', 'coordinate'])
  assert.deepEqual(grantList(undefined), [])
})

test('the coordinate grant is what lets an agent launch others, and taking it away takes them too', async () => {
  const st = memoryStore()
  await st.createAgent('sami', 'coordinator', 'ed25519:k', 'sami')
  await syncCoordinate(st, 'sami', 'lab', 'sami/coordinator', true, 'sami')
  const [grant] = await st.orchestratorGrants('sami/coordinator')
  assert.ok(grant, 'coordinate gives the repo grant')
  await syncCoordinate(st, 'sami', 'lab', 'sami/coordinator', true, 'sami')
  assert.equal((await st.orchestratorGrants('sami/coordinator')).length, 1, 'granting twice is one grant')
  const launched = await st.createChildAgent({ requestId: 'r1', human: 'sami', label: 'alpha', publicKey: 'ed25519:a', repo: 'sami/lab', repoId: 'x', grants: ['pr'], note: null, orchestrator: 'sami/coordinator', scope: grant.scope, childLimit: 10 })
  assert.equal(typeof launched, 'object')
  await syncCoordinate(st, 'sami', 'lab', 'sami/coordinator', false, 'sami')
  assert.equal((await st.orchestratorGrants('sami/coordinator')).length, 0)
  assert.ok((await st.getAgent('sami/alpha'))?.revokedAt, 'the agent it launched is revoked with it')
})
