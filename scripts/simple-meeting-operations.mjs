// One owner per mounted admin host. Not a multi-user workflow or editor lease.
export function createMeetingOperations() {
 const active=new Map(),deleting=new Set(),deleted=new Set()
 const error=(code)=>Object.assign(new Error(code),{code,status:409})
 const valid=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)
 function assertOpen(id){if(!valid(id))throw error('MEETING_ID_INVALID');if(deleting.has(id)||deleted.has(id))throw error('MEETING_DELETING_OR_DELETED')}
 function enter(id,kind){assertOpen(id);const token=Symbol(kind);if(!active.has(id))active.set(id,new Map());active.get(id).set(token,kind);let closed=false;return ()=>{if(closed)return;closed=true;const slots=active.get(id);slots?.delete(token);if(!slots?.size)active.delete(id)}}
 function activities(id){return [...(active.get(id)?.values()||[])]}
 function assertIdle(id){if(activities(id).length)throw error('MEETING_ACTIVE')}
 async function remove(id,perform){assertOpen(id);assertIdle(id);deleting.add(id);try{const result=await perform();if(result?.ok!==true||result.meetingId!==id)throw error('MEETING_DELETE_RESULT_INVALID');deleted.add(id);return result}finally{deleting.delete(id)}}
 return Object.freeze({enter,assertOpen,assertIdle,activities,remove})
}
// Reuses launcher-bound profile and native Connection authentication. Caller
// supplies actual ctx services, never HTTP body identity, role or data root.
export async function requireAdminDelete({ctx,request,home}) {
 const deny=(code,status)=>{throw Object.assign(new Error(code),{code,status})}
 let profile,connection
 try{profile=ctx.get('profileContext');connection=ctx.get('connection')}catch{deny('ADMIN_AUTH_UNAVAILABLE',503)}
 if(profile?.home!==home||home!=='/home/lgsj/.dsh/multi-user/users/admin/home'||profile.name!=='web')deny('ADMIN_REQUIRED',403)
 if(typeof connection?.requestRejection!=='function'||typeof connection.admit!=='function'||!connection.operator)deny('ADMIN_AUTH_UNAVAILABLE',503)
 const rejection=await connection.requestRejection(request)
 if(rejection!==undefined)deny('ADMIN_AUTH_REQUIRED',rejection===403?403:401)
 const admission=connection.admit(request)
 if(admission?.peer!==connection.operator)deny('ADMIN_AUTH_REQUIRED',403)
 if(request.headers?.['sec-fetch-site']==='cross-site')deny('ADMIN_ORIGIN_FORBIDDEN',403)
 if(request.headers?.origin){let origin;try{origin=new URL(request.headers.origin)}catch{deny('ADMIN_ORIGIN_FORBIDDEN',403)}if(!['http:','https:'].includes(origin.protocol)||origin.host!==request.headers.host)deny('ADMIN_ORIGIN_FORBIDDEN',403)}
 return {account:'admin'}
}
