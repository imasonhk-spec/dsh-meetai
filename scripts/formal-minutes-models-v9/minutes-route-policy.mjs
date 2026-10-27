// User-approved operational minutes policy; never pretends legacy release gates passed.
export const LEGACY_MINUTES_MODEL='huiwen-lm:latest'
export const MAX_MINUTES_MODEL='huiwen-max:latest'
export const LUNA_MINUTES_MODEL='huiwen-luna:latest'
const fail=code=>Object.assign(new Error(code),{code})
function selection(value){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(k=>!['provider','model'].includes(k)))throw fail('MODEL_SELECTION_INVALID')
  const {provider,model}=value
  if(typeof provider!=='string'||typeof model!=='string'||!provider.trim()||!model.trim()||provider.length>256||model.length>256||/[\s\x00-\x1f]/.test(provider.trim())||/[\x00-\x1f]/.test(model)||provider.includes('://')||model.includes('://'))throw fail('MODEL_SELECTION_INVALID')
  return Object.freeze({provider:provider.trim(),model:model.trim()})
}
export function classifyMinutesRoute(value){
  let route=selection(value)
  if(route.provider==='ollama'&&route.model==='occamy-1.0-q5:latest')route=Object.freeze({...route,model:LEGACY_MINUTES_MODEL})
  const lower=route.model.toLowerCase()
  if(lower.startsWith('huiwen-max')&&route.model!==MAX_MINUTES_MODEL||lower.startsWith('huiwen-luna')&&route.model!==LUNA_MINUTES_MODEL)throw fail('MODEL_ID_NOT_CANONICAL')
  if([MAX_MINUTES_MODEL,LUNA_MINUTES_MODEL].includes(route.model)){
    if(route.provider==='gufo-local') return Object.freeze({role:'minutes',execution:'existing-explicit',route,operationalAdmissionRequired:false,admissionPolicy:'gufo-local-direct/1'})
    if(route.provider==='gufo-local') return Object.freeze({role:'minutes',execution:'existing-explicit',route,operationalAdmissionRequired:false,admissionPolicy:'gufo-local-direct/1'})
    if(route.provider!=='ollama')throw fail('LOCAL_MINUTES_MODEL_REQUIRED')
    return Object.freeze({role:'minutes',execution:'grounded',route,operationalAdmissionRequired:true,admissionPolicy:'local-minutes-operational/1'})
  }
  if(route.model===LEGACY_MINUTES_MODEL)return Object.freeze({role:'minutes',execution:'grounded',route,operationalAdmissionRequired:false})
  return Object.freeze({role:'minutes',execution:'existing-explicit',route,operationalAdmissionRequired:false})
}
