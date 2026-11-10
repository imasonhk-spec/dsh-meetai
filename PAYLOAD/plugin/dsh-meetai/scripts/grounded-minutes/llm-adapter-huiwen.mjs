// Fixed Host route only; no cloud fallback.
export const CORE_MODEL='huiwen-lm:latest'
export const error=(code,message)=>Object.assign(new Error(message),{code})
const VERSION='host-huiwen-model-names-only-1'
async function bounded(fn,{signal,timeoutMs=10000}={}) {
  signal?.throwIfAborted()
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw error('MODEL_DIRECTORY_TIMEOUT','目录超时预算不合法')
  let timer,abort
  const gate=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(error('MODEL_DIRECTORY_TIMEOUT','模型目录查询超时')),timeoutMs)
    abort=()=>reject(signal.reason??error('ABORTED','调用已取消'))
    signal?.addEventListener('abort',abort,{once:true})
  })
  try{return await Promise.race([Promise.resolve().then(fn),gate])}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
}
export async function chooseCoreRoute(llm,selected,options={}) {
  if(!llm||typeof llm.listProviders!=='function'||typeof llm.listModels!=='function')throw error('MODEL_DIRECTORY_UNAVAILABLE','宿主模型目录不可用')
  const providers=await bounded(()=>llm.listProviders(),options)
  if(!Array.isArray(providers)||providers.some(p=>typeof p?.id!=='string'))throw error('MODEL_DIRECTORY_UNAVAILABLE','宿主模型目录格式不兼容')
  if(selected) {
    if(selected.model!==CORE_MODEL||typeof selected.provider!=='string'||!providers.some(p=>p.id===selected.provider))throw error('CORE_MODEL_REQUIRED','纪要固定使用所选本地Huiwen-LM')
    const models=await bounded(()=>llm.listModels(selected.provider,options.signal),options)
    if(!Array.isArray(models)||!models.some(m=>m.id===CORE_MODEL))throw error('CORE_MODEL_UNAVAILABLE','所选提供方未提供Huiwen-LM')
    return Object.freeze({provider:selected.provider,model:CORE_MODEL})
  }
  const routes=[]
  for(const p of providers) {
    let models
    try{models=await bounded(()=>llm.listModels(p.id,options.signal),options)}
    catch(e){if(options.signal?.aborted||e.code==='MODEL_DIRECTORY_TIMEOUT')throw e;continue}
    if(Array.isArray(models)&&models.some(m=>m.id===CORE_MODEL))routes.push({provider:p.id,model:CORE_MODEL})
  }
  if(routes.length!==1)throw error(routes.length?'CORE_MODEL_AMBIGUOUS':'CORE_MODEL_UNAVAILABLE','需准备并明确选择本地Huiwen-LM路由，不回退其它模型')
  return Object.freeze(routes[0])
}
export async function createHostAdapter(llm,selection,options={}) {
  const route=await chooseCoreRoute(llm,selection,options)
  if(typeof llm.prepareCall!=='function')throw error('LLM_RUNTIME_TOO_OLD','宿主缺少绑定模型调用能力')
  const info=typeof llm.resolveModelInfo==='function'?await bounded(()=>llm.resolveModelInfo(route.provider,route.model),options):null
  if(info&&(info.provider!==route.provider||info.id!==route.model))throw error('MODEL_ROUTE_CHANGED','模型元数据与路由不一致')
  const efforts=info?.reasoning?.efforts||[]
  const reasoningEffort=['none','minimal','low'].find(id=>efforts.some(e=>e.id===id))||info?.reasoning?.defaultEffort
  const identity=Object.freeze({...route,reasoningEffort:reasoningEffort??null})
  return {identity,fingerprint:VERSION,async complete({system,user,maxTokens=1536,signal}) {
    signal?.throwIfAborted()
    if(typeof system!=='string'||typeof user!=='string'||!Number.isSafeInteger(maxTokens)||maxTokens<=0)throw error('MODEL_CALL_CONFIG_CHANGED','调用参数不合法')
    const config={...route,temperature:0,maxTokens,...(reasoningEffort?{reasoningEffort}:{})}
    const prepared=await llm.prepareCall(config,signal)
    signal?.throwIfAborted()
    if(prepared?.config?.provider!==route.provider||prepared?.config?.model!==route.model)throw error('MODEL_ROUTE_CHANGED','准备结果改变固定路由')
    if(prepared.config.maxTokens!==maxTokens||prepared.config.temperature!==0||(prepared.config.reasoningEffort??null)!==(reasoningEffort??null))throw error('MODEL_CALL_CONFIG_CHANGED','宿主改变任务预算/参数')
    if(typeof prepared.stream!=='function')throw error('STREAM_PROTOCOL','无合法流接口')
    const window=prepared.context?.contextWindow??4096
    if(!Number.isFinite(window)||window<=0)throw error('MODEL_CALL_CONFIG_CHANGED','上下文预算不合法')
    if(Buffer.byteLength(system+user,'utf8')+maxTokens+512>Math.min(window,8192))throw error('INPUT_BUDGET','超过保守调用预算，需拆分')
    const blocks=new Map();let finish=null,usage=null,deltaTotal=0,finalTotal=0
    for await(const chunk of prepared.stream({...prepared.config,system,messages:[{role:'user',content:[{type:'text',text:user}]}],signal})) {
      signal?.throwIfAborted()
      if(!chunk||typeof chunk.type!=='string')throw error('STREAM_PROTOCOL','流块不合法')
      if(chunk.type==='usage'){usage=chunk.usage;continue}
      if(finish)throw error('STREAM_PROTOCOL','终止后出现额外内容')
      if(chunk.type==='finish'){if(!chunk.reason||typeof chunk.reason.kind!=='string')throw error('STREAM_PROTOCOL','终止块不合法');finish=chunk.reason;continue}
      if(chunk.type==='tool-call-delta'||(chunk.type==='block-end'&&chunk.block?.type==='tool-call'))throw error('UNEXPECTED_TOOL_CALL','不得调用工具')
      if(!['block-start','reasoning-delta','text-delta','block-end'].includes(chunk.type)||!Number.isSafeInteger(chunk.index)||chunk.index<0)throw error('STREAM_PROTOCOL','未知块类型或非法索引')
      if(chunk.type==='block-start') {
        if(!['text','reasoning'].includes(chunk.blockType)||blocks.has(chunk.index))throw error('STREAM_PROTOCOL','非法或重复块开始')
        blocks.set(chunk.index,{deltas:'',kind:chunk.blockType});continue
      }
      const b=blocks.get(chunk.index)||{deltas:''}
      if(b.final!==undefined)throw error('STREAM_PROTOCOL','已完成块再次写入')
      if(chunk.type==='text-delta'||chunk.type==='reasoning-delta') {
        const kind=chunk.type==='text-delta'?'text':'reasoning'
        if(typeof chunk.text!=='string'||(b.kind&&b.kind!==kind))throw error('STREAM_PROTOCOL','增量类型或文本不合法')
        b.kind=kind;deltaTotal+=chunk.text.length;b.deltas+=chunk.text
      } else {
        if(!['text','reasoning'].includes(chunk.block?.type)||typeof chunk.block.text!=='string'||(b.kind&&b.kind!==chunk.block.type))throw error('STREAM_PROTOCOL','终块类型不合法')
        b.kind=chunk.block.type;finalTotal+=chunk.block.text.length;b.final=chunk.block.text
      }
      if(deltaTotal>maxTokens*24||finalTotal>maxTokens*24)throw error('OUTPUT_TRUNCATED','累计输出超过保护预算')
      blocks.set(chunk.index,b)
      if([...blocks.values()].reduce((n,x)=>n+(x.final??x.deltas).length,0)>maxTokens*24)throw error('OUTPUT_TRUNCATED','合并输出超过保护预算')
    }
    signal?.throwIfAborted()
    if(finish?.kind!=='stop')throw error(finish?.kind==='max-tokens'?'OUTPUT_TRUNCATED':'LLM_UNFINISHED','模型缺少正常终止回执')
    const text=[...blocks.entries()].sort((a,b)=>a[0]-b[0]).filter(([,b])=>b.kind!=='reasoning').map(([,b])=>b.final??b.deltas).join('').trim()
    if(!text)throw error('LLM_EMPTY','模型未返回内容')
    return {text,finish:'stop',usage,route:identity}
  }}
}
