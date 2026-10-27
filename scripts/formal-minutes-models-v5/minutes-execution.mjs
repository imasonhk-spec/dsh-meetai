import {createHash} from 'node:crypto'
import {classifyMinutesRoute} from './minutes-route-policy.mjs'
import {createHostAdapter} from './llm-adapter-huiwen.mjs'
import {openLocalMinutesOwner} from './local-minutes-owner.mjs'
const issued=new WeakMap()
const fail=code=>Object.assign(new Error(code),{code})
export async function assertMinutesExecution(binding,adapter,signal,source){
  const record=binding&&issued.get(binding)
  if(!record||record.adapter!==adapter)throw fail('MINUTES_BINDING_REQUIRED')
  if(adapter.complete!==record.complete||adapter.identity?.provider!==record.route.provider||adapter.identity?.model!==record.route.model||adapter.fingerprint!==record.fingerprint)throw fail('MINUTES_BINDING_CHANGED')
  if(source!==undefined&&record.sourceSha256&&createHash('sha256').update(source).digest('hex')!==record.sourceSha256)throw fail('SOURCE_BINDING_FAILED')
  if(record.owner)await record.owner.assertCurrent(signal)
  signal?.throwIfAborted()
  return record.route
}
export async function prepareMinutesExecution(selection,llm,{signal,admissionHome,hostContext,sourceSha256,templateSha256=''}={}){
  const plan=classifyMinutesRoute(selection);signal?.throwIfAborted()
  if(plan.execution!=='grounded')return Object.freeze({plan,adapter:null,binding:null})
  let owner,adapter
  try{
    if(plan.operationalAdmissionRequired){
      if(!hostContext||!llm)throw fail('LOCAL_MINUTES_HOST_REQUIRED')
      owner=await openLocalMinutesOwner({ctx:hostContext,home:admissionHome,selection:plan.route,sourceSha256,templateSha256,signal})
      adapter=Object.freeze({identity:owner.identity,fingerprint:owner.fingerprint,complete:options=>owner.complete(owner.ticket,options)})
    }else adapter=await createHostAdapter(llm,plan.route,{signal,expectedModel:plan.route.model})
    if(adapter.identity?.provider!==plan.route.provider||adapter.identity?.model!==plan.route.model)throw fail('MINUTES_BINDING_CHANGED')
    const binding=Object.freeze({role:'minutes',provider:plan.route.provider,model:plan.route.model})
    issued.set(binding,{adapter,route:plan.route,complete:adapter.complete,fingerprint:adapter.fingerprint,owner,sourceSha256})
    return Object.freeze({plan,adapter,binding,assertCurrent:activeSignal=>assertMinutesExecution(binding,adapter,activeSignal),close:async()=>{await owner?.close()}})
  }catch(error){await owner?.close();throw error}
}
