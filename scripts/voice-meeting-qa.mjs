import {timingSafeEqual} from 'node:crypto'
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status})
const DAY=86400000,SHIFT=8*3600000
const date=value=>typeof value==='string'&&value.trim()?Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(value)?value:value.replace(' ','T')+'+08:00'):NaN
function week(now,offset){const local=new Date(+now+SHIFT),day=(local.getUTCDay()+6)%7;return Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-SHIFT-day*DAY+offset*7*DAY}
const label=t=>new Date(t+SHIFT).toISOString().slice(0,10)
function chineseOrdinal(text){
 const digit=value=>'一二三四五六七八九'.indexOf(value)+1
 if(/^[一二三四五六七八九]$/.test(text))return digit(text)
 const tens=text.match(/^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/)
 return tens?(tens[1]?digit(tens[1]):1)*10+(tens[2]?digit(tens[2]):0):0
}
export function createVoiceMeetingQa({loadMeetings,ask,facts,save,now=()=>new Date()}){
 const sessions=new Map()
 async function perform(input,context){
  const text=input.text.replace(/^\s*惠宝[，,。\s]*/,'').trim()
  const follow=context.question&&/^(?:(?:那|那么)[，,\s]*(?:[上下本这]周|(?:会议)?(?:内容|议题|结论|决定|行动|待办)|第[一二三四五六七八九十\d]+[场个])|这些|它们?|这场|其中|第[一二三四五六七八九十\d]+[场个]|再(?:说|讲|详细)|还有(?:哪些|什么)(?:议题|决定|结论|待办))/.test(text)
  if(!/会议|纪要/.test(text)&&!follow)return {handled:false}
  if(/^(开启|结束|开始|停止|生成|制作|删除|新建|修改|取消)/.test(text))return {handled:false}
  const statistical=/多少|几[场个次]|有哪些|哪些会议|会议列表|列出|会议(?:的)?(?:数量|总数)/.test(text)||follow&&/^(那|那么)?[上下本这]周(?:呢)?[？?。\s]*$/.test(text)
  let range=context.range
  if(/上周/.test(text))range=week(now(),-1)
  else if(/本周|这周/.test(text))range=week(now(),0)
  else if(/下周/.test(text))range=week(now(),1)
  else if(!follow)range=undefined
  const all=[...new Map((await loadMeetings()).map(m=>[m.id,m])).values()]
  const missing=all.filter(m=>!Number.isFinite(date(m.start_time))).length
  const meetings=all.filter(m=>range===undefined||date(m.start_time)>=range&&date(m.start_time)<range+7*DAY).sort((a,b)=>(date(a.start_time)||0)-(date(b.start_time)||0)||a.id.localeCompare(b.id))
  let result,selected=follow&&context.selection&&range===context.range?meetings.filter(m=>context.selection.includes(m.id)):meetings
  if(statistical){
   const period=range===undefined?'当前可见会议':`${label(range)}至${label(range+7*DAY)}（北京时间，结束日不含）`
   const text=`${period}共${meetings.length}场会议。${missing?`另有${missing}场缺少有效开始日期，${range===undefined?'已列入可见总数':'未计入该日期范围'}。`:''}`+(meetings.length?'\n'+meetings.map((m,i)=>`${i+1}、${m.title||'未命名会议'}${m.start_time?'，'+m.start_time:''}`).join('\n'):'')
   result=await facts({text,meetings})
  }else{
   const ordinal=text.match(/第([一二三四五六七八九十\d]+)[场个]/)
   if(ordinal){const value=Number(ordinal[1])||chineseOrdinal(ordinal[1]),id=context.list?.[value-1];selected=meetings.filter(m=>m.id===id);if(!selected.length)return {handled:true,reply:'当前会话中没有这场会议，请先查询会议列表。',sources:[]}}
   const question=follow?`前题：${context.question}\n前次回答：${context.answer||''}\n本次追问：${text}${range===undefined?'':`\n仅限北京时间${label(range)}至${label(range+7*DAY)}的会议。`}`:text
   result=await ask({question,meetingIds:selected.map(m=>m.id)})
  }
  const qaSessionId=await save({question:input.text,session_id:context.qaSessionId},result)
  context.question=text;context.answer=statistical?undefined:result.text;context.selection=statistical?undefined:selected.map(m=>m.id);context.range=range;context.qaSessionId=qaSessionId
  if(statistical)context.list=meetings.map(m=>m.id)
  const spoken=result.text.replace(/〔S\d+〕/g,'').replace(/\s+/g,' ').trim()
  const reply=statistical?spoken.split(/\n|1、/)[0]:spoken.length>240?spoken.slice(0,240)+'。完整回答请查看会议问答。':spoken
  return {handled:true,reply,answer:result.text,qaSessionId,sources:result.sources,qaTurnId:result.qaTurnId,...(statistical?{count:meetings.length,range:range===undefined?null:{start:label(range),end:label(range+7*DAY)},missingDates:missing}:{})}
 }
 return {query(input){
  if(!input||typeof input.text!=='string'||!input.text.trim()||input.text.length>1000||typeof input.requestId!=='string'||!input.requestId||input.requestId.length>128||typeof input.deviceId!=='string'||!input.deviceId||!/^(?:session-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.sessionId||''))throw fail('QA_REQUEST_INVALID')
  const key=input.deviceId+':'+input.sessionId
  let context=sessions.get(key);if(!context){context={receipts:new Map(),tail:Promise.resolve()};sessions.set(key,context)}
  if(context.receipts.has(input.requestId))return context.receipts.get(input.requestId)
  const run=context.tail.then(()=>perform(input,context));context.tail=run.catch(()=>{});context.receipts.set(input.requestId,run);return run
 },clear(){sessions.clear()}}
}

export function createVoiceQaInternalHandler({readKey,binding,query}){
 return async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
  try{
   if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress))throw fail('LOOPBACK_REQUIRED',403)
   const expected=Buffer.from((await readKey()).trim()),supplied=req.headers['x-meeting-control-key']
   if(expected.length<32||typeof supplied!=='string'||Buffer.byteLength(supplied)!==expected.length||!timingSafeEqual(Buffer.from(supplied),expected))throw fail('SERVICE_AUTH_REQUIRED',403)
   if(req.method!=='POST')throw fail('METHOD_NOT_ALLOWED',405)
   let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>8192)throw fail('BODY_TOO_LARGE',413);chunks.push(part)}
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString())}catch{throw fail('INPUT_INVALID')}
   const bound=await binding()
   if(!input||input.deviceId!==bound.deviceId)throw fail('WRONG_DEVICE',403)
   if(Array.isArray(input)||Object.keys(input).some(k=>!['deviceId','text','requestId','sessionId'].includes(k)))throw fail('INPUT_INVALID')
   send(200,await query(input))
  }catch(e){send(e.status||503,{error:e.code||'VOICE_QA_UNAVAILABLE'})}
 }
}
