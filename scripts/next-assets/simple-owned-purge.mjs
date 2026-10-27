import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
const valid=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)
const error=code=>Object.assign(new Error(code),{code,status:409})
function strings(value,out=new Set()){if(typeof value==='string')out.add(value);else if(value&&typeof value==='object')for(const v of Object.values(value))strings(v,out);return out}
// Host-only: caller uses the already-open journal, never a second writer.
export function createOwnedPurge({journal,artifactRoot}) {
 async function plan(meetingId){
  if(!valid(meetingId))throw error('MEETING_ID_INVALID')
  const entries=await journal.history(),rows=new Map(),byId=new Map(),selected=new Set(),retained=new Map()
  for(const entry of entries)for(const op of entry.ops){if(op.delete)continue;const key=op.type+'/'+op.id;if(!rows.has(key))rows.set(key,[]);rows.get(key).push(op.value);if(!byId.has(op.id))byId.set(op.id,new Set());byId.get(op.id).add(key);if(op.value.meetingId===meetingId)selected.add(key)}
  const keep=(key,reason)=>retained.set(key,reason)
  for(const key of selected)if(rows.get(key).some(v=>v.meetingId!==meetingId||(v.retainedMeetingIds?.length)))keep(key,'历史归属共享或不明')
  const references=new Map(),artifactNativeReferences=new Map()
  for(const [key,versions]of rows){const refs=new Set();for(const value of versions)for(const id of strings(value))for(const target of byId.get(id)||[])if(target!==key)refs.add(target);references.set(key,refs)}
  // Inspect JSON artifact manifests as well as nested journal relation fields.
  for(const [key,versions]of rows)if(key.startsWith('artifacts/')){
   const id=key.slice(10);if(!/^art_[a-f0-9]{32}$/.test(id)){if(selected.has(key))keep(key,'产物标识不明');continue}
   const file=path.join(artifactRoot,id+'.data');let st;try{st=await fs.lstat(file)}catch(e){if(e.code==='ENOENT')continue;throw e}
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1){if(selected.has(key))keep(key,'非专属普通文件');continue}
   if(st.size<=16*1024*1024){const bytes=await fs.readFile(file);if(/^[\s]*[\[{]/.test(bytes.toString('utf8',0,80))){let value;try{value=JSON.parse(bytes.toString('utf8'))}catch{if(versions.some(v=>/json|manifest/.test(v.kind||'')))for(const target of selected)keep(target,'存在无法解析的产物引用，归属待核实');continue}artifactNativeReferences.set(key,strings(value));for(const ref of artifactNativeReferences.get(key))for(const target of byId.get(ref)||[])if(target!==key)references.get(key).add(target)}}
  }
  // Foreign historical references retain their target and its whole dependency closure.
  const queue=[...rows.keys()].filter(key=>!selected.has(key)||retained.has(key)),seen=new Set(queue)
  for(let i=0;i<queue.length;i++)for(const target of references.get(queue[i])||[]){if(selected.has(target))keep(target,'其他历史记录引用或共享依赖');if(!seen.has(target)){seen.add(target);queue.push(target)}}
  for(const job of journal.values('jobs'))if(job.meetingId===meetingId&&!['completed','failed','cancelled','succeeded','done'].includes(job.state))throw error('MEETING_WORKSPACE_JOB_ACTIVE')
  const keys=new Set([...selected].filter(key=>!retained.has(key))),artifacts=[]
  for(const key of keys)if(key.startsWith('artifacts/')){
   const id=key.slice(10),versions=rows.get(key),first=versions[0]
   if(!versions.every(v=>v.bytes===first.bytes&&v.sha256===first.sha256)||!Number.isSafeInteger(first.bytes)||first.bytes<0||!/^[a-f0-9]{64}$/.test(first.sha256||''))throw error('MEETING_ARTIFACT_HISTORY_INVALID')
   artifacts.push({id,bytes:first.bytes,sha256:first.sha256})
  }
  const nativeReferences=new Set()
  for(const [key,versions]of rows)if(!keys.has(key)){
   for(const value of versions)strings(value,nativeReferences)
   for(const ref of artifactNativeReferences.get(key)||[])nativeReferences.add(ref)
  }
  return {entries,keys,artifacts,nativeReferences:[...nativeReferences],retained:[...retained].map(([file,reason])=>({file:'workspace-v1/'+file,reason}))}
 }
 async function proof(artifact){
  const file=path.join(artifactRoot,artifact.id+'.data');let st;try{st=await fs.lstat(file)}catch(e){if(e.code==='ENOENT')return null;throw e}
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==artifact.bytes)throw error('MEETING_ARTIFACT_FILE_CHANGED')
  const handle=await fs.open(file,'r');try{const opened=await handle.stat();if(opened.ino!==st.ino||opened.dev!==st.dev)throw error('MEETING_ARTIFACT_FILE_CHANGED');const hash=createHash('sha256');for await(const bytes of handle.createReadStream({autoClose:false}))hash.update(bytes);if(hash.digest('hex')!==artifact.sha256)throw error('MEETING_ARTIFACT_HASH_CHANGED')}finally{await handle.close()}
  return {file,st}
 }
 return {
  nativeReferences:meetingId=>journal.serial(async()=>(await plan(meetingId)).nativeReferences),
  inspect:meetingId=>journal.serial(async()=>{const p=await plan(meetingId);for(const artifact of p.artifacts)await proof(artifact);return {retained:p.retained,count:p.keys.size}}),
  remove:meetingId=>journal.serial(async()=>{
   const p=await plan(meetingId),removed=[]
   try{for(const artifact of p.artifacts){const verified=await proof(artifact);if(!verified)continue;const now=await fs.lstat(verified.file),before=verified.st;if(now.ino!==before.ino||now.dev!==before.dev||now.size!==before.size||now.mtimeMs!==before.mtimeMs||now.ctimeMs!==before.ctimeMs)throw error('MEETING_ARTIFACT_FILE_CHANGED');await fs.unlink(verified.file);removed.push('workspace-v1/artifacts/'+artifact.id+'.data')}
    if(p.keys.size)await journal.purgeHistory(p.entries,p.keys)
    return {removed,retained:p.retained}
   }catch(e){e.cleanupReceipt={removed,retained:p.retained};throw e}
  })
 }
}
