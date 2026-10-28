// Actual launcher ProfileContext + existing Connection.admit bridge; no new auth provider.
// Account admission is NOT a meeting grant, core context, model permit or bootstrap completion.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpath, lstat } from 'node:fs/promises'
import { createAdminRuntimeOwner } from './admin-runtime-owner.mjs'
import { createAdminNativeRequests } from './admin-native-requests.mjs'
import { createAdminWriterLifecycle } from './admin-writer-lifecycle.mjs'
import { openPrivateHostConfiguration } from '../native-unified/private-host-configuration.mjs'
const HOME='/home/lgsj/.dsh/multi-user/users/admin/home'
const PROFILE=path.join(HOME,'profiles/web')
const HOST=path.join(PROFILE,'node_modules/dsh-meetai/index-huiwen.js')
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code})}
const facts=value=>value&&({name:value.name,home:value.home,dir:value.dir,patchPath:value.patchPath})
const same=(value,captured)=>value&&['name','home','dir','patchPath'].every(key=>value[key]===captured[key])
function service(ctx,name){try{return ctx.get(name)}catch{throw Object.assign(new Error('ADMIN_HOST_SERVICE_UNAVAILABLE'),{code:'ADMIN_HOST_SERVICE_UNAVAILABLE'})}}
async function privateHome(){
  const info=await lstat(HOME)
  need(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&(info.mode&0o077)===0&&await realpath(HOME)===HOME,'ADMIN_HOST_HOME_UNSAFE')
  const profile=await lstat(PROFILE)
  need(profile.isDirectory()&&!profile.isSymbolicLink()&&profile.uid===process.getuid()&&(profile.mode&0o022)===0&&await realpath(PROFILE)===PROFILE,'ADMIN_HOST_PROFILE_UNSAFE')
}
/** Called only by the actual parent Host, with import.meta.url. No incoming data paths.
 * No credentials/config/history body is read and no core/worker/service is booted.
 */
