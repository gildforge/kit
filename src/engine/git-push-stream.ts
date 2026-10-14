import { PUSH_BYTES } from './git-limits.js'
import { ApiError } from './api/errors.js'
/** Read only receive-pack's pkt-line command header, then replay it and forward
 * the pack with backpressure. Pack size never determines Worker memory use. */
export async function streamPush(request:Request) {
  if(Number(request.headers.get('content-length'))>PUSH_BYTES) throw new ApiError(413,'Push exceeds the 2 GiB pack limit')
  let stream=request.body
  if(!stream) throw Error('Missing Git push body')
  let transfer=0
  stream=stream.pipeThrough(new TransformStream({transform(chunk,controller){transfer+=chunk.length;if(transfer>PUSH_BYTES)throw new ApiError(413,'Push exceeds the 2 GiB pack limit');controller.enqueue(chunk)}}))
  if((request.headers.get('content-encoding')??'').includes('gzip')) stream=stream.pipeThrough(new DecompressionStream('gzip'))
  const reader=stream.getReader(),prefix:Uint8Array[]=[]
  let pending=new Uint8Array(0),size=0,offset=0,done=false
  const updates:{ref:string;before:string;sha:string}[]=[]
  while(!done) {
    const chunk=await reader.read()
    if(chunk.done) throw Error('Incomplete Git push commands')
    const combined=new Uint8Array(pending.length+chunk.value.length);combined.set(pending);combined.set(chunk.value,pending.length);pending=combined;offset=0
    while(pending.length-offset>=4) {
      const header=new TextDecoder().decode(pending.subarray(offset,offset+4))
      if(!/^[0-9a-f]{4}$/i.test(header)) throw Error('Invalid Git packet header')
      const length=parseInt(header,16)
      if(length===0) {offset+=4;done=true;break}
      if(length<4 || length>65520) throw Error('Invalid Git packet length')
      if(pending.length-offset<length) break
      const command=new TextDecoder().decode(pending.subarray(offset+4,offset+length)).split('\0')[0].trim()
      const match=/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s\0]+)$/.exec(command)
      if(!match) throw Error('Invalid Git ref command')
      updates.push({before:match[1],sha:match[2],ref:match[3]});offset+=length
    }
    if(offset) {prefix.push(pending.slice(0,offset));size+=offset;pending=pending.subarray(offset)}
    if(size+(!done?pending.length:0)>1024*1024) {await reader.cancel();throw Error('Git ref commands exceed 1 MiB')}
  }
  let cursor=0,first=true
  const body=new ReadableStream<Uint8Array>({async pull(controller){
    if(cursor<prefix.length){controller.enqueue(prefix[cursor++]);return}
    if(first){first=false;if(pending.length){controller.enqueue(pending);pending=new Uint8Array(0);return}}
    try{const chunk=await reader.read();if(chunk.done)controller.close();else controller.enqueue(chunk.value)}catch(e){controller.error(e)}
  },cancel(reason){return reader.cancel(reason)}})
  return {refs:updates.map(u=>u.ref),updates,body}
}
