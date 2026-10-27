// Recovery over actual owners retained by trusted server bootstrap after startup settles.
// No acquisition, inferred credentials, queue, store reopen, stale-lock removal or ready claim.
const held=new WeakSet()
const ORDER=['worker','provider','core-recovery','authority','grant','storage']
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code})}
export function createNativeBootstrapRecovery({owners,unknownOwnership=false}={}){
  need(Array.isArray(owners)&&owners.length>0&&typeof unknownOwnership==='boolean','NATIVE_BOOTSTRAP_ACTUAL_OWNERS_REQUIRED')
  const names=new Set(),identities=new Set()
  const rows=owners.map(row=>{
    need(row&&ORDER.includes(row.kind)&&!names.has(row.kind),'NATIVE_BOOTSTRAP_OWNER_KIND_CONFLICT')
    const owner=row.owner
    need(owner&&['close','retryClose'].every(key=>typeof owner[key]==='function')&&
      (typeof owner.status==='function'||typeof owner.closeStatus==='function'),'NATIVE_BOOTSTRAP_CLOSE_OWNER_REQUIRED')
    need(!identities.has(owner)&&!held.has(owner),'NATIVE_BOOTSTRAP_RECOVERY_OWNER_CONFLICT')
    names.add(row.kind);identities.add(owner)
    return {kind:row.kind,owner,closed:false,attempted:false}
  }).sort((a,b)=>ORDER.indexOf(a.kind)-ORDER.indexOf(b.kind))
  need(!(names.has('provider')&&names.has('core-recovery')),'NATIVE_BOOTSTRAP_CORE_OWNERSHIP_CONFLICT')
  for(const owner of identities)held.add(owner)
  let phase='retained',closing
  const nativeStatus=row=>typeof row.owner.status==='function'?row.owner.status():row.owner.closeStatus()
  function status(){return Object.freeze({contract:'native-bootstrap-recovery/1',phase,unknownOwnership,
    coverage:'supplied-actual-owners-only',ready:false,
    owners:Object.freeze(rows.map(row=>Object.freeze({kind:row.kind,closed:row.closed,attempted:row.attempted})))})}
  function close(){
    if(phase==='closed')return Promise.resolve()
    if(closing)return closing
    phase='closing'
    closing=Promise.resolve().then(async()=>{
      need(!unknownOwnership,'NATIVE_BOOTSTRAP_OWNERSHIP_RECONCILIATION_REQUIRED')
      for(const row of rows){
        if(row.closed)continue
        const native=nativeStatus(row)
        if(native?.phase!=='closed'){
          const retry=row.attempted||['failed','close-failed'].includes(native?.phase)
          row.attempted=true
          await (retry?row.owner.retryClose():row.owner.close())
        }
        need(nativeStatus(row)?.phase==='closed','NATIVE_BOOTSTRAP_CHILD_CLOSE_UNPROVEN')
        row.closed=true
        // Stop at first failure: lower dependency owners remain held for retry.
      }
      phase='closed'
      for(const owner of identities)held.delete(owner)
    }).catch(error=>{phase='close-failed';closing=undefined;throw error})
    return closing
  }
  return Object.freeze({contract:'native-bootstrap-recovery/1',status,close,retryClose:close})
}
