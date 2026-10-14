/** Repoint only the advertised HEAD, for Git v0/v1 and v2 ls-refs. Pack data
 * never enters this function. Physical HEAD can still name the creation branch. */
const packet = (value: string) =>
  (new TextEncoder().encode(value).length + 4).toString(16).padStart(4, '0') + value

/** A HEAD-only v2 query must also return the selected branch's oid so an
 * unborn or differently configured physical HEAD can be advertised. */
export function defaultRefsRequest(body: string, branch: string) {
  const prefix = `ref-prefix refs/heads/${branch}\n`
  if (!body.endsWith('0000') || body.includes(prefix) || !body.includes('ref-prefix HEAD\n')) return body
  return body.slice(0, -4) + packet(prefix) + '0000'
}

export function defaultAdvertisement(body: string, branch: string, protocol: 'v0' | 'v2' = 'v0', internalPrefix?:string) {
  const bytes = new TextEncoder().encode(body),
    decoder = new TextDecoder()
  const packets: { control: string | null; value: string }[] = []
  for (let at = 0; at < bytes.length; ) {
    const prefix = decoder.decode(bytes.subarray(at, at + 4)),
      n = parseInt(prefix, 16)
    if (!/^[a-f0-9]{4}$/i.test(prefix) || (n > 3 && at + n > bytes.length))
      return body
    packets.push({
      control: n <= 3 ? prefix : null,
      value: decoder.decode(bytes.subarray(at + 4, at + (n > 3 ? n : 4))),
    })
    at += n > 3 ? n : 4
  }
  const retainedCapabilities=packets.find(p=>p.value.includes('\0'))?.value.split('\0')[1]
  if(internalPrefix) {
    // Keep capabilities when the first advertised ref is filtered out.
    const capability=retainedCapabilities
    for(let i=packets.length-1;i>=0;i--)if(new RegExp('^[a-f0-9]{40} refs/heads/'+internalPrefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/').test(packets[i].value) || /^([a-f0-9]{40}) refs\/heads\/_meta(?:[\s\0]|$)/.test(packets[i].value))packets.splice(i,1)
    if(capability && !packets.some(p=>p.value.includes('\0'))) {
      const first=packets.find(p=>/^[a-f0-9]{40} /.test(p.value))
      if(first)first.value=first.value.trimEnd()+'\0'+capability
    }
  }
  const oid = packets
    .map(
      ({ value: p }) =>
        new RegExp(
          `^([a-f0-9]{40}) refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|\\0|$)`,
        ).exec(p)?.[1],
    )
    .find(Boolean)
  if (!oid) {
    if(!internalPrefix) return body
    // No source code yet: advertise no default checkout rather than _meta.
    for(let i=packets.length-1;i>=0;i--)if(/^(?:[a-f0-9]{40}|unborn) HEAD(?:[\s\0]|$)/.test(packets[i].value))packets.splice(i,1)
    for(const p of packets)p.value=p.value.replace(/(?:^| )symref=HEAD:[^ \n]+/g,'')
    if(protocol==='v0' && retainedCapabilities && !packets.some(p=>/^[a-f0-9]{40} /.test(p.value))) {
      const caps=retainedCapabilities.replace(/(?:^| )symref=HEAD:[^ \n]+/g,'').trim()
      packets.splice(packets.length-1,0,{control:null,value:`${'0'.repeat(40)} capabilities^{}\0${caps}\n`})
    }
    return packets.map(p=>p.control??packet(p.value)).join('')
  }
  // An import can leave physical HEAD unborn. Git v0 omits HEAD entirely,
  // placing capabilities on the first ref; v2 can advertise an unborn HEAD.
  const v2 = protocol === 'v2'
  const head = packets.find(({ value }) => /^(?:[a-f0-9]{40}|unborn) HEAD(?:[\s\0]|$)/.test(value))
  if (!head) {
    const first = packets.find(({ value }) => /^[a-f0-9]{40} refs\//.test(value))
    if (!first) return body
    const capabilities = first.value.split('\0')[1]?.trimEnd() ?? ''
    if (!v2) first.value = first.value.split('\0')[0].trimEnd() + '\n'
    packets.splice(packets.indexOf(first), 0, {
      control: null,
      value: v2
        ? `${oid} HEAD symref-target:refs/heads/${branch}\n`
        : `${oid} HEAD\0${capabilities.replace(/(?:^| )symref=HEAD:[^ ]+/g, '').trim()} symref=HEAD:refs/heads/${branch}\n`,
    })
  }
  // Preserve control packet types and reconstruct lengths with byte counts.
  return packets
    .map(({ control, value: p }) => {
      if (control) return control
      const value = p
        .replace(/^(?:[a-f0-9]{40}|unborn) HEAD(?=[\s\0]|$)/, oid + ' HEAD')
        .replace(
          /symref=HEAD:refs\/heads\/[^\s\0]+/,
          'symref=HEAD:refs/heads/' + branch,
        )
        .replace(
          /symref-target:refs\/heads\/[^\s\0]+/,
          'symref-target:refs/heads/' + branch,
        )
      return packet(value)
    })
    .join('')
}
