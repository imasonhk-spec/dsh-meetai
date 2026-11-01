// Parent-owned in-flight transport leases. No queue/store/core or IO is created.
// Empty native leases are NOT proof that legacy/editor/ASR/model writers drained.
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code})}
const UNKNOWN=Object.freeze(['LEGACY_HOST_WRITERS_NOT_BOUND','EDITOR_SAVE_WRITERS_NOT_BOUND',
  'ASR_BACKGROUND_WRITERS_NOT_BOUND','NATIVE_BACKGROUND_OWNER_INVENTORY_NOT_BOUND'])
export function createAdminWriterLifecycle({assertActive}={}){
  need(typeof assertActive==='function','ADMIN_WRITER_HOST_REQUIRED')
  let phase='open',next=0,maintenance,closing
  const leases=new Map(),waiters=new Set()
  function active(){assertActive();need(phase==='open','ADMIN_WRITER_ADMISSION_CLOSED')}
  function snapshot(){
    return Object.freeze({contract:'admin-parent-writer-lifecycle/1',phase,
      items:Object.freeze([...leases.values()].map(row=>Object.freeze({id:row.id,
        kind:row.kind,scope:row.scope,state:row.state}))),
      unknowns:UNKNOWN,coverage:'native-request-transports-only',wholeHostQuiescenceProven:false})
  }
  function notify(){if(!leases.size){for(const resolve of waiters)resolve();waiters.clear()}}
  function drain(){return leases.size?new Promise(resolve=>waiters.add(resolve)):Promise.resolve()}
  function begin(kind){
    active();need(kind==='native-request','ADMIN_WRITER_KIND_UNBOUND')
    need(next<Number.MAX_SAFE_INTEGER,'ADMIN_WRITER_ID_EXHAUSTED')
    const token=Object.freeze({}),row={id:++next,kind,scope:null,state:'capturing'}
    leases.set(token,row);return token
  }
  function bind(token,scope){
    const row=leases.get(token)
    need(row&&row.state==='capturing'&&scope?.accountId==='admin'&&
      typeof scope.meetingId==='string'&&Number.isSafeInteger(scope.epoch)&&scope.epoch>0,
      'ADMIN_WRITER_ORIGINAL_SCOPE_REQUIRED')
    row.scope=Object.freeze({accountId:scope.accountId,meetingId:scope.meetingId,epoch:scope.epoch})
    row.state='running'
  }
  function finish(token){need(leases.has(token),'ADMIN_WRITER_LEASE_REQUIRED');leases.delete(token);notify()}
  // Existing transports finish under their original epoch while new captures stop.
  // The callback cannot be used for maintenance writes: remaining owners are UNKNOWN.
  function withMaintenance(operation){
    active();need(typeof operation==='function'&&!maintenance,'ADMIN_MAINTENANCE_CALLBACK_REQUIRED')
    phase='maintenance'
    const task=Promise.resolve().then(async()=>{
      await drain();assertActive();need(phase==='maintenance','ADMIN_MAINTENANCE_INTERRUPTED')
      const observed=snapshot()
      need(observed.unknowns.length===0,'ADMIN_WHOLE_HOST_WRITER_COVERAGE_UNKNOWN')
      return operation(observed)
    })
    maintenance=task
    return task.finally(()=>{if(maintenance===task)maintenance=undefined;if(phase==='maintenance')phase='open'})
  }
  function close(){
    if(phase==='closed')return Promise.resolve()
    if(closing)return closing
    phase='closing'
    // Cancellation belongs to actual runtime/transport owners, not fabricated here.
    closing=Promise.resolve().then(async()=>{
      await drain();if(maintenance)await maintenance.catch(()=>{})
      phase='closed'
    }).catch(error=>{phase='close-failed';closing=undefined;throw error})
    return closing
  }
  return Object.freeze({contract:'admin-parent-writer-lifecycle/1',begin,bind,finish,
    assertAdmission:active,snapshot,withMaintenance,close,retryClose:close})
}
