import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownerNameAvailable } from '../../dist/engine/backend-names.js'
import { publicPageRoute } from '../../dist/engine/public-page-route.js'

test('site pages are not owners: nobody can claim them and they are never served as a profile', () => {
  for (const name of ['download', 'brand', 'docs']) {
    assert.equal(ownerNameAvailable(name), false, name)
    assert.equal(publicPageRoute(new URL(`https://gild.gg/${name}`)), null, name)
  }
  assert.equal(ownerNameAvailable('downloads-team'), true)
  assert.equal(publicPageRoute(new URL('https://gild.gg/sami'))?.owner, 'sami')
})
