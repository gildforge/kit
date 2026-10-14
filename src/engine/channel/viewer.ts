import type { ChannelParticipant, ChannelPeople } from '../api/channel-contract.js'
/** Add the viewer once, in the same state as permissions and the public roster. */
export function channelViewer(participants:ChannelParticipant[], viewer:string|null, can_post:boolean):ChannelPeople {
  if (viewer && !participants.some(p=>p.name===viewer)) participants=[...participants,{name:viewer,kind:viewer.includes('/')?'agent':'human',prefix:can_post?'+':'',scopes:[],sponsor:null,online:false,state:null} as ChannelParticipant].sort((a,b)=>Number(a.kind==='agent')-Number(b.kind==='agent') || a.name.localeCompare(b.name))
  return {participants,viewer,can_post}
}
