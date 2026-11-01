import {createVoiceQaInternalHandler} from './voice-meeting-qa.mjs'
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises'
import path from 'node:path'
import {randomUUID,timingSafeEqual} from 'node:crypto'
import {Readable} from 'node:stream'
import {voiceMeetingBusiness} from '../index-minutes-operational-v9.js?operational-minutes-v6'
import {createExternalCaptionSession} from './local-captions.mjs'
import {requireAdminDelete} from './simple-meeting-operations.mjs'

const active=s=>['preparing','recording'].includes(s?.recordingState)
const fail=(code,status=409)=>Object.assign(new Error(code),{code,status})
const copy=x=>JSON.parse(JSON.stringify(x))

/** One admin host owns all browser/voice mutations; no client identity or paths. */
export function createVoiceMeetingController({home,deviceId,device,business}) {
 const file=path.join(home,'meeting-assistant','voice-control.json')
 let state,chain=Promise.resolve(),work;const captionWork=new Map()
 const serial=fn=>{const next=chain.then(fn);chain=next.catch(()=>{});return next}
 async function load(){
  if(state)return state
  let raw
  try{raw=JSON.parse(await readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;raw={version:2,sessions:{},current:null,browserId:null,browserTouched:0,requests:{}}}
  if(raw.version!==2){
   if(active(await device('status')))throw fail('MIGRATION_ACTIVE_WRITER')
   if(raw.browserId||Object.values(raw.sessions||{}).some(row=>active(row)||['importing','unknown'].includes(row.saveState)||['transcribing','generating','unknown'].includes(row.generationState)))throw fail('MIGRATION_ACTIVE_WRITER')
   // No active writers: preserve the exact v1 bytes before the first v2 publication.
   await mkdir(path.dirname(file),{recursive:true,mode:0o700})
   try{await writeFile(file+'.v1-backup',await readFile(file),{mode:0o600,flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}
  }
  raw.version=2;raw.sessions ||= raw.recordings||{};raw.recordings=raw.sessions;raw.activeBySource ||= {};raw.currentByOwner ||= {}
  for(const row of Object.values(raw.sessions)){row.ownerEntry ||= 'huibao';row.sourceKey ||= 'device:'+deviceId;row.deviceId ||= deviceId;row.recordingSessionId ||= row.sessionId}
  if(raw.current)raw.currentByOwner.huibao=raw.current
  state=raw;return state
 }
 async function save(){
  state.recordings=state.sessions;state.activeBySource={}
  for(const row of Object.values(state.sessions))if(active(row))state.activeBySource[row.sourceKey]=row.sessionId
  if(state.browserId)state.activeBySource['browser:default']=state.browserId
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify(state),{mode:0o600});await rename(tmp,file)
 }
 const current=()=>state.sessions[state.current]||null
 async function sync(){
  await load()
  const audio=await device('status')
  if(audio?.sessionId){
   state.current=audio.sessionId
   const old=state.sessions[audio.sessionId]||{saveState:'pending',generationState:'idle',controls:[],captions:[]}
   const saveState=old.saveState
   Object.assign(old,audio,{saveState,ownerEntry:'huibao',sourceKey:'device:'+deviceId,deviceId,recordingSessionId:audio.sessionId});state.currentByOwner.huibao=audio.sessionId
   state.sessions[audio.sessionId]=old
   if(old.pending?.expires<Date.now()){old.pending=null;if(old.generationState==='awaiting_confirmation')old.generationState='idle'}
  }
  return current()
 }
 async function imported(row){
  if(!row||active(row)||!row.savedBytes)return
  if(row.recordingId){row.saveState='saved';return}
  row.saveState='importing';await save()
  try{const result=await business.importRecording(row);row.recordingId=result.recording.recording_id;row.saveState='saved';delete row.saveError}
  catch(e){row.saveState='failed';row.saveError=e.code||'IMPORT_FAILED'}
  await save()
 }
 async function output(reply,row=current()){
  if(reply&&row){row.lastReply=reply;row.controls.push({kind:'control-response',text:reply,at:Date.now()});await save()}
  return {...(row?copy(row):{recordingState:'idle'}),reply}
 }
 function announce(row,text){
  void business.speak(text).then(receipt=>serial(async()=>{
   row.controls.push({kind:'device-announcement',text,at:Date.now(),operationId:receipt?.operation_id||null,playback:'accepted-not-verified'});await save()
  })).catch(e=>serial(async()=>{row.speechError=e.code||'DEVICE_SPEAK_FAILED';await save()}))
 }
 async function executeGeneration(row){
  if(row.generationTaskId||['transcribing','generating','unknown'].includes(row.generationState))return
  row.generationState='transcribing';row.operationId=randomUUID();await save()
  // Owned by the server, not the lifetime of the requesting page/socket.
  work=(async()=>{
   try{
    await business.bind(row.recordingId,row.meetingId,row.durationSeconds)
    await business.markControls(row.recordingId,row.controls)
    const transcript=await business.transcribe(row.recordingId)
    await serial(async()=>{row.generationState='generating';await save()})
    const task=await business.generate({transcript,recording_id:row.recordingId,meeting_id:row.meetingId,source:'live-record',template_type:'weekly',word_export:true})
    await serial(async()=>{row.generationTaskId=task.task_id;row.generationState='generating';await save()})
   }catch(e){await serial(async()=>{row.generationState=e.code==='ETIMEDOUT'?'unknown':'failed';row.generationError=e.code||'GENERATION_FAILED';await save();announce(row,'本场纪要处理未完成，录音保留，请在会议助手查看原任务状态。')})}
  })()
 }
 async function name(row,title){
  title=title.trim().slice(0,200)
  if(!title)return output('请告诉我会议名称。',row)
  const meetings=await business.meetings(),hits=meetings.filter(m=>m.title===title)
  row.pending={kind:hits.length>1?'choose':hits.length?'existing':'new',title,hits:hits.map(m=>({id:m.id,title:m.title,start_time:m.start_time})),expires:Date.now()+120000,interruptedAccepted:row.pending?.interruptedAccepted||false}
  await save()
  if(hits.length>1)return output('找到同名会议，请说惠宝，选择第几项：'+hits.map((m,i)=>`${i+1}，${m.start_time}`).join('；'),row)
  return output(hits.length?`会议名称是${title}，将关联已有会议。请说惠宝，确认或取消。`:`没有找到会议${title}，是否新建${title}并生成纪要？请说惠宝，确认或取消。`,row)
 }
 async function perform(text,requestId,scope){
  const row=await sync()
  if(scope&&(scope.ownerEntry!=='huibao'||scope.sessionId&&row?.sessionId!==scope.sessionId))throw fail('RECORDING_NOT_OWNED',403)
  if(typeof text!=='string'||text.length>1000)throw fail('VOICE_TEXT_INVALID',400)
  if(!/^\s*惠宝[，,。\s]*/.test(text))return output('',row)
  const words=text.replace(/^\s*惠宝[，,。\s]*/,'').trim()
  if(row){row.controls.push({kind:'voice-command',text,requestId,at:Date.now()});await save()}
  const modeStart=/^开启会议模式[。！!\s]*$/.test(words),modeEnd=/^结束会议模式[。！!\s]*$/.test(words)
  if(/会议模式/.test(words)&&!modeStart&&!modeEnd){
   if(/[不别勿否]|[‘’“”\"']|意思|讨论|说过|提到|口令/.test(words))return output('',row)
   return output('请明确说惠宝，开启会议模式或惠宝，结束会议模式。',row)
  }
  if(/^(取消|不用了|算了)[。！!\s]*$/.test(words)){
   if(row?.generationTaskId||['transcribing','generating','completed','unknown'].includes(row?.generationState))return output('本场任务已受理，取消确认不会取消或隐藏原任务，请在会议助手查看状态。',row)
   if(row){row.pending=null;row.generationState='idle';await save()}
   return output('已取消本次生成意图，录音材料保留。',row)
  }
  if(modeStart||/^(开始录音|开始记录)[。！!\s]*$/.test(words)){
   if(active(row))return output(row.recordingState==='recording'?'正在录音。':'正在等待外设音频，尚未确认开始录音。',row)
   await imported(row)
   const audio=await device('start',{request_id:requestId})
   state.current=audio.sessionId;state.sessions[audio.sessionId]={saveState:'pending',generationState:'idle',controls:[],captions:[],...state.sessions[audio.sessionId],...audio,ownerEntry:'huibao',sourceKey:'device:'+deviceId,deviceId,recordingSessionId:audio.sessionId};state.currentByOwner.huibao=audio.sessionId;await save()
   return output(audio.recordingState==='recording'?'已开始录音。':'正在等待外设音频，尚未确认开始录音。')
  }
  if(modeEnd||/^(停止录音|结束录音)[。！!\s]*$/.test(words)){
   if(!row||!active(row))return output(modeEnd?'当前是普通对话模式，没有活动录音。':'当前没有活动的外设录音。',row)
   Object.assign(row,await device('stop',{session_id:row.sessionId}));await save()
   if(active(row))return output('尚未确认停止录音，请在会议助手查看原会话状态。',row)
   await imported(row)
   return output(row.saveState==='saved'?'已停止录音，原始音频已保存。':'已停止录音，音频保存尚未完成；原始材料保留。',row)
  }
  if(/状态|录了多久|录音多久|录音情况/.test(words))return output(row?`${row.recordingState==='preparing'?'正在等待外设音频':row.recordingState==='recording'?'正在录音':row.recordingState==='interrupted'?'录音已中断':'录音已停止'}，已录${Math.floor(row.durationSeconds||0)}秒。${row.saveState==='failed'?'导入失败，原始材料保留。':''}`:'当前没有外设录音。',row)
  if(!row)return output('当前没有明确的录音材料，请先开始录音。')
  if(row.pending?.expires<Date.now()){row.pending=null;row.generationState='idle';await save()}
  if(/^(生成|制作).*纪要/.test(words)){
   if(active(row))return output('请先明确停止录音，再生成会议纪要。',row)
   if(row.generationTaskId||['transcribing','generating','completed','unknown'].includes(row.generationState))return output('本场已有生成任务，请查看页面中的原任务状态。',row)
   await imported(row)
   if(row.saveState!=='saved')return output('录音尚未成功导入，原始材料保留；请稍后按本场重试。',row)
   row.generationState='awaiting_confirmation'
   row.pending={kind:row.recordingState==='interrupted'?'interrupted':'name',expires:Date.now()+120000}
   await save()
   if(row.pending.kind==='interrupted')return output('本场录音已中断，是否使用现有不完整材料？请说惠宝，确认或取消。',row)
   const given=words.match(/(?:名称(?:是|为)?|叫做?|会议名(?:是|为)?)[：:\s]*(.+)$/)?.[1]
   return given?name(row,given):output('请告诉我会议名称，回答时先说惠宝。',row)
  }
  const pending=row.pending
  if(!pending)return output('',row)
  if(pending.kind==='name')return name(row,words.replace(/^(会议名称(?:是|为)?|名称(?:是|为)?)[：:\s]*/,''))
  if(pending.kind==='choose'){
   const n=words.match(/(?:选择)?第?([0-9一二三四五六七八九十]+)(?:项|个)?/),cn='一二三四五六七八九十'
   const index=n?(Number(n[1])||cn.indexOf(n[1])+1)-1:-1
   if(!pending.hits[index])return output('请明确选择页面列出的同名会议序号。',row)
   pending.selected=pending.hits[index].id;pending.kind='existing';pending.hits=[pending.hits[index]];await save()
   return output(`将关联${pending.title}，时间${pending.hits[0].start_time}。请说惠宝，确认或取消。`,row)
  }
  if(!/^(确认|是的|确定|好的)[。！!\s]*$/.test(words))return output('请说惠宝，确认或取消。',row)
  if(pending.kind==='interrupted'){
   row.pending={kind:'name',expires:Date.now()+120000,interruptedAccepted:true};await save();return output('将使用中断材料。请告诉我会议名称，回答时先说惠宝。',row)
  }
  if(pending.kind==='new'){
   row.creationRequestId ||= randomUUID();await save()
   const result=await business.createMeeting({title:pending.title,start_time:new Date(row.startedAt*1000).toISOString(),end_time:new Date(row.endedAt*1000).toISOString(),creation_request_id:row.creationRequestId})
   if(!result.ok)throw fail('MEETING_CREATE_FAILED')
   row.meetingId=result.meeting.id
  }else row.meetingId=pending.hits[0].id
  row.pending=null;await save();await executeGeneration(row)
  return output('已受理本场会议纪要生成，请在会议助手查看结果。',row)
 }
 const controller={
  command:(text,requestId,scope)=>serial(async()=>{
   await load()
   if(typeof requestId!=='string'||!requestId||requestId.length>128)throw fail('REQUEST_ID_REQUIRED',400)
   if(scope&&(scope.ownerEntry!=='huibao'||scope.sessionId&&state.currentByOwner.huibao!==scope.sessionId))throw fail('RECORDING_NOT_OWNED',403)
   if(state.requests[requestId]?.operationState==='submitted')throw fail('RECORDING_OPERATION_UNKNOWN')
   if(state.requests[requestId])return copy(state.requests[requestId])
   state.requests[requestId]={operationState:'submitted',requestId};await save()
   const result=await perform(text,requestId,scope);state.requests[requestId]=result
   // Retain receipts on disk for original-ID reconciliation, including unknown work.
   await save();return result
  }),
  status:(ownerEntry='huibao',sessionId)=>serial(async()=>{await sync();if(!['huibao','meeting-assistant'].includes(ownerEntry))throw fail('RECORDING_NOT_OWNED',403);const row=state.sessions[sessionId||state.currentByOwner[ownerEntry]];if(row&&row.ownerEntry!==ownerEntry)throw fail('RECORDING_NOT_OWNED',403);await save();return {...copy(row||{recordingState:'idle'}),browserId:ownerEntry==='meeting-assistant'?state.browserId:null,browserTouched:state.browserTouched}}),
  browser:(action,id,details={})=>serial(async()=>{
   const row=await sync()
   if(typeof id!=='string'||!id||id.length>128)throw fail('BROWSER_ID_REQUIRED',400)
   if(state.sessions[id]&&state.sessions[id].ownerEntry!=='meeting-assistant')throw fail('RECORDING_NOT_OWNED',403)
   if(action==='start'){
    if(state.browserId&&state.browserId!==id)throw fail('SOURCE_BUSY')
    state.browserId=id;state.browserTouched=Date.now();state.currentByOwner['meeting-assistant']=id;state.sessions[id] ||= {sessionId:id,recordingSessionId:id,ownerEntry:'meeting-assistant',sourceKey:'browser:default',recordingState:'recording',saveState:'pending',generationState:'idle'}
   }else if(action==='heartbeat'){if(state.browserId!==id)throw fail('BROWSER_RECORDING_NOT_OWNED');state.browserTouched=Date.now()}
   else if(action==='stop'){if(state.browserId&&state.browserId!==id)throw fail('RECORDING_NOT_OWNED',403);if(state.browserId===id){state.sessions[id].recordingState='stopped';state.browserId=null;state.browserTouched=0}}
   else if(action==='bind'){
    const owned=state.sessions[id]
    if(!owned||owned.ownerEntry!=='meeting-assistant')throw fail('RECORDING_NOT_OWNED',403)
    if(typeof details.recordingId!=='string'||!details.recordingId||details.recordingId.length>128)throw fail('RECORDING_ID_REQUIRED',400)
    const original=await business.recording(details.recordingId)
    if(!original||original.recording_id!==details.recordingId)throw fail('RECORDING_NOT_FOUND',404)
    if(owned.recordingId&&owned.recordingId!==original.recording_id)throw fail('RECORDING_BINDING_CHANGED')
    owned.recordingId=original.recording_id;owned.meetingId=original.meeting_id||null;owned.saveState='saved'
   }
   else throw fail('BROWSER_ACTION_INVALID',400)
   await save();return {...copy(state.sessions[id]||{}),browserId:state.browserId}
  }),
  tick:()=>serial(async()=>{
   await load()
   const before=current(),oldState=before?.recordingState,row=await sync()
   if(!row)return
   await imported(row)
   if(business.captions&&!captionWork.has(row.sessionId)){
    captionWork.set(row.sessionId,business.captions(copy(row)).then(result=>serial(async()=>{
     if(result){row.captions.push(...result.entries);row.captionOffset=result.offset;row.captionState='ready';await save()}
    })).catch(e=>serial(async()=>{row.captionState=e.code||'LOCAL_CAPTION_FAILED';await save()})).finally(()=>{captionWork.delete(row.sessionId)}))
   }
   if(oldState==='preparing'&&row.recordingState==='recording')announce(row,'已开始录音。')
   if(row.generationTaskId&&row.generationState==='generating'){
    const task=await business.task(row.generationTaskId)
    if(['completed','unresolved','interrupted','cancelled'].includes(task.state)){
     row.generationState=task.state==='completed'?'completed':'failed';row.generationResult=task.result;await save()
     announce(row,task.state==='completed'?'会议纪要已生成，请在会议助手查看。':'会议纪要未完成，请在会议助手查看原任务。')
    }
   }
  }),
  settled:async()=>{await work}
 }
 controller.start=async input=>{
  if(input.ownerEntry!=='huibao'||input.sourceKey!=='device:'+deviceId)throw fail('RECORDING_NOT_OWNED',403)
  return controller.command('惠宝，开始录音',input.requestId)
 }
 controller.stop=input=>serial(async()=>{
  await sync();const row=state.sessions[input.sessionId]
  if(input.ownerEntry!=='huibao'||!row||row.ownerEntry!==input.ownerEntry||state.currentByOwner.huibao!==input.sessionId)throw fail('RECORDING_NOT_OWNED',403)
  if(typeof input.requestId!=='string'||!input.requestId||input.requestId.length>128)throw fail('REQUEST_ID_REQUIRED',400)
  if(state.requests[input.requestId]?.operationState==='submitted')throw fail('RECORDING_OPERATION_UNKNOWN')
  if(state.requests[input.requestId])return copy(state.requests[input.requestId])
  state.requests[input.requestId]={operationState:'submitted',requestId:input.requestId};await save()
  const result=await perform('惠宝，停止录音',input.requestId);state.requests[input.requestId]=result;await save();return result
 })
 return controller
}

export function mountVoiceMeetingControl(ctx) {
 const home=process.env.DSH_HOME,prefix='/api/meeting-assistant/voice-control'
 let controller,config,error,busy=false,closed=false,initializing;const captionReaders=new Map()
 const deviceRoot=process.env.DSH_XIAOWAI_SERVICE_DIR||'/home/lgsj/01-DSH/11-汇报机器人/longshu-xiaowai-v2-upstream-full-r6/service'
 async function configured(){
  if(controller)return controller
  if(!initializing)initializing=initialize().catch(e=>{initializing=null;throw e})
  return initializing
 }
 async function initialize(){
  if(home!==(process.env.DSH_ADMIN_HOME||'/home/lgsj/.dsh/multi-user/users/admin/home'))throw fail('ADMIN_REQUIRED',403)
  config=JSON.parse(await readFile(path.join(home,'meeting-assistant','voice-control-binding.json'),'utf8'))
  if(config.account!=='admin'||typeof config.deviceId!=='string'||!config.deviceId)throw fail('DEVICE_BINDING_REQUIRED',503)
  const raw=await readFile(path.join(deviceRoot,'data','.free_api_key'),'utf8')
  const key=raw.match(/^api_key\s*=\s*(.+)$/m)?.[1].trim()
  if(!key)throw fail('DEVICE_CREDENTIAL_REQUIRED',503)
  async function device(action,body={}){
   const url='http://127.0.0.1:9000/api/meeting_recording'
   const data={device_id:config.deviceId,...body}
   const res=await fetch(action==='status'?url+'?'+new URLSearchParams(data):url,{method:action==='status'?'GET':'POST',headers:{'x-api-key':key,'content-type':'application/json'},...(action==='status'?{}:{body:JSON.stringify({...data,action})}),signal:AbortSignal.timeout(15000)})
   const value=await res.json();if(!res.ok||value.error)throw fail(value.error||'DEVICE_FAILED',res.status);return value
  }
  async function* audio(row){
   const total=row.savedBytes+44
   for(let offset=0;offset<total;){
    const q=new URLSearchParams({device_id:config.deviceId,session_id:row.sessionId,offset:String(offset),length:String(Math.min(1024*1024,total-offset))})
    const res=await fetch('http://127.0.0.1:9000/api/meeting_recording/audio?'+q,{headers:{'x-api-key':key},signal:AbortSignal.timeout(15000)})
    if(!res.ok)throw fail('AUDIO_READ_FAILED',503)
    const bytes=Buffer.from(await res.arrayBuffer());if(!bytes.length)throw fail('AUDIO_TRUNCATED',503)
    offset+=bytes.length;yield bytes
   }
  }
  const original=voiceMeetingBusiness(ctx)
  const business={...original,importRecording:row=>original.importRecording(row.sessionId,Readable.from(audio(row)),`外设会议-${row.sessionId}.wav`),
   async captions(row){
    if(row.sampleRate!==16000||row.channels!==1)throw fail('CAPTION_FORMAT_UNSUPPORTED',503)
    const offset=row.captionOffset||0,remaining=row.savedBytes-offset
    if(remaining<480000&&(active(row)||remaining<3200))return null
    let captionReader=captionReaders.get(row.sessionId)
    if(!captionReader){captionReader=await createExternalCaptionSession({dir:path.join(home,'meeting-assistant','local-captions',`external-${row.sessionId}-${process.pid}`)});captionReaders.set(row.sessionId,captionReader)}
    const length=Math.min(480000,remaining),q=new URLSearchParams({device_id:config.deviceId,session_id:row.sessionId,offset:String(offset),length:String(length)})
    const response=await fetch('http://127.0.0.1:9000/api/meeting_recording/pcm?'+q,{headers:{'x-api-key':key},signal:AbortSignal.timeout(15000)})
    if(!response.ok)throw fail('CAPTION_AUDIO_READ_FAILED',503)
    const pcm=Buffer.from(await response.arrayBuffer())
    if(pcm.length!==length)throw fail('CAPTION_AUDIO_TRUNCATED',503)
    const seq=Math.floor(offset/480000),result=await captionReader.infer({seq,pcm,startMs:offset/32})
    return {...result,entries:result.entries.map(e=>({...e,utteranceId:row.sessionId+':'+seq,sequence:seq})),offset:offset+length}
   },
   async speak(text){
    const res=await fetch('http://127.0.0.1:9000/api/device_tts',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify({device_id:config.deviceId,text}),signal:AbortSignal.timeout(90000)})
    if(!res.ok)throw fail('DEVICE_SPEAK_FAILED',503)
    return res.json()
   }}
  controller=createVoiceMeetingController({home,deviceId:config.deviceId,device,business})
  return controller
 }
 const timer=setInterval(()=>{
  if(busy||closed)return
  busy=true
  configured().then(c=>c.tick()).then(()=>{error=null}).catch(e=>{error=e.code||'VOICE_CONTROL_UNAVAILABLE'}).finally(()=>{busy=false})
 },2000);timer.unref()
 const qaHandler=createVoiceQaInternalHandler({
  readKey:()=>readFile(path.join(home,'meeting-assistant','voice-control.key'),'utf8'),
  binding:async()=>{if(home!==(process.env.DSH_ADMIN_HOME||'/home/lgsj/.dsh/multi-user/users/admin/home'))throw fail('ADMIN_REQUIRED',403);const bound=JSON.parse(await readFile(path.join(home,'meeting-assistant','voice-control-binding.json'),'utf8'));if(bound.account!=='admin'||typeof bound.deviceId!=='string'||!bound.deviceId)throw fail('DEVICE_BINDING_REQUIRED',503);return bound},
  query:input=>voiceMeetingBusiness(ctx).qa(input)})
 async function handler(req,res){
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
  try{
   const suffix=new URL(req.url,'http://localhost').pathname.slice(prefix.length)
   if(suffix==='/qa/internal'){await qaHandler(req,res);return}
   if(suffix==='/internal'){
    const peer=req.socket?.remoteAddress
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer))throw fail('LOOPBACK_REQUIRED',403)
    const expected=(await readFile(path.join(home,'meeting-assistant','voice-control.key'),'utf8').catch(()=>'' )).trim(), supplied=req.headers['x-meeting-control-key']
    if(expected.length<32||typeof supplied!=='string'||supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw fail('SERVICE_AUTH_REQUIRED',403)
   }else await requireAdminDelete({ctx,request:req,home})
   const c=await configured()
   if(suffix===''&&req.method==='GET'){send(200,{...(await c.status()),serviceError:error});return}
   if(req.method!=='POST')throw fail('METHOD_NOT_ALLOWED',405)
   let bytes=0,chunks=[]
   for await(const part of req){bytes+=part.length;if(bytes>8192)throw fail('BODY_TOO_LARGE',413);chunks.push(part)}
   const input=JSON.parse(Buffer.concat(chunks).toString())
   const allowed=suffix==='/browser'?['action','browserId','recordingId']:['text','requestId',...(suffix==='/internal'?['deviceId']:[])]
   if(!input||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw fail('INPUT_INVALID',400)
   if(suffix==='/internal'&&input.deviceId!==config.deviceId)throw fail('WRONG_DEVICE',403)
   if(suffix==='/browser')send(200,await c.browser(input.action,input.browserId,{recordingId:input.recordingId}))
   else if(suffix===''||suffix==='/internal')send(200,await c.command(input.text,input.requestId))
   else throw fail('ROUTE_NOT_FOUND',404)
  }catch(e){send(e.status||503,{error:e.code||'VOICE_CONTROL_UNAVAILABLE',...(e.code==='SOURCE_BUSY'?{reason:'电脑麦克风音源已被另一场录音占用，请先停止原录音；机器人录音不受影响。'}:{})})}
 }
 const withdraw=ctx.provide('huibaoMeeting',{
  async status(sessionId){return (await configured()).status('huibao',sessionId)},
  async command(input){return (await configured()).command(input.text,input.requestId,{ownerEntry:'huibao',sessionId:input.sessionId})},
  async query(input){await configured();return voiceMeetingBusiness(ctx).qa({...input,deviceId:config.deviceId})}
 })
 const dispose=ctx.webServer.register({kind:'prefix',path:prefix,handler})
 return ()=>{closed=true;clearInterval(timer);dispose();withdraw();for(const reader of captionReaders.values())void reader.close()}
}
