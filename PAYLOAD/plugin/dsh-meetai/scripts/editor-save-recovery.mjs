import fs from 'node:fs/promises'
import path from 'node:path'
import {constants} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'

const ID=/^save_[a-f0-9]{64}$/
const OPAQUE=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/
const SHA=/^[a-f0-9]{64}$/
const LIMIT=32*1024*1024
const hash=data=>createHash('sha256').update(data).digest('hex')
const bad=(code,status=503)=>Object.assign(new Error('Word保存收据需要核对，原文件已保留。'),{code,status,stage:'editor_recovery',recoveryAction:'inspect_save_receipt'})
async function syncDir(dir){const h=await fs.open(dir,'r');try{await h.sync()}finally{await h.close()}}

/** Account-private durable intent. A receipt ID is NOT an authorization token.
 * No model, template, remote URL or client-selected path enters recovery. */
export function createEditorSaveRecovery({root}={}){
 if(!path.isAbsolute(root))throw bad('WORD_SAVE_RECOVERY_ROOT')
 const directory=path.join(root,'editor-save-recovery-v1'),tails=new Map()
 let accountId
 async function bounds(){
  await fs.mkdir(root,{recursive:true,mode:0o700})
  const real=await fs.realpath(root)
  if(real!==path.resolve(root))throw bad('WORD_SAVE_RECOVERY_UNSAFE')
  accountId=hash(real)
  await fs.mkdir(directory,{recursive:true,mode:0o700});await syncDir(root)
  const s=await fs.lstat(directory)
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)||await fs.realpath(directory)!==directory)throw bad('WORD_SAVE_RECOVERY_UNSAFE')
 }
 function receiptPath(id){if(!ID.test(id||''))throw bad('WORD_SAVE_RECEIPT_INVALID',400);return path.join(directory,id+'.json')}
 function validate(r){
  if(!r||r.schemaVersion!==1||!ID.test(r.receiptId||'')||r.accountId!==accountId||!OPAQUE.test(r.minutesId||'')||!Number.isSafeInteger(r.version)||r.version<2||r.record?.minutes_id!==r.minutesId||r.record?.version!==r.version||r.record?.word_document?.artifact_id!==r.artifactId||!SHA.test(r.docxSha256||'')||!SHA.test(r.contentSha256||'')||hash(r.content)!==r.contentSha256||!Number.isSafeInteger(r.revision)||r.revision<1)throw bad('WORD_SAVE_RECEIPT_CORRUPT')
  return r
 }
 async function load(id){
  await bounds();const file=receiptPath(id)
  let h
  try{
   const s=await fs.lstat(file)
   if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1||s.size>LIMIT)throw bad('WORD_SAVE_RECEIPT_UNSAFE')
   h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await h.stat();if(before.dev!==s.dev||before.ino!==s.ino)throw bad('WORD_SAVE_RECEIPT_UNSAFE')
   const buffer=Buffer.alloc(Math.min(s.size,LIMIT)+1);let length=0
   while(length<buffer.length){const read=await h.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead}
   const after=await h.stat(),current=await fs.lstat(file)
   if(length>LIMIT||length!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs||current.ino!==s.ino||current.dev!==s.dev||current.isSymbolicLink())throw bad('WORD_SAVE_RECEIPT_UNSAFE')
   const bytes=buffer.subarray(0,length)
   let r;try{r=JSON.parse(bytes.toString('utf8'))}catch{throw bad('WORD_SAVE_RECEIPT_CORRUPT')}
   if(r.receiptId!==id)throw bad('WORD_SAVE_RECEIPT_CORRUPT')
   return validate(r)
  }catch(error){if(error.code==='ENOENT')throw bad('WORD_SAVE_RECEIPT_NOT_FOUND',404);throw error}finally{await h?.close()}
 }
 async function persist(record){
  await bounds();validate(record)
  const text=JSON.stringify(record);if(Buffer.byteLength(text)>LIMIT)throw bad('WORD_SAVE_RECEIPT_LIMIT',413)
  const file=receiptPath(record.receiptId),temp=file+'.'+randomUUID()+'.pending';let h
  try{h=await fs.open(temp,'wx',0o600);await h.writeFile(text);await h.sync();await h.close();h=null;await fs.rename(temp,file);await syncDir(directory);return record}
  catch(error){throw Object.assign(bad('WORD_SAVE_RECEIPT_WRITE_UNCERTAIN'),{cause:error})}
  finally{await h?.close().catch(()=>{});await fs.rm(temp,{force:true}).catch(()=>{})}
 }
 async function serial(id,fn){const prior=tails.get(id)||Promise.resolve(),run=prior.catch(()=>{}).then(fn);tails.set(id,run);try{return await run}finally{if(tails.get(id)===run)tails.delete(id)}}
 async function prepare({record,content,previousRecord,previousContent,expectedArtifactId,saveContext={}}){
  await bounds()
  const receiptId='save_'+hash(JSON.stringify([record.minutes_id,record.version,expectedArtifactId,record.word_document?.artifact_id]))
  return serial(receiptId,async()=>{
   let prior;try{prior=await load(receiptId)}catch(error){if(error.code!=='WORD_SAVE_RECEIPT_NOT_FOUND')throw error}
   if(prior){if(prior.contentSha256!==hash(content)||prior.docxSha256!==record.word_document.docx_sha256||prior.sessionId!==(saveContext.sessionId||null)||prior.requestId!==(saveContext.requestId||null))throw bad('WORD_SAVE_RECEIPT_CONFLICT',409);return prior}
   return persist({schemaVersion:1,receiptId,accountId,minutesId:record.minutes_id,meetingId:record.meeting_id||null,version:record.version,artifactId:record.word_document.artifact_id,docxSha256:record.word_document.docx_sha256,contentSha256:hash(content),expectedVersion:record.version-1,expectedArtifactId,sessionId:saveContext.sessionId||null,requestId:saveContext.requestId||null,editEpoch:saveContext.editEpoch??null,record:structuredClone(record),content,previousRecord:structuredClone(previousRecord),previousContent,state:'save_uncertain',wordSaved:false,wordVerified:false,relationshipRecovery:'pending',phase:'intent_prepared',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})
  })
 }
 async function update(id,patch){return serial(id,async()=>{const prior=await load(id);const allowed=['state','wordSaved','wordVerified','relationshipRecovery','phase','lastCode','journalRefs'];if(Object.keys(patch).some(key=>!allowed.includes(key)))throw bad('WORD_SAVE_RECEIPT_PATCH_INVALID',400);return persist({...prior,...patch,revision:prior.revision+1,updatedAt:new Date().toISOString()})})}
 async function list(){await bounds();const names=(await fs.readdir(directory)).filter(name=>ID.test(name.slice(0,-5))&&name.endsWith('.json'));if(names.length>10000)throw bad('WORD_SAVE_RECEIPT_LIMIT');const receipts=[];for(const name of names)receipts.push(await load(name.slice(0,-5)));return receipts.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.receiptId.localeCompare(b.receiptId))}
 function publicReceipt(r){return {schemaVersion:1,receiptId:r.receiptId,state:r.state,wordSaved:r.wordSaved===true,receiptUpdatePending:r.receiptUpdatePending===true,minutesId:r.minutesId,meetingId:r.meetingId,version:r.version,artifactId:r.artifactId,docxSha256:r.docxSha256,contentSha256:r.contentSha256,requestId:r.requestId,editEpoch:r.editEpoch,relationshipRecovery:r.relationshipRecovery,relationshipPending:r.relationshipRecovery!=='complete',retryable:r.state!=='failed'&&(r.relationshipRecovery!=='complete'||r.receiptUpdatePending===true),recoveryAction:r.receiptUpdatePending?'recover_save_receipt':r.state==='save_uncertain'?'reconcile_save_receipt':r.relationshipRecovery==='complete'?'none':'recover_relationships',lastCode:/^[A-Z][A-Z0-9_]{1,80}$/.test(r.lastCode||'')?r.lastCode:undefined}}
 return {prepare,load,update,list,publicReceipt}
}

