// Parent-only transport to the ACTUAL runtime core and durable authority.
// Definitions only: no imports of a second core, queue, worker or grant store.
const CONTROL='integration_account_control'
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code})}
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value)
const plain=value=>value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype
export function createAdminNativeRequests({hostContext}={}){
  need(hostContext?.contract==='admin-host-account-connection/1'&&
    ['admit','assertAdmission','nativeInputs','assertActive'].every(key=>typeof hostContext[key]==='function')&&
    typeof hostContext.runtimeOwner?.current==='function'&&
    ['begin','bind','finish'].every(key=>typeof hostContext.writers?.[key]==='function'),'ADMIN_NATIVE_HOST_REQUIRED')
  const tickets=new WeakMap()
  function runtime(){
    hostContext.assertActive()
    const value=hostContext.runtimeOwner.current(),control=value.controlContext
    need(value.authority?.contract==='admin-connection-authority/1.0.0'&&
      value.provider?.contract==='unified-core-provider/1.0.0'&&value.provider.core===value.core&&
      control?.accountId==='admin'&&control.meetingId===CONTROL&&id(control.subjectId)&&
      value.authority.accountId==='admin'&&value.authority.subjectId===control.subjectId&&
      ['capture','guardContext','assertContextActive','inspectPrivateContextCredential'].every(key=>typeof value.core?.[key]==='function')&&
      ['issue','authenticate','inspectMeeting'].every(key=>typeof value.authority[key]==='function')&&
      typeof value.withRequest==='function','ADMIN_NATIVE_RUNTIME_CONFLICT')
    value.core.assertContextActive(control)
    return value
  }
  function scopeFor(value,input,control){
    if(control){
      need(input===undefined,'ADMIN_NATIVE_CONTROL_SCOPE_CONFLICT')
      return Object.freeze({accountId:'admin',meetingId:CONTROL,epoch:value.controlContext.epoch})
    }
    need(plain(input)&&Object.keys(input).length===3&&input.accountId==='admin'&&id(input.meetingId)&&
      input.meetingId!==CONTROL&&Number.isSafeInteger(input.epoch)&&input.epoch>0,'ADMIN_NATIVE_ORIGINAL_SCOPE_REQUIRED')
    // A client hint is NOT an epoch refresh. Compare the exact durable scope.
    return Object.freeze({accountId:'admin',meetingId:input.meetingId,epoch:input.epoch})
  }
  function assertScope(value,scope){
    const row=value.authority.inspectMeeting(value.controlContext,scope.meetingId)
    need(row.accountId===scope.accountId&&row.meetingId===scope.meetingId&&row.epoch===scope.epoch&&
      row.allowed===true&&row.fenced===false,'ADMIN_NATIVE_ORIGINAL_SCOPE_STALE')
  }
  function assertSaved(saved){
    hostContext.assertAdmission(saved.admission,saved.request)
    need(runtime()===saved.runtime,'ADMIN_NATIVE_OWNER_CHANGED')
    saved.signal?.throwIfAborted()
    assertScope(saved.runtime,saved.scope)
    saved.runtime.core.assertContextActive(saved.base)
  }
  /** scope/control are set by trusted server routing, not arbitrary request body spread. */
  async function capture(request,{scope,control=false,mutation=false,signal}={}){
    need(typeof control==='boolean'&&typeof mutation==='boolean','ADMIN_NATIVE_ROUTE_INVALID')
    const lease=hostContext.writers.begin('native-request')
    try{
    const admission=hostContext.admit(request,{mutation,signal}),value=runtime()
    const original=scopeFor(value,scope,control)
    assertScope(value,original)
    hostContext.writers.bind(lease,original)
    const credential=value.authority.issue(request,original.meetingId,()=>{
      hostContext.assertAdmission(admission,request);signal?.throwIfAborted()
    })
    const base=await value.core.capture(credential,original.meetingId)
    need(['accountId','meetingId','epoch'].every(key=>base[key]===original[key])&&
      base.subjectId===value.controlContext.subjectId,'ADMIN_NATIVE_CAPTURE_CONFLICT')
    const saved={request,admission,runtime:value,scope:original,base,signal,state:'captured'}
    assertSaved(saved)
    const context=value.core.guardContext(base,()=>assertSaved(saved))
    const ticket=Object.freeze({contract:'admin-native-request-ticket/1'})
    saved.context=context;tickets.set(ticket,saved)
    return ticket
    }finally{hostContext.writers.finish(lease)}
  }
  async function withRequest(ticket,request,operation){
    const saved=tickets.get(ticket)
    need(saved&&saved.request===request&&saved.state==='captured'&&typeof operation==='function','ADMIN_NATIVE_REQUEST_TICKET_REQUIRED')
    // Consume synchronously before any await, including concurrent duplicate dispatch.
    const lease=hostContext.writers.begin('native-request')
    saved.state='running'
    try{
      hostContext.writers.bind(lease,saved.scope)
      assertSaved(saved)
      const identity=await saved.runtime.authority.authenticate(saved.runtime.core.inspectPrivateContextCredential(saved.context))
      assertSaved(saved)
      need(['accountId','meetingId','subjectId'].every(key=>identity[key]===saved.context[key]),'ADMIN_NATIVE_REQUEST_IDENTITY_CONFLICT')
      // Real runtime withRequest installs BOTH broker transport and execution context.
      // Native commit owns final auth/source/CAS checks; no post-commit fake rollback.
      return await saved.runtime.withRequest(request,{context:saved.context,signal:saved.signal},()=>{
        assertSaved(saved)
        return operation({runtime:saved.runtime,context:saved.context,scope:saved.scope,signal:saved.signal})
      })
    }finally{saved.state='settled';tickets.delete(ticket);hostContext.writers.finish(lease)}
  }
  return Object.freeze({contract:'admin-native-request-bridge/1',capture,withRequest})
}
