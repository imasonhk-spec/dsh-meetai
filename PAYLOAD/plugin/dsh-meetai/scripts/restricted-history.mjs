import {safeHistoricalQaDisplay} from './next-qa/index.mjs'
const error=(code,status)=>Object.assign(new Error(code),{code,status})
export function validateRestrictedHistory(rows){
 if(!Array.isArray(rows)||rows.some(row=>!row||typeof row!=='object'||!/^qa_[0-9]{8}_[a-f0-9]{8}$/.test(row.session_id||'')||row.qa_mode!=='restricted-v1'||!(/^(?:all|meeting:[A-Za-z0-9_-]{1,80})$/.test(row.scope||''))||!Array.isArray(row.messages)))throw error('QA_HISTORY_UNREADABLE',503)
 return rows
}
function display(value){return safeHistoricalQaDisplay(typeof value==='string'?value:'').text}
export function restrictedHistoryView(row,detail=false){
 const result={session_id:row.session_id,title:display(row.title),scope:row.scope,created_at:row.created_at,updated_at:row.updated_at,messageCount:row.messages.length}
 if(detail)result.messages=row.messages.filter(message=>message&&['user','assistant'].includes(message.role)).map(message=>{
  if(message.role==='user')return{role:'user',content:typeof message.content==='string'?message.content:'',created_at:message.created_at}
  const content=display(message.content),approved=message.displayApproved===true&&content===message.content&&/^[a-f0-9-]{36}$/.test(message.qaTurnId||'')
  const sources=approved&&Array.isArray(message.sources)?message.sources.filter(source=>/^S(?:[1-9]|1[0-2])$/.test(source?.id||'')).slice(0,12).map((source,index)=>({id:source.id,index:index+1,title:display(source.title),label:display(source.title),quote:display(source.quote),text:display(source.quote)})):[]
  return{role:'assistant',content,created_at:message.created_at,displayApproved:approved,qaTurnId:approved?message.qaTurnId:null,queryScope:row.scope,sources}
 })
 return result
}