export async function openAdminHostContext({ctx,hostModuleUrl}={}){
  need(ctx&&typeof ctx.get==='function'&&typeof hostModuleUrl==='string','ADMIN_HOST_CONTEXT_REQUIRED')
  let file
  try{const url=new URL(hostModuleUrl);need(url.protocol==='file:','ADMIN_HOST_MODULE_REQUIRED');file=fileURLToPath(url)}catch{throw Object.assign(new Error('ADMIN_HOST_MODULE_REQUIRED'),{code:'ADMIN_HOST_MODULE_REQUIRED'})}
  need(file===HOST&&await realpath(file)===HOST,'ADMIN_HOST_MODULE_REQUIRED')
  const profile=service(ctx,'profileContext'),captured=facts(profile)
  need(captured&&captured.name==='web'&&captured.home===HOME&&captured.dir===PROFILE&&captured.patchPath===path.join(PROFILE,'cordis.patch.yml'),'ADMIN_LAUNCHER_PROFILE_REQUIRED')
  const connection=service(ctx,'connection')
  need(connection&&typeof connection.admit==='function'&&typeof connection.requestRejection==='function'&&connection.operator&&typeof connection.operator.id==='string'&&connection.operator.id.length>0,'ADMIN_ACTUAL_CONNECTION_REQUIRED')
  // UID alone is not business authority. Account scope also requires launcher-owned facts,
  // the owning module path and the actual Connection's authenticated operator Peer.
  await privateHome()
  const operator=connection.operator,operatorId=operator.id,recorded=Object.freeze({...captured})
  const admissions=new WeakMap()
  let phase='open',closing,requests
  const runtimeOwner=createAdminRuntimeOwner({assertActive:active})
  const configurationOwner=createAdminRuntimeOwner({assertActive:active})
  const writers=createAdminWriterLifecycle({assertActive:active})
  function active(){
    need(phase==='open','ADMIN_HOST_CONTEXT_CLOSED')
    const actualProfile=service(ctx,'profileContext'),actual=service(ctx,'connection')
    need(actualProfile===profile&&same(facts(actualProfile),recorded),'ADMIN_LAUNCHER_PROFILE_CHANGED')
    need(actual?.operator===operator&&actual.operator.id===operatorId&&typeof actual.admit==='function'&&typeof actual.requestRejection==='function','ADMIN_HOST_CONNECTION_CHANGED')
    return actual
  }
  function authenticated(request){
    const actual=active()
    const result=actual.admit(request)
    need(result?.peer===operator&&result.peer.id===operatorId,'ADMIN_REQUEST_AUTH_DENIED')
    return result.peer
  }
  function mutationOrigin(request){
    need(request?.headers&&request.headers['sec-fetch-site']!=='cross-site'&&typeof request.headers.origin==='string'&&typeof request.headers.host==='string','ADMIN_REQUEST_ORIGIN_REQUIRED')
    let origin
    try{origin=new URL(request.headers.origin)}catch{need(false,'ADMIN_REQUEST_ORIGIN_REQUIRED')}
    need(['http:','https:'].includes(origin.protocol)&&origin.origin===request.headers.origin&&origin.host===request.headers.host,'ADMIN_REQUEST_ORIGIN_CONFLICT')
  }
  function admit(request,{mutation=false,signal}={}){
    signal?.throwIfAborted()
    authenticated(request)
    writers.assertAdmission()
    if(mutation)mutationOrigin(request)
    const capability=Object.freeze({accountId:'admin',profileDirectory:PROFILE,operatorId})
    admissions.set(capability,{request,mutation,signal})
    return capability
  }
  function assertAdmission(capability,request){
    const saved=capability&&admissions.get(capability)
    need(saved&&saved.request===request,'ADMIN_REQUEST_CAPABILITY_REQUIRED')
    saved.signal?.throwIfAborted()
    authenticated(request)
    if(saved.mutation)mutationOrigin(request)
    return true
  }
  function nativeInputs(capability,request){
    assertAdmission(capability,request)
    // Only native server code consumes this transport object. It is not a public DTO.
    return Object.freeze({connection:active(),request,operator,home:HOME,profileDirectory:PROFILE})
  }
  async function privateConfiguration(capability,request){
    assertAdmission(capability,request)
    need(admissions.get(capability)?.mutation===true,'ADMIN_CONFIGURATION_MUTATION_ADMISSION_REQUIRED')
    const inputs=nativeInputs(capability,request)
    const owner=await configurationOwner.open(({signal})=>openPrivateHostConfiguration({
      file:path.join(PROFILE,'meeting-unified.json'),home:inputs.home,
      profileDirectory:inputs.profileDirectory,operator:inputs.operator,signal
    }))
    assertAdmission(capability,request)
    await owner.assertCurrent()
    assertAdmission(capability,request)
    return owner
  }
  const api=Object.freeze({contract:'admin-host-account-connection/1',admit,assertAdmission,nativeInputs,
    assertActive:active,
    // Internal server lifecycle only. Account admission does not grant meeting/model access.
    runtimeOwner,privateConfiguration,writers,
    get nativeRequests(){active();return requests??=createAdminNativeRequests({hostContext:api})},
    information:Object.freeze({accountId:'admin',profileDirectory:PROFILE,accountOnly:true,meetingGrantsIssued:false,coreOpened:false,workerStarted:false}),
    close(){
      if(phase==='closed')return Promise.resolve()
      if(closing)return closing
      phase='closing'
      closing=Promise.allSettled([runtimeOwner.close(),writers.close()]).then(results=>{
        const errors=results.filter(row=>row.status==='rejected').map(row=>row.reason)
        if(errors.length)throw new AggregateError(errors,'ADMIN_RUNTIME_WRITER_CLOSE_INCOMPLETE')
        return configurationOwner.close()
      }).then(()=>{phase='closed'}).catch(error=>{
        phase='close-failed';closing=undefined;throw error
      })
      return closing
    }
  })
  return api
}
