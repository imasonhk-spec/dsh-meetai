// Sub-owner for actual failed startup/cleanup. Never opens a core or removes a lock.
// Bootstrap must aggregate this with grant/config/worker owners, not call it a whole runtime.
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code})}
export function createNativeCoreRecovery({core,startupRecovery}={}){
  need(Boolean(core)!==Boolean(startupRecovery),'NATIVE_RECOVERY_ONE_OWNER_REQUIRED')
  if(core)need(['close','retryClose','closeStatus'].every(key=>typeof core[key]==='function'),'NATIVE_CORE_RECOVERY_REQUIRED')
  else need(['retryClose','status'].every(key=>typeof startupRecovery[key]==='function'),'NATIVE_STARTUP_RECOVERY_REQUIRED')
  let phase='retained',closing
  const nativeStatus=()=>core?core.closeStatus():startupRecovery.status()
  function status(){return Object.freeze({contract:'native-core-recovery/1',phase,
    kind:core?'core-close':'startup-close',nativePhase:nativeStatus()?.phase,wholeRuntimeOwner:false})}
  function close(){
    if(phase==='closed')return Promise.resolve()
    if(closing)return closing
    phase='closing'
    closing=Promise.resolve().then(async()=>{
      const native=nativeStatus()
      if(native?.phase!=='closed'){
        if(startupRecovery)await startupRecovery.retryClose()
        else if(native?.phase==='failed')await core.retryClose()
        else await core.close()
      }
      need(nativeStatus()?.phase==='closed','NATIVE_CORE_CLOSE_UNPROVEN')
      phase='closed'
    }).catch(error=>{phase='close-failed';closing=undefined;throw error})
    return closing
  }
  return Object.freeze({contract:'native-core-recovery/1',status,close,retryClose:close})
}
