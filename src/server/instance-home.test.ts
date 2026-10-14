import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWithCloudflareContext } from '../../dist/server/context.js'
import { instanceHome } from '../../dist/server/instance-home.js'

const env = { DB: { prepare: () => ({ first: async () => ({ name: 'sami' }) }) } }
const open = (accept: string) => runWithCloudflareContext({ env, ctx: {} } as never, () =>
  instanceHome(new Request('https://gild-sami.example.workers.dev/', { headers: { accept } })))

test('a browser opening an install gets a page that says how to connect to it', async () => {
  const res = await open('text/html,application/xhtml+xml')
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  const html = await res.text()
  assert.match(html, /gild auth token --server https:\/\/gild-sami\.example\.workers\.dev/)
  assert.match(html, /--sponsor sami/)
  assert.match(html, /run by @sami/)
})

test('an API client gets JSON naming the owner and the API', async () => {
  const body = await (await open('application/json')).json()
  assert.deepEqual(body, { gild: true, owner: 'sami', api: 'https://gild-sami.example.workers.dev/api/v1', git: 'https://gild-sami.example.workers.dev/git/<owner>/<repo>.git' })
})
