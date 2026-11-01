// Sole parent-Host lifecycle slot. No core, worker, grant or endpoint is created here.
// The opener is trusted server code, never request JSON or a client-supplied function.
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code})}
export function createAdminRuntimeOwner({assertActive}={}){
  need(typeof assertActive==='function','ADMIN_RUNTIME_HOST_REQUIRED')
  let phase='idle',opening,owner,closing,unknownOwnership=false,closeAttempted=false,openerInvoked=false
  const lifetime=new AbortController()
  function inspectOwner(value){
    need(value&&typeof value.close==='function'&&typeof value.retryClose==='function'&&typeof value.status==='function','ADMIN_RUNTIME_OWNER_INVALID')
    return value
  }
  function status(){
    return Object.freeze({contract:'admin-runtime-owner/1',phase,unknownOwnership,
      ownerPresent:!!owner,shutdownRequested:lifetime.signal.aborted})
  }
  function retainFailure(error){
    // The real assembly returns ownedRuntime even when startup has failed.
    // Keep that recovery owner; never delete a slot and open a second core.
    if(!owner&&openerInvoked){
      try{owner=inspectOwner(error?.ownedRuntime)}catch{unknownOwnership=true}
    }
    if(error?.reconciliationRequired===true&&!owner)unknownOwnership=true
    if(!lifetime.signal.aborted)phase='open-failed'
  }
  function open(opener){
    assertActive()
    need(typeof opener==='function','ADMIN_RUNTIME_OPENER_REQUIRED')
    need(!lifetime.signal.aborted,'ADMIN_RUNTIME_SHUTTING_DOWN')
    if(phase==='ready')return Promise.resolve(owner)
    if(phase==='opening')return opening
    need(phase==='idle','ADMIN_RUNTIME_RECOVERY_REQUIRED')
    phase='opening'
    opening=Promise.resolve().then(()=>{
      assertActive();lifetime.signal.throwIfAborted()
      openerInvoked=true
      return opener({signal:lifetime.signal})
    }).then(value=>{
      // Retain first, validate second: invalid startup output may still own IO.
      owner=value
      try{inspectOwner(owner)}catch(error){unknownOwnership=true;throw error}
      if(lifetime.signal.aborted)throw Object.assign(new Error('ADMIN_RUNTIME_SHUTTING_DOWN'),{code:'ADMIN_RUNTIME_SHUTTING_DOWN'})
      assertActive();phase='ready';return owner
    }).catch(error=>{retainFailure(error);throw error})
    return opening
  }
  function current(){
    assertActive();need(phase==='ready'&&!lifetime.signal.aborted,'ADMIN_RUNTIME_NOT_READY')
    need(owner.status()?.phase==='ready','ADMIN_NATIVE_RUNTIME_NOT_READY')
    return owner
  }
  function close(){
    if(phase==='closed')return Promise.resolve()
    if(closing)return closing
    phase='closing'
    lifetime.abort(Object.assign(new Error('ADMIN_HOST_SHUTDOWN'),{code:'ADMIN_HOST_SHUTDOWN'}))
    closing=Promise.resolve().then(async()=>{
      if(opening)await opening.catch(()=>{})
      need(!unknownOwnership,'ADMIN_RUNTIME_OWNER_RECONCILIATION_REQUIRED')
      if(owner){
        inspectOwner(owner)
        const retry=closeAttempted||['failed','close-failed'].includes(owner.status()?.phase)
        closeAttempted=true
        await (retry?owner.retryClose():owner.close())
        need(owner.status()?.phase==='closed','ADMIN_RUNTIME_CLOSE_UNPROVEN')
      }
      phase='closed'
    }).catch(error=>{
      phase='close-failed';closing=undefined
      // Failure stays in this slot. Parent cleanup must propagate it, not reopen.
      throw error
    })
    return closing
  }
  return Object.freeze({contract:'admin-runtime-owner/1',open,current,status,close,retryClose:close})
}
