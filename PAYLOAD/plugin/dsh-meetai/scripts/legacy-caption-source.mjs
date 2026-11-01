// Read-only legacy caption leaf. No media/ASR runner, writes, lifecycle, model or
// store/QA authorization replacement. A pure manifest is not producer attestation.
import path from 'node:path'
import * as fs from 'node:fs/promises'
import {constants} from 'node:fs'
import {createHash} from 'node:crypto'
import {readAsrSentenceManifest} from './asr-sentence-manifest.mjs'
const digest=value=>createHash('sha256').update(value).digest('hex')
const fail=(code,status=409)=>Object.assign(new Error(code),{code,status})
const HASH=/^[a-f0-9]{64}$/
const AUDIO_EXT=new Set(['mp3','m4a','wav','aac','ogg','webm','amr','flac'])
export function captionCanonical(value,depth=0){
 if(depth>64)throw fail('LEGACY_RECORD_INVALID')
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value)
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value)
 if(Array.isArray(value))return '['+value.map(item=>captionCanonical(item,depth+1)).join(',')+']'
 if(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+captionCanonical(value[key],depth+1)).join(',')+'}'
 throw fail('LEGACY_RECORD_INVALID')
}
const fingerprint=value=>digest(captionCanonical(value))
export async function snapshotLegacyCaptionAudio(root,record){
 if(!path.isAbsolute(root)||!/^rec_[A-Za-z0-9_-]{1,120}$/.test(record.recording_id)||!AUDIO_EXT.has(record.ext)||!HASH.test(record.sha256)||!Number.isSafeInteger(record.size_bytes)||record.size_bytes<1||record.size_bytes>500*1024*1024)throw fail('LEGACY_AUDIO_METADATA_UNBOUND')
 const directory=path.join(root,'recordings','files'),file=path.join(directory,record.recording_id+'.'+record.ext)
 let handle
 try{
  const parent=await fs.lstat(directory)
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid()||(parent.mode&0o022)||await fs.realpath(directory)!==path.resolve(directory))throw fail('LEGACY_AUDIO_STORAGE_UNSAFE')
  handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
  const before=await handle.stat({bigint:true})
  if(!before.isFile()||before.nlink!==1n||before.uid!==BigInt(process.getuid())||(before.mode&0o022n)||before.size!==BigInt(record.size_bytes))throw fail('LEGACY_AUDIO_STORAGE_UNSAFE')
  const sha=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))sha.update(chunk)
  const after=await handle.stat({bigint:true})
  if(['dev','ino','size','mtimeNs','ctimeNs'].some(key=>before[key]!==after[key]))throw fail('LEGACY_AUDIO_CHANGED')
  const sha256=sha.digest('hex');if(sha256!==record.sha256)throw fail('LEGACY_AUDIO_IDENTITY_MISMATCH')
  return {dev:String(before.dev),ino:String(before.ino),size:String(before.size),sha256}
 }catch(error){if(error.status)throw error;throw fail('LEGACY_AUDIO_VERIFY_FAILED')}finally{await handle?.close()}
}
export function legacyCaptionMetadata(source){
 return {id:source.id,transcriptVersionId:source.id,meetingId:source.meetingId,legacyRecordingId:source.legacyRecordingId,audioRevisionId:null,revision:null,sourceSha256:source.sourceSha256,audioSha256:source.audioSha256,manifestSha256:source.manifestSha256,sourceAudioFingerprint:source.sourceAudioFingerprint,state:source.state,timingLevel:'sentence',timingProvenance:source.timingProvenance,timingsAvailable:source.timingsAvailable,timingsUnavailableReason:source.timingsUnavailableReason,reviewRequired:true,accuracyVerified:false}
}
export function createLegacyCaptionReader({root,loadRecordings,authorizeMeeting}){
 const permits=new WeakMap()
 async function read(record,expectedMeetingId){
  const serialized=captionCanonical(record),r=JSON.parse(serialized),key='legacy_'+r.recording_id,recordFingerprint=digest(serialized)
  if(typeof r.recording_id!=='string'||!r.meeting_id||expectedMeetingId&&r.meeting_id!==expectedMeetingId)throw fail('NOT_FOUND',404)
  await authorizeMeeting(r.meeting_id)
  const value=typeof r.transcript==='string'?r.transcript:r.transcript?.text
  const source={id:key,meetingId:r.meeting_id,legacyRecordingId:r.recording_id,audioRevisionId:null,revision:null,audioSha256:HASH.test(r.sha256)?r.sha256:null,sourceSha256:typeof value==='string'?digest(value):null,manifestSha256:null,sourceAudioFingerprint:null,state:'ready_with_review',timingsAvailable:false,timingsUnavailableReason:r.transcript_sentence_unavailable_reason||'MANIFEST_MISSING',timingLevel:'sentence',timingProvenance:'unavailable',reviewRequired:true,accuracyVerified:false,text:typeof value==='string'?value:'',cues:[]}
  let audio=null
  if(r.transcript_sentence_manifest!=null){
   if(r.transcript_origin!=='akun-offline'||!HASH.test(r.sha256)||r.transcript_audio_sha256!==r.sha256)throw fail('LEGACY_PROVIDER_METADATA_UNBOUND')
   const timing=readAsrSentenceManifest(r.transcript_sentence_manifest,{transcript:value,audioSha256:r.sha256})
   if(!timing.available)throw fail('TIMING_INTEGRITY')
   audio=await snapshotLegacyCaptionAudio(root,r)
   if(r.transcript_sentence_audio_fingerprint!=null&&fingerprint(r.transcript_sentence_audio_fingerprint)!==fingerprint(audio))throw fail('LEGACY_AUDIO_IDENTITY_MISMATCH')
   const manifest=timing.manifest
   source.timingsAvailable=true;source.timingsUnavailableReason=null;source.manifestSha256=manifest.manifestSha256;source.sourceAudioFingerprint=audio;source.timingProvenance=manifest.timingProvenance
   source.cues=manifest.sentences.map(row=>({id:key+'_line_'+row.index,transcriptVersionId:key,recordingId:r.recording_id,rootRecordingId:r.recording_id,startMs:row.startMs,endMs:row.endMs,text:row.text,speakerId:row.speakerId,timingProvenance:manifest.timingProvenance,quality:'review_required',accuracyVerified:false,wordTimingsAvailable:false}))
  }
  permits.set(source,{record:r,fingerprint:recordFingerprint,audio})
  await assertCurrent([source]);return source
 }
 async function assertCurrent(sources){
  if(!sources.length)return
  const records=await loadRecordings()
  for(const source of sources){const permit=permits.get(source);if(!permit)throw fail('LEGACY_READ_PROOF_REQUIRED');const fresh=records[permit.record.recording_id];if(!fresh||fingerprint(fresh)!==permit.fingerprint)throw fail('LEGACY_RECORD_CHANGED');await authorizeMeeting(permit.record.meeting_id);if(permit.audio&&fingerprint(await snapshotLegacyCaptionAudio(root,permit.record))!==fingerprint(permit.audio))throw fail('LEGACY_AUDIO_CHANGED')}
  // Authorization/audio awaits cannot hide a concurrent index rebind or metadata
  // update. Compare the entire original record, not just text/audio hashes.
  const final=await loadRecordings()
  for(const source of sources){const permit=permits.get(source),fresh=final[permit.record.recording_id];if(!fresh||fingerprint(fresh)!==permit.fingerprint)throw fail('LEGACY_RECORD_CHANGED')}
 }
 return Object.freeze({read,assertCurrent})
}
export function legacyCaptionSegments(source,url){
 if((url.searchParams.get('level')||'sentence')!=='sentence'||!source.timingsAvailable||!Array.isArray(source.cues)||!source.cues.length)throw fail('TIMING_UNAVAILABLE')
 const required=['meetingId','id','legacyRecordingId','sourceSha256','audioSha256','manifestSha256','audioRevisionId','revision','timingProvenance','sourceAudioFingerprint']
 if(required.some(key=>!Object.hasOwn(source,key))||source.audioRevisionId!==null||source.revision!==null||source.timingProvenance!=='akun-provider-sentence-info-ms'||['sourceSha256','audioSha256','manifestSha256'].some(key=>!HASH.test(source[key])))throw fail('TIMING_INTEGRITY')
 const limit=Number(url.searchParams.get('limit')||50),startMs=Number(url.searchParams.get('startMs')??0),endMs=Number(url.searchParams.get('endMs')??14400000)
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw fail('ASSET_PAGE_LIMIT',400)
 if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||endMs<startMs||endMs>14400000)throw fail('BAD_SEGMENT_QUERY',400)
 const rows=endMs===startMs?[]:source.cues.filter(row=>row.endMs>startMs&&row.startMs<endMs),binding={schemaVersion:1,...Object.fromEntries(required.map(key=>[key,source[key]])),startMs,endMs}
 let offset=0
 if(url.searchParams.has('cursor')){
  let cursor;const raw=url.searchParams.get('cursor')
  try{if(!raw||raw.length>2048||!/^[A-Za-z0-9_-]+$/.test(raw))throw Error();cursor=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'))}catch{throw fail('BAD_SEGMENT_CURSOR',400)}
  if(!cursor||typeof cursor!=='object'||Array.isArray(cursor)||Object.keys(cursor).length!==Object.keys(binding).length+1||Object.keys(binding).some(key=>!Object.hasOwn(cursor,key)||fingerprint(cursor[key])!==fingerprint(binding[key]))||!Number.isSafeInteger(cursor.offset)||cursor.offset<=0||cursor.offset>rows.length)throw fail('BAD_SEGMENT_CURSOR',400)
  offset=cursor.offset
 }
 const items=rows.slice(offset,offset+limit),nextCursor=offset+limit<rows.length?Buffer.from(JSON.stringify({...binding,offset:offset+limit})).toString('base64url'):null
 return {...legacyCaptionMetadata(source),transcriptVersionId:source.id,items,nextCursor}
}