/** Account-private save coordinator. No LLM or template render in recovery. */
export function createEditorSaveCoordinator(hooks){
 const receipts=createEditorSaveRecovery({root:hooks.root}),tails=new Map()
 const errorCode=e=>/^[A-Z][A-Z0-9_]{1,80}$/.test(e?.code||'')?e.code:'WORD_SAVE_RECOVERY_FAILED'
 async function serial(id,fn){const run=(tails.get(id)||Promise.resolve()).catch(()=>{}).then(fn);tails.set(id,run);try{return await run}finally{if(tails.get(id)===run)tails.delete(id)}}
 async function mark(r,patch){try{return await receipts.update(r.receiptId,patch)}catch(e){return {...r,...patch,state:(patch.wordSaved??r.wordSaved)?'saved_pending_recovery':(patch.state||r.state),lastCode:errorCode(e),receiptUpdatePending:true}}}
 function outcome(r){const saveReceipt=receipts.publicReceipt(r);return {...hooks.minutesPublic(r.record,r.content),saveReceipt,relationshipPending:saveReceipt.relationshipPending}}
 async function authorized(r,id,context){
  const found=await hooks.readMinutesMeta(id)
  if(r.minutesId!==id||!found||(found.rec.meeting_id||null)!==r.meetingId||(r.meetingId&&!(await hooks.loadMeetings()).some(row=>row.id===r.meetingId)))throw bad('WORD_SAVE_RECEIPT_SCOPE',403)
  if(context){
   const strict=r.sessionId===context.sessionId&&r.requestId===(context.requestId||null)&&r.editEpoch===(context.editEpoch??null)
   const pair=(context.boundVersion===r.version&&context.boundArtifactId===r.artifactId)||(context.boundVersion===r.expectedVersion&&context.boundArtifactId===r.expectedArtifactId)
   const rebound=context.allowSessionRebind===true&&typeof context.sessionId==='string'&&pair&&(found.rec.version||1)===context.boundVersion&&found.rec.word_document?.artifact_id===context.boundArtifactId
   if(!strict&&!rebound)throw bad('WORD_SAVE_RECEIPT_SCOPE',403)
  }
  return found
 }
 async function verifyWord(r){const bytes=await hooks.wordRuntime().readDocx(r.artifactId),text=await hooks.wordRuntime().readContent(r.artifactId);if(hash(bytes)!==r.docxSha256||hash(text)!==r.contentSha256||text!==r.content)throw bad('WORD_SAVE_RECEIPT_ARTIFACT_CHANGED',409)}
 async function settle(r,{inspectOnly=false,restoreIndex=false,runtime}={}){
  await verifyWord(r)
  const indexed=await hooks.withIndexLock(async()=>{
   const found=await authorized(r,r.minutesId),current={...found.rec,version:found.rec.version||1}
   if(current.version===r.version){if(current.word_document?.artifact_id!==r.artifactId||current.word_document.docx_sha256!==r.docxSha256||current.word_document.content_sha256!==r.contentSha256||await hooks.readMinutesContent(current)!==r.content)throw bad('WORD_SAVE_RECEIPT_VERSION_CONFLICT',409);return true}
   if(current.version>r.version){if(r.wordSaved||current.history?.some(row=>row.version===r.version&&row.word_artifact_id===r.artifactId))return true;throw bad('WORD_SAVE_RECEIPT_VERSION_CONFLICT',409)}
   if(restoreIndex&&current.version===r.expectedVersion&&current.word_document?.artifact_id===r.expectedArtifactId&&!current.is_archived){found.idx[r.minutesId]=r.record;await hooks.saveMinutesIndex(found.idx);return true}
   return false
  })
  // Inspection never persists a recovery-state transition or mirrors the index.
  if(inspectOnly)return outcome(!indexed?{...r,state:'save_uncertain',wordSaved:false,wordVerified:true,relationshipRecovery:'uncertain',phase:'index_unconfirmed'}:r.relationshipRecovery==='complete'?r:{...r,state:'saved_pending_recovery',wordSaved:true,wordVerified:true,relationshipRecovery:'pending',phase:'word_index_confirmed'})
  if(!indexed)return outcome(await mark(r,{state:'save_uncertain',wordSaved:false,wordVerified:true,relationshipRecovery:'uncertain',phase:'index_unconfirmed'}))
  r=await mark(r,{state:'saved_pending_recovery',wordSaved:true,wordVerified:true,relationshipRecovery:'pending',phase:'word_index_confirmed'})
  if(!r.meetingId)return outcome(await mark(r,{state:'saved',relationshipRecovery:'complete',phase:'complete'}))
  if(inspectOnly)return outcome(r)
  try{
   runtime ||= await hooks.nextRuntime()
   await runtime.store.reconcileUncertain()
   let mirror=await runtime.verifyMinutesMirror(r.record,r.content)
   if(!mirror){
    if(r.previousRecord?.meeting_id&&!await runtime.verifyMinutesMirror(r.previousRecord,r.previousContent))await runtime.registerMinutes(r.previousRecord,r.previousContent)
    await runtime.registerMinutes(r.record,r.content)
    mirror=await runtime.verifyMinutesMirror(r.record,r.content)
   }
   if(!mirror)throw bad('WORD_SAVE_RELATIONSHIP_UNCONFIRMED')
   r=await mark(r,{state:'saved',relationshipRecovery:'complete',phase:'complete',journalRefs:mirror,lastCode:null})
  }catch(e){r=await mark(r,{state:'saved_pending_recovery',wordSaved:true,relationshipRecovery:e.code==='ASSET_COMMIT_UNCERTAIN'||runtime?.store.availability?.uncertain?'uncertain':'pending',phase:'relationship_pending',lastCode:errorCode(e)})}
  return outcome(r)
 }
 async function save(id,{transaction,expectedVersion,expectedArtifactId,saveContext={}}){
  let r,wordCommitted=false,commitAttempted=false,indexed=false
  try{
   await hooks.withIndexLock(async()=>{
    const found=await hooks.readMinutesMeta(id);if(!found)throw bad('WORD_MINUTES_NOT_FOUND',404)
    const {idx,rec}=found
    if(rec.is_archived)throw bad('WORD_MINUTES_ARCHIVED',409)
    if((rec.version||1)!==expectedVersion||rec.word_document?.artifact_id!==expectedArtifactId)throw bad('WORD_EDITOR_VERSION_CONFLICT',409)
    if(!transaction||transaction.document?.source_kind!=='rich-edit'||typeof transaction.content!=='string'||typeof transaction.commit!=='function'||!SHA.test(transaction.document.docx_sha256||'')||transaction.document.content_sha256!==hash(transaction.content))throw bad('WORD_EDITOR_TRANSACTION_INVALID',422)
    const version=(rec.version||1)+1,updatedAt=new Date().toISOString(),artifactId=transaction.document.artifact_id
    const record={...rec,version,source:'edit',updated_at:updatedAt,...(rec.grounding?{grounding:hooks.editedGrounding(rec.grounding)}:{}),word_content_artifact:artifactId,word_document:{...transaction.document,minutes_version:version},history:[...(Array.isArray(rec.history)?rec.history:[]),{version,saved_at:updatedAt,source:'edit',word_artifact_id:artifactId,format:'rich-edit'}].slice(-50)}
    // Prewrite failure MUST stop before any Word/index side effect.
    r=await receipts.prepare({record,content:transaction.content,previousRecord:rec,previousContent:await hooks.readMinutesContent(rec),expectedArtifactId,saveContext})
    commitAttempted=true;await transaction.commit();wordCommitted=true;await verifyWord(r)
    r=await mark(r,{wordVerified:true,phase:'word_committed'})
    idx[id]=record;await hooks.saveMinutesIndex(idx);indexed=true
    r=await mark(r,{state:'saved_pending_recovery',wordSaved:true,phase:'word_index_confirmed',relationshipRecovery:'pending'})
   })
  }catch(e){
   if(!commitAttempted){await transaction?.rollback().catch(()=>{});throw e}
   // Keep actual user bytes, including rename/fsync-uncertain outcomes.
   await transaction?.rollback({retainCommitted:true}).catch(()=>{})
   try{await verifyWord(r);const found=await hooks.readMinutesMeta(id);indexed=found?.rec.version===r.version&&found.rec.word_document?.artifact_id===r.artifactId&&found.rec.word_document.docx_sha256===r.docxSha256&&await hooks.readMinutesContent(found.rec)===r.content}catch{indexed=false}
   r=await mark(r,{state:indexed?'saved_pending_recovery':'save_uncertain',wordSaved:indexed,relationshipRecovery:indexed?'pending':'uncertain',phase:indexed?'word_index_confirmed':'index_unconfirmed',lastCode:errorCode(e)})
   if(!indexed)return outcome(r)
  }
  // Index lock is released before projection: no recursive lock deadlock.
  let runtime
  try{if(r.meetingId)runtime=await hooks.nextRuntime()}catch(e){return outcome(await mark(r,{state:'saved_pending_recovery',wordSaved:true,relationshipRecovery:'pending',lastCode:errorCode(e)}))}
  return serial(r.receiptId,async()=>{try{return await settle(r,{runtime})}catch(e){return outcome(await mark(r,{state:'save_uncertain',wordSaved:false,relationshipRecovery:'uncertain',lastCode:errorCode(e)}))}})
 }
 async function recover(id,{recoveryReceiptId,findSaveReceipt,saveContext,inspectOnly=false,runtime}={}){
  let r
  if(recoveryReceiptId)r=await receipts.load(recoveryReceiptId)
  else if(findSaveReceipt){r=(await receipts.list()).find(row=>row.minutesId===id&&row.sessionId===saveContext?.sessionId&&row.requestId===(saveContext?.requestId||null)&&row.editEpoch===(saveContext?.editEpoch??null));if(!r)return null}
  else throw bad('WORD_SAVE_RECEIPT_INVALID',400)
  await authorized(r,id,saveContext)
  // Resolve a new Host before the receipt lock: startup replay uses this lock too.
  if(!inspectOnly&&!runtime&&r.meetingId){try{runtime=await hooks.nextRuntime()}catch(e){return outcome(await mark(r,{state:r.wordSaved?'saved_pending_recovery':'save_uncertain',relationshipRecovery:'uncertain',lastCode:errorCode(e)}))}}
  return serial(r.receiptId,async()=>{try{return await settle(r,{inspectOnly,restoreIndex:!inspectOnly,runtime})}catch(e){return outcome(await mark(r,{state:'save_uncertain',wordSaved:false,relationshipRecovery:e.status===409?'conflict':'uncertain',lastCode:errorCode(e)}))}})
 }
 async function replay(runtime){for(const r of await receipts.list()){if(r.state==='failed'||r.relationshipRecovery==='complete')continue;try{await authorized(r,r.minutesId);await serial(r.receiptId,()=>settle(r,{runtime,restoreIndex:false}))}catch{}}}
 async function publicReceipts(meetingId){const out=[];for(const r of(await receipts.list()).filter(row=>row.meetingId===meetingId)){try{await authorized(r,r.minutesId);const status=await serial(r.receiptId,()=>settle(r,{inspectOnly:true}));out.push(status.saveReceipt)}catch{}}return out}
 return {save,recover,replay,publicReceipts}
}
