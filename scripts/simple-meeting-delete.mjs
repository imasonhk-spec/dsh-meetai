import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
const idOK=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v)
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)
const fail=(code,message)=>Object.assign(new Error(message||code),{code})
function strings(value,result=new Set()) {if(typeof value==='string')result.add(value);else if(Array.isArray(value))for(const v of value)strings(v,result);else if(value&&typeof value==='object')for(const v of Object.values(value))strings(v,result);return result}
function wordIDs(rec){const ids=new Set();for(const v of [rec.word_source_artifact,rec.word_content_artifact,rec.word_document?.artifact_id,...(Array.isArray(rec.history)?rec.history.map(h=>h.word_artifact_id):[])])if(v)ids.add(v);return ids}
// Called by the authenticated host while holding its original recording/minutes
// index locks and a target-meeting activity admission lock. No HTTP paths accepted.
export async function deleteSimpleMeeting({root,meetingId,load,saveRecordings,saveMinutes,removeSchedule,assertIdle,extraCleanup=async()=>({removed:[],retained:[]}),unlink=fs.unlink}) {
 if(!path.isAbsolute(root)||!idOK(meetingId))throw fail('MEETING_DELETE_INPUT_INVALID')
 const removed=[],retained=[],pending=new Set();let phase='inventory'
 const keep=(file,reason)=>{if(!retained.some(r=>r.file===file&&r.reason===reason))retained.push({file,reason})}
 try {
  await assertIdle(meetingId)
  const state=await load()
  if(!Array.isArray(state.meetings)||!state.recordings||Array.isArray(state.recordings)||!state.minutes||Array.isArray(state.minutes))throw fail('MEETING_DELETE_INDEX_INVALID')
  if(!state.meetings.some(m=>m.id===meetingId))throw fail('MEETING_NOT_FOUND')
  const recs=Object.entries(state.recordings).filter(([,v])=>v?.meeting_id===meetingId)
  const mins=Object.entries(state.minutes).filter(([,v])=>v?.meeting_id===meetingId)
  const other=[...Object.values(state.recordings),...Object.values(state.minutes),...(state.docs||[])].filter(r=>r?.meeting_id!==meetingId)
  const foreign=strings([other,state.foreignReferences||[]]),files=new Set()
  const add=(relative,refs=[])=>{if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p)){keep(String(relative),'归属路径不明');return}
   if(refs.some(ref=>foreign.has(ref))||foreign.has(relative)){keep(relative,'其他会议引用或归属不明');return}files.add(relative)}
  for(const [id,r]of recs){if(!idOK(id)||r.recording_id!==id||!/^\w{1,12}$/.test(r.ext||'')){keep('recordings/'+id,'录音路径归属不明');continue}add('recordings/files/'+id+'.'+r.ext,[id])}
  const artifactIds=new Set()
  for(const [id,m]of mins){if(!idOK(id)||m.minutes_id!==id)throw fail('MEETING_DELETE_INDEX_INVALID')
   for(const key of ['md_path','meta_path','transcript_path'])if(m[key])add('minutes/'+m[key],[m[key],id])
   for(const word of wordIDs(m)){if(!uuid(word)){keep('word-documents/artifacts/'+word,'Word产物标识不明');continue}if(foreign.has(word)){keep('word-documents/artifacts/'+word,'其他会议引用或归属不明');continue}artifactIds.add(word)}
  }
  async function safeStat(relative){const parts=relative.split('/');let current=root;for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);let stat;try{stat=await fs.lstat(current)}catch(e){if(e.code==='ENOENT')return null;throw e}if(stat.isSymbolicLink()){keep(relative,'符号链接保留');return false}if(i<parts.length-1&&!stat.isDirectory())throw fail('MEETING_DELETE_PATH_INVALID');if(i===parts.length-1)return stat}}
  const rootStat=await fs.lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw fail('MEETING_DELETE_ROOT_INVALID')
  let count=0
  async function collect(relative,depth=0){if(depth>16||++count>10000)throw fail('MEETING_DELETE_INVENTORY_LIMIT');const st=await safeStat(relative);if(!st)return;if(st.isFile()){if(st.nlink!==1){keep(relative,'共享硬链接保留');return}files.add(relative);return}if(!st.isDirectory()){keep(relative,'非普通文件保留');return}for(const entry of await fs.readdir(path.join(root,relative)))await collect(relative+'/'+entry,depth+1)}
  for(const id of artifactIds)await collect('word-documents/artifacts/'+id)
  // The original source-store binds each source to a hashed meeting+recording
  // namespace. Verify that original manifest, never infer ownership from text.
  const hash=text=>createHash('sha256').update(text).digest('hex')
  const namespaces=new Set(['text',...recs.map(([id])=>id),...mins.map(([,m])=>m.recording_id).filter(Boolean)].map(recordingId=>hash('meeting:'+meetingId+'|recording:'+recordingId)))
  const sourceRefs=new Set(mins.map(([,m])=>m.grounding?.sourceId).filter(Boolean))
  const sourceRoot='grounded-minutes/sources',sourceStat=await safeStat(sourceRoot)
  if(sourceStat&&sourceStat.isDirectory())for(const id of await fs.readdir(path.join(root,sourceRoot))){
   if(!/^[a-f0-9]{64}$/.test(id))continue
   const relative=sourceRoot+'/'+id,manifestFile=relative+'/manifest.json',st=await safeStat(manifestFile)
   if(!st||!st.isFile()){if(sourceRefs.has(id))keep(relative,'原文清单缺失，归属不明');continue}
   let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(root,manifestFile),'utf8'))}catch(error){if(sourceRefs.has(id))throw error;continue}
   if(!namespaces.has(manifest.namespaceSha256)){if(sourceRefs.has(id))keep(relative,'原文命名空间归属不明');continue}
   if(hash(JSON.stringify(manifest))!==id)throw fail('MEETING_SOURCE_MANIFEST_INVALID')
   if(foreign.has(id)){keep(relative,'其他会议引用或归属不明');continue}
   await collect(relative)
  }
  // Original chunked uploads keep a committed recording copy in their state.
  const uploadDir=await safeStat('upload-parts')
  if(uploadDir&&uploadDir.isDirectory())for(const name of await fs.readdir(path.join(root,'upload-parts'))){
   if(!/^upl_[a-f0-9]{32}\.json$/.test(name))continue
   const relative='upload-parts/'+name,st=await safeStat(relative);if(!st||!st.isFile())continue
   const upload=JSON.parse(await fs.readFile(path.join(root,relative),'utf8'))
   if(upload.meetingId!==meetingId)continue
   if(!upload.committed)throw fail('MEETING_UPLOAD_ACTIVE','本会议有未完成上传，请先完成或取消上传。')
   add(relative);add('upload-parts/'+name.slice(0,-5)+'.part')
  }
  for(const file of files)pending.add(file)
  phase='files'
  // Keep ownership manifests until all content files have gone, so retry can
  // still identify exclusive source trees after any earlier unlink failure.
  const orderedFiles=[...files].sort((a,b)=>Number(a.endsWith('/manifest.json'))-Number(b.endsWith('/manifest.json')))
  for(const file of orderedFiles){await assertIdle(meetingId);const st=await safeStat(file);if(st===false){pending.delete(file);continue}if(st&&!st.isFile()){keep(file,'非普通文件保留');pending.delete(file);continue}if(st?.nlink!==undefined&&st.nlink!==1){keep(file,'共享硬链接保留');pending.delete(file);continue}if(st){try{await unlink(path.join(root,file))}catch(e){if(e.code!=='ENOENT')throw e}try{await fs.lstat(path.join(root,file));throw fail('MEETING_DELETE_FILE_REMAINS')}catch(e){if(e.code!=='ENOENT')throw e}removed.push(file)}pending.delete(file)}
  // Preserve the schedule until all owned file work and both indexes succeed.
  phase='task-history';pending.add('会议助手资产／任务历史');const extra=await extraCleanup(meetingId);removed.push(...extra.removed);retained.push(...extra.retained);pending.delete('会议助手资产／任务历史')
  phase='indexes';await assertIdle(meetingId)
  const recordings={...state.recordings},minutes={...state.minutes};for(const [id]of recs)delete recordings[id];for(const [id]of mins)delete minutes[id]
  await saveRecordings(recordings);await saveMinutes(minutes)
  phase='schedule';await assertIdle(meetingId);await removeSchedule(meetingId)
  return {ok:true,meetingId,removed,retained,scope:'meeting-assistant-owned',message:retained.length?'会议已删除，以下文件因共享或归属不明予以保留':'会议及对应录音、纪要已删除',excluded:['DSH聊天历史','知识库独立副本','OnlyOffice内部缓存','系统备份','已下载到用户设备的文件']}
 }catch(error){if(error.cleanupReceipt){removed.push(...(error.cleanupReceipt.removed||[]));retained.push(...(error.cleanupReceipt.retained||[]))}throw Object.assign(fail(error.code||'MEETING_DELETE_FAILED','会议删除未完成，请重试；已删除的内容不可恢复。'),{cause:error,status:409,result:{ok:false,meetingId,phase,removed,retained,pending:[...pending],partial:removed.length>0}})}
}
