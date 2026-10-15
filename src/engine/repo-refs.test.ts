import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settleAdvertisedRefs } from '../../dist/engine/repo-refs.js'

const tagObject='8670bac8'.padEnd(40,'0'),peeled='0ae1ffac'.padEnd(40,'0'),pr='0de688f0'.padEnd(40,'0'),main='c1a89c38'.padEnd(40,'0')
const advertised=[
  {ref:'refs/heads/main',oid:main},
  {ref:'refs/tags/v0.1.0',oid:tagObject},
  {ref:'refs/heads/_meta',oid:'b'.repeat(40)},
]

test('an annotated tag pushed as its tag object is settled by the advertisement', () => {
  assert.deepEqual(settleAdvertisedRefs({'v0.1.0':tagObject},advertised),{'v0.1.0':tagObject})
})
test('a ref deleted outside the push path (import cleanup) is settled', () => {
  assert.deepEqual(settleAdvertisedRefs({'import/pr/1':pr},advertised),{'import/pr/1':pr})
})
test('a ref advertised at another oid, and _meta, stay outstanding', () => {
  assert.deepEqual(settleAdvertisedRefs({main:peeled,_meta:'c'.repeat(40)},advertised),{})
})
