import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceBytes,SERVER_IMPORT_LIMIT,tooLargeMessage } from '../../../dist/server/import/dispatch.js'

const answer=(body:unknown,ok=true)=>(async(url:string,init?:RequestInit)=>{seen.push({url:String(url),headers:init?.headers as Record<string,string>});return new Response(JSON.stringify(body),{status:ok?200:404})}) as typeof fetch
let seen:{url:string;headers:Record<string,string>}[]=[]

test('a large GitHub source is measured from its API size in kilobytes', async () => {
  seen=[]
  const bytes=await sourceBytes('https://github.com/torvalds/linux',undefined,'t0k',answer({size:5_000_000}))
  assert.equal(bytes,5_000_000*1024)
  assert.ok(bytes!>SERVER_IMPORT_LIMIT)
  assert.equal(seen[0].url,'https://api.github.com/repos/torvalds/linux')
  assert.equal(seen[0].headers.authorization,'Bearer t0k')
  assert.match(tooLargeMessage(bytes!,'sami/linux'),/4\.8 GB.*gild clone sami\/linux$/)
})
test('GitLab statistics are bytes; plain git and failures are unknown', async () => {
  assert.equal(await sourceBytes('https://gitlab.com/a/b',undefined,undefined,answer({statistics:{repository_size:42}})),42)
  assert.equal(await sourceBytes('https://github.com/a/b',undefined,undefined,answer({},false)),null)
  assert.equal(await sourceBytes('https://git.example.com/a/b.git',undefined,undefined,answer({size:1})),null)
})
