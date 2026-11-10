import {readFile,lstat} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createEditorRegistry} from './word-editor-registry.mjs'
import {editorError,signEditorToken,verifyEditorToken,requestNonce,downloadEditorDocument,checkSecret} from './word-editor-security.mjs'
const PREFIX='/api/meeting-assistant/word-editor'
const UUID=/^[a-f0-9-]{36}$/
const hash=value=>createHash('sha256').update(value).digest('hex')
function json(res,status,data){if(!res.writableEnded){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}}
async function body(req,max=1024*1024){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw editorError('WORD_EDITOR_BODY_LIMIT',413);chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{throw editorError('WORD_EDITOR_BODY_INVALID',400)}}
export async function loadEditorConfig(file=process.env.DSH_WORD_EDITOR_CONFIG){
 if(!file)throw editorError('WORD_EDITOR_NOT_CONFIGURED',503)
 const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw editorError('WORD_EDITOR_CONFIG_UNSAFE',503)
 const cfg=JSON.parse(await readFile(file,'utf8'));checkSecret(cfg.jwtSecret);checkSecret(cfg.capabilitySecret)
 const server=new URL(cfg.documentServer),broker=new URL(cfg.brokerURL)
 const privateContainer=cfg.containerOrigin&&server.origin===new URL(cfg.containerOrigin).origin&&server.hostname==='172.30.35.2'
 if((!['127.0.0.1','localhost'].includes(server.hostname)&&!privateContainer)||server.protocol!=='http:'||broker.protocol!=='http:'||!/^\/[a-z0-9-]+\/$/.test(cfg.publicEditorPath))throw editorError('WORD_EDITOR_CONFIG_UNSAFE',503)
 return cfg
}
function tokenFrom(req){const value=req.headers.authorization;return typeof value==='string'&&value.startsWith('Bearer ')?value.slice(7):''}
export function verifyDocumentCallback(req,data,secret){
 const token=typeof data.token==='string'?data.token:tokenFrom(req),claims=verifyEditorToken(token,secret,{requireExpiry:false}),signed=claims.payload||claims
 for(const[key,value]of Object.entries(data))if(key!=='token'&&JSON.stringify(value)!==JSON.stringify(signed[key]))throw editorError('WORD_EDITOR_CALLBACK_SIGNATURE')
 if(typeof data.key!=='string'||!Number.isInteger(data.status))throw editorError('WORD_EDITOR_CALLBACK_INVALID',400)
 return data
}
function sourceToken(cfg,session,scope){return signEditorToken({scope,sid:session.id,actor:session.actor,exp:Math.floor(session.expiresAt/1000)},cfg.capabilitySecret)}
export function normalizedDownloadURL(value,cfg){
 const url=new URL(value),local=new URL(cfg.documentServer)
 if(url.origin===local.origin)return url.href
 if(cfg.publicOrigin&&url.origin===new URL(cfg.publicOrigin).origin&&url.pathname.startsWith(cfg.publicEditorPath+'cache/'))return local.origin+'/'+url.pathname.slice(cfg.publicEditorPath.length)+url.search
 if(cfg.containerOrigin&&url.origin===new URL(cfg.containerOrigin).origin&&url.pathname.startsWith('/cache/'))return local.origin+url.pathname+url.search
 throw editorError('WORD_EDITOR_DOWNLOAD_DENIED')
}
/** Existing private account hooks; receipt IDs never authorize another session. */
export function mountWordEditor(ctx,{getMinutes,commitMinutes,getRuntime,configLoader=loadEditorConfig,fetcher=fetch,home=process.env.DSH_HOME}={}){
 let closed=false
 const controllers=new Set(),registries=new Map()
 const dispose=ctx.webServer.register({kind:'prefix',path:PREFIX,handler:async(req,res)=>{
  try{
   if(closed)throw editorError('WORD_EDITOR_CLOSED',503)
   const url=new URL(req.url,'http://localhost'),suffix=url.pathname.slice(PREFIX.length),cfg=await configLoader()
   let registry=registries.get(cfg.registry);if(!registry){registry=createEditorRegistry(cfg.registry);registries.set(cfg.registry,registry)}
   async function own(sid){return registry.load(sid,{home})}
   function browserOrigin(){if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host))throw editorError('WORD_EDITOR_ORIGIN_DENIED')}
   function context(session,receipt){return{sessionId:session.id,requestId:receipt?receipt.requestId:session.export?.request_id||null,editEpoch:receipt?receipt.editEpoch:session.export?.edit_epoch??null,boundVersion:session.version,boundArtifactId:session.artifactId,allowSessionRebind:!!receipt&&session.reboundReceiptId===receipt.receiptId}}
   async function refresh(session,{recover=false,native=false}={}){
    const receipt=native?session.lastSaveReceipt:session.export?.saveReceipt||session.lastSaveReceipt
    const saveContext=receipt?context(session,receipt):native?{sessionId:session.id,requestId:null,editEpoch:null}:context(session)
    const minutes=await commitMinutes(session.minutesId,{...(receipt?{recoveryReceiptId:receipt.receiptId}:{findSaveReceipt:true}),saveContext,inspectOnly:!recover})
    if(!minutes?.saveReceipt)return null
    const saved=minutes.saveReceipt
    // Do not roll a session back after another accepted save advanced it.
    if(saved.wordSaved&&minutes.version>=session.version){
     if(minutes.version===session.version&&minutes.word_document.artifact_id!==session.artifactId)throw editorError('WORD_EDITOR_VERSION_CONFLICT',409)
     session.version=minutes.version;session.artifactId=minutes.word_document.artifact_id
    }
    session.lastSaveReceipt=saved
    if(session.export&&saved.requestId===session.export.request_id&&saved.editEpoch===session.export.edit_epoch){
     session.export={...session.export,state:saved.wordSaved?'saved':'save_uncertain',minutes,saveReceipt:saved,relationshipPending:saved.relationshipPending,...(saved.wordSaved?{savedAt:Date.now()}:{} )}
     if(saved.wordSaved&&!session.export.recoveryBinding)session.confirmedEditEpoch=session.export.edit_epoch
    }
    await registry.save(session)
    return minutes
   }
   if(suffix==='/status'&&req.method==='GET'){
    browserOrigin();const response=await fetcher(cfg.documentServer+'/healthcheck',{signal:AbortSignal.timeout(5000)});if(!response.ok||(await response.text()).trim()!=='true')throw editorError('WORD_EDITOR_UNAVAILABLE',503)
    json(res,200,{ok:true,local:true});return
   }
   if(suffix==='/sessions'&&req.method==='POST'){
    browserOrigin();const data=await body(req,16384)
    if(typeof data.minutes_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(data.minutes_id))throw editorError('WORD_MINUTES_ID_INVALID',400)
    const minutes=await getMinutes(data.minutes_id)
    const session=await registry.create({home,port:req.socket.localPort,minutesId:minutes.minutes_id,artifactId:minutes.word_document.artifact_id,version:minutes.version})
    session.readonly=minutes.is_archived===true;session.confirmedEditEpoch=0
    const receipt=minutes.saveReceipt
    if(receipt?.wordSaved&&receipt.version===minutes.version&&receipt.artifactId===session.artifactId&&receipt.docxSha256===minutes.word_document.docx_sha256){
     // Fresh session binds a verified saved document, not a fabricated export
     // nonce. Old request/epoch remain receipt audit identity only.
     session.lastSaveReceipt=receipt;session.reboundReceiptId=receipt.receiptId
     session.export={state:'saved',request_id:receipt.requestId,edit_epoch:receipt.editEpoch,minutes,saveReceipt:receipt,relationshipPending:receipt.relationshipPending,recoveryBinding:true}
    }
    await registry.save(session)
    const configuration={documentType:'word',type:'desktop',width:'100%',height:'100%',document:{fileType:'docx',key:session.key,title:(minutes.title||'会议纪要').replace(/[\x00-\x1f\\/]/g,'_').slice(0,160)+'.docx',url:cfg.brokerURL+'/source/'+session.id+'?cap='+sourceToken(cfg,session,'word-file'),permissions:{edit:!session.readonly,download:false,print:false}},editorConfig:{mode:session.readonly?'view':'edit',lang:'zh-CN',user:{id:session.actor,name:'会议纪要编辑用户'},callbackUrl:cfg.brokerURL+'/callback/'+session.id+'?cap='+sourceToken(cfg,session,'word-callback'),customization:{autosave:true,forcesave:true,compactToolbar:true,hideRightMenu:true}}}
    const token=signEditorToken(configuration,cfg.jwtSecret);json(res,200,{session_id:session.id,config:{...configuration,token},sdk_url:cfg.publicEditorPath+'web-apps/apps/api/documents/api.js',minutes,export:session.export||null,saveReceipt:session.lastSaveReceipt||null});return
   }
   const matched=/^\/sessions\/([a-f0-9-]{36})(\/(?:export|recovery))?$/.exec(suffix)
   if(matched&&req.method==='GET'&&!matched[2]){
    browserOrigin();const status=await registry.serialize(matched[1],async()=>{const session=await own(matched[1]);await refresh(session,{native:!session.export});return{session_id:session.id,export:session.export||null,version:session.version,saveReceipt:session.lastSaveReceipt||null}});json(res,200,status);return
   }
   if(matched&&matched[2]==='/recovery'&&req.method==='POST'){
    browserOrigin();const data=await body(req,16384)
    if(!data||Object.keys(data).some(key=>key!=='receipt_id')||!/^save_[a-f0-9]{64}$/.test(data.receipt_id||''))throw editorError('WORD_SAVE_RECEIPT_INVALID',400)
    const result=await registry.serialize(matched[1],async()=>{
     const session=await own(matched[1]),receipt=session.export?.saveReceipt||session.lastSaveReceipt
     let minutes
     if(receipt?.receiptId===data.receipt_id)minutes=await refresh(session,{recover:true})
     else{
      // Explicit recovery under a NEW authenticated session may bind the old
      // intent only to this exact logical minutes/version/artifact pair.
      minutes=await commitMinutes(session.minutesId,{recoveryReceiptId:data.receipt_id,saveContext:{sessionId:session.id,requestId:null,editEpoch:null,boundVersion:session.version,boundArtifactId:session.artifactId,allowSessionRebind:true},inspectOnly:false})
      if(minutes.saveReceipt.wordSaved&&minutes.version>=session.version){session.version=minutes.version;session.artifactId=minutes.word_document.artifact_id}
      session.lastSaveReceipt=minutes.saveReceipt;session.reboundReceiptId=data.receipt_id;await registry.save(session)
     }
     return session.export?.saveReceipt?.receiptId===data.receipt_id?session.export:{state:minutes.saveReceipt.wordSaved?'saved':'save_uncertain',minutes,saveReceipt:minutes.saveReceipt,relationshipPending:minutes.saveReceipt.relationshipPending}
    });json(res,200,result);return
   }
   if(matched&&matched[2]==='/export'&&req.method==='POST'){
    browserOrigin();const data=await body(req,16384)
    if(!Number.isSafeInteger(data.edit_epoch)||data.edit_epoch<0)throw editorError('WORD_EDITOR_EPOCH_INVALID',400)
    const result=await registry.serialize(matched[1],async()=>{
     const session=await own(matched[1]);if(session.readonly){const minutes=await getMinutes(session.minutesId);return{state:'saved',request_id:requestNonce(),minutes}}
     if(session.export?.recoveryBinding&&session.export.state==='saved'&&data.edit_epoch===session.confirmedEditEpoch)return session.export
     if(session.export?.state==='save_uncertain')return session.export // Never force-save over an unverified committed artifact.
     if(session.export?.state==='saved'&&!session.export.recoveryBinding&&session.export.relationshipPending&&data.edit_epoch===session.export.edit_epoch)return session.export
     if(session.export?.state==='pending'&&Date.now()-session.export.requestedAt<120000)throw editorError('WORD_EDITOR_SAVE_BUSY',409)
     const current=await getMinutes(session.minutesId)
     if(current.version!==session.version||current.word_document.artifact_id!==session.artifactId)throw editorError('WORD_EDITOR_VERSION_CONFLICT',409)
     const nonce=requestNonce();session.export={state:'pending',request_id:nonce,edit_epoch:data.edit_epoch,requestedAt:Date.now()};await registry.save(session)
     const command={c:'forcesave',key:session.key,userdata:nonce}
     try{
      const response=await fetcher(cfg.documentServer+'/coauthoring/CommandService.ashx',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+signEditorToken({payload:command},cfg.jwtSecret)},body:JSON.stringify(command),signal:AbortSignal.timeout(15000)})
      if(!response.ok)throw editorError('WORD_EDITOR_COMMAND_FAILED',502)
      const answer=await response.json()
      if(answer.error===4&&data.edit_epoch===session.confirmedEditEpoch){const latest=await getMinutes(session.minutesId);if(latest.version!==session.version||latest.word_document.artifact_id!==session.artifactId)throw editorError('WORD_EDITOR_VERSION_CONFLICT',409);session.export={...session.export,state:'saved',minutes:latest};await registry.save(session)}
      else if(answer.error!==0)throw editorError('WORD_EDITOR_FORCE_SAVE_FAILED',502)
     }catch(error){session.export={...session.export,state:'failed',error:error.code||'WORD_EDITOR_COMMAND_FAILED'};await registry.save(session);throw error}
     return session.export
    });json(res,200,result);return
   }
   const internal=/^\/(file|callback)\/([a-f0-9-]{36})$/.exec(suffix)
   if(internal){
    const cap=verifyEditorToken(req.headers['x-dsh-editor-capability']||tokenFrom(req),cfg.capabilitySecret,{scope:internal[1]==='file'?'word-file':'word-callback'})
    const session=await own(internal[2]);if(cap.sid!==session.id||cap.actor!==session.actor)throw editorError('WORD_EDITOR_ACCOUNT_DENIED')
    if(internal[1]==='file'&&req.method==='GET'){const bytes=await getRuntime().readDocx(session.artifactId);res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return}
    if(internal[1]==='callback'&&req.method==='POST'){
     const data=verifyDocumentCallback(req,await body(req),cfg.jwtSecret)
     await registry.serialize(session.id,async()=>{
      const live=await own(session.id)
      if(data.key!==live.key)throw editorError('WORD_EDITOR_DOCUMENT_DENIED')
      if([1,4].includes(data.status))return
      if([3,7].includes(data.status)){if(live.export?.state==='pending'){await refresh(live);if(live.export?.state==='pending'){live.export={...live.export,state:'failed',error:'WORD_EDITOR_FORCE_SAVE_FAILED'};await registry.save(live)}}return}
      if(![2,6].includes(data.status))throw editorError('WORD_EDITOR_CALLBACK_INVALID',400)
      const appNonce=data.status===6&&live.export&&data.userdata===live.export.request_id
      const nativeSave=data.status===2||(data.status===6&&[1,2].includes(data.forcesavetype)&&data.userdata===undefined)
      if(data.status===6&&!appNonce&&!nativeSave)return
      // Discover durable receipt before CAS: registry.save itself may have failed
      // after manual v2 persisted. Never reapply a matching callback to old v1.
      await refresh(live,{native:!appNonce})
      const matchingExport=appNonce&&live.export?.state==='pending'
      const existingReceipt=appNonce?live.export?.saveReceipt:null
      const ac=new AbortController();controllers.add(ac);let transaction
      try{
       const bytes=await downloadEditorDocument(normalizedDownloadURL(data.url,cfg),{base:cfg.documentServer,signal:ac.signal,fetcher})
       if(existingReceipt){if(hash(bytes)!==existingReceipt.docxSha256)throw editorError('WORD_SAVE_RECEIPT_CONFLICT',409);await refresh(live,{recover:true});return}
       const current=await getMinutes(live.minutesId)
       if(current.version!==live.version||current.word_document.artifact_id!==live.artifactId)throw editorError('WORD_EDITOR_VERSION_CONFLICT',409)
       const old=await getRuntime().readDocx(live.artifactId)
       let minutes
       if(hash(bytes)===hash(old))minutes=current
       else{transaction=await getRuntime().prepareEdited({bytes,sourceArtifactId:live.artifactId,signal:ac.signal});minutes=await commitMinutes(live.minutesId,{transaction,expectedVersion:live.version,expectedArtifactId:live.artifactId,saveContext:matchingExport?context(live):{sessionId:live.id,requestId:null,editEpoch:null}})}
       const receipt=minutes.saveReceipt
       if(!receipt||receipt.wordSaved){live.version=minutes.version;live.artifactId=minutes.word_document.artifact_id}
       if(receipt)live.lastSaveReceipt=receipt
       if(matchingExport){if(!receipt||receipt.wordSaved)live.confirmedEditEpoch=live.export.edit_epoch;live.export={...live.export,state:receipt&&!receipt.wordSaved?'save_uncertain':'saved',minutes,saveReceipt:receipt,relationshipPending:receipt?.relationshipPending===true,savedAt:Date.now()}}
       await registry.save(live)
      }catch(error){
       await transaction?.rollback({retainCommitted:true}).catch(()=>{})
       // A confirmed receipt wins over mirror/registry errors: no false save-fail.
       try{await refresh(live,{native:!appNonce})}catch{}
       if(live.export?.state==='pending'){live.export={...live.export,state:'failed',error:error.code||'WORD_EDITOR_SAVE_FAILED'};await registry.save(live)}
       if(error.code==='WORD_SAVE_RECEIPT_CONFLICT'||(!live.export?.saveReceipt?.wordSaved&&!live.lastSaveReceipt?.wordSaved))throw error
      }finally{controllers.delete(ac)}
     });json(res,200,{error:0});return
    }
   }
   throw editorError('WORD_EDITOR_ROUTE_NOT_FOUND',404)
  }catch(error){json(res,error.status||500,{error:error.code||'WORD_EDITOR_INTERNAL',reason:'本地 Word 编辑或保存状态需要核对；原Word与保存收据保留，未改用旧文件。'})}
 }})
 const cleanup=()=>{closed=true;dispose();for(const ac of controllers)ac.abort();controllers.clear()}
 return cleanup
}
