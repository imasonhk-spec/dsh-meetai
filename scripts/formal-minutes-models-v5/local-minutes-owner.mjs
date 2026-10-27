// Distinct native-loopback backend owner; NOT an SDK registry or business-release authority.
import http from 'node:http'
import path from 'node:path'
import {readFile,readdir,readlink,lstat,realpath} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {LOCAL_SERVICE,LOCAL_MODELS} from './local-minutes-pins.mjs'
import {structuredReply} from './structured-reply.mjs'
const CONTRACT='local-minutes-operational/1'
const tickets=new WeakMap(),fileChecks=new Map(),knownProcesses=new Map(),transport=new WeakMap()
const hash=value=>createHash('sha256').update(value).digest('hex')
const fail=code=>Object.assign(new Error(code),{code})
const need=(condition,code)=>{if(!condition)throw fail(code)}
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':')
async function approvedFile(file,expected){
  const info=await lstat(file,{bigint:true});need(info.isFile()&&!info.isSymbolicLink()&&await realpath(file)===file,'LOCAL_MINUTES_OWNER_UNSAFE')
  const identity=stamp(info),cached=fileChecks.get(file)
  if(cached?.stamp!==identity){const bytes=await readFile(file),after=await lstat(file,{bigint:true})
    need(stamp(after)===identity&&hash(bytes)===expected,'LOCAL_MINUTES_OWNER_CODE_CHANGED');fileChecks.set(file,{stamp:identity,sha256:expected})
  }else need(cached.sha256===expected,'LOCAL_MINUTES_OWNER_CODE_CHANGED')
  return identity
}
async function listener(port=LOCAL_SERVICE.port,uid=process.getuid()){
  const rows=(await readFile('/proc/net/tcp','utf8')).trim().split('\n').slice(1).map(s=>s.trim().split(/\s+/))
  const address='0100007F:'+port.toString(16).toUpperCase().padStart(4,'0'),found=rows.filter(r=>r[1]===address&&r[3]==='0A')
  need(found.length===1&&Number(found[0][7])===uid,'LOCAL_MINUTES_OWNER_UNAVAILABLE')
  return {inode:found[0][9],uid:Number(found[0][7]),port}
}
async function processFor(inode){
  async function matches(pid){
    try{
      const dir='/proc/'+pid,info=await lstat(dir);if(info.uid!==process.getuid())return null
      const command=await readFile(dir+'/cmdline'),args=command.toString().replace(/\0$/,'').split('\0')
      if(args.length!==2||args[1]!==LOCAL_SERVICE.proxyScript||await realpath(dir+'/exe')!==LOCAL_SERVICE.executable)return null
      if(args[0]!=='node'&&(!path.isAbsolute(args[0])||await realpath(args[0])!==LOCAL_SERVICE.executable))return null
      // Read only selected launch variables; never publish/store environment values or credentials.
      const env=new Map((await readFile(dir+'/environ')).toString().split('\0').filter(s=>s.includes('=')).map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)]))
      if(['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_AUDIT','NODE_USE_ENV_PROXY'].some(key=>env.get(key)))return null
      let owns=false
      for(const fd of await readdir(dir+'/fd')){try{if(await readlink(dir+'/fd/'+fd)==='socket:['+inode+']'){owns=true;break}}catch{}}
      if(!owns)return null
      const stat=await readFile(dir+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ')
      return {pid:Number(pid),startTime:fields[19],commandSha256:hash(command),inode,launchMode:'approved-script-no-preload'}
    }catch{return null}
  }
  const old=knownProcesses.get(inode)
  if(old){const current=await matches(old);if(current)return current;knownProcesses.delete(inode)}
  for(const pid of await readdir('/proc')){if(!/^\d+$/.test(pid))continue;const current=await matches(pid);if(current){knownProcesses.set(inode,pid);return current}}
  throw fail('LOCAL_MINUTES_OWNER_UNAVAILABLE')
}
async function serviceIdentity(){
  const first=await listener(),owner=await processFor(first.inode),upstream=await listener(LOCAL_SERVICE.upstreamPort,LOCAL_SERVICE.upstreamUid)
  const script=await approvedFile(LOCAL_SERVICE.proxyScript,LOCAL_SERVICE.proxySha256),executable=await approvedFile(LOCAL_SERVICE.executable,LOCAL_SERVICE.executableSha256)
  need((await listener()).inode===first.inode&&(await listener(LOCAL_SERVICE.upstreamPort,LOCAL_SERVICE.upstreamUid)).inode===upstream.inode,'LOCAL_MINUTES_OWNER_CHANGED')
  return hash(JSON.stringify({owner,script,executable,upstream}))
}
async function bounded(fn,signal,timeoutMs=10000){
  signal?.throwIfAborted();let timer,abort
  const gate=new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('LOCAL_MINUTES_CATALOG_TIMEOUT')),timeoutMs)
    abort=()=>reject(fail('LOCAL_MINUTES_CANCELLED'));signal?.addEventListener('abort',abort,{once:true})})
  try{return await Promise.race([Promise.resolve().then(fn),gate])}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
}
// node:http ignores ambient HTTP proxies; no redirects, dynamic endpoint, retries or middleware.
function response(pathname,payload,signal,beforeSend,timeoutMs=600000){
  return new Promise((resolve,reject)=>{
    const state={request:null,res:null,timer:null,cause:null};let settled=false
    const rejectOnce=error=>{if(!settled){settled=true;reject(error)}}
    try{
      signal?.throwIfAborted();beforeSend?.();const bytes=payload===undefined?undefined:Buffer.from(JSON.stringify(payload))
      state.request=http.request({hostname:LOCAL_SERVICE.host,port:LOCAL_SERVICE.port,path:pathname,method:bytes?'POST':'GET',agent:false,signal,
        headers:{Accept:bytes?'application/x-ndjson, application/json':'application/json',...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},res=>{
        state.res=res;transport.set(res,state)
        if(res.statusCode!==200){state.cause=fail('LOCAL_MINUTES_BACKEND_HTTP');clearTimeout(state.timer);res.destroy();rejectOnce(state.cause);return}
        res.once('close',()=>clearTimeout(state.timer));settled=true;resolve(res)
      })
      state.timer=setTimeout(()=>{state.cause=fail('LOCAL_MINUTES_BACKEND_TIMEOUT');state.request.destroy(state.cause);state.res?.destroy(state.cause)},timeoutMs);state.timer.unref()
      state.request.once('error',error=>{clearTimeout(state.timer);state.cause??=signal?.aborted?fail('LOCAL_MINUTES_CANCELLED'):error.code?.startsWith('LOCAL_MINUTES_')?error:fail('LOCAL_MINUTES_BACKEND_UNAVAILABLE');rejectOnce(state.cause)})
      state.request.end(bytes)
    }catch(error){clearTimeout(state.timer);state.request?.destroy();rejectOnce(signal?.aborted?fail('LOCAL_MINUTES_CANCELLED'):error)}
  })
}
function bodyError(res,error,signal){return transport.get(res)?.cause??(signal?.aborted?fail('LOCAL_MINUTES_CANCELLED'):error.code?.startsWith('LOCAL_MINUTES_')||['OUTPUT_TRUNCATED','LLM_UNFINISHED','UNEXPECTED_TOOL_CALL'].includes(error.code)?error:fail('LOCAL_MINUTES_PROTOCOL'))}
function releaseResponse(res){if(!res)return;const state=transport.get(res);clearTimeout(state?.timer);res.destroy();state?.request?.destroy();transport.delete(res)}
async function json(pathname,payload,signal,beforeSend){
  const res=await response(pathname,payload,signal,beforeSend,20000);let text=''
  try{res.setEncoding('utf8');for await(const chunk of res){text+=chunk;need(text.length<=2*1024*1024,'LOCAL_MINUTES_PROTOCOL')}
    try{return JSON.parse(text)}catch{throw fail('LOCAL_MINUTES_PROTOCOL')}
  }catch(error){throw bodyError(res,error,signal)}finally{releaseResponse(res)}
}
async function modelIdentity(model,signal,check){
  const pin=LOCAL_MODELS[model];need(pin,'LOCAL_MINUTES_MODEL_REQUIRED');check()
  need((await json('/api/version',undefined,signal,check)).version===LOCAL_SERVICE.nativeVersion,'LOCAL_MINUTES_PROTOCOL_VERSION_CHANGED')
  const tags=await json('/api/tags',undefined,signal,check),tag=tags.models?.find(m=>m.name===model&&m.model===model)
  need(tag?.digest===pin.digest&&tag.details?.parameter_size===pin.parameterSize&&tag.details?.quantization_level===pin.quantization&&tag.details?.family===pin.family,'LOCAL_MINUTES_MODEL_CHANGED')
  const show=await json('/api/show',{model},signal,check),weight=show.modelfile?.match(/^FROM\s+\S*sha256-([a-f0-9]{64})\s*$/m)?.[1]
  need(weight===pin.weightsSha256&&hash(show.template||'')===pin.templateSha256&&show.details?.parameter_size===pin.parameterSize&&show.details?.quantization_level===pin.quantization,'LOCAL_MINUTES_MODEL_CHANGED')
  check();return {digest:pin.digest,weightsSha256:weight,parametersSha256:hash(show.parameters||''),templateSha256:pin.templateSha256}
}
export async function openLocalMinutesOwner({ctx,home,selection,sourceSha256,templateSha256='',signal}={}){
  need(ctx&&typeof ctx.get==='function'&&typeof ctx.effect==='function','LOCAL_MINUTES_HOST_REQUIRED');const llm=ctx.get('llm')
  need(llm&&typeof llm.listProviders==='function'&&typeof llm.listModels==='function','LOCAL_MINUTES_HOST_REQUIRED')
  need(home===process.env.DSH_HOME&&typeof home==='string'&&await realpath(home)===path.resolve(home),'LOCAL_MINUTES_ACCOUNT_REQUIRED')
  const hs=await lstat(home);need(hs.isDirectory()&&!hs.isSymbolicLink()&&hs.uid===process.getuid()&&(hs.mode&0o077)===0,'LOCAL_MINUTES_ACCOUNT_REQUIRED')
  need(selection?.provider==='ollama'&&Object.hasOwn(LOCAL_MODELS,selection.model),'LOCAL_MINUTES_MODEL_REQUIRED')
  need(/^[a-f0-9]{64}$/.test(sourceSha256||'')&&(!templateSha256||/^[a-f0-9]{64}$/.test(templateSha256)),'LOCAL_MINUTES_SOURCE_REQUIRED')
  const model=selection.model,cancel=new AbortController();let closed=false,activeCall=false
  const life=()=>{need(!closed&&home===process.env.DSH_HOME&&!!ctx.get('llm'),'LOCAL_MINUTES_OWNER_CHANGED');if(signal?.aborted||cancel.signal.aborted)throw fail('LOCAL_MINUTES_CANCELLED')}
  const joined=extra=>AbortSignal.any([cancel.signal,...(signal?[signal]:[]),...(extra?[extra]:[])])
  async function catalog(activeSignal){
    life();activeSignal.throwIfAborted();const providers=await bounded(()=>ctx.get('llm').listProviders(),activeSignal)
    need(Array.isArray(providers)&&providers.some(p=>p.id==='ollama'),'LOCAL_MINUTES_CATALOG_CHANGED')
    const models=await bounded(()=>ctx.get('llm').listModels('ollama',activeSignal),activeSignal)
    need(Array.isArray(models)&&models.filter(m=>m.id===model).length===1,'LOCAL_MINUTES_CATALOG_CHANGED');life()
  }
  const close=()=>{if(!closed){closed=true;cancel.abort()}},dispose=ctx.effect(()=>close,'operational local minutes owner')
  try{
    const initialSignal=joined();await catalog(initialSignal)
    const ownerId=await serviceIdentity(),metadata=await modelIdentity(model,initialSignal,life)
    need(await serviceIdentity()===ownerId,'LOCAL_MINUTES_OWNER_CHANGED')
    const identity=Object.freeze({provider:'ollama',model,reasoningEffort:'backend-default',...metadata,ownerKind:'native-loopback-service'})
    const fingerprint=CONTRACT+'|'+hash(JSON.stringify({ownerId,identity,contextWindow:LOCAL_SERVICE.contextWindow,nativeVersion:LOCAL_SERVICE.nativeVersion,protocol:'ollama-native-schema-4-inflight-residency',generationBudget:'combined-native-at-least8192'}))
    const ticket=Object.freeze({contract:CONTRACT});tickets.set(ticket,{llm,ctx,identity,sourceSha256,templateSha256,ownerId,fingerprint})
    async function assertCurrent(extraSignal){
      const activeSignal=joined(extraSignal);life();await catalog(activeSignal)
      need(await serviceIdentity()===ownerId,'LOCAL_MINUTES_OWNER_CHANGED');const current=await modelIdentity(model,activeSignal,life)
      need(JSON.stringify(current)===JSON.stringify(metadata),'LOCAL_MINUTES_MODEL_CHANGED')
      need(await serviceIdentity()===ownerId,'LOCAL_MINUTES_OWNER_CHANGED');life();return true
    }
    async function complete(capability,{system,user,maxTokens=1536,signal:callSignal}={}){
      need(tickets.get(capability)?.ctx===ctx&&capability===ticket,'LOCAL_MINUTES_BINDING_REQUIRED');need(!activeCall,'LOCAL_MINUTES_CALL_BUSY')
      need(typeof system==='string'&&typeof user==='string'&&Number.isSafeInteger(maxTokens)&&maxTokens>0&&maxTokens<=8192,'LOCAL_MINUTES_REQUEST_INVALID')
      const reply=structuredReply(system,user),predictionLimit=Math.max(8192,maxTokens+1536),promptUser=reply.reminder?user+'\n'+reply.reminder:user
      need(Buffer.byteLength(system+promptUser,'utf8')+predictionLimit+512<=LOCAL_SERVICE.contextWindow,'INPUT_BUDGET')
      // Combined native generation cap, not a guarantee of visible tokens or reserved thinking.
      // No think:false: native backend default internal thinking is retained and never published.
      const payload={model,stream:true,format:reply.format,keep_alive:'5m',messages:[{role:'system',content:system},{role:'user',content:promptUser}],options:{temperature:0,num_predict:predictionLimit,num_ctx:LOCAL_SERVICE.contextWindow}}
      const activeSignal=joined(callSignal);activeCall=true;let res
      try{
        await assertCurrent(activeSignal);res=await response('/api/chat',payload,activeSignal,()=>{life();activeSignal.throwIfAborted()})
        res.setEncoding('utf8');let buffer='',text='',done=false,seen=0,thoughtChars=0,usage,residentDuringCall=false
        function consume(line){
          if(!line.trim())return;let event;try{event=JSON.parse(line)}catch{throw fail('LOCAL_MINUTES_PROTOCOL')}
          need(!done&&!event.error&&event.model===model,'LOCAL_MINUTES_RESPONSE_MODEL_MISMATCH');need(!event.message?.tool_calls?.length,'UNEXPECTED_TOOL_CALL')
          if(event.message?.content!==undefined){need(typeof event.message.content==='string','LOCAL_MINUTES_PROTOCOL');text+=event.message.content}
          if(event.message?.thinking!==undefined){need(typeof event.message.thinking==='string','LOCAL_MINUTES_PROTOCOL');thoughtChars+=event.message.thinking.length}
          need(text.length<=maxTokens*24&&thoughtChars<=predictionLimit*24,'OUTPUT_TRUNCATED')
          if(event.done){need(event.done===true,'LOCAL_MINUTES_PROTOCOL');if(event.done_reason==='length')throw fail('OUTPUT_TRUNCATED');need(event.done_reason==='stop','LLM_UNFINISHED')
            need(Number.isSafeInteger(event.prompt_eval_count)&&event.prompt_eval_count>=0&&Number.isSafeInteger(event.eval_count)&&event.eval_count>=0,'LOCAL_MINUTES_PROTOCOL')
            done=true;usage={inputTokens:event.prompt_eval_count,outputTokens:event.eval_count,thoughtChars,nativePredictionLimit:payload.options.num_predict,budgetKind:'combined-text-thinking'}
          }
        }
        for await(const chunk of res){life();activeSignal.throwIfAborted();
          if(!residentDuringCall){const live=await json('/api/ps',undefined,activeSignal,life);need(live.models?.some(m=>m.name===model&&m.model===model&&m.digest===metadata.digest),'LOCAL_MINUTES_RESIDENT_MODEL_MISMATCH');residentDuringCall=true}
          seen+=chunk.length;need(seen<=2*1024*1024,'OUTPUT_TRUNCATED');buffer+=chunk
          let newline;while((newline=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,newline));buffer=buffer.slice(newline+1)}}
        if(buffer.trim())consume(buffer);need(done&&text.trim(),'LLM_UNFINISHED')
        const ps=await json('/api/ps',undefined,activeSignal,life)
        need(residentDuringCall,'LOCAL_MINUTES_RESIDENT_MODEL_MISMATCH')
        const remaining=ps.models?.filter(m=>m.name===model&&m.model===model)||[]
        need(remaining.every(m=>m.digest===metadata.digest),'LOCAL_MINUTES_RESIDENT_MODEL_MISMATCH')
        // Another tenant may legitimately unload this runner after completion. In-flight proof is mandatory.
        usage.residentDuringCallVerified=true;usage.residentAfterCall=remaining.length>0
        await assertCurrent(activeSignal);return {text:text.trim(),finish:'stop',usage,route:identity,operationalAdmission:CONTRACT}
      }catch(error){throw bodyError(res,error,activeSignal)}finally{releaseResponse(res);activeCall=false}
    }
    return Object.freeze({ticket,identity,fingerprint,sourceSha256,templateSha256,assertCurrent,complete,async close(){close();await dispose?.()}})
  }catch(error){close();await dispose?.();throw error}
}
