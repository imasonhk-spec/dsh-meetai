/**
 * dsh-meetai — 会议助手插件（浏览器半）
 *
 * 主内容区完整应用（main key = cap:meeting）：左侧插件自有深色导航 rail
 * （品牌区 / 会议日程 / 新建会议 / 会议纪要 / 会议问答 / 统计卡 / 返回会话，
 * 参考 meetai.html 原型，固定配色不随 DSH 主题）+ 右侧正文（mt-body，DSH 主题 token）。
 * 正文页签：会议日程（列表/周/月） · 新建会议（AI 议程） ·
 *   会议纪要（实时录音转写 / 上传录音 / 粘贴文本 → 生成/编辑/归档） · 会议问答（rail 二级导航：
 *   新建对话 / 历史对话；单一对话框 = POST /qa SSE 流式回答 + 📎 附件拖拽上传 + 模型选择 + 提示 chips）。
 * 挂载时若 DSH 侧栏处于展开态则收起一次（仅此一次；除此之外绝不触碰 DSH 左侧导航）。
 *
 * 入口：
 *   - sidebar.panellist 行（cap:meeting，图标 IconAlarmClockOutlineRegular）；
 *   - 监听 cappacks:open-meeting（detail.section ∈ 会议日程/会议纪要/会议问答 或 null）→
 *     模块级 CustomEvent 'meetai:navigate' 桥接 + ctx.layout.selectPanel('cap:meeting')。
 *
 * 仅依赖 seed 表模块：react、@deepseek-ai/dsh-client-ui-primitives。
 * 正文配色全部使用 --dsw-alias-*（已核对 checkout design-platform.css），深浅主题自适应。
 */
window.__ModuleLoader__.load({
  id: 'dsh-meetai',
  factory(require) {
    const React = require('react')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const API = '/api/meeting-assistant'
// Inline into classic factory; no dynamic imports, job submissions or source writes.
function SplitLegacyPanel({meetingId,locked,onLatest,showToast}){
 const [workspace,setWorkspace]=useState(null),[recordingId,setRecordingId]=useState(''),[cues,setCues]=useState([]),[text,setText]=useState(''),[cursor,setCursor]=useState(null),[clock,setClock]=useState(0),[error,setError]=useState(''),[history,setHistory]=useState(null),[reload,setReload]=useState(0)
 const audio=useRef(null),axis=useRef(''),pending=useRef(null),requestEpoch=useRef(0),historyEpoch=useRef(0),pageBusy=useRef(false)
 const owner=JSON.stringify([meetingId,recordingId,reload]);axis.current=owner
 const recording=(workspace?.legacyRecordings||[]).find(row=>row.recording_id===recordingId)
 const url=recording?.mediaURL===API+'/recordings/'+encodeURIComponent(recordingId)+'/file'?recording.mediaURL:null
 useEffect(()=>{let live=true;setWorkspace(null);setRecordingId('');setError('');setHistory(null);historyEpoch.current++;if(meetingId)request('/meetings/'+encodeURIComponent(meetingId)+'/workspace').then(value=>{if(live){setWorkspace(value);setRecordingId(value.legacyRecordings?.[0]?.recording_id||'')}}).catch(e=>{if(live)setError(e.message)});return()=>{live=false;requestEpoch.current++;historyEpoch.current++;pending.current=null}},[meetingId,reload])
 async function loadCues(next){const key=owner,epoch=++requestEpoch.current;if(!recording?.timingsAvailable)return;try{const data=await request('/transcripts/'+encodeURIComponent(recording.transcriptVersionId)+'/segments?meetingId='+encodeURIComponent(meetingId)+'&level=sentence&limit=100'+(next?'&cursor='+encodeURIComponent(next):''));if(axis.current===key&&requestEpoch.current===epoch){setCues(data.items||[]);setCursor(data.nextCursor||null)}}catch(e){if(axis.current===key&&requestEpoch.current===epoch){setCues([]);setCursor(null);setError('时间信息不可用，不提供定位：'+e.message)}}}
 useEffect(()=>{let live=true;const key=owner;requestEpoch.current++;setCues([]);setText('');setCursor(null);setClock(0);setError('');pending.current=null;if(recording?.transcriptVersionId){request('/transcripts/'+encodeURIComponent(recording.transcriptVersionId)+'?meetingId='+encodeURIComponent(meetingId)).then(data=>{if(live&&axis.current===key)setText(data.text||'')}).catch(e=>{if(live&&axis.current===key)setError(e.message)});if(recording.timingsAvailable)void loadCues(null)}return()=>{live=false;requestEpoch.current++;pending.current=null}},[owner,recording?.transcriptVersionId,recording?.timingsAvailable])
 function applySeek(){const p=pending.current,a=audio.current;if(!p||p.owner!==axis.current||owner!==axis.current||!a||a.readyState<1||!url||a.getAttribute('data-recording-id')!==recordingId||a.currentSrc&&a.currentSrc!==new URL(url,window.location.href).href)return;if(!Number.isFinite(a.duration)||p.ms>a.duration*1000){pending.current=null;setError('定位时间超出或未能确认录音时长，未执行跳转。');return}a.currentTime=p.ms/1000;setClock(a.currentTime);pending.current=null}
 function seek(ms){if(!url||!Number.isFinite(ms)||ms<0)return;pending.current={owner,ms};applySeek()}
 async function preview(row){const key=owner,epoch=++historyEpoch.current;try{const data=await request('/minutes-revisions/'+encodeURIComponent(row.id)+'?meetingId='+encodeURIComponent(meetingId));if(axis.current===key&&historyEpoch.current===epoch)setHistory(data)}catch(e){if(axis.current===key&&historyEpoch.current===epoch)showToast('历史读取失败，当前Word未替换：'+e.message,'error')}}
 async function more(kind){const next=workspace?.pages?.[kind]?.nextCursor,key=owner;if(!next||pageBusy.current)return;pageBusy.current=true;try{const data=await request('/meetings/'+encodeURIComponent(meetingId)+'/workspace?'+kind+'Cursor='+encodeURIComponent(next));if(axis.current===key)setWorkspace(value=>({...value,[kind]:[...(value[kind]||[]),...(data[kind]||[])],pages:{...value.pages,[kind]:data.pages?.[kind]}}))}catch(e){if(axis.current===key)setError(e.message)}finally{pageBusy.current=false}}
 const valid=row=>Number.isFinite(row.startMs)&&Number.isFinite(row.endMs)&&row.startMs>=0&&row.endMs>row.startMs&&row.timingProvenance&&row.timingProvenance!=='unavailable',active=cues.find(row=>valid(row)&&clock*1000>=row.startMs&&clock*1000<row.endMs)
 if(!meetingId)return null
 return h('section',{className:'mt-card mt-stack','aria-label':'独立会议资产与历史'},h('h3',null,'会议资产与历史'),h('p',{className:'mt-muted'},'独立验收版；不执行新版纪要、转写或裁剪任务。'),h('button',{className:'mt-btn small',disabled:locked,onClick:()=>setReload(value=>value+1)},'刷新资产'),error?h('div',{role:'alert'},'读取失败不代表没有历史：',error):null,
 (workspace?.legacyMinutes||[]).map(row=>h('div',{key:row.minutesId},row.title,' · v'+row.version,' ',h('button',{className:'mt-btn small',disabled:locked,onClick:()=>onLatest(row.logicalMinutesId)},'载入最新人工稿'))),workspace?.pages?.legacyMinutes?.nextCursor?h('button',{onClick:()=>more('legacyMinutes')},'更多纪要'):null,
 (workspace?.minutes||[]).map(row=>h('button',{key:row.id,onClick:()=>preview(row)},'只读历史 v'+row.version)),workspace?.pages?.minutes?.nextCursor?h('button',{onClick:()=>more('minutes')},'更多历史版本'):null,history?h('details',{open:true},h('summary',null,'只读历史；不替换当前Word'),h('pre',{style:{whiteSpace:'pre-wrap'}},history.content)):null,
 h('select',{value:recordingId,disabled:locked,onChange:event=>{pending.current=null;setRecordingId(event.target.value)}},h('option',{value:''},'选择已保存录音'),(workspace?.legacyRecordings||[]).map(row=>h('option',{key:row.recording_id,value:row.recording_id},row.filename))),workspace?.pages?.legacyRecordings?.nextCursor?h('button',{onClick:()=>more('legacyRecordings')},'更多录音'):null,
 url?h('audio',{key:owner,ref:audio,src:url,controls:true,preload:'metadata','data-recording-id':recordingId,onLoadedMetadata:applySeek,onTimeUpdate:event=>{if(axis.current===owner)setClock(event.currentTarget.currentTime)},style:{width:'100%'}}):null,
 h('p',{role:'note'},recording?.timingsAvailable?'原文显式句级区间，精度为秒；需人工复核，准确性未认证，没有逐字时间。':'无可用真实时间：全文可读，定位和高亮禁用。'),
 h('div',{style:{maxHeight:260,overflow:'auto'}},cues.map(row=>h('div',{key:row.id,'aria-current':active?.id===row.id?'true':undefined,style:{padding:8,border:active?.id===row.id?'2px solid currentColor':'2px solid transparent'}},h('button',{disabled:!url||!valid(row),onClick:()=>seek(row.startMs)},valid(row)?Math.floor(row.startMs/1000)+'秒 · 定位':'时间不可用'),' ',row.speakerId,' ',row.text))),cursor?h('button',{onClick:()=>loadCues(cursor)},'下一页字幕（100句）'):null,
 text?h('details',null,h('summary',null,'已保存转写全文（只读）'),h('pre',{style:{whiteSpace:'pre-wrap'}},text)):null)
}


    // Presentation only: never modify the authoritative transcript/FULL TEXT.
    function formalCaptionEntries(transcript) {
      const lines = String(transcript || '').split(/\r?\n/).filter(line => line.trim())
      const timed = lines.map(line => {
        const match = line.match(/^\[([\d:]+)-([\d:]+)\]\s*(?:SPK[^:]*:\s*)?(.*)$/)
        if (!match) return null
        const millis = value => value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000
        return { startMs: millis(match[1]), endMs: millis(match[2]), text: match[3].trim() }
      }).filter(row => row && row.text && Number.isFinite(row.startMs) && Number.isFinite(row.endMs))
      const rows = timed.length ? timed : lines.map(line => ({ text: line.replace(/^\[FULL TEXT\]\s*/, '').trim() })).filter(row => row.text)
      return rows.map((row, index) => ({ ...row, utteranceId: `formal-${index}`, speakerId: null,
        kind: 'formal', confidenceState: 'unknown', source: '正式转写' }))
    }
    const NAV_EV = 'meetai:navigate'
    const OPEN_EV = 'cappacks:open-meeting'
    let pendingNav = null
// This function is compiled into the existing classic Client factory, not loaded as another plugin.
function startServerLocalCapture(stream, handlers) {
  const controller = new AbortController()
  let audio, node, source, gain, session, running = true, stopping = false, draining = false, closed = false
  let samples = [], queue = [], seq = 0, sampleOffset = 0, carry = new Float32Array(0), phase = 0
  const cleanupAudio = () => {
    if (node) node.onaudioprocess = null
    for (const item of [node, source, gain]) { try { item?.disconnect() } catch {} }
    if (audio && audio.state !== 'closed') audio.close().catch(() => {})
  }
  const deleteSession = () => {
    if (session && !closed) {
      closed = true
      fetch(`${API}/local-captions/session/${encodeURIComponent(session.sessionId)}`, {
        method: 'DELETE', credentials: 'same-origin', headers: { 'X-Caption-Token': session.token },
      }).catch(() => {})
    }
  }
  const fail = (message) => {
    if (!running && closed) return
    running = false; stopping = true; queue = []; samples = []
    controller.abort(); cleanupAudio(); deleteSession()
    handlers.error(message || '本地字幕失败；保持本地模式，完整录音继续。')
  }
  const packet = () => {
    if (!samples.length) return
    if (queue.length >= 4) { fail('本地字幕处理积压超过一分钟，已停止字幕识别；未切换浏览器，完整录音继续。'); return }
    const buffer = new ArrayBuffer(samples.length * 2), view = new DataView(buffer)
    samples.forEach((value, index) => view.setInt16(index * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true))
    queue.push({ buffer, seq: seq++, startMs: Math.floor(sampleOffset / 16) })
    sampleOffset += samples.length; samples = []
    void drain()
  }
  async function drain() {
    if (!session || draining || !running) return
    draining = true
    try {
      while (queue.length && running) {
        const item = queue[0]
        const response = await fetch(`${API}/local-captions/session/${encodeURIComponent(session.sessionId)}/chunk?seq=${item.seq}&startMs=${item.startMs}`, {
          method: 'POST', credentials: 'same-origin', signal: controller.signal,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Caption-Token': session.token }, body: item.buffer,
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.reason || data.message || data.error || '服务器本地识别失败')
        if (!running) break
        queue.shift()
        handlers.entries(Array.isArray(data.entries) ? data.entries : [])
        handlers.status(stopping ? '本地字幕尾段已处理；正式转写仍依据完整录音。' : '服务器本地字幕已更新；不使用浏览器识别服务。')
      }
      if (stopping && !queue.length) { running = false; deleteSession() }
    } catch (error) { if (running) fail(error.message) }
    finally { draining = false }
  }
  void (async () => {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext
      if (!Audio) throw new Error('浏览器不支持本地字幕音频采集；完整录音继续。')
      audio = new Audio({ sampleRate: 16000 })
      await audio.resume()
      if (!running || stopping) { cleanupAudio(); return }
      source = audio.createMediaStreamSource(stream)
      node = audio.createScriptProcessor(4096, 1, 1)
      gain = audio.createGain(); gain.gain.value = 0
      node.onaudioprocess = event => {
        if (!running || stopping) return
        const input = event.inputBuffer.getChannelData(0), joined = new Float32Array(carry.length + input.length)
        joined.set(carry); joined.set(input, carry.length)
        const step = audio.sampleRate / 16000
        while (phase + 1 < joined.length) {
          const i = Math.floor(phase), f = phase - i
          samples.push(joined[i] * (1 - f) + joined[i + 1] * f)
          phase += step
          if (samples.length === 16000 * 15) packet()
          if (!running) return
        }
        phase -= joined.length - 1; carry = joined.slice(-1)
      }
      source.connect(node); node.connect(gain); gain.connect(audio.destination)
      handlers.status('服务器本地字幕启动中；每约15秒提交一段，模型处理可能延迟，完整录音独立进行。')
      const response = await fetch(`${API}/local-captions/session`, {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.reason || data.message || data.error || '本地字幕会话启动失败')
      if (!data.sessionId || !data.token || data.sampleRate !== 16000) throw new Error('本地字幕协议不匹配')
      session = data
      if (!running) { deleteSession(); return }
      if (stopping && !queue.length) { running = false; deleteSession(); return }
      await drain()
    } catch (error) { if (running) fail(error.message) }
  })()
  return {
    stop() {
      if (stopping) return
      stopping = true; cleanupAudio(); packet(); void drain()
      if (session && !queue.length && !draining) { running = false; deleteSession() }
    },
    cancel() { running = false; stopping = true; controller.abort(); cleanupAudio(); queue = []; samples = []; deleteSession() },
  }
}

    // 会议问答附件：扩展名白名单与单文件大小上限（与服务端 /upload 契约一致）
    const UPLOAD_RE = /\.(pdf|docx|xlsx|txt|md)$/i
    const UPLOAD_MAX = 30 * 1024 * 1024
    // 「新建会议」提示 chip 插入输入框的模板（用户补全后发送，服务端 agent 调 meeting_create 建会）
    const MEETING_TEMPLATE = ['【新建会议】', '主题：', '开始时间：（如 2026-09-29 14:00）', '结束时间：', '地点：', '参会人：', '议程：', '补充说明：'].join('\n')

    /* ---------------------------------------------------------------- */
    /* 样式（单条 <style> 注入；正文全部 --dsw-alias-* 变量；rail 固定深色） */
    /* ---------------------------------------------------------------- */

    const CSS = `
.mt-app{height:100%;min-height:0;display:flex;flex-direction:row;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.6 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;overflow:hidden}
.mt-app *{box-sizing:border-box}
.mt-app button{font:inherit;color:inherit}
.mt-app ::placeholder{color:var(--dsw-alias-label-tertiary)}
/* —— 插件自有导航 rail（配色随 DSH「通用设置 → 外观」主题令牌联动，明暗自动切换；结构参考 meetai.html 原型侧栏）—— */
.mt-rail{width:232px;flex:none;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);overflow-y:auto;overflow-x:hidden}
.mt-brand{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.mt-brandicon{width:34px;height:34px;flex:none;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;color:#fff;background:linear-gradient(45deg,var(--dsw-static-blue-600),var(--dsw-static-deepseek-450));box-shadow:0 4px 12px rgba(37,99,235,.28)}
.mt-brandname{font-size:14px;font-weight:750;color:var(--dsw-alias-label-primary);letter-spacing:.01em;white-space:nowrap}
.mt-brandtag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:5px;font-size:10px;font-weight:650;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);vertical-align:1.5px}
.mt-brandsub{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-railnav{flex:1;min-height:0;display:flex;flex-direction:column;gap:4px;padding:10px;overflow-y:auto}
.mt-railsection{padding:2px 10px 5px;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.mt-railitem{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border:none;background:none;color:var(--dsw-alias-label-secondary);padding:9px 11px;border-radius:10px;font-size:13px;font-weight:550;cursor:pointer;text-align:left}
.mt-railitem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-railitem.active{background:var(--dsw-static-blue-600);color:#fff;font-weight:650;box-shadow:0 4px 12px rgba(37,99,235,.28)}
.mt-railitem .ic{display:flex;align-items:center;gap:9px;min-width:0}
.mt-railitem .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-railbadge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 6px;border-radius:999px;font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);flex:none}
.mt-railitem.active .mt-railbadge{background:rgba(255,255,255,.22);color:#fff}
.mt-railbadge.amber{background:rgba(245,158,11,.18);color:var(--dsw-alias-state-warn-label)}
.mt-railitem.active .mt-railbadge.amber{background:rgba(255,255,255,.22);color:#fff}
.mt-railtag{display:inline-flex;align-items:center;padding:1px 6px;border-radius:6px;font-size:10px;font-weight:650;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);flex:none}
.mt-railitem.active .mt-railtag{color:rgba(255,255,255,.85);border-color:rgba(255,255,255,.35);background:rgba(255,255,255,.14)}
.mt-raildot{position:relative;width:8px;height:8px;flex:none}
.mt-raildot::after{content:'';position:absolute;inset:0;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.mt-raildot::before{content:'';position:absolute;inset:-2px;border-radius:50%;background:var(--dsw-alias-state-success-secondary);opacity:.75;animation:mt-ping 1.6s cubic-bezier(0,0,.2,1) infinite}
@keyframes mt-ping{75%,100%{transform:scale(2.2);opacity:0}}
.mt-railstats{margin-top:8px;padding:11px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.mt-railstats .cap{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:650;color:var(--dsw-alias-label-primary);margin-bottom:7px}
.mt-railstats .live{display:inline-flex;align-items:center;gap:4px;margin-left:auto;color:var(--dsw-alias-state-success-primary);font-weight:600}
.mt-railstats .live i{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.mt-statrow{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2.5px 0}
.mt-statrow b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:700}
.mt-statrow b.indigo{color:var(--dsw-static-blue-600)}
.mt-railback{margin:8px 10px 12px;display:flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);border-radius:10px;padding:8px 10px;cursor:pointer;font-size:12.5px;flex:none;white-space:nowrap}
.mt-railback:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-menu{display:none;align-items:center;justify-content:center;width:32px;height:32px;flex:none;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:15px;line-height:1}
.mt-menu:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-menu:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
/* ===== 窄屏抽屉化（mtNavDrawer-20261005）：不再常驻 60px 图标条，侧栏改为屏外抽屉 ===== */
@media (max-width:900px){
  .mt-app aside.mt-rail{width:min(280px,86vw);position:absolute;left:0;top:0;bottom:0;z-index:1202;flex:none;transform:translateX(-110%);transition:transform .16s ease;will-change:transform;box-shadow:8px 0 24px rgba(0,0,0,.18);touch-action:pan-y;overscroll-behavior:contain}
  .mt-app.mt-rail-expanded .mt-rail{transform:translateX(0)}
  .mt-app.mt-rail-lock .mt-body{overflow:hidden}
  .mt-app .mt-menu{display:inline-flex}
  .mt-app .mt-grow{min-width:150px}
  .mt-app .mt-session.active{font-weight:650;box-shadow:inset 3px 0 0 var(--dsw-static-blue-600);border-radius:0 9px 9px 0}
}
.mt-kicker{font-size:10px;letter-spacing:.16em;text-transform:uppercase;font-weight:750;color:var(--dsw-alias-state-business-primary)}
.mt-body{flex:1;min-width:0;min-height:0;overflow:auto;padding:15px 20px 44px}
.mt-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:13px 15px}
.mt-card+.mt-card{margin-top:10px}
.mt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mt-between{justify-content:space-between}
.mt-stack{display:grid;gap:10px}
.mt-grow{flex:1;min-width:0}
.mt-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mt-secondary{color:var(--dsw-alias-label-secondary);font-size:12px}
.mt-h3{font-size:14px;font-weight:700;margin:0 0 10px}
.mt-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:6px 12px;cursor:pointer;line-height:1.4;white-space:nowrap}
.mt-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-btn:disabled{opacity:.5;cursor:not-allowed}
.mt-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:650}
.mt-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.mt-btn.success{background:var(--dsw-alias-state-success-primary);border-color:transparent;color:#fff;font-weight:650}
.mt-btn.success:hover{opacity:.9}
.mt-btn.small{padding:3px 9px;font-size:12px;border-radius:7px}
.mt-btn.ghost{border-color:transparent;background:none;color:var(--dsw-alias-label-secondary)}
.mt-btn.ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.mt-input,.mt-select,.mt-textarea{width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.mt-input:focus,.mt-select:focus,.mt-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.mt-textarea{min-height:120px;resize:vertical;line-height:1.6}
.mt-select{width:auto;min-width:130px}
.mt-field{display:grid;gap:5px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.mt-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.mt-grid3{display:grid;grid-template-columns:130px minmax(0,1fr) 150px auto;gap:8px;align-items:center}
@media (max-width:860px){.mt-grid3{grid-template-columns:1fr;gap:6px}.mt-grid2{grid-template-columns:1fr}}
.mt-pill{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:650;border:1px solid transparent;white-space:nowrap;font-variant-numeric:tabular-nums;letter-spacing:.01em}
.mt-pill.blue{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.mt-pill.green{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.mt-pill.amber{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));background:var(--dsw-alias-state-warn-tertiary)}
.mt-pill.gray{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3)}
.mt-pill.red{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.mt-breathe{width:7px;height:7px;border-radius:50%;background:currentColor;animation:mt-breathe 1.6s ease-in-out infinite}
@keyframes mt-breathe{0%,100%{opacity:1}50%{opacity:.35}}
.mt-star{border:none;background:none;cursor:pointer;font-size:16px;line-height:1;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));padding:1px 3px}
.mt-star.on{color:var(--dsw-alias-state-warn-primary)}
.mt-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 9px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.mt-linkchip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 10px;font-size:11.5px;color:var(--dsw-alias-link);background:var(--dsw-alias-bg-layer-2);cursor:pointer;max-width:100%}
.mt-linkchip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-cite{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;margin:0 2px;border:none;border-radius:5px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:10.5px;font-weight:700;cursor:pointer;vertical-align:1px}
.mt-cite:hover{outline:1px solid var(--dsw-alias-state-business-primary)}
.mt-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.mt-seg button{border:none;background:none;padding:5px 12px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mt-seg button[aria-pressed=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:700}
.mt-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;row-gap:8px}
.mt-toggle{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:5px 11px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mt-toggle[aria-pressed=true]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);font-weight:650}
.mt-cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
.mt-calhead{font-size:11px;font-weight:700;color:var(--dsw-alias-label-tertiary);text-align:center;padding:2px 0 6px}
.mt-cell{min-height:78px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:4px 5px;background:var(--dsw-alias-bg-layer-1);position:relative;overflow:visible;transition:border-color .15s ease}
.mt-cell:hover{border-color:var(--dsw-alias-border-l2)}
.mt-cell.dim{opacity:.55}
.mt-cell.today{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}
.mt-daynum{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:650}
.mt-cell.today .mt-daynum{color:var(--dsw-alias-state-business-primary)}
.mt-ev{display:block;width:100%;text-align:left;border:none;border-left:3px solid var(--dsw-static-blue-600);background:var(--dsw-alias-interactive-bg-hover);border-radius:6px;padding:2.5px 7px;margin-top:3px;font-size:11px;font-weight:550;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .15s ease}
.mt-ev:hover{background:var(--dsw-alias-interactive-bg-active)}
.mt-ev.pinned{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));border-left-color:var(--dsw-alias-state-warn-primary)}
.mt-evmore{margin-top:3px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.mt-pop{display:none;position:absolute;z-index:30;top:calc(100% + 4px);left:0;width:230px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 11px;box-shadow:0 12px 32px rgba(0,0,0,.22)}
.mt-cell:hover .mt-pop{display:block}
.mt-pop .mt-ev{white-space:normal}
.mt-tcard{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start}
@media (max-width:960px){.mt-tcard{grid-template-columns:1fr}}
.mt-tplgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mt-tpl{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:9px 11px;text-align:left;cursor:pointer}
.mt-tpl:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-tpl[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.mt-tpl b{display:block;font-size:12.5px}
.mt-tpl span{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:1px}
.mt-fp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;color:var(--dsw-alias-label-secondary);user-select:all}
.mt-todo{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mt-todo:last-child{border-bottom:none}
.mt-todo input[type=checkbox]{margin-top:3px;accent-color:var(--dsw-alias-state-business-primary)}
.mt-todo .done{text-decoration:line-through;color:var(--dsw-alias-label-tertiary)}
.mt-msgs{display:flex;flex-direction:column;gap:12px;overflow:auto;min-height:0;flex:1;padding:4px 2px 10px}
.mt-bubble{max-width:82%;border-radius:12px;padding:9px 13px;white-space:pre-wrap;word-break:break-word}
.mt-bubble.user{align-self:flex-end;background:var(--dsw-alias-interactive-bg-active);border:1px solid var(--dsw-alias-border-l1)}
.mt-bubble.ai{align-self:flex-start;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.mt-msgsrc{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.mt-session{display:block;width:100%;text-align:left;border:1px solid transparent;background:none;border-radius:9px;padding:7px 9px;cursor:pointer}
.mt-session:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-session.active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.mt-session b{display:block;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-session span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mt-welcome{flex:1;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:18px;text-align:center;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;align-items:center;justify-content:center}
.mt-welcome .q{display:inline-block;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:6px 14px;margin:5px 4px 0;cursor:pointer;font-size:12px}
.mt-welcome .q:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary)}
/* 底部停靠区（sticky 吸底）：新建会议标签 + 模型选择 + 输入栏 + 拖拽把手打包常驻可视区，
   对话框高于视口时无需滚动即可输入与调整高度 */
.mt-askdock{position:sticky;bottom:0;z-index:5;flex:none;display:flex;flex-direction:column;gap:8px}
.mt-asksub{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:none}
.mt-inputbar{display:flex;gap:8px;align-items:flex-end;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:8px;flex:none}
.mt-resizer{flex:none;height:14px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;border-radius:8px;touch-action:none}
.mt-resizer .grip{width:46px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background .15s ease,width .15s ease}
.mt-resizer:hover .grip,.mt-resizer:focus-visible .grip{background:var(--dsw-alias-state-business-primary);width:68px}
.mt-inputbar textarea{flex:1;min-height:40px;max-height:120px;border:none;background:none;resize:none;outline:none;color:var(--dsw-alias-label-primary);font:inherit}
.mt-modal-mask{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;z-index:80;padding:20px}
.mt-modal{width:min(760px,94vw);max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px 20px;box-shadow:0 18px 50px rgba(0,0,0,.28)}
.mt-modal.narrow{width:min(560px,94vw)}
.mt-toastwrap{position:fixed;right:18px;bottom:18px;display:grid;gap:8px;z-index:99;max-width:340px}
.mt-toast{background:var(--dsw-alias-toast-bg);color:#fff;border-radius:10px;padding:9px 14px;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.25);border-left:3px solid var(--dsw-alias-label-tertiary);word-break:break-word}
.mt-toast.success{border-left-color:var(--dsw-alias-state-success-primary)}
.mt-toast.error{border-left-color:var(--dsw-alias-state-error-primary)}
.mt-toast.warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.mt-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;padding:32px 20px;text-align:center;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}
.mt-drop{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:14px;text-align:center;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:var(--dsw-alias-bg-layer-2)}
.mt-drop:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-secondary)}
.mt-file{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.mt-file:last-child{border-bottom:none}
.mt-file .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-agendaline{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12.5px}
.mt-agendaline:last-child{border-bottom:none}
.mt-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mt-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:mt-spin .8s linear infinite;vertical-align:-2px}
@keyframes mt-spin{to{transform:rotate(360deg)}}
.mt-notice{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border-radius:9px;padding:7px 12px;font-size:12.5px;margin-bottom:10px}
/* —— 会议纪要：三来源模式（实时录音 / 上传录音 / 粘贴文本）—— */
.mt-recdot{width:10px;height:10px;flex:none;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:mt-breathe 1.2s ease-in-out infinite}
.mt-livewrap{max-height:190px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);padding:8px 10px;font-size:12px;line-height:1.8}
.mt-liveline{white-space:pre-wrap;word-break:break-word}
.mt-liveline.interim{color:var(--dsw-alias-label-tertiary);font-style:italic}
.mt-recfile{display:grid;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:9px 11px}
.mt-recfile .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}
.mt-progress{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.mt-progress i{display:block;height:100%;background:var(--dsw-alias-state-business-primary);transition:width .2s ease}
/* —— 问答 v0.2.5：rail 二级导航（历史=标签+会话列表）/ 全量资产+模型+新建会议同排顶栏 / 可拖拽调高对话框 —— */
.mt-railarrow{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;border-radius:5px;color:var(--dsw-alias-label-tertiary);transition:transform .16s ease,background .15s ease,color .15s ease}
.mt-railarrow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-railitem.active .mt-railarrow{color:rgba(255,255,255,.85)}
.mt-railitem.active .mt-railarrow:hover{background:rgba(255,255,255,.16);color:#fff}
.mt-railarrow.open{transform:rotate(90deg)}
.mt-railsub{position:relative;display:flex;align-items:center;width:calc(100% - 16px);margin-left:16px;border:none;background:none;color:var(--dsw-alias-label-secondary);padding:7px 10px;border-radius:9px;font-size:12.5px;font-weight:500;cursor:pointer;text-align:left}
.mt-railsub:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-railsub.active{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-weight:650}
.mt-railsub .ic{display:flex;align-items:center;gap:8px;min-width:0}
.mt-railsub .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 「历史对话」标签：非按钮的分组标题，其下平铺全部历史会话 */
.mt-raillabel{display:flex;align-items:center;gap:7px;width:calc(100% - 16px);margin-left:16px;padding:8px 10px 3px;font-size:11px;font-weight:750;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}
.mt-raillabel .n{margin-left:auto;font-size:10.5px;font-weight:700;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 7px;line-height:16px}
.mt-railsessrow{position:relative;display:flex;align-items:center;width:calc(100% - 16px);margin-left:16px}
.mt-railsessrow .mt-railsession{flex:1;min-width:0;padding-right:28px}
.mt-railsessdel{position:absolute;right:5px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:6px;background:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;cursor:pointer;opacity:0;transition:opacity .15s ease,background .15s ease,color .15s ease}
.mt-railsessrow:hover .mt-railsessdel{opacity:1}
.mt-railsessdel:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.mt-railempty{width:calc(100% - 16px);margin-left:16px;padding:1px 10px 3px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
/* kbcAsk-20261005：输入卡片贴底，底部留白统一交给 .mt-askwrap 的 12px */
.mt-body-ask{padding-bottom:0}
/* kbcAsk-20261005：对话区高度恒为可用空间（autoH035）；输入卡片高度另由 dockH035 控制 */
.mt-askwrap{position:relative;display:flex;flex-direction:column;gap:10px;min-width:0;flex:1}
.mt-asktop{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:none}
.mt-hintchip{display:inline-flex;align-items:center;gap:4px;max-width:340px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-hintchip:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
/* kbcAsk-20261005：新建会议 chip 底色改浅灰（原为品牌蓝实心） */
.mt-hintchip.new{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l1);font-weight:650;flex:none}
.mt-hintchip.new:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.mt-askbody{display:flex;gap:12px;flex:1;min-height:0}
.mt-askpanel{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:8px}
/* 底部拖拽把手样式并入 .mt-askdock（吸底停靠区内），此处不再单独定位 */
html[data-mt-resizing],html[data-mt-resizing] *{cursor:ns-resize!important;user-select:none!important}
.mt-streamstatus{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.mt-streamthink{font-size:12px;font-style:italic;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;margin-bottom:6px}
.mt-toolrow{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);margin:6px 0 2px;padding:4px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px dashed var(--dsw-alias-border-l2)}
.mt-errmsg{margin-top:7px;padding:6px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px}
.mt-attachrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex:none}
.mt-attach{display:inline-flex;align-items:center;gap:6px;max-width:280px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:3px 8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mt-attach.uploading{border-style:dashed;color:var(--dsw-alias-label-tertiary)}
.mt-attach .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-attach .rm{border:none;background:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1;padding:1px 2px;flex:none}
.mt-attach .rm:hover{color:var(--dsw-alias-state-error-primary)}
.mt-clipbtn{display:flex;align-items:center;justify-content:center;width:37px;height:37px;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;font-size:15px;color:var(--dsw-alias-label-secondary)}
.mt-clipbtn:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.mt-clipbtn:disabled{opacity:.55;cursor:not-allowed}
.mt-btn.stop{background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-weight:650}
.mt-dropoverlay{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;gap:8px;border:2px dashed var(--dsw-alias-state-business-primary);border-radius:14px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-weight:700;font-size:14px;pointer-events:none}
/* —— 会议日程 v0.2.4 美化：主题色渐变竖条 / hover 抬升 / 日历事件块左侧色条 —— */
.mt-mcard{position:relative;overflow:hidden;padding-left:19px;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
.mt-mcard::before{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(180deg,var(--dsw-static-blue-600),var(--dsw-static-deepseek-450))}
.mt-mcard.s-in_progress::before{background:linear-gradient(180deg,var(--dsw-alias-state-success-primary),var(--dsw-alias-state-success-secondary))}
.mt-mcard.s-completed::before{background:linear-gradient(180deg,var(--dsw-alias-label-tertiary),var(--dsw-alias-border-l2))}
.mt-mcard:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(15,23,42,.12);border-color:var(--dsw-alias-border-l2)}
.mt-metarow{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin:7px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mt-when{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.mt-when b{font-weight:700;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:1px 7px;font-size:11.5px}
.mt-where,.mt-who{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
@media (max-width:900px){
  .mt-askbody{flex-direction:column}
  .mt-railsub{width:calc(100% - 12px);margin-left:12px;padding:8px 0;justify-content:center}
  .mt-railsub .txt{display:none}
  .mt-railsub .ic{gap:0}
  /* 历史会话行窄屏保留标题（无图标，仅文字），删除按钮常显 */
  .mt-railsessrow{width:calc(100% - 12px);margin-left:12px}
  .mt-railsession{justify-content:flex-start;padding:8px 30px 8px 10px}
  .mt-railsession .txt{display:block}
  .mt-railsessdel{opacity:1}
  .mt-raillabel,.mt-railempty{width:calc(100% - 12px);margin-left:12px}
}
`

    /* ---------------------------------------------------------------- */
    /* i18n 词典                                                          */
    /* ---------------------------------------------------------------- */

    // Approved cloud palette is local to this module, never html/body or global settings.
    const CLOUD_CSS = `
.mt-app{--dsw-specific-sidebar-fill:#fff;--dsw-alias-bg-base:#f4f6f9;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f7f9fc;--dsw-alias-bg-layer-3:#eef2f7;--dsw-alias-bg-mask-1:rgba(16,28,48,.36);--dsw-alias-border-l1:#e6eaf1;--dsw-alias-border-l2:#d3dae5;--dsw-alias-label-primary:#2a3342;--dsw-alias-label-secondary:#5f6b7e;--dsw-alias-label-tertiary:#94a0b2;--dsw-alias-label-dimmed:#94a0b2;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-button-primary-fill:#2563eb;--dsw-alias-button-primary-hover:#1d4fd7;--dsw-alias-state-business-primary:#2563eb;--dsw-alias-state-business-tertiary:#eaf1fe;--dsw-alias-state-success-primary:#16803c;--dsw-alias-state-success-secondary:#44b778;--dsw-alias-state-success-tertiary:#e2f5e9;--dsw-alias-state-warn-primary:#c99b36;--dsw-alias-state-warn-label:#9a6b15;--dsw-alias-state-warn-tertiary:#fdf3dd;--dsw-alias-state-error-primary:#c0392b;--dsw-alias-interactive-bg-hover-danger:#fdecea;--dsw-alias-interactive-bg-hover:#f0f4fc;--dsw-alias-interactive-bg-active:#eaf1fe;--dsw-alias-link:#2563eb;--dsw-alias-toast-bg:#2a3342;--dsw-static-blue-600:#2563eb;--dsw-static-deepseek-450:#38bdf8;display:flex;flex-direction:column;font:14px/1.6 'PingFang SC','Microsoft YaHei','Segoe UI',system-ui,sans-serif}
.mt-topbar{flex:none;padding:20px 30px 16px;background:linear-gradient(180deg,#fff,#f9fbff);border-bottom:2px solid #dbe8fd;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.mt-topbar h2{margin:0;font-size:23px;line-height:1.3;color:#2a3342}
.mt-topbar p{margin:5px 0 0;font-size:12px;color:#5f6b7e}
.mt-tabs{display:flex;gap:8px;flex-wrap:wrap;padding:10px 30px;border-bottom:1px solid #e6eaf1;background:#fff;flex:none}
.mt-body{padding:22px 30px 44px;width:100%}
.mt-content{max-width:1240px;margin:0 auto}
.mt-card{padding:20px;border-radius:14px;box-shadow:0 1px 3px rgba(16,28,48,.04),0 6px 18px rgba(16,28,48,.04)}
.mt-stack{gap:18px}.mt-btn{padding:8px 16px;border-radius:9px}.mt-btn.small{padding:5px 10px;font-size:12px}
.mt-input,.mt-select,.mt-textarea{background:#fff;padding:9px 11px}.mt-tcard{grid-template-columns:1fr;gap:18px}
.mt-minute-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}.mt-minute-body{white-space:pre-wrap;word-break:break-word;border:1px solid #e6eaf1;border-radius:10px;padding:14px 16px;line-height:1.85}
.mt-more{position:relative}.mt-more summary{list-style:none;cursor:pointer}.mt-more[open]>.mt-more-menu{position:absolute;right:0;top:calc(100% + 5px);min-width:200px;z-index:25;background:#fff;border:1px solid #d3dae5;border-radius:10px;padding:8px;box-shadow:0 10px 30px rgba(16,28,48,.18)}
.mt-health-menu{max-width:370px}.mt-app[data-mt-resizing],.mt-app[data-mt-resizing] *{cursor:ns-resize!important;user-select:none!important}
@media(max-width:1080px){.mt-qa-grid{grid-template-columns:1fr}}
@media(max-width:860px){.mt-topbar{padding:16px}.mt-tabs{padding:10px 16px}.mt-body{padding:16px}.mt-minute-tools{margin-left:0;width:100%}}
`
    // A tiny rule scoper: recursively scope media/support rules, leave animation frames intact.
    function scopeMeetingCss(input) {
      const source = input.replace(/\/\*[\s\S]*?\*\//g, '')
      let result = '', cursor = 0
      while (cursor < source.length) {
        const open = source.indexOf('{', cursor)
        if (open < 0) break
        let end = open + 1, depth = 1
        while (end < source.length && depth) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; end++ }
        const header = source.slice(cursor, open).trim(), body = source.slice(open + 1, end - 1)
        if (/^@(?:media|supports)/.test(header)) result += header + '{' + scopeMeetingCss(body) + '}'
        else if (header.startsWith('@')) result += header + '{' + body + '}'
        else result += header.split(',').map(selector => selector.trim().startsWith('.mt-app') ? selector.trim() : '.mt-app ' + selector.trim()).join(',') + '{' + body + '}'
        cursor = end
      }
      return result
    }
    const FINAL_CLOUD_CSS = `
.mt-app [hidden]{display:none!important}.mt-body{overflow:auto;flex:1;min-height:0}.mt-body>*{max-width:1240px;margin-left:auto;margin-right:auto}.mt-topbar{color:#2a3342}.mt-source-tabs{width:100%;display:grid;grid-template-columns:repeat(3,1fr);background:#f5f7fc;padding:5px;gap:5px}.mt-source-tabs button{padding:12px 8px;text-align:center;border-radius:9px}.mt-source-tabs button[aria-pressed=true]{background:#fff;color:#2563eb;box-shadow:0 2px 6px rgba(16,28,48,.07)}
.mt-context{display:grid;grid-template-columns:minmax(220px,1.4fr) minmax(170px,1fr) auto;gap:18px;align-items:end}.mt-context .mt-select{width:100%}.mt-minute-body{font-size:13px;background:#fff;color:#2a3342}.mt-preview .mt-h3{margin:0}.mt-rec-center{display:flex;align-items:center;flex-direction:column;gap:12px;padding:16px}.mt-record-knob{border:0;border-radius:50%;width:76px;height:76px;color:#fff;background:linear-gradient(135deg,#2563eb,#5595f8);font-size:30px;cursor:pointer;box-shadow:0 5px 16px rgba(37,99,235,.23)}.mt-record-knob.recording{background:#df5555}.mt-record-knob:disabled{opacity:.45;cursor:not-allowed}.mt-seek{flex:1;min-width:100px;accent-color:#2563eb}
.mt-livewrap{background:#0e1c30;color:#9fc3ef;min-height:130px;padding:14px;border-radius:10px;max-height:260px;overflow:auto;font:12px/1.9 ui-monospace,SFMono-Regular,monospace}.mt-livewrap .mt-muted{color:#9fc3ef}.mt-caption-float{position:fixed;z-index:1200;width:min(420px,calc(100vw - 16px));height:min(280px,calc(100vh - 16px));display:flex;flex-direction:column;background:#0e1c30;border:1px solid #2b4668;border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.25);color:#9fc3ef;overflow:hidden}.mt-caption-handle{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:move;touch-action:none}.mt-caption-float .mt-livewrap{flex:1;min-height:0}.mt-caption-handle .mt-btn{background:#223b58;border-color:#355576;color:#d6e6fb}
.mt-task-model{position:relative}.mt-task-model summary{list-style:none;cursor:pointer;max-width:310px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt-task-model-menu{position:absolute;bottom:calc(100% + 8px);left:0;z-index:100;min-width:250px;max-width:min(390px,calc(100vw - 48px));max-height:320px;overflow:auto;border:1px solid #d3dae5;background:#fff;border-radius:10px;padding:10px;box-shadow:0 10px 30px rgba(16,28,48,.17)}.mt-task-model-menu button{display:block;width:100%;text-align:left;margin:5px 0}.mt-task-model-menu b{display:block;margin-top:8px;color:#5f6b7e;font-size:12px}
.mt-qa-grid{display:block;min-width:0}.mt-history{padding:14px;display:flex;flex-direction:column;gap:12px;position:sticky;top:0;max-height:calc(100vh - 200px);overflow:auto}.mt-session{display:flex;flex-direction:column;gap:3px;min-width:0;width:100%;padding:9px;border:1px solid transparent;border-radius:9px;background:#f5f7fb;cursor:pointer;text-align:left}.mt-session.active{background:#eaf1fe;border-color:#c8dcff;color:#2563eb}.mt-session b{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt-session span{font-size:10px;color:#94a0b2}.mt-askwrap{background:#fff;padding:16px;border:1px solid #e6eaf1;border-radius:14px}.mt-create{margin:18px 0}.mt-create-more>summary{display:inline-flex;list-style:none;cursor:pointer;margin-bottom:12px}.mt-agenda-row{display:grid;grid-template-columns:120px 1.5fr 110px 1fr auto;gap:8px}.mt-calendar-scroll{overflow-x:auto}.mt-cal{min-width:680px}.mt-mcard::before{display:none}.mt-mcard{padding-left:20px}.mt-day-more{cursor:pointer;background:#eaf1fe;color:#2563eb;border:0;border-radius:5px;padding:2px 6px}.mt-day-meeting{display:flex;align-items:flex-start;flex-direction:column;gap:5px;padding:12px;border:1px solid #e6eaf1;border-radius:10px;background:#fff;cursor:pointer;text-align:left}.mt-day-meeting:hover{background:#f5f8ff}
@media(max-width:1080px){.mt-context{grid-template-columns:1fr 1fr}.mt-context>.mt-row{grid-column:1/-1}.mt-qa-grid{grid-template-columns:1fr}.mt-history{position:static;max-height:230px}.mt-agenda-row{grid-template-columns:1fr 1fr}}
@media(max-width:860px){.mt-context{grid-template-columns:1fr}.mt-minute-tools{gap:5px}.mt-minute-tools>.mt-btn{padding:6px 9px}.mt-source-tabs button{font-size:12px}.mt-card{padding:16px}.mt-grid2,.mt-grid3{grid-template-columns:1fr}.mt-agenda-row{grid-template-columns:1fr}.mt-task-model summary{max-width:210px}}
`
    
     const NAVIGATION_CSS = `
.mt-app{flex-direction:row;position:relative}
.mt-stage{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}
.mt-rail{width:216px}
.mt-railchild{margin-left:12px;width:calc(100% - 12px);font-size:12px}
.mt-railqa{margin:0 0 6px 12px;padding:3px 0 4px 8px;border-left:1px solid var(--dsw-alias-border-l1);min-height:0;max-height:40vh;overflow-y:auto;overflow-x:hidden;flex:none}
.mt-railqa .mt-railsection{padding:2px 8px 7px}
.mt-railqa .mt-railitem{font-size:11.5px;padding:6px 7px}
.mt-railqa .mt-railrow{display:flex;align-items:center;gap:3px}
.mt-railqa .mt-session{flex:1;min-width:0;text-align:left}
.mt-railqa .mt-railremove{border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mt-railqa .mt-railremove:hover{color:var(--dsw-alias-state-error-primary)}
/* mtHist-20261019：历史对话「更多操作」菜单 / 行内重命名 / 归档对话入口 */
.mt-railqa .mt-morebtn{border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:1px 4px;line-height:1.1;font-size:13px;border-radius:6px;flex:none}
.mt-railqa .mt-morebtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-sessionmenu{display:flex;flex-direction:column;gap:1px;padding:4px;background:#fff;border:1px solid #dfe5ee;border-radius:10px;box-shadow:0 8px 26px rgba(23,43,77,.16)}
.mt-sessionmenu button{display:flex;align-items:center;gap:7px;width:100%;text-align:left;border:0;background:none;border-radius:7px;padding:7px 9px;font-size:12.5px;color:#2a3342;cursor:pointer}
.mt-sessionmenu button:hover{background:#f2f5fa}
.mt-sessionmenu button.danger{color:#d4380d}
.mt-sessionmenu button.danger:hover{background:#fff1f0}
.mt-railqa .mt-reninput{flex:1;min-width:0;font-size:12px;padding:5px 7px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:8px;background:#fff;color:#2a3342}
.mt-railqa .mt-archtoggle{width:100%;text-align:left;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px;padding:5px 7px;border-radius:7px}
.mt-railqa .mt-archtoggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-livewrap,.mt-caption-float{background:#fff;color:#243247;border:1px solid #d9e1eb;box-shadow:0 4px 18px rgba(26,43,66,.08);font:13px/1.6 system-ui,sans-serif}
.mt-livewrap{display:flex;flex-direction:column;gap:10px;min-height:130px;padding:14px;max-height:260px}
.mt-livewrap .mt-muted,.mt-caption-handle{color:#506178}.mt-caption-float .mt-livewrap{border:0;box-shadow:none}
.mt-caption-handle{border-bottom:1px solid #e4e9f0;background:#fff}.mt-caption-handle .mt-btn{background:#fff;border-color:#d1dbe8;color:#243247}
.mt-caption-row{display:flex;align-items:flex-start;gap:10px;min-width:0}.mt-caption-avatar{width:32px;height:32px;flex:none;border-radius:50%;background:#edf3ff;color:#2759a5;display:grid;place-items:center;font-weight:700;font-size:13px;border:1px solid #d5e3fa}
.mt-caption-bubble{min-width:0;max-width:calc(100% - 42px);background:#fff;color:#243247;border:1px solid #e0e7f0;border-radius:5px 12px 12px 12px;box-shadow:0 2px 9px rgba(24,43,75,.07);padding:8px 11px;word-break:break-word}.mt-caption-meta{display:flex;align-items:center;gap:7px;color:#627187;font-size:11px;margin-bottom:3px;flex-wrap:wrap}.mt-caption-bubble.interim{border-style:dashed}.mt-caption-bubble.interim .mt-caption-text{color:#536278}
.mt-caption-rename{border:0;background:transparent;padding:1px 2px;color:#244e91;text-decoration:underline;cursor:pointer}.mt-caption-rename:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.mt-railgroup{display:flex;flex-direction:column;min-height:0}
.mt-railqa .mt-session{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-railqa .mt-railrow{min-width:0}
.mt-rail-toggle,.mt-rail-shade{display:none}
.mt-railitem:focus-visible,.mt-railback:focus-visible,.mt-railqa button:focus-visible,.mt-rail-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
@media(max-width:900px){
 .mt-railgroup{display:none}.mt-app.mt-rail-expanded .mt-railgroup{display:flex}.mt-railchild{margin:0;width:100%}
 .mt-app.mt-rail-expanded .mt-rail{position:absolute;z-index:1202;top:0;bottom:0;left:0;width:min(280px,calc(100vw - 72px));box-shadow:8px 0 24px rgba(0,0,0,.18)}
 .mt-app.mt-rail-expanded .mt-brand{justify-content:flex-start;padding:13px 15px}
 .mt-app.mt-rail-expanded .mt-brandname,.mt-app.mt-rail-expanded .mt-railsection,.mt-app.mt-rail-expanded .mt-railstats,.mt-app.mt-rail-expanded .mt-railitem .txt,.mt-app.mt-rail-expanded .mt-railback .txt{display:initial}
 .mt-app.mt-rail-expanded .mt-railitem{justify-content:space-between;padding:9px 11px}
 .mt-app.mt-rail-expanded .mt-railitem .ic{gap:9px}
 .mt-app.mt-rail-expanded .mt-railqa{display:block}
 .mt-app.mt-rail-expanded .mt-railchild{margin-left:12px;width:calc(100% - 12px)}
 .mt-app.mt-rail-expanded .mt-rail-toggle{display:block;align-self:center;margin:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;cursor:pointer}
 .mt-app.mt-rail-expanded .mt-rail-shade{display:block;position:absolute;inset:0;background:rgba(0,0,0,.3);z-index:1201;border:0;cursor:pointer}
}
`
const QA035_CSS = "\n.mt-app .mt-askwrap,.mt-app .mt-askbody,.mt-app .mt-askpanel{min-width:0;box-sizing:border-box;max-width:100%}\n.mt-app .mt-askwrap{display:flex;flex-direction:column;min-height:0;padding:12px}\n.mt-app .mt-asktop,.mt-app .mt-asksub{display:flex;flex-wrap:wrap;min-width:0;max-width:100%;gap:8px;box-sizing:border-box;flex:none}\n.mt-app .mt-asktop>.mt-select{flex:1 1 190px;min-width:0;max-width:100%;width:0}\n.mt-app .mt-asktop>.mt-muted{flex:1 1 190px;min-width:0;overflow-wrap:anywhere}\n.mt-app .mt-asksub .mt-select{flex:1 1 190px;min-width:0;width:0;max-width:100%;box-sizing:border-box}\n.mt-app .mt-asksub>.mt-btn,.mt-app .mt-asksub>.mt-hintchip,.mt-app .mt-asktop>.mt-btn{max-width:100%;white-space:normal;overflow-wrap:anywhere}\n.mt-app .mt-askbody,.mt-app .mt-askpanel{display:flex;flex:1;flex-direction:column;min-height:0}\n.mt-app .mt-msgs{flex:1;min-width:0;min-height:0;overflow-y:auto;overflow-wrap:anywhere}\n.mt-app .mt-inputbar{min-width:0;max-width:100%;box-sizing:border-box;flex-wrap:wrap}\n.mt-app .mt-inputbar textarea{min-width:0;flex:1 1 140px;width:0;box-sizing:border-box}\n.mt-app .mt-askdock{background:var(--dsw-alias-bg-layer-1);min-width:0;max-width:100%}\n.mt-app .mt-attachrow,.mt-app .mt-msgsrc{min-width:0;max-width:100%;flex-wrap:wrap;overflow-wrap:anywhere}\n.mt-app .mt-qa-message035{display:flex;align-items:flex-start;gap:8px;width:100%;min-width:0;margin:10px 0}\n.mt-app .mt-qa-message035.user{flex-direction:row-reverse}\n.mt-app .mt-qa-avatar035{width:36px;height:36px;flex:none}\n.mt-app .mt-qa-message035>.mt-bubble{min-width:0;max-width:calc(100% - 44px);margin:0;overflow-wrap:anywhere}\n.mt-app .mt-qa-message035>.mt-qa-col035{display:flex;flex-direction:column;min-width:0;max-width:calc(100% - 44px)}\n.mt-app .mt-qa-message035.user>.mt-qa-col035{align-items:flex-end}\n.mt-app .mt-qa-col035>.mt-bubble{min-width:0;max-width:100%;margin:0;overflow-wrap:anywhere}\n.mt-app .mt-qa-time035{font-size:11px;line-height:1.5;margin-top:3px;color:var(--dsw-alias-label-secondary);opacity:.85;font-variant-numeric:tabular-nums;white-space:nowrap}\n.mt-app .mt-qa-message035 a,.mt-app .mt-qa-message035 .mt-linkchip{overflow-wrap:anywhere;max-width:100%;white-space:normal}\n.mt-app .mt-qa-message035 pre{max-width:100%;overflow:auto}\n.mt-app .mt-context{container-type:inline-size;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}\n.mt-app .mt-context>.mt-field{min-width:0;max-width:100%}\n.mt-app .mt-context .mt-select,.mt-app .mt-word-pick035{height:36px;border-radius:8px;min-width:0;max-width:100%;width:100%;box-sizing:border-box}\n.mt-app .mt-word-pick035{display:flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);padding:0 8px;background:var(--dsw-alias-bg-layer-1)}\n.mt-app .mt-word-pick035>.mt-btn{border:0;background:none;padding:3px;flex:none}\n.mt-app .mt-word-pick035>.mt-chip{flex:1;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.mt-app .mt-context>.mt-context-status035,.mt-app .mt-context>.mt-notice{grid-column:1/-1}\n@container(max-width:760px){.mt-app .mt-context>.mt-field{grid-column:1/-1}}\n@media(max-width:600px){.mt-app .mt-context{grid-template-columns:minmax(0,1fr)}.mt-app .mt-qa-avatar035{width:30px;height:30px}.mt-app .mt-qa-message035>.mt-bubble{max-width:calc(100% - 38px)}.mt-app .mt-qa-message035>.mt-qa-col035{max-width:calc(100% - 38px)}}\n.mt-app .mt-genopt035{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}.mt-app .mt-genopt035>.mt-row>.mt-btn{flex:none}.mt-app .mt-genopt-body035{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px}.mt-app .mt-newmeeting035{border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;padding:12px;background:transparent}.mt-app .mt-newmeeting035 .mt-grid2{gap:10px}@media(max-width:860px){.mt-app .mt-genopt035>.mt-row{flex-wrap:wrap}}"
const QA_INPUT_WIDTH_FIX_CSS = `
.mt-app .mt-inputbar{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;width:100%;min-width:0;max-width:100%;box-sizing:border-box}
.mt-app .mt-inputbar>textarea{grid-column:1 / -1;grid-row:1;width:100%;min-width:0;max-width:100%;box-sizing:border-box}
.mt-app .mt-inputbar>.mt-clipbtn{grid-column:1;grid-row:2;justify-self:start}
.mt-app .mt-inputbar>.mt-btn{grid-column:2;grid-row:2;justify-self:end;max-width:100%;box-sizing:border-box}
`
const KB_COMPOSER_CSS = `
/* ================= KB 同款输入框（kbComposer-20261005）=================
   移植自 dsh-raganything-kb/lib/client.js 的会话输入框：圆角卡片 + 底部工具条
   （+ 附件 / @ 引用 / 模型 / 圆形发送）+ 绿色虚线落点。颜色全部走 --dsw-alias-*
   令牌，深浅色跟随 DSH「设置-通用设置-外观」；此处不写死任何品牌色。 */
/* kbcInputBg-20261005：输入框背景与知识库输入框一致（--kb-input-major = #fff） */
/* kbcInputStroke-20261005：描边与阴影与知识库输入框一致（--kb-input-stroke=rgba(0,0,0,.1) + 双层柔光） */
.mt-app .mt-askdock{position:relative;box-sizing:border-box;border:0;border-radius:22px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 0 0 .5px rgba(0,0,0,.1),0 4px 16px 0 rgba(0,0,0,.03),0 0 24px 0 rgba(0,0,0,.03);padding:8px 0 0;display:flex;flex-direction:column;gap:10px}
.mt-app .mt-askwrap:has(.mt-dropoverlay) .mt-askdock{outline:2px dashed var(--dsw-alias-state-success-primary);outline-offset:-6px}
.mt-app .mt-askdock .mt-asksub{padding:0 10px;gap:8px}
.mt-app .mt-askdock .mt-inputbar{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto auto;grid-template-rows:auto auto;align-items:center;column-gap:12px;row-gap:2px;padding:2px 8px 6px;border:0;background:transparent}
.mt-app .mt-askdock .mt-inputbar>textarea{grid-column:1 / -1;grid-row:1;box-sizing:border-box;width:100%;min-width:0;min-height:36px;max-height:200px;height:auto;margin:0;padding:4px 12px 0 14px;background:transparent;border:0;border-radius:0;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);font-size:14px;line-height:24px;resize:none}
.mt-app .mt-askdock .mt-inputbar>textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
/* 聚焦不要蓝框（与 KB 第 6 轮同款处理）：只豁免输入框，按钮的键盘焦点环保留 */
.mt-app .mt-askdock .mt-inputbar>textarea:focus,.mt-app .mt-askdock .mt-inputbar>textarea:focus-visible{outline:none!important;box-shadow:none!important;border:0}
.mt-app .mt-kbc-icon{grid-row:2;width:28px;height:28px;flex:none;display:grid;place-items:center;border:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1;cursor:pointer}
.mt-app .mt-kbc-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.mt-app .mt-kbc-icon:disabled{opacity:.45;cursor:default}
.mt-app .mt-askdock .mt-inputbar .mt-clipbtn{grid-column:1}
.mt-app .mt-askdock .mt-inputbar .mt-kbc-at{grid-column:2}
.mt-app .mt-kbc-spacer{grid-column:3;grid-row:2;min-width:0}
.mt-app .mt-askdock .mt-inputbar>.mt-select{grid-column:4;grid-row:2;width:auto;min-width:0;max-width:210px;height:28px;padding:0 4px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px}
.mt-app .mt-askdock .mt-inputbar>.mt-select:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-app .mt-askdock .mt-inputbar>.mt-muted{grid-column:4;grid-row:2;max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.mt-app .mt-askdock .mt-inputbar>.mt-btn.primary{grid-column:5;grid-row:2;width:34px;height:34px;padding:0;display:grid;place-items:center;border:0;border-radius:999px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:15px;line-height:1;transform:translateY(-2px)}
.mt-app .mt-askdock .mt-inputbar>.mt-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.mt-app .mt-askdock .mt-inputbar>.mt-btn.primary:disabled{opacity:.4;cursor:default}
.mt-app .mt-askdock .mt-inputbar>.mt-btn.stop{grid-column:5;grid-row:2;width:34px;height:34px;padding:0;display:grid;place-items:center;border-radius:999px}
/* 拖拽落点：KB 同款绿色胶囊提示（.mt-dropoverlay 仍由原实现渲染，这里只换外观） */
.mt-app .mt-askwrap>.mt-dropoverlay{position:absolute;left:50%;top:-30px;right:auto;bottom:auto;width:auto;height:auto;transform:translateX(-50%);z-index:9;display:block;padding:6px 12px;border:0;border-radius:999px;background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary-foreground);font-size:12px;font-weight:600;white-space:nowrap;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.12)}
/* @ 引用会议菜单 */
.mt-app .mt-kbc-menu{position:absolute;left:10px;right:10px;bottom:70px;z-index:12;max-height:300px;overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 30px rgba(0,0,0,.16)}
.mt-app .mt-kbc-menuhead{padding:6px 10px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.mt-app .mt-kbc-menuitem{display:block;width:100%;text-align:left;padding:8px 10px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.mt-app .mt-kbc-menuitem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-app .mt-kbc-menuitem.on{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.mt-app .mt-kbc-menuempty{padding:8px 10px;color:var(--dsw-alias-label-tertiary);font-size:13px}
/* ================= kbcAsk-20261005：问答输入区四项调整 ================= */
/* ① 发送按钮左侧：模型下拉真正可见（原内联 width:0 在 grid 轨道里把列压成 8px） */
.mt-app .mt-askdock .mt-inputbar>.mt-kbc-model{grid-column:4;grid-row:2;display:flex;align-items:center;gap:4px;min-width:0;max-width:260px}
.mt-app .mt-askdock .mt-inputbar>.mt-kbc-model>.mt-select{width:auto;min-width:96px;max-width:230px;height:28px;padding:0 4px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;text-overflow:ellipsis}
.mt-app .mt-askdock .mt-inputbar>.mt-kbc-model>.mt-select:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-app .mt-askdock .mt-inputbar>.mt-kbc-model>.mt-muted{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:13px}
/* ② 卡片下沿贴底不动，把手贴在卡片上沿（向上拖 = 输入区变高） */
.mt-app .mt-askdock{max-height:100%}
.mt-app .mt-askdock>.mt-resizer{position:absolute;left:0;right:0;top:-8px;height:16px;z-index:3}
.mt-app .mt-askdock.mt-askdock-fixed .mt-inputbar{flex:1;min-height:0;grid-template-rows:minmax(36px,1fr) auto}
.mt-app .mt-askdock.mt-askdock-fixed .mt-inputbar>textarea{height:100%;max-height:none;overflow-y:auto}
/* ③ 输入提示挪到卡片上方一行，不再占卡片下方空间 */
.mt-app .mt-kbc-hint{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ④ 多行内容（新建会议模板）自适应加高时内部滚动兜底 */
.mt-app .mt-askdock .mt-inputbar>textarea{overflow-y:auto}
/* ================= kbcCtl-20261005：输入框内三控件与知识库 composerBar 同款 ================= */
/* 附件「＋」/ 引用「@」：知识库 --kb-input-selector #f5f6f7 + 15px/600 + padding 0，hover --accent-soft */
.mt-app .mt-askdock .mt-inputbar .mt-kbc-icon{width:28px;height:28px;padding:0;border:0;border-radius:999px;background:#f5f6f7;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1}
.mt-app .mt-askdock .mt-inputbar .mt-kbc-icon:hover:not(:disabled){background:#eaf1fe}
/* 模型下拉：知识库 .modelBtn 的 padding/字重/行高/最大宽与 hover */
.mt-app .mt-askdock .mt-inputbar>.mt-kbc-model>.mt-select{max-width:210px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px}
.mt-app .mt-askdock .mt-inputbar>.mt-kbc-model>.mt-select:hover{background:#eaf1fe}
/* 发送：知识库 --kb-send-fill #4176e6 / hover --kb-send-hover #7aaaff */
.mt-app .mt-askdock .mt-inputbar>.mt-btn.primary{background:#4176e6}
.mt-app .mt-askdock .mt-inputbar>.mt-btn.primary:hover:not(:disabled){background:#7aaaff}
`
const MEETING_CSS = scopeMeetingCss(CSS.replace(/html\[data-mt-resizing\],html\[data-mt-resizing\] \*\{[^}]*\}/, '') + CLOUD_CSS + FINAL_CLOUD_CSS + NAVIGATION_CSS + QA035_CSS + QA_INPUT_WIDTH_FIX_CSS + KB_COMPOSER_CSS)

    const dict = {
      zh: {
        title: '会议助手', subtitle: '会议日程与 AI 议程、模板纪要生成与签署归档、可溯源会议问答', back: '返回主页',
        brandSub: '企业级智能会议协同系统', brandTag: '智会', railSection: '工作台协同', aiAssistTag: 'AI辅助',
        statTitle: 'AI 助手状态', statOnline: '在线', statTodayMeetings: '今日待开会议', statPendingMinutes: '待归档纪要', statIndexedDocs: '已索引文档',
        unitMeetings: (n) => `${n} 场`, unitFiles: (n) => `${n} 份`, unitDocs: (n) => `${n} 篇`,
        navSchedule: '会议日程', navCreate: '新建会议', navMinutes: '会议纪要', navAsk: '会议问答', pendingArchiveBadge: '待归档',
        searchPlaceholder: '搜索标题 / 地点 / 参会人 / 标签', allStatus: '所有状态', upcoming: '待开始', inProgress: '进行中', completed: '已结束',
        pinnedOnly: '仅看置顶', viewList: '列表', viewWeek: '周日历', viewMonth: '月日历', today: '今天',
        newMeeting: '新建会议', emptySchedule: '暂无符合条件的会议日程', emptyScheduleHint: '调整筛选条件，或点击「新建会议」创建第一场会议。',
        detail: '详情', gotoMinutes: '纪要', gotoAsk: 'AI问答', pinnedBadge: '重要置顶', etc: '等', materialCount: '份材料', noAgenda: '暂无议程',
        starOn: '已置顶', starOff: '已取消置顶',
        weekNo: (y, m, w) => `${y}年${m}月 第${w}周`, monthLabel: (y, m) => `${y}年${m}月`,
        noMeetings: '无会议安排', more: (n) => `更多 ${n} 场`,
        fTitle: '会议主题', fStart: '开始时间', fEnd: '结束时间', fType: '会议形式', typeOnline: '纯线上', typeOffline: '纯线下', typeHybrid: '混合',
        locOnline: '线上视频会议号 / 腾讯会议链接', locOffline: '线下物理会议室与工区地点', locHybrid: '会议地点 / 线上会议室',
        fParticipants: '参会人员（逗号分隔）', fTags: '会议标签（逗号分隔）', fPinned: '设为重要并置顶', meetingLink: '视频会议链接（可选）',
        agendaTitle: '会议议程与指派任务', agendaTime: '时间段', agendaTopic: '议题大纲与目标', agendaSpeaker: '发言/负责人', addAgenda: '添加议程', removeAgenda: '删除',
        aiAgenda: 'AI 一键根据主题生成议程', aiAgendaBusy: 'AI 正在编排议程…', aiAgendaDone: '议程已生成，可继续编辑', aiAgendaEmpty: 'AI 未返回可用议程，请补充会议主题后重试',
        materialTitle: '会议资料与知识挂载', materialHint: '点击选择文件（TXT / MD / PDF / DOCX / PPTX / XLSX，单文件 ≤10MB）', materialTextReady: '文本已提取，可参与问答检索', materialQueued: '仅存元数据（不支持文本抽取的格式）', materialTooBig: '文件超过 10MB 上限',
        submitCreate: '确认并发布会议日程', created: '会议已发布', needTitle: '请填写会议主题', needTime: '请填写开始与结束时间，且结束晚于开始',
        bindMeeting: '当前绑定关联会议', archiveBtn: '正式签署归档', archivedToast: (fp) => `已签署归档 · SHA-256 指纹 ${fp.slice(0, 16)}…`, archiveNoContent: '纪要正文为空，无法归档',
        minutesStatusNone: '待生成纪要', minutesStatusReady: 'AI纪要待签署', minutesStatusArchived: '纪要已归档',
        srcLive: '实时录音转写', srcUpload: '上传录音', srcPaste: '粘贴文本',
        startRec: '开始录音', finishAndGenerate: '结束并生成纪要', cancelRec: '取消', recLive: '录音中',
        recHint: '请开始说话，语音将实时转写为文字…', micDenied: '无法访问麦克风，请检查浏览器录音权限',
        liveUnsupported: '当前浏览器不支持实时录音转写（需 Chrome/Edge 的 Web Speech 与 MediaRecorder），请改用「上传录音」或「粘贴文本」模式。',
        liveAutoHint: '停止只封存完整录音；点击生成后才上传并由阿昆正式全文识别', downloadRec: '下载录音', recEmpty: '转写内容为空，未生成纪要',
        uploadHint: '点击选择或拖入录音文件（MP3 / M4A / WAV / AAC / OGG / WEBM / AMR / FLAC，≤500MiB）', uploadProgress: '上传中',
        uploadDone: '录音已上传', recTooBig: '录音文件超过 500MB 上限', saveTranscript: '保存转写', savedTranscript: '转写已保存',
        importTxtSrt: '导入 .txt/.srt', playTranscribe: '播放并实时转写（实验性）', stopPlayTranscribe: '停止',
        playTranscribeHint: '实验性：需外放且环境安静',
        transcriptLabel: '录音转写文本（或粘贴 [HH:mm:ss] 说话人: 内容 格式）', importTxt: '导入转写 .txt', templateLabel: '选择 AI 提炼模板', generateBtn: 'AI 一键生成纪要', generating: '正在生成纪要…',
        generated: '纪要已生成', contentTitle: '纪要正文（Markdown，可直接编辑修订）', saveBtn: '保存修订', saved: '纪要已保存', copyAll: '复制全文', copied: '已复制到剪贴板',
        importFixed: '导入修正版覆盖', imported: '已导入修正版（版本 +1）', versionLabel: (v) => `v${v}`, sourceAi: 'AI 生成', sourceEdit: '在线修订', sourceImport: '导入覆盖', sourceLive: '实时录音', sourceUpload: '上传录音',
        fingerprintLabel: '归档 SHA-256 指纹', actionItems: '跟进待办与责任人', noActionItems: '本篇纪要暂无结构化待办', noMinutes: '该会议尚无纪要', noMinutesHint: '在左侧录音、上传录音或粘贴转写文本，选择模板后生成。',
        pickMeeting: '请先绑定一场会议', noMeetingsForMinutes: '暂无会议可绑定，请先创建会议。',
        askTitle: '会议问答', askSub: '知识检索 RAG 引擎就绪 · 已关联日程与纪要知识库', newSession: '新建问答对话', sessions: '历史对话', noSessions: '暂无会话，点击上方新建。',
        scopeAll: (n) => `全量会议资产（${n} 场会议）`, scopeMeeting: '仅当前：', scopeDocs: '仅检索上传文档', delSession: '删除',
        welcomeTitle: '你好，我是 MeetAI 会议问答助手', welcomeSub: '针对关联会议、日程安排或材料提问，回答均带可溯源引用。',
        thinking: '正在检索会议知识库与转写索引…', citations: '证据与引文溯源', noCitations: '本回答未携带引用', copyAnswer: '复制',
        inputPlaceholder: '针对关联会议、日程安排或材料提问…', sendBtn: '发送', enterHint: 'Enter 发送 / Shift + Enter 换行', askFailed: '问答失败',
        srcTitle: '引文溯源', srcSource: '引文来源', srcStamp: '精确时间戳 / 定位', srcText: '原文片段', close: '我知道了', quote: '引用',
        loading: '加载中…', requestFailed: '请求失败', meetingDeleted: '会议已删除', deleteSessionFirst: '已删除会话', detailJumpAsk: (t) => `请针对《${t}》的核心共识与待办事项做全面梳理`,
        agendaFromMeeting: '议程', none: '—',
        newChat: '新建对话', histChat: '历史对话',
        /* mtHist-20261019：历史对话「更多操作」 */
        moreActions: '更多操作', pinSession: '置顶', unpinSession: '取消置顶', renameSession: '重命名',
        archiveSession: '归档', unarchiveSession: '取消归档', archivedChat: '归档对话', backToHistory: '返回历史对话',
        noSessions2: '暂无历史会话', noArchived: '暂无归档会话',
        pinOk: '已置顶', unpinOk: '已取消置顶', renameOk: '已重命名', renameEmpty: '会话名称不能为空',
        archiveOk: '已归档', unarchiveOk: '已取消归档', resizeHint: '拖动上沿调整输入框高度，双击恢复随内容自适应',
        attachBtn: '添加附件', attachTip: '支持 .pdf / .docx / .xlsx / .txt / .md，单文件 ≤30MB', attUploading: '附件上传中…',
        attTooBig: '文件超过 30MB 上限', attUnsupported: '不支持的文件类型（仅 .pdf / .docx / .xlsx / .txt / .md）',
        attUploadFail: '附件上传失败', attRemove: '移除附件', dropHint: '松开以添加附件',
        modelLabel: '模型', modelDefaultOption: '跟随系统默认', modelDefaultSuffix: '（默认）',
        modelLoading: '模型加载中…', modelFail: '模型列表不可用', modelRetry: '重试',
        stopBtn: '停止', toolCalling: (name) => `正在调用工具：${name}…`,
      },
      en: {
        title: 'Meeting Assistant', subtitle: 'Schedules & AI agendas, template minutes with signing & archiving, traceable meeting Q&A', back: 'Back to Home',
        brandSub: 'Enterprise intelligent meeting suite', brandTag: 'Smart', railSection: 'Workspace', aiAssistTag: 'AI assist',
        statTitle: 'AI assistant', statOnline: 'Online', statTodayMeetings: 'Meetings today', statPendingMinutes: 'Minutes to sign', statIndexedDocs: 'Indexed docs',
        unitMeetings: (n) => `${n}`, unitFiles: (n) => `${n}`, unitDocs: (n) => `${n}`,
        navSchedule: 'Schedule', navCreate: 'New meeting', navMinutes: 'Minutes', navAsk: 'Q&A', pendingArchiveBadge: 'to sign',
        searchPlaceholder: 'Search title / place / people / tags', allStatus: 'All statuses', upcoming: 'Upcoming', inProgress: 'In progress', completed: 'Ended',
        pinnedOnly: 'Pinned only', viewList: 'List', viewWeek: 'Week', viewMonth: 'Month', today: 'Today',
        newMeeting: 'New meeting', emptySchedule: 'No meetings match the filters', emptyScheduleHint: 'Adjust the filters, or create your first meeting.',
        detail: 'Details', gotoMinutes: 'Minutes', gotoAsk: 'Ask AI', pinnedBadge: 'Pinned', etc: 'more', materialCount: ' files', noAgenda: 'No agenda yet',
        starOn: 'Pinned', starOff: 'Unpinned',
        weekNo: (y, m, w) => `${y}-${String(m).padStart(2, '0')} · W${w}`, monthLabel: (y, m) => `${y}-${String(m).padStart(2, '0')}`,
        noMeetings: 'No meetings', more: (n) => `+${n} more`,
        fTitle: 'Meeting title', fStart: 'Start time', fEnd: 'End time', fType: 'Format', typeOnline: 'Online', typeOffline: 'On-site', typeHybrid: 'Hybrid',
        locOnline: 'Video meeting ID / link', locOffline: 'Physical room / site', locHybrid: 'Location / online room',
        fParticipants: 'Participants (comma separated)', fTags: 'Tags (comma separated)', fPinned: 'Mark important & pin', meetingLink: 'Meeting link (optional)',
        agendaTitle: 'Agenda & assignments', agendaTime: 'Time range', agendaTopic: 'Topic & goal', agendaSpeaker: 'Speaker / owner', addAgenda: 'Add row', removeAgenda: 'Remove',
        aiAgenda: 'AI: generate agenda from title', aiAgendaBusy: 'AI is drafting the agenda…', aiAgendaDone: 'Agenda generated — feel free to edit', aiAgendaEmpty: 'AI returned no agenda, please refine the title',
        materialTitle: 'Materials & knowledge', materialHint: 'Pick files (TXT / MD / PDF / DOCX / PPTX / XLSX, ≤10MB each)', materialTextReady: 'Text extracted — searchable in Q&A', materialQueued: 'Metadata only (no text extraction for this format)', materialTooBig: 'File exceeds the 10MB limit',
        submitCreate: 'Publish meeting', created: 'Meeting published', needTitle: 'Please enter the meeting title', needTime: 'Start/end time required, and end must be after start',
        bindMeeting: 'Bound meeting', archiveBtn: 'Sign & archive', archivedToast: (fp) => `Archived · SHA-256 ${fp.slice(0, 16)}…`, archiveNoContent: 'Minutes content is empty',
        minutesStatusNone: 'No minutes yet', minutesStatusReady: 'AI minutes to sign', minutesStatusArchived: 'Minutes archived',
        srcLive: 'Live recording', srcUpload: 'Upload audio', srcPaste: 'Paste text',
        startRec: 'Start recording', finishAndGenerate: 'Finish & generate', cancelRec: 'Cancel', recLive: 'Recording',
        recHint: 'Start speaking — your speech is transcribed in real time…', micDenied: 'Microphone unavailable — please check browser permission',
        liveUnsupported: 'Live transcription needs Web Speech + MediaRecorder (e.g. Chrome/Edge). Please use "Upload audio" or "Paste text" instead.',
        liveAutoHint: 'Stopping retains the complete recording. Only explicit generation uploads and transcribes it.',
        downloadRec: 'Download audio', recEmpty: 'Transcript is empty — minutes not generated',
        uploadHint: 'Click or drop an audio file (MP3 / M4A / WAV / AAC / OGG / WEBM / AMR / FLAC, ≤500MiB)', uploadProgress: 'Uploading',
        uploadDone: 'Recording uploaded', recTooBig: 'Audio file exceeds the 500MB limit', saveTranscript: 'Save transcript', savedTranscript: 'Transcript saved',
        importTxtSrt: 'Import .txt/.srt', playTranscribe: 'Play & live transcribe (experimental)', stopPlayTranscribe: 'Stop',
        playTranscribeHint: 'Experimental: requires speaker output and a quiet room',
        transcriptLabel: 'Transcript (or paste [HH:mm:ss] speaker: text lines)', importTxt: 'Import .txt', templateLabel: 'AI template', generateBtn: 'Generate minutes', generating: 'Generating minutes…',
        generated: 'Minutes generated', contentTitle: 'Minutes body (Markdown, editable)', saveBtn: 'Save revision', saved: 'Minutes saved', copyAll: 'Copy all', copied: 'Copied to clipboard',
        importFixed: 'Import corrected version', imported: 'Imported (version +1)', versionLabel: (v) => `v${v}`, sourceAi: 'AI', sourceEdit: 'Edited', sourceImport: 'Imported', sourceLive: 'Live record', sourceUpload: 'Uploaded audio',
        fingerprintLabel: 'Archive SHA-256 fingerprint', actionItems: 'Action items', noActionItems: 'No structured action items in these minutes', noMinutes: 'No minutes for this meeting yet', noMinutesHint: 'Record, upload or paste a transcript on the left, then generate.',
        pickMeeting: 'Bind a meeting first', noMeetingsForMinutes: 'No meetings yet — create one first.',
        askTitle: 'Meeting Q&A', askSub: 'RAG engine ready · schedule, minutes & documents indexed', newSession: 'New session', sessions: 'History', noSessions: 'No sessions yet.',
        scopeAll: (n) => `All meeting assets (${n} meetings)`, scopeMeeting: 'Current: ', scopeDocs: 'Documents only', delSession: 'Delete',
        welcomeTitle: 'Hi, I am the MeetAI Q&A assistant', welcomeSub: 'Ask about meetings, schedules or materials — answers carry traceable citations.',
        thinking: 'Searching meeting knowledge base & transcripts…', citations: 'Citations', noCitations: 'No citations attached', copyAnswer: 'Copy',
        inputPlaceholder: 'Ask about meetings, schedules or materials…', sendBtn: 'Send', enterHint: 'Enter to send / Shift + Enter for newline', askFailed: 'Q&A failed',
        srcTitle: 'Citation source', srcSource: 'Source', srcStamp: 'Timestamp / locator', srcText: 'Original snippet', close: 'Got it', quote: 'Cite',
        loading: 'Loading…', requestFailed: 'Request failed', meetingDeleted: 'Meeting deleted', deleteSessionFirst: 'Session deleted', detailJumpAsk: (t) => `Summarize the key consensus and action items of "${t}"`,
        agendaFromMeeting: 'Agenda', none: '—',
        newChat: 'New chat', histChat: 'History',
        /* mtHist-20261019：history conversation "more actions" */
        moreActions: 'More actions', pinSession: 'Pin', unpinSession: 'Unpin', renameSession: 'Rename',
        archiveSession: 'Archive', unarchiveSession: 'Unarchive', archivedChat: 'Archived chats', backToHistory: 'Back to history',
        noSessions2: 'No history yet', noArchived: 'No archived chats',
        pinOk: 'Pinned', unpinOk: 'Unpinned', renameOk: 'Renamed', renameEmpty: 'Session name cannot be empty',
        archiveOk: 'Archived', unarchiveOk: 'Unarchived', resizeHint: 'Drag the top edge to resize the input box; double-click to reset',
        attachBtn: 'Attach files', attachTip: 'PDF / DOCX / XLSX / TXT / MD, ≤30MB each', attUploading: 'Uploading attachments…',
        attTooBig: 'File exceeds the 30MB limit', attUnsupported: 'Unsupported file type (.pdf / .docx / .xlsx / .txt / .md only)',
        attUploadFail: 'Failed to upload attachment', attRemove: 'Remove attachment', dropHint: 'Release to attach',
        modelLabel: 'Model', modelDefaultOption: 'System default', modelDefaultSuffix: ' (default)',
        modelLoading: 'Loading models…', modelFail: 'Model list unavailable', modelRetry: 'Retry',
        stopBtn: 'Stop', toolCalling: (name) => `Calling tool: ${name}…`,
      },
    }

    /* ---------------------------------------------------------------- */
    /* 工具                                                               */
    /* ---------------------------------------------------------------- */

    async function request(route, options) {
      const res = await fetch(API + route, { credentials: 'same-origin', ...options })
      let data = null
      try {
        data = await res.json()
      } catch {
        /* 非 JSON 响应 */
      }
      if (!res.ok || !data || data.error || data.ok === false) {
        const error = new Error((data && (data.reason || data.message || data.error)) || `HTTP ${res.status}`)
        error.code = data && (data.error || data.code); error.status = res.status
        throw error
      }
      return data
    }
// Compiled into the existing classic meeting factory. No model or upload substitution.
async function generateWithProgress035(body, { signal, onProgress, resumeTaskId } = {}) {
  signal?.throwIfAborted()
  let taskId, cancelled = false, cancellation
  const report = task => {
    const p = task.progress || {}, phase = task.state === "completed" ? task.state : p.phase || task.state
    const labels = { committing: "正在提交纪要；提交阶段不再接受取消", queued: "等待纪要处理", extract: "正在逐段提取与回查原文", write: "正在按议题生成并核验", word: "正在生成Word并提交纪要", running: "纪要任务处理中", completed: "纪要任务完成" }
    const segments = Number.isSafeInteger(p.plannedSegments) ? ` · 已处理分段 ${p.processedSegments || 0}/${p.plannedSegments}` : ""
    const subsegments = Number.isSafeInteger(p.processedSubsegments) ? ` · 子段 ${p.processedSubsegments}` : ""
    const calls = Number.isSafeInteger(p.completionAttempts) ? ` · 模型调用 ${p.completionAttempts} / 合格缓存 ${p.cacheHits || 0}` : ""
    const pending = Number.isSafeInteger(p.unresolvedCount) ? ` · 待复核 ${p.unresolvedCount}` : ""
    const diagnostic = p.lastErrorCode ? ` · ${p.lastFailedSegment || "分段"}: ${p.lastErrorCode}（原文保留）` : ""
    onProgress?.({ ...task, label: (labels[phase] || "纪要任务处理中") + segments + subsegments + calls + pending + diagnostic })
  }
  const cancel = () => {
    if (cancelled) return cancellation
    if (!taskId) return Promise.resolve({accepted:false})
    cancelled = true
    cancellation = fetch(API + "/generation-tasks/" + encodeURIComponent(taskId), { method: "DELETE", credentials: "same-origin", signal: AbortSignal.timeout(15000) })
      .then(async response=>({accepted:response.ok && (await response.json()).task?.state === "cancelled"})).catch(()=>({accepted:false}))
    return cancellation
  }
  const pause = () => new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", aborted); resolve() }
    const timer = setTimeout(done, 1200)
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(signal.reason || new DOMException("已取消", "AbortError")) }
    if (signal?.aborted) aborted(); else signal?.addEventListener("abort", aborted, { once: true })
  })
  try {
    // Learn the server task ID even if the operator cancels while admission is pending.
    const route = resumeTaskId ? "/generation-tasks/" + encodeURIComponent(resumeTaskId) + "/retry" : "/generation-tasks"
    const admitted = await request(route, { ...json(resumeTaskId ? {} : body), signal: AbortSignal.timeout(30000) })
    let task = admitted.task
    if (!task || !/^[a-f0-9-]{36}$/.test(task.task_id)) throw new Error("服务器未返回合法纪要任务，未显示生成成功。")
    taskId = task.task_id
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) { cancel(); signal.throwIfAborted() }
    for (;;) {
      signal?.throwIfAborted(); report(task)
      if (task.state === "completed") {
        if (!task.result?.minutes?.minutes_id) throw new Error("纪要提交回执缺失，未显示成功。")
        return task.result
      }
      if (["unresolved", "cancelled", "interrupted"].includes(task.state)) {
        const error = new Error(task.result?.reason || "纪要任务未通过或服务已中断；原文与缓存保留，请重试。")
        error.code = task.result?.error || "GENERATION_TASK_" + task.state.toUpperCase(); error.task_id = taskId; error.grounding = task.result?.grounding
        throw error
      }
      await pause()
      const options = { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) }
      task = (await request("/generation-tasks/" + encodeURIComponent(taskId), options)).task
      if (!task || task.task_id !== taskId) throw new Error("纪要任务身份发生变化，停止读取结果。")
    }
  } catch (error) {
    if (signal?.aborted && !(await cancel())?.accepted) error = Object.assign(new Error("取消未获服务器确认；任务可能正在提交，请恢复任务读取最新回执。"), {code:"TASK_CANCELLATION_UNCONFIRMED"})
    if (taskId) error.task_id = taskId
    throw error
  } finally { signal?.removeEventListener("abort", cancel) }
}

    const json = (data) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    const put = (data) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    const patch = (data) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })

    // 与分片存储合同一致：服务端ACK及封存完成后才允许生成，单请求不超过1MiB。
    async function uploadInChunks(file, options) {
      const { create, put: putChunk, commit, abort, onProgress, signal } = options
      const checkAbort = () => { if (signal.aborted) throw Object.assign(new Error('上传已取消'), { name: 'AbortError' }) }
      async function retry(operation) {
        for (let attempt = 0; ; attempt++) {
          checkAbort()
          try { return await operation() }
          catch (error) { if (signal.aborted || (error.status >= 400 && error.status < 500) || attempt >= 2) throw error }
        }
      }
      let id
      try {
        checkAbort()
        const session = await create({ filename: file.name, totalBytes: file.size, meetingId: options.meetingId || '' })
        id = session.uploadId
        const size = session.chunkBytes
        if (!id || !Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024 || session.receivedBytes !== 0) throw new Error('服务器上传会话确认无效')
        let seq = 0
        for (let offset = 0; offset < file.size; offset += size, seq++) {
          checkAbort()
          const end = Math.min(file.size, offset + size)
          const bytes = await file.slice(offset, end).arrayBuffer()
          const digest = await crypto.subtle.digest('SHA-256', bytes)
          const sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
          const ack = await retry(() => putChunk(id, seq, bytes, sha))
          if (ack.seq !== seq || ack.receivedBytes !== end) throw new Error('服务器已保存字节与分片确认不一致')
          onProgress(Math.min(99, Math.floor(end / file.size * 100)), 'upload')
        }
        onProgress(99, 'commit')
        const recording = await retry(() => commit(id))
        if (!recording || !recording.recording_id || recording.size_bytes !== file.size) throw new Error('服务器封存确认无效')
        return recording
      } catch (error) {
        if (id) await abort(id).catch(() => {})
        throw error
      }
    }
    const del = () => ({ method: 'DELETE' })

    const pad2 = (n) => String(n).padStart(2, '0')
    const localInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    const fmtDay = (iso) => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    }
    const fmtTime = (iso) => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }
    const fmtRange = (m) => `${fmtDay(m.start_time)} ${fmtTime(m.start_time)} ~ ${fmtTime(m.end_time)}`
    const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    const startOfWeek = (d) => {
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
      return x
    }
    function deriveStatus(m, now = Date.now()) {
      const s = Date.parse(m.start_time || '')
      if (!Number.isFinite(s) || now < s) return 'upcoming'
      const e = Date.parse(m.end_time || '')
      if (Number.isFinite(e) && now > e) return 'completed'
      return 'in_progress'
    }
    const peopleOf = (m) => (Array.isArray(m.participants) ? m.participants : [])
    const matchMeetings = (m, query) =>
      !query ||
      [m.title, m.location, ...(Array.isArray(m.tags) ? m.tags : []), ...peopleOf(m)].join(' ').toLowerCase().includes(query.toLowerCase())

    function minutesTaskBody({ transcript, template, meetingId = '', recordingId = '', source = 'ai', model = null, wordTemplateId = '' }) {
      return Object.freeze({ transcript, template_type: template, source, word_export: true,
        ...(wordTemplateId ? { word_template_id: wordTemplateId } : {}),
        ...(meetingId ? { meeting_id: meetingId } : {}), ...(recordingId ? { recording_id: recordingId } : {}),
        ...(model ? { provider: model.provider, model: model.model } : {}),
      })
    }
    function clampCaptionPosition(x, y, width, height) {
      return { x: Math.max(8, Math.min(x, Math.max(8, width - Math.min(420, width - 16) - 8))),
        y: Math.max(8, Math.min(y, Math.max(8, height - Math.min(280, height - 16) - 8))) }
    }
    // Module-owned memory retains complete audio across this module's route unmount/remount, not page reload.
    let retainedLiveRound = null
    let retainedMinutesSnapshot = null

    function TaskModelPicker({ catalog, value, onChange, disabled = false }) {
      const label = value ? `${value.provider} / ${value.model}` : '服务端纪要默认'
      return h('details', { className: 'mt-task-model' },
        h('summary', { className: 'mt-btn small', onClick: (event) => { if (disabled) event.preventDefault() }, 'aria-disabled': disabled }, label, ' ▴'),
        h('div', { className: 'mt-task-model-menu' },
          h('button', { className: 'mt-btn small', disabled, onClick: (event) => { onChange(null); event.currentTarget.closest('details').open = false } }, '服务端纪要默认（不改全局）'),
          catalog.state === 'loading' ? h('div', { className: 'mt-muted' }, '正在加载真实模型目录…') : null,
          catalog.state === 'error' ? h('div', { className: 'mt-notice' }, '目录读取失败；可重试，指定模型不得假切换。') : null,
          catalog.groups.map(group => h('div', { key: group.id },
            h('b', null, group.name || group.id),
            group.models.map(model => h('button', { key: model.id, className: 'mt-btn small' + (value && value.provider === group.id && value.model === model.id ? ' primary' : ''), disabled, onClick: (event) => { onChange({ provider: group.id, model: model.id }); event.currentTarget.closest('details').open = false } }, model.name || model.id)),
          )),
          catalog.state === 'ready' && !catalog.groups.length ? h('div', { className: 'mt-muted' }, '暂无可选模型') : null,
        ),
      )
    }

    function Toasts({ toasts }) {
      return h('div', { className: 'mt-toastwrap' }, toasts.map((t) => h('div', { key: t.id, className: `mt-toast ${t.type}` }, t.message)))
    }

    function Modal({ title, narrow, onClose, children }) {
      return h(
        'div',
        { className: 'mt-modal-mask', onMouseDown: (e) => { if (e.target === e.currentTarget && onClose) onClose() } },
        h('div', { className: 'mt-modal' + (narrow ? ' narrow' : ''), role: 'dialog', 'aria-label': title || 'dialog' },
          h('div', { className: 'mt-row mt-between', style: { marginBottom: 10 } },
            h('strong', { style: { fontSize: 15 } }, title),
            onClose ? h('button', { className: 'mt-btn ghost small', onClick: onClose }, '✕') : null,
          ),
          children,
        ),
      )
    }

    function StatusPill({ status, t }) {
      const map = { upcoming: ['blue', t.upcoming], in_progress: ['green', t.inProgress], completed: ['gray', t.completed] }
      const [cls, label] = map[status] || map.upcoming
      return h('span', { className: `mt-pill ${cls}` }, status === 'in_progress' ? h('span', { className: 'mt-breathe' }) : null, label)
    }

    function MinutesPill({ value, t }) {
      const map = {
        none: ['gray', t.minutesStatusNone],
        ready: ['amber', h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h('span', { className: 'mt-breathe' }), t.minutesStatusReady)],
        archived: ['green', t.minutesStatusArchived],
      }
      const [cls, label] = map[value] || map.none
      return h('span', { className: `mt-pill ${cls}` }, label)
    }

    /* ---------------------------------------------------------------- */
    /* 视图一：会议日程（列表 / 周 / 月）                                    */
    /* ---------------------------------------------------------------- */

    const WEEKDAYS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const WEEKDAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    function ScheduleView({ t, lang, meetings, onDetail, onNew, gotoMinutes, gotoAsk, togglePin, showToast, refreshMeetings }) {
      const [creating, setCreating] = useState(false)
      const [dayDetails, setDayDetails] = useState(null)
      const [view, setView] = useState('list')
      const [anchor, setAnchor] = useState(() => new Date())
      const [pinnedOnly, setPinnedOnly] = useState(false)
      const [statusFilter, setStatusFilter] = useState('all')
      const [query, setQuery] = useState('')
      const now = Date.now()

      const filtered = useMemo(() => {
        const rows = meetings
          .filter((m) => (!pinnedOnly || m.is_pinned) && (statusFilter === 'all' || deriveStatus(m, now) === statusFilter) && matchMeetings(m, query))
        return rows.sort((a, b) => Number(b.is_pinned === true) - Number(a.is_pinned === true) || Date.parse(b.start_time || '') - Date.parse(a.start_time || ''))
      }, [meetings, pinnedOnly, statusFilter, query, now])

      const periodLabel = useMemo(() => {
        const y = anchor.getFullYear()
        const m = anchor.getMonth() + 1
        if (view === 'week') {
          const week = Math.ceil(((anchor - new Date(y, 0, 1)) / 86400000 + new Date(y, 0, 1).getDay() + 1) / 7)
          return t.weekNo(y, m, week)
        }
        if (view === 'month') return t.monthLabel(y, m)
        return ''
      }, [view, anchor, t])

      const shift = (dir) => {
        const d = new Date(anchor)
        if (view === 'week') d.setDate(d.getDate() + dir * 7)
        else if (view === 'month') d.setMonth(d.getMonth() + dir)
        setAnchor(d)
      }

      function MeetingCard({ m }) {
        const people = peopleOf(m)
        const st = deriveStatus(m, now)
        return h('article', { className: `mt-card mt-mcard s-${st}`, key: m.id },
          h('div', { className: 'mt-row mt-between' },
            h('div', { className: 'mt-row', style: { minWidth: 0 } },
              h('button', {
                className: 'mt-star' + (m.is_pinned ? ' on' : ''), title: m.is_pinned ? t.starOff : t.starOn,
                onClick: () => togglePin(m),
              }, m.is_pinned ? '★' : '☆'),
              h('button', { className: 'mt-btn ghost', style: { fontWeight: 700, fontSize: 14, padding: '2px 6px' }, onClick: () => onDetail(m) }, m.title),
              m.is_pinned ? h('span', { className: 'mt-pill amber' }, '⭐ ', t.pinnedBadge) : null,
            ),
            h('div', { className: 'mt-row' },
              StatusPill({ status: st, t }),
              MinutesPill({ value: m.minutes_status || 'none', t }),
            ),
          ),
          // v0.2.4 精致排版：日期徽标（mt-when b）+ 等宽时间段 + 地点/参会人分列（超长省略）
          h('div', { className: 'mt-metarow' },
            h('span', { className: 'mt-when' }, '◷ ', h('b', null, fmtDay(m.start_time)), ' ', fmtTime(m.start_time), ' ~ ', fmtTime(m.end_time)),
            m.location ? h('span', { className: 'mt-where' }, '📍 ', m.location) : null,
            people.length
              ? h('span', { className: 'mt-who' }, '👥 ',
                  `${people.slice(0, 3).join('、')}${people.length > 3 ? ` ${t.etc} ${people.length} ${lang === 'en' ? 'people' : '人'}` : ''}`)
              : null,
          ),
          h('div', { className: 'mt-row' },
            (Array.isArray(m.tags) ? m.tags : []).map((tag) => h('span', { className: 'mt-chip', key: tag }, '# ', tag)),
            h('span', { className: 'mt-chip' }, '📅 ', t.agendaFromMeeting, ' ', (m.agenda || []).length),
            h('span', { style: { flex: 1 } }),
            h('button', { className: 'mt-btn small', onClick: () => onDetail(m) }, t.detail),
            h('button', { className: 'mt-btn small', onClick: () => gotoMinutes(m.id) }, t.gotoMinutes),
            h('button', { className: 'mt-btn small', onClick: () => gotoAsk(m) }, t.gotoAsk),
          ),
        )
      }

      function dayMeetings(date) {
        return filtered.filter((m) => {
          const s = new Date(m.start_time || '')
          return Number.isFinite(s.getTime()) && sameDay(s, date)
        })
      }

      function WeekView() {
        const start = startOfWeek(anchor)
        const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d })
        const today = new Date()
        const wd = lang === 'en' ? WEEKDAYS_EN : WEEKDAYS_ZH
        return h('div', null,
          h('div', { className: 'mt-cal' }, days.map((d) => h('div', { className: 'mt-calhead' + (sameDay(d, today) ? ' mt-cell today' : ''), key: d.toISOString() }, wd[(d.getDay() + 6) % 7], ' ', pad2(d.getDate()), sameDay(d, today) ? (lang === 'en' ? ' (today)' : '（今日）') : ''))),
          h('div', { className: 'mt-cal', style: { marginTop: 4 } }, days.map((d) => {
            const list = dayMeetings(d)
            return h('div', { className: 'mt-cell' + (sameDay(d, today) ? ' today' : ''), key: d.toISOString() },
              list.length
                ? list.map((m) => h('button', { className: 'mt-ev' + (m.is_pinned ? ' pinned' : ''), key: m.id, onClick: () => onDetail(m) }, (m.is_pinned ? '★ ' : '') + `${fmtTime(m.start_time)} ${m.title}`))
                : h('div', { className: 'mt-evmore' }, t.noMeetings),
            )
          })),
        )
      }

      function MonthView() {
        const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
        const start = startOfWeek(first)
        const today = new Date()
        const cells = [...Array(42)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d })
        return h('div', null,
          h('div', { className: 'mt-cal' }, (lang === 'en' ? WEEKDAYS_EN : WEEKDAYS_ZH).map((w) => h('div', { className: 'mt-calhead', key: w }, w))),
          h('div', { className: 'mt-cal', style: { marginTop: 4 } }, cells.map((d) => {
            const list = dayMeetings(d)
            const inMonth = d.getMonth() === anchor.getMonth()
            return h('div', { className: 'mt-cell' + (sameDay(d, today) ? ' today' : '') + (inMonth ? '' : ' dim'), key: d.toISOString() },
              h('div', { className: 'mt-daynum' }, d.getDate(), sameDay(d, today) ? (lang === 'en' ? ' •' : ' 今') : ''),
              list.slice(0, 3).map((m) => h('button', { className: 'mt-ev' + (m.is_pinned ? ' pinned' : ''), key: m.id, onClick: () => onDetail(m) }, (m.is_pinned ? '★ ' : '') + m.title)),
              list.length > 3 ? h('button', { className: 'mt-evmore mt-day-more', onClick: () => setDayDetails(d) }, t.more(list.length - 3)) : null,
              list.length
                ? h('div', { className: 'mt-pop' },
                    h('div', { className: 'mt-muted', style: { marginBottom: 5 } }, `${d.getMonth() + 1}-${pad2(d.getDate())} · ${list.length}`),
                    list.map((m) => h('button', { className: 'mt-ev', key: m.id, onClick: () => onDetail(m) }, `${fmtTime(m.start_time)} ${m.title}`)),
                  )
                : null,
            )
          })),
        )
      }

      return h('div', null,
        h('div', { className: 'mt-toolbar' },
          h('div', { className: 'mt-seg', role: 'tablist' },
            [['list', t.viewList], ['week', t.viewWeek], ['month', t.viewMonth]].map(([v, label]) =>
              h('button', { key: v, 'aria-pressed': view === v, onClick: () => setView(v) }, label),
            ),
          ),
          view !== 'list' ? h('button', { className: 'mt-btn small', onClick: () => setAnchor(new Date()) }, t.today) : null,
          view !== 'list' ? h('button', { className: 'mt-btn small', onClick: () => shift(-1) }, '‹') : null,
          view !== 'list' ? h('button', { className: 'mt-btn small', onClick: () => shift(1) }, '›') : null,
          periodLabel ? h('span', { className: 'mt-secondary', style: { fontWeight: 650 } }, periodLabel) : null,
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'mt-toggle', 'aria-pressed': pinnedOnly, onClick: () => setPinnedOnly(!pinnedOnly) }, '★ ', t.pinnedOnly),
          h('select', { className: 'mt-select', value: statusFilter, onChange: (e) => setStatusFilter(e.target.value) },
            [['all', t.allStatus], ['upcoming', t.upcoming], ['in_progress', t.inProgress], ['completed', t.completed]].map(([v, label]) =>
              h('option', { key: v, value: v }, label),
            ),
          ),
          h('input', { className: 'mt-input', style: { width: 210 }, value: query, placeholder: t.searchPlaceholder, onChange: (e) => setQuery(e.target.value) }),
          h('button', { className: 'mt-btn primary', onClick: () => setCreating(open => !open) }, creating ? '收起新建会议' : '＋ ' + t.newMeeting),
        ),
        creating ? h(CreateView, { t, showToast, refreshMeetings, onCreated: () => setCreating(false) }) : null,
        view === 'list' && h('div', { className: 'mt-stack' },
          filtered.length === 0
            ? h('div', { className: 'mt-empty' }, h('div', { style: { fontWeight: 700, marginBottom: 4 } }, t.emptySchedule), h('div', { className: 'mt-muted' }, t.emptyScheduleHint))
            : filtered.map((m) => h(MeetingCard, { m, key: m.id })),
        ),
        view === 'week' ? h('div', { className: 'mt-calendar-scroll' }, WeekView()) : null,
        view === 'month' ? h('div', { className: 'mt-calendar-scroll' }, MonthView()) : null,
        dayDetails ? h(Modal, { title: dayDetails.getFullYear() + '-' + pad2(dayDetails.getMonth() + 1) + '-' + pad2(dayDetails.getDate()) + ' 会议', onClose: () => setDayDetails(null) },
          h('div', { className: 'mt-stack' }, dayMeetings(dayDetails).map(item => h('button', { className: 'mt-day-meeting', key: item.id, onClick: () => { setDayDetails(null); onDetail(item) } },
            h('b', null, item.title), h('span', null, fmtTime(item.start_time) + ' — ' + fmtTime(item.end_time)),
            h('span', { className: 'mt-muted' }, item.location || '地点未填写'),
          ))),
        ) : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /* 详情弹窗                                                           */
    /* ---------------------------------------------------------------- */

    function DetailModal({ t, meeting, onClose, gotoMinutes, gotoAsk }) {
      const [docs, setDocs] = useState([])
      useEffect(() => {
        let alive = true
        request(`/docs?meeting_id=${encodeURIComponent(meeting.id)}`)
          .then((d) => { if (alive) setDocs(d.docs || []) })
          .catch(() => {})
        return () => { alive = false }
      }, [meeting.id])
      const people = peopleOf(meeting)
      return h(Modal, { title: meeting.title, onClose },
        h('div', { className: 'mt-row', style: { marginBottom: 10 } },
          StatusPill({ status: deriveStatus(meeting), t }),
          MinutesPill({ value: meeting.minutes_status || 'none', t }),
          meeting.is_pinned ? h('span', { className: 'mt-pill amber' }, '⭐ ', t.pinnedBadge) : null,
        ),
        h('div', { className: 'mt-grid2', style: { marginBottom: 10 } },
          h('div', { className: 'mt-muted' }, '◷ ', fmtRange(meeting)),
          h('div', { className: 'mt-muted' }, '📍 ', meeting.location || t.none, meeting.meeting_link ? ` · 🔗 ${meeting.meeting_link}` : ''),
        ),
        people.length ? h('div', { className: 'mt-row', style: { marginBottom: 10 } }, people.map((p) => h('span', { className: 'mt-chip', key: p }, '👥 ', p))) : null,
        h('div', { style: { marginBottom: 10 } },
          h('div', { className: 'mt-h3' }, '📅 ', t.agendaFromMeeting),
          (meeting.agenda || []).length
            ? meeting.agenda.map((row, i) =>
                h('div', { className: 'mt-agendaline', key: i },
                  h('span', { className: 'mt-time' }, row.time_range || '--'),
                  h('span', { className: 'mt-grow' }, row.topic, row.objective ? h('div', { className: 'mt-muted' }, row.objective) : null),
                  row.speaker ? h('span', { className: 'mt-chip' }, row.speaker) : null,
                ),
              )
            : h('div', { className: 'mt-muted' }, t.noAgenda),
        ),
        h('div', { style: { marginBottom: 14 } },
          h('div', { className: 'mt-h3' }, '📎 ', t.materialTitle),
          docs.length
            ? docs.map((d) => h('div', { className: 'mt-file', key: d.file_id },
                h('span', { className: 'name' }, d.name),
                h('span', { className: 'mt-muted' }, fmtBytes(d.size)),
                d.has_text ? h('span', { className: 'mt-pill green' }, t.materialTextReady) : h('span', { className: 'mt-pill gray' }, t.materialQueued),
              ))
            : h('div', { className: 'mt-muted' }, t.none),
        ),
        h('div', { className: 'mt-row', style: { justifyContent: 'flex-end' } },
          h('button', { className: 'mt-btn', onClick: onClose }, t.close),
          h('button', { className: 'mt-btn', onClick: () => gotoMinutes(meeting.id) }, t.gotoMinutes),
          h('button', { className: 'mt-btn primary', onClick: () => gotoAsk(meeting) }, t.gotoAsk),
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 视图二：新建会议                                                    */
    /* ---------------------------------------------------------------- */

    function CreateView({ t, onCreated, showToast, refreshMeetings }) {
      const [form, setForm] = useState(() => ({
        title: '', start: localInput(new Date(Date.now() + 3600000)), end: localInput(new Date(Date.now() + 7200000)),
        type: 'offline', location: '', meeting_link: '', participants: '', tags: '', is_pinned: false,
      }))
      const [agenda, setAgenda] = useState([])
      const [materials, setMaterials] = useState([])
      const [busy, setBusy] = useState(false)
      const [agendaBusy, setAgendaBusy] = useState(false)
      const fileRef = useRef(null)
      const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
      const locLabel = form.type === 'online' ? t.locOnline : form.type === 'offline' ? t.locOffline : t.locHybrid

      async function genAgenda() {
        if (!form.title.trim()) return showToast(t.needTitle, 'warn')
        setAgendaBusy(true)
        try {
          const data = await request('/agenda', json({
            title: form.title.trim(),
            duration_minutes: String(Math.max(15, Math.round((Date.parse(form.end) - Date.parse(form.start)) / 60000)) || 60),
            participants: form.participants,
            start_time: form.start,
          }))
          if (!data.agenda || !data.agenda.length) showToast(t.aiAgendaEmpty, 'warn')
          else { setAgenda(data.agenda); showToast(t.aiAgendaDone, 'success') }
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setAgendaBusy(false)
        }
      }

      function pickFiles(e) {
        const files = [...(e.target.files || [])]
        e.target.value = ''
        for (const f of files) {
          if (f.size > 10 * 1024 * 1024) { showToast(`${f.name}: ${t.materialTooBig}`, 'error'); continue }
          const isText = /\.(txt|md|markdown)$/i.test(f.name)
          if (isText) {
            const reader = new FileReader()
            reader.onload = () => setMaterials((list) => [...list, { name: f.name, size: f.size, text: String(reader.result || '') }])
            reader.onerror = () => setMaterials((list) => [...list, { name: f.name, size: f.size, text: '' }])
            reader.readAsText(f)
          } else {
            setMaterials((list) => [...list, { name: f.name, size: f.size, text: '' }])
          }
        }
      }

      async function submit() {
        if (!form.title.trim()) return showToast(t.needTitle, 'warn')
        const startMs = Date.parse(form.start), endMs = Date.parse(form.end)
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.end) ||
            !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return showToast(t.needTime, 'warn')
        const startIso = new Date(startMs).toISOString(), endIso = new Date(endMs).toISOString()
        setBusy(true)
        try {
          const data = await request('/meetings', json({
            title: form.title.trim(),
            start_time: startIso,
            end_time: endIso,
            type: form.type,
            location: form.location.trim(),
            meeting_link: form.meeting_link.trim(),
            is_pinned: form.is_pinned,
            participants: form.participants.split(/[,，、]/).map((x) => x.trim()).filter(Boolean),
            tags: form.tags.split(/[,，、]/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean),
            agenda: agenda.filter((row) => row.topic || row.time_range),
          }))
          const meetingId = data.meeting && data.meeting.id
          for (const mat of materials) {
            await request('/docs', json({ name: mat.name, size: mat.size, meeting_id: meetingId, text: mat.text || '' })).catch(() => {})
          }
          setForm((f) => ({ ...f, title: '', location: '', meeting_link: '', participants: '', tags: '', is_pinned: false }))
          setAgenda([])
          setMaterials([])
          await refreshMeetings()
          showToast(t.created, 'success')
          onCreated()
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      const setRow = (i, k, v) => setAgenda((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))

      return h('div', { className: 'mt-card mt-create mt-stack' },
        h('div', { className: 'mt-row mt-between' }, h('h3', { className: 'mt-h3' }, '新建会议'), h('span', { className: 'mt-muted' }, '时间按浏览器时区 ' + Intl.DateTimeFormat().resolvedOptions().timeZone + ' 保存为ISO时间')),
        h('div', { className: 'mt-grid2' },
          h('label', { className: 'mt-field' }, t.fTitle, h('input', { className: 'mt-input', value: form.title, maxLength: 120, placeholder: lang0(t), onChange: e => set('title', e.target.value) })),
          h('label', { className: 'mt-field' }, locLabel, h('input', { className: 'mt-input', value: form.location, onChange: e => set('location', e.target.value) })),
          h('label', { className: 'mt-field' }, t.fStart, h('input', { className: 'mt-input', type: 'datetime-local', value: form.start, onChange: e => set('start', e.target.value) })),
          h('label', { className: 'mt-field' }, t.fEnd, h('input', { className: 'mt-input', type: 'datetime-local', value: form.end, onChange: e => set('end', e.target.value) })),
          h('label', { className: 'mt-field' }, t.fParticipants, h('input', { className: 'mt-input', value: form.participants, placeholder: '张三, 李四', onChange: e => set('participants', e.target.value) })),
        ),
        h('details', { className: 'mt-create-more' },
          h('summary', { className: 'mt-btn small' }, '更多会议信息 · 形式 / 标签 / 议程 / 材料'),
          h('div', { className: 'mt-stack' },
            h('div', { className: 'mt-grid2' },
              h('label', { className: 'mt-field' }, t.fType, h('select', { className: 'mt-select', value: form.type, onChange: e => set('type', e.target.value) }, [['offline', t.typeOffline], ['online', t.typeOnline], ['hybrid', t.typeHybrid]].map(([id, label]) => h('option', { key: id, value: id }, label)))),
              h('label', { className: 'mt-field' }, t.fTags, h('input', { className: 'mt-input', value: form.tags, placeholder: '#战略决策, Q4', onChange: e => set('tags', e.target.value) })),
              h('label', { className: 'mt-field' }, t.meetingLink, h('input', { className: 'mt-input', value: form.meeting_link, onChange: e => set('meeting_link', e.target.value) })),
              h('label', { className: 'mt-row' }, h('input', { type: 'checkbox', checked: form.is_pinned, onChange: e => set('is_pinned', e.target.checked) }), '⭐ ', t.fPinned),
            ),
            h('div', { className: 'mt-row mt-between' }, h('h3', { className: 'mt-h3' }, t.agendaTitle), h('button', { className: 'mt-btn small', disabled: agendaBusy, onClick: genAgenda }, agendaBusy ? t.aiAgendaBusy : '✦ ' + t.aiAgenda)),
            agenda.map((row, i) => h('div', { className: 'mt-agenda-row', key: i },
              h('input', { className: 'mt-input', value: row.time_range || '', placeholder: t.agendaTime, onChange: e => setRow(i, 'time_range', e.target.value) }),
              h('input', { className: 'mt-input', value: row.topic || '', placeholder: t.agendaTopic, onChange: e => setRow(i, 'topic', e.target.value) }),
              h('input', { className: 'mt-input', value: row.speaker || '', placeholder: t.agendaSpeaker, onChange: e => setRow(i, 'speaker', e.target.value) }),
              h('input', { className: 'mt-input', value: row.objective || '', placeholder: '交付目标', onChange: e => setRow(i, 'objective', e.target.value) }),
              h('button', { className: 'mt-btn small danger', onClick: () => setAgenda(rows => rows.filter((_, j) => j !== i)) }, '×'),
            )),
            h('button', { className: 'mt-btn small', onClick: () => setAgenda(rows => [...rows, { time_range: '', topic: '', speaker: '', objective: '' }]) }, '＋ ' + t.addAgenda),
            h('h3', { className: 'mt-h3' }, t.materialTitle),
            h('div', { className: 'mt-drop', onClick: () => fileRef.current?.click() }, t.materialHint),
            h('input', { ref: fileRef, type: 'file', multiple: true, style: { display: 'none' }, onChange: pickFiles }),
            materials.map((mat, i) => h('div', { className: 'mt-file', key: mat.name + '-' + i }, h('span', { className: 'name' }, mat.name), h('span', { className: 'mt-muted' }, fmtBytes(mat.size)), h('span', { className: 'mt-pill gray' }, mat.text ? t.materialTextReady : t.materialQueued), h('button', { className: 'mt-btn small danger', onClick: () => setMaterials(list => list.filter((_, j) => j !== i)) }, '×'))),
          ),
        ),
        h('div', { className: 'mt-row', style: { justifyContent: 'flex-end' } }, h('button', { className: 'mt-btn primary', disabled: busy || !form.title.trim() || !Number.isFinite(Date.parse(form.start)) || !Number.isFinite(Date.parse(form.end)) || Date.parse(form.end) <= Date.parse(form.start), onClick: submit }, busy ? '正在创建…' : t.submitCreate)),
      )
    }
    const lang0 = (t) => (t.fTitle === '会议主题' ? '例如：Q4 算力扩容专项评审会' : 'e.g. Q4 compute expansion review')

    /* ---------------------------------------------------------------- */
    /* 视图三：会议纪要（实时录音 / 上传录音 / 粘贴文本 三来源）              */
    /* ---------------------------------------------------------------- */

// Insert inside the existing classic client factory; uses its React/h/request/json bindings.
// Classic factory helper: public save receipt is not a replacement for nonce/edit_epoch or server verification.
async function classifyWordSave(result, expected) {
  const receipt=result?.saveReceipt, minutes=result?.minutes
  const uncertain=message=>({state:'save_uncertain',wordSaved:false,receipt:receipt || null,minutes:null,message})
  // Archived documents are already authoritative read-only artifacts, not a new force-save transaction.
  if(expected.readonly && result?.state==='saved' && minutes?.is_archived && receipt?.state!=='save_uncertain' && receipt?.state!=='saved_pending_recovery'){
    const doc=minutes.word_document
    if(minutes.minutes_id===expected.minutesId && (minutes.meeting_id || '')===(expected.meetingId || '') && Number.isSafeInteger(minutes.version) && minutes.version>=expected.minimumVersion && doc && /^[a-f0-9-]{36}$/.test(doc.artifact_id || '') && /^[a-f0-9]{64}$/.test(doc.docx_sha256 || '') && doc.docx_url==='/api/meeting-assistant/word-documents/'+doc.artifact_id+'/download')return {state:'saved',wordSaved:true,receipt:null,minutes,message:'已核验当前归档Word，无需再次强制保存。'}
    return uncertain('归档Word版本或artifact/hash未确认；未下载旧稿。')
  }
  if(result?.state==='failed' || receipt?.state==='failed')return {state:'failed',wordSaved:false,receipt:receipt || null,minutes:null,message:result?.error || 'Word保存未完成；原稿和当前编辑保留。'}
  if(result?.state==='save_uncertain' || receipt?.state==='save_uncertain' || receipt?.wordSaved===false)return uncertain('Word保存提交结果尚待核对；未下载旧稿，请核对保存收据。')
  if(!['saved','saved_pending_recovery'].includes(result?.state) || !receipt || receipt.schemaVersion!==1 || !['saved','saved_pending_recovery'].includes(receipt.state) || receipt.wordSaved!==true)return uncertain('尚未取得可核验的Word保存收据；未把旧稿作为最新稿导出。')
  const doc=minutes?.word_document
  if(!minutes || minutes.minutes_id!==expected.minutesId || (minutes.meeting_id || '')!==(expected.meetingId || '') || receipt.minutesId!==minutes.minutes_id || (receipt.meetingId || '')!==(minutes.meeting_id || '') || !Number.isSafeInteger(minutes.version) || minutes.version<expected.minimumVersion || receipt.version!==minutes.version)return uncertain('保存收据与会议、纪要或最新版本不一致；停止下载与替换预览。')
  if(!/^save_[a-f0-9]{64}$/.test(receipt.receiptId || '') || !doc || !/^[a-f0-9-]{36}$/.test(doc.artifact_id || '') || receipt.artifactId!==doc.artifact_id || !/^[a-f0-9]{64}$/.test(receipt.docxSha256 || '') || receipt.docxSha256!==doc.docx_sha256 || !/^[a-f0-9]{64}$/.test(receipt.contentSha256 || '') || doc.docx_url!=='/api/meeting-assistant/word-documents/'+doc.artifact_id+'/download')return uncertain('最新Word artifact/hash/下载地址与保存收据未对齐；不导出旧文件。')
  if(expected.editEpoch!==undefined && result.edit_epoch!==expected.editEpoch)return uncertain('保存回执edit_epoch不一致；当前编辑继续保留。')
  if(typeof minutes.content!=='string' || minutes.content.length>2000000)return uncertain('完整正文未能按既定上限核验；不截断、不导出旧稿。')
  try{const bytes=new TextEncoder().encode(minutes.content),digest=await crypto.subtle.digest('SHA-256',bytes);const hash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');if(hash!==receipt.contentSha256)return uncertain('正文SHA256与保存收据不一致；停止替换与导出。')}catch{return uncertain('浏览器未能验证完整正文SHA256；Word提交待核对，未下载旧稿。')}
  const receiptPending=receipt.receiptUpdatePending===true || result.receiptUpdatePending===true,relationshipPending=result.relationshipPending===true || receipt.relationshipRecovery!=='complete',pending=receipt.state==='saved_pending_recovery' || receiptPending || relationshipPending
  return {state:pending?'saved_pending_recovery':'saved',wordSaved:true,receipt,minutes:{...minutes,saveReceipt:receipt,relationshipPending,receiptUpdatePending:receiptPending},message:receiptPending?'Word文字与排版已保存，保存收据待核对；不会再次强制保存或覆盖排版。':pending?'Word文字与排版已保存；资产关系待恢复。可导出此已核验最新Word，恢复关系不会重新生成或套用模板。':'最新Word与资产关系已保存。'}
}
function wordSaveError(classification){const error=new Error(classification.message);error.saveState=classification.state;error.wordSaved=classification.wordSaved;error.code=classification.state==='save_uncertain'?'WORD_SAVE_UNCERTAIN':'WORD_SAVE_FAILED';return error}
function downloadConfirmedWord(minutes){const doc=minutes.word_document;if(!/^[a-f0-9-]{36}$/.test(doc.artifact_id) || doc.docx_url!=='/api/meeting-assistant/word-documents/'+doc.artifact_id+'/download')throw new Error('Word下载地址未通过校验。');const link=document.createElement('a');link.href=doc.docx_url;link.download=(minutes.title || '会议纪要')+'.docx';link.click()}

// Insert inside existing classic factory; nonce, edit_epoch, SDK sync and save fence remain authoritative.
function WordEditorPane({ minutes, onSaved, onState, apiRef }) {
  const containerRef = useRef(null), editorRef = useRef(null), sessionRef = useRef(null)
  const epochRef = useRef(0), aliveRef = useRef(false), saveLock = useRef(false), abortRef = useRef(null), fenceRef = useRef(null), syncedRef = useRef(true), syncWaiters = useRef(new Set())
  const [phase, setPhase] = useState('loading'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirtyWord, setDirtyWord] = useState(false), [retry, setRetry] = useState(0)
   const saveAttemptRef=useRef(null)
   const savedResultRef=useRef(null),[receiptState,setReceiptState]=useState(minutes.saveReceipt || null),[saveNotice,setSaveNotice]=useState('')
  const latest = useRef({ onSaved, onState, minutes }); latest.current = { onSaved, onState, minutes }
  useEffect(() => { latest.current.onState?.({ ready: phase === 'ready', dirty: dirtyWord, busy, error,saveReceipt:receiptState }) }, [phase, dirtyWord, busy, error,receiptState])
  useEffect(() => { if (busy) fenceRef.current?.focus() }, [busy])
  async function acceptReceipt(result,sid,epoch,editEpoch,minimumVersion,replacePreview){
    const target=latest.current.minutes
    const classification=await classifyWordSave(result,{minutesId:target.minutes_id,meetingId:target.meeting_id,minimumVersion:minimumVersion ?? target.version,editEpoch,readonly:target.is_archived===true})
    if(!aliveRef.current || sessionRef.current!==sid || latest.current.minutes.minutes_id!==target.minutes_id)return classification
    savedResultRef.current={result,classification,sid,epoch}
    setReceiptState({...classification.receipt,state:classification.state,wordSaved:classification.wordSaved});setSaveNotice(classification.message)
    if(replacePreview && classification.wordSaved && epochRef.current===epoch){latest.current.onSaved?.(classification.minutes);setDirtyWord(false)}
    return classification
  }
  useEffect(() => {
    let active = true; aliveRef.current = true
    const ac = new AbortController(); abortRef.current = ac
    const targetId = 'meet-word-' + Date.now().toString(36) + Math.random().toString(36).slice(2)
    const slot = document.createElement('div'); slot.id = targetId; slot.style.width = '100%'; slot.style.height = '100%'
    containerRef.current.replaceChildren(slot); epochRef.current = 0; sessionRef.current = null; syncedRef.current = true;savedResultRef.current=null
    setPhase('loading'); setError(''); setDirtyWord(false);setReceiptState(minutes.saveReceipt || null);setSaveNotice('')
    async function open() {
      const data = await request('/word-editor/sessions', { ...json({ minutes_id: minutes.minutes_id, compact:true }), signal: ac.signal })
      if (!active) return
      if (!data.session_id || !/^\/meeting-word-editor\/web-apps\/apps\/api\/documents\/api\.js$/.test(data.sdk_url || '')) throw new Error('本地 Word 编辑入口无效。')
      sessionRef.current = data.session_id
      // Reopened service can report its durable save receipt. No force-save or model call on recovery.
      const status=data.export?data:await request('/word-editor/sessions/'+data.session_id,{signal:ac.signal})
      if(!active)return
      if(status.export?.saveReceipt){
        const resumed={...status.export,minutes:status.export.minutes || data.minutes}
        if(resumed.saveReceipt.wordSaved && (!data.minutes || resumed.minutes?.version!==data.minutes.version || resumed.minutes?.word_document?.artifact_id!==data.minutes.word_document?.artifact_id))throw new Error('Word文档源已更新；请重开编辑器读取真实最新版本，未套用旧文档。')
        await acceptReceipt(resumed,data.session_id,0,undefined,minutes.version,true)
        if(!active)return
      }
      if (!window.DocsAPI) {
        if (!window.__meetaiDocsSdk) window.__meetaiDocsSdk = new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = data.sdk_url; script.async = true
          script.onload = () => window.DocsAPI ? resolve() : reject(new Error('Word SDK 未就绪'))
          script.onerror = () => { script.remove(); window.__meetaiDocsSdk = null; reject(new Error('本地 Word 服务脚本加载失败')) }
          document.head.appendChild(script)
        })
        await window.__meetaiDocsSdk
      }
      if (!active) return
      editorRef.current = new window.DocsAPI.DocEditor(targetId, { ...data.config, events: {
        onDocumentReady: () => { if (active) setPhase('ready') },
        onDocumentStateChange: event => {
          if (!active) return
          if (event.data === true) { syncedRef.current = false; epochRef.current++; setDirtyWord(true) }
          else if (event.data === false) { syncedRef.current = true; for (const finish of [...syncWaiters.current]) finish() }
        },
        onError: event => { if (active) { setError('Word 编辑服务错误：' + String(event?.data?.errorDescription || event?.data?.errorCode || '请重试')); setPhase('error') } }
      } })
    }
    open().catch(reason => { if (active && reason.name !== 'AbortError') { setError('草稿已保存，编辑器加载失败：' + reason.message); setPhase('error') } })
    return () => { active = false; aliveRef.current = false; ac.abort(); editorRef.current?.destroyEditor(); editorRef.current = null; sessionRef.current = null }
  }, [minutes.minutes_id, retry])
  async function verifyPendingWordSave(){
    const binding=savedResultRef.current,sid=sessionRef.current
    if(saveLock.current||!sid||!binding||binding.sid!==sid)return
    saveLock.current=true;setBusy(true);setError('')
    try{const state=await request('/word-editor/sessions/'+sid,{signal:abortRef.current.signal}),result=state.export
      if(!aliveRef.current||sessionRef.current!==sid||savedResultRef.current!==binding)return
      if(!binding.result.request_id||!result||result.request_id!==binding.result.request_id||result.edit_epoch!==binding.result.edit_epoch)throw new Error('保存请求标识未确认；请核对最新已存稿，本次不重提或下载。')
      if(result.state==='pending'){setSaveNotice('服务端仍在确认保存；没有重提保存或下载旧稿。');return}
      const attempt=saveAttemptRef.current,classification=await acceptReceipt(result,sid,binding.epoch,binding.result.edit_epoch,attempt?.minimumVersion||latest.current.minutes.version,epochRef.current===binding.epoch)
      if(!classification.wordSaved)throw wordSaveError(classification)
    }catch(error){if(aliveRef.current)setError(error.message)}finally{saveLock.current=false;if(aliveRef.current)setBusy(false)}
  }
  async function recoverWordRelations(){
    const binding=savedResultRef.current,sid=sessionRef.current
    if(saveLock.current || !sid || !binding?.classification.receipt?.receiptId || binding.sid!==sid)return
    saveLock.current=true;setBusy(true);setError('')
    try{
      const result=await request('/word-editor/sessions/'+sid+'/recovery',{...json({receipt_id:binding.classification.receipt.receiptId}),signal:abortRef.current.signal})
      if(!aliveRef.current || sessionRef.current!==sid || savedResultRef.current!==binding)return
      if(result.request_id!==binding.result.request_id || result.edit_epoch!==binding.result.edit_epoch)throw Object.assign(new Error('关系恢复回执与原保存nonce/edit_epoch不一致；当前稿和编辑保留。'),{saveState:'save_uncertain'})
      const unchanged=epochRef.current===binding.epoch
      const classification=await acceptReceipt(result,sid,binding.epoch,undefined,latest.current.minutes.version,unchanged)
      if(classification.state==='failed' || classification.state==='save_uncertain')throw wordSaveError(classification)
    }catch(reason){if(aliveRef.current && reason.name!=='AbortError'){setError('保存收据核对／关系恢复未完成：'+reason.message);setSaveNotice(binding.classification.wordSaved?'Word此前已确认保存；保存收据核对／关系恢复尚未完成，不会重跑生成或覆盖排版。':'Word提交结果仍待核对；没有下载旧稿，也未再次强制保存。')}}
    finally{saveLock.current=false;if(aliveRef.current)setBusy(false)}
  }
  async function saveWord(download = false) {
    if (saveLock.current || phase !== 'ready' || !sessionRef.current) throw new Error('Word 编辑器尚未就绪或正在保存。')
    const prior=savedResultRef.current
    if(prior?.classification.state==='save_uncertain')throw wordSaveError(prior.classification)
    // A relationship-only recovery is not another Word save; retain the already confirmed artifact.
    if(prior?.classification.wordSaved && prior.sid===sessionRef.current && prior.epoch===epochRef.current && !dirtyWord){if(download)downloadConfirmedWord(prior.classification.minutes);return prior.classification.minutes}
    saveLock.current = true; setBusy(true); setError('')
    const sid = sessionRef.current, epoch = epochRef.current, ac = abortRef.current,hadLocalChanges=dirtyWord || (prior?prior.epoch!==epoch:epoch>0),minimumVersion=latest.current.minutes.version+(hadLocalChanges?1:0)
    try {
      // Fence immediately, then wait for the SDK's native server acknowledgment.
      // A successful force-save command alone cannot flush pending local edits.
      if (containerRef.current) { containerRef.current.inert = true; containerRef.current.style.pointerEvents = 'none' }
      document.activeElement?.blur?.(); fenceRef.current?.focus()
      await new Promise(resolve => window.setTimeout(resolve, 0))
      if (!syncedRef.current) await new Promise((resolve, reject) => {
        const signal = ac.signal
        let timer
        const cleanup = () => { window.clearTimeout(timer); syncWaiters.current.delete(finish); signal.removeEventListener('abort', abort) }
        const finish = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')) }
        if (signal.aborted) return abort()
        syncWaiters.current.add(finish); signal.addEventListener('abort', abort, { once: true })
        timer = window.setTimeout(() => { cleanup(); reject(new Error('编辑器同步确认超时；本次未请求保存，也没有下载旧文件。')) }, 45000)
        if (syncedRef.current) finish()
      })
      if (epochRef.current !== epoch || sessionRef.current !== sid) throw new Error('同步期间编辑状态已变化，请重新导出最新版本。')
      saveAttemptRef.current={sid,epoch,minimumVersion,requestId:null}
       let result = await request('/word-editor/sessions/' + sid + '/export', { ...json({ edit_epoch: epoch }), signal: ac.signal })
      const nonce = result.request_id, deadline = Date.now() + 120000
       saveAttemptRef.current.requestId=nonce
      if(typeof nonce!=='string' || !nonce)throw Object.assign(new Error('保存请求缺少nonce；停止下载以避免旧稿。'),{saveState:'save_uncertain'})
      while (result.state === 'pending') {
        if (Date.now() >= deadline) throw Object.assign(new Error('Word保存确认超时；提交结果待核对，没有下载旧文件。'),{saveState:'save_uncertain'})
        await new Promise((resolve, reject) => { const timer = window.setTimeout(resolve, 1000); const abort = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }; ac.signal.addEventListener('abort', abort, { once: true }); window.setTimeout(() => ac.signal.removeEventListener('abort', abort), 1100) })
        const state = await request('/word-editor/sessions/' + sid, { signal: ac.signal })
        result = state.export
        if (!result || result.request_id !== nonce) throw Object.assign(new Error('保存请求已变化；为避免下载旧版本，本次导出已停止。'),{saveState:'save_uncertain'})
      }
      if (sessionRef.current !== sid || epochRef.current !== epoch) throw new Error('保存过程中编辑状态已变化，请重新导出最新版本。')
      if(result.recoveryBinding && hadLocalChanges)throw Object.assign(new Error('该回执仅确认此前Word；当前SDK新编辑尚未保存，请恢复关系后重新保存新编辑。'),{saveState:'save_uncertain'})
      const classification=await acceptReceipt(result,sid,epoch,epoch,minimumVersion,true)
      if(!aliveRef.current || sessionRef.current!==sid || epochRef.current!==epoch || latest.current.minutes.minutes_id!==result.minutes?.minutes_id)throw Object.assign(new Error('核验期间编辑或会议已变化；保留当前编辑，未下载旧稿。'),{saveState:'save_uncertain'})
      if(!classification.wordSaved)throw wordSaveError(classification)
      if (download)downloadConfirmedWord(classification.minutes)
      return classification.minutes
    } catch (reason) {
       const attempt=saveAttemptRef.current
       if(aliveRef.current&&attempt?.sid===sid&&!savedResultRef.current?.classification.wordSaved&&savedResultRef.current?.classification.state!=='failed'){const classification={state:'save_uncertain',wordSaved:false,receipt:savedResultRef.current?.classification.receipt||null,minutes:null,message:'保存提交结果待核对；不会重新提交或下载旧稿。'};savedResultRef.current={result:{request_id:attempt.requestId,edit_epoch:epoch},classification,sid,epoch};setReceiptState({state:'save_uncertain',wordSaved:false});setSaveNotice(classification.message)}
       if (aliveRef.current && reason.name !== 'AbortError') setError(reason.message); throw reason
     }
    finally {
      saveLock.current = false
      if (containerRef.current) { containerRef.current.inert = false; containerRef.current.style.pointerEvents = '' }
      if (aliveRef.current) setBusy(false)
    }
  }
  if (apiRef) apiRef.current = { save: saveWord,recover:recoverWordRelations,saveReceipt:receiptState, dirty: dirtyWord, busy, ready: phase === 'ready' }
  return h('div', { className: 'mt-word-editor-wrap', style: { position: 'relative', minWidth: 0 } },
    h('div', { className: 'mt-muted', style: { marginBottom: 8 } }, minutes.is_archived ? '已归档版本只读；导出原排版。' : dirtyWord ? '有文字或排版修改；保存／导出会等待本地服务确认。' : 'Word 式本地编辑；导出前自动保存当前文字和排版。'),
    saveNotice?h('div',{role:'status',className:'mt-notice'},saveNotice,receiptState?.state!=='saved' && savedResultRef.current?.classification.receipt?.receiptId?h('button',{className:'mt-btn small',disabled:busy,onClick:recoverWordRelations},['save_uncertain','failed'].includes(receiptState?.state) || receiptState?.receiptUpdatePending?'核对保存收据（不重新保存）':'仅恢复资产关系'):null):null,
    receiptState?.state==='save_uncertain'?h('button',{className:'mt-btn small',disabled:busy,onClick:verifyPendingWordSave},'仅核对保存状态（不重提）'):null,
     error ? h('div', { role: 'alert', className: 'mt-notice' }, error, ' ', h('button', { className: 'mt-btn small', disabled: busy, onClick: () => { if (!dirtyWord || window.confirm('重载前请确认修改已保存；未保存修改可能丢失。继续？')) setRetry(x => x + 1) } }, '重试编辑器')) : null,
    h('div', { ref: containerRef, style: { height: 'min(900px, calc(100vh - 220px))', minHeight: 480, width: '100%', border: '1px solid var(--border)', borderRadius: 8 } }),
    phase === 'loading' ? h('div', { role: 'status', className: 'mt-muted' }, '正在载入本地 Word 编辑器…') : null,
    busy ? h('div', { ref: fenceRef, tabIndex: 0, role: 'status', 'aria-live': 'polite', style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.85)', zIndex: 20, outline: 'none' } }, '正在核对当前Word保存回执；不会下载未经确认的旧文件…') : null,
    h('div', { className: 'mt-muted', style: { marginTop: 6, fontSize: 12 } }, '本地 ONLYOFFICE Docs · 保留原厂版权与许可说明；字体缺失时可能替代显示，最终分页以 Word 打开结果为准。')
  )
}


    function MinutesView({ t, lang, meetings, showToast, seed, refreshMeetings, registerGuard, visible }) {
      const restored = useRef(retainedMinutesSnapshot && (!seed?.meetingId || seed.meetingId === retainedMinutesSnapshot.targetId) ? retainedMinutesSnapshot : null).current
      const [targetId, setTargetId] = useState(restored?.targetId || (seed && seed.meetingId ? seed.meetingId : ''))
      const [minutes, setMinutes] = useState(restored?.minutes || null)
      const [transcript, setTranscript] = useState(restored?.transcript || '')
      const [template, setTemplate] = useState(restored?.template || 'weekly')
      const [wordTemplate, setWordTemplate] = useState(restored?.wordTemplate || null)
      const [wordBusy, setWordBusy] = useState(false)
      const wordInput = useRef(null), wordUploadLock = useRef(false)
      const nativeWordApi = useRef(null)
      const [nativeWordState, setNativeWordState] = useState({ ready:false, dirty:false, busy:false, error:'' })
      const [wordPreview, setWordPreview] = useState({ state: 'idle', error: '' })
      const [wordRetry, setWordRetry] = useState(0)
      const [busy, setBusy] = useState(false)
      const [generationProgress035,setGenerationProgress035] = useState(null)
      const [groundingView035,setGroundingView035] = useState(null)
      async function inspectGrounding035(taskId) { const owner=taskId?'task:'+taskId:'minutes:'+minutes?.minutes_id;const route=taskId?'/generation-tasks/'+encodeURIComponent(taskId)+'/grounding':'/minutes/'+encodeURIComponent(minutes.minutes_id)+'/grounding';setGroundingView035({owner,loading:true});try{const data=await request(route);setGroundingView035(v=>v?.owner===owner?{owner,data}:v)}catch(error){setGroundingView035(v=>v?.owner===owner?{owner,error:error.message}:v)}}
      const [generationActive035,setGenerationActive035] = useState(false)
      const generationAbort035=useRef(null),generationInput035=useRef(null)
      useEffect(()=>()=>generationAbort035.current?.abort(),[])
      /* mtGenOpt-20261019：生成纪要的可配置项 —— 会议绑定 / 会议信息 / 纪要模板 / Word模板 收进生成动作内；
       * 未绑定会议时，点击生成会先创建会议（会议信息必填），再携带 meeting_id 生成纪要。 */
      const L035 = (zh, en) => (lang === 'en' ? en : zh)
      const [genOptOpen035, setGenOptOpen035] = useState(false)
      const [newMeeting035, setNewMeeting035] = useState({ title: '', start: '', end: '', location: '', participants: '', type: 'offline' })
      const [newMeetingBusy035, setNewMeetingBusy035] = useState(false)
      const createdMeeting035 = useRef({ signature: '', meetingId: '' })
      const previewRef035 = useRef(null)
      const lastMinutesId035 = useRef(null)
      function pad2b035(v) { return String(v).padStart(2, '0') }
      function localInput035(date) { return `${date.getFullYear()}-${pad2b035(date.getMonth() + 1)}-${pad2b035(date.getDate())}T${pad2b035(date.getHours())}:${pad2b035(date.getMinutes())}` }
      function focusGenOpt035(key) {
        setGenOptOpen035(true)
        setTimeout(() => {
          const node = document.querySelector(`[data-genopt035="${key}"]`)
          if (!node) return
          node.scrollIntoView?.({ block: 'nearest' })
          node.focus?.()
        }, 0)
      }
      function defaultMeetingTitle035() {
        const raw = srcMode === 'upload' ? upTranscript : transcript
        const line = String(raw || '').split('\n').map((row) => row.trim()).find(Boolean) || ''
        if (line) return line.replace(/^\[\d{1,2}:\d{2}(:\d{2})?\]\s*/, '').replace(/^[^：:]{0,12}[：:]\s*/, '').slice(0, 60)
        const name = srcMode === 'upload' && uploadRec?.filename ? String(uploadRec.filename) : ''
        if (name) return name.replace(/\.[^.]+$/, '').slice(0, 60)
        return `${new Date().toISOString().slice(0, 10)} 会议纪要`
      }
      function meetingSignature035(form) { return [form.title, form.start, form.end, form.location, form.participants, form.type].join('\u0001') }
      // 返回带 meeting_id 的新 body；校验不通过时抛错（调用方已有 toast 兜底）。
      async function ensureMeetingForGenerate035(body) {
        if (body && body.meeting_id) return body
        if (audioUrl) {
          focusGenOpt035('bind')
          throw new Error(L035('未绑定会议：已保留录音的会议绑定不可更改，请先绑定会议，或下载并放弃录音后重试。', 'No meeting bound: the binding is locked while a recording is kept. Bind a meeting, or download and discard the recording, then retry.'))
        }
        const form = { ...newMeeting035 }
        if (!form.start) form.start = localInput035(new Date())
        if (!form.end) form.end = localInput035(new Date(Date.parse(form.start) + 3600000))
        if (!form.title.trim()) form.title = defaultMeetingTitle035()
        setNewMeeting035(form)
        if (!form.title.trim()) {
          focusGenOpt035('title')
          throw new Error(L035('未绑定会议：请先填写会议主题。', 'No meeting bound: fill in the meeting title first.'))
        }
        const startMs = Date.parse(form.start), endMs = Date.parse(form.end)
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.end) || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
          focusGenOpt035(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.start) ? 'end' : 'start')
          throw new Error(L035('未绑定会议：请填写合法的开始／结束时间（结束须晚于开始）。', 'No meeting bound: provide valid start/end times (end must be later than start).'))
        }
        const signature = meetingSignature035(form)
        if (createdMeeting035.current.meetingId && createdMeeting035.current.signature === signature) {
          return { ...body, meeting_id: createdMeeting035.current.meetingId }
        }
        setNewMeetingBusy035(true)
        setGenerationProgress035({ state: 'queued', label: L035('正在创建会议并准备纪要…', 'Creating the meeting before generating minutes…') })
        try {
          const data = await request('/meetings', json({
            title: form.title.trim(),
            start_time: new Date(startMs).toISOString(),
            end_time: new Date(endMs).toISOString(),
            type: form.type,
            location: form.location.trim(),
            participants: form.participants.split(/[,，、]/).map((row) => row.trim()).filter(Boolean),
            agenda: [],
          }))
          const id = data && data.meeting && data.meeting.id
          if (!id) throw new Error(L035('服务端未返回会议标识', 'the server returned no meeting id'))
          createdMeeting035.current = { signature, meetingId: id }
          setTargetId(id)
          await refreshMeetings()
          // 录音先于建会上传时会话不携带 meeting_id；这里补挂一次，保证录音与会议同源可查。
          if (body && body.recording_id) request(`/recordings/${encodeURIComponent(body.recording_id)}`, patch({ meeting_id: id })).catch(() => {})
          showToast(L035(`已创建会议「${form.title.trim()}」，正在生成纪要…`, `Meeting "${form.title.trim()}" created; generating minutes…`), 'info')
          return { ...body, meeting_id: id }
        } catch (error) {
          if (createdMeeting035.current.meetingId) throw error
          throw new Error(L035('会议创建失败，纪要未生成：', 'Meeting creation failed, minutes were not generated: ') + (error.message || ''))
        } finally { setNewMeetingBusy035(false) }
      }

      async function runGeneration035(body,options={}) {
        if (body) body = await ensureMeetingForGenerate035(body)
        const ac=new AbortController(),abort=()=>ac.abort()
        generationAbort035.current=ac;setGenerationActive035(true)
        if(body)generationInput035.current=body
        options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)ac.abort()
        setGenerationProgress035({state:"queued",label:"正在创建可恢复的纪要任务"})
        try {return await generateWithProgress035(body,{signal:ac.signal,resumeTaskId:options.resumeTaskId,onProgress:task=>{setGenerationProgress035(task);options.onProgress?.(task.label)}})}
        catch(error){setGenerationProgress035({task_id:error.task_id,state:error.name==="AbortError"?"cancelled":error.code?.includes("GROUNDED")?"unresolved":"interrupted",label:error.name==="AbortError"?"纪要处理已取消；完整录音、转写和缓存保留。":error.message});throw error}
        finally{options.signal?.removeEventListener("abort",abort);generationAbort035.current=null;setGenerationActive035(false)}
      }
      async function resumeGeneration035() {
        if(contextBusy||!generationProgress035?.task_id)return
        if(!window.confirm("恢复使用原任务的会议、模型、原文和模板，不采用现在的新选项。自动核验仍需人工复核。继续？"))return
        if(dirty&&!window.confirm("恢复成功后将替换未保存的预览修改。继续？"))return
        setBusy(true)
        try{const data=await runGeneration035(null,{resumeTaskId:generationProgress035.task_id});setMinutes(data.minutes);setTargetId(data.minutes.meeting_id||targetId);setDraft(null);setEditing(false);setWordTemplate(current=>current?.templateId===generationInput035.current?.word_template_id?null:current);refreshMeetings();showToast(t.generated,"success")}
        catch(error){showToast(error.message,"error")}finally{setBusy(false)}
      }
      const operationRef = useRef(null) // synchronous lock; React state updates alone do not prevent repeated callbacks
      const skipInitialLoad = useRef(Boolean(restored?.minutes || restored?.draft !== undefined && restored?.draft !== null))
      const [draft, setDraft] = useState(restored?.draft ?? null) // null = 跟随服务端；否则为本地编辑缓冲
      const txtRef = useRef(null)
      const impRef = useRef(null)
      const [editing, setEditing] = useState(restored?.editing || false)
      const [minuteLoad, setMinuteLoad] = useState('idle')
      const [templateCatalog, setTemplateCatalog] = useState({ state: 'loading', rows: [] })
      const [modelCatalog, setModelCatalog] = useState({ state: 'loading', groups: [] })
      const [taskModel, setTaskModel] = useState(restored?.taskModel || null)
      const refreshCatalogs = useCallback(async () => {
        setModelCatalog(current => ({ ...current, state: 'loading' }))
        try { const data = await request('/models'); setModelCatalog({ state: 'ready', groups: data.groups || [] }) }
        catch { setModelCatalog({ state: 'error', groups: [] }) }
        try { const data = await request('/templates'); setTemplateCatalog({ state: 'ready', rows: data.templates || [] }) }
        catch { setTemplateCatalog({ state: 'error', rows: [] }) }
      }, [])
      useEffect(() => { refreshCatalogs() }, [refreshCatalogs])
      const [floatingCaption, setFloatingCaption] = useState(false)
      const [captionPosition, setCaptionPosition] = useState({ x: 24, y: 90 })
      const captionDragRef = useRef(null)
      const liveAudioRef = useRef(null)
      const [playPosition, setPlayPosition] = useState(0)
      const [playDuration, setPlayDuration] = useState(0)
      const minuteLoadSeq = useRef(0)
      const recoverySnapshot = useRef(null)
      const uploadRecRef = useRef(null)

      // —— 转写来源三模式：live 实时录音 / upload 上传录音 / paste 粘贴文本 ——
      const [srcMode, setSrcMode] = useState(restored?.srcMode || 'live')
      // live 实时录音态
      const [recording, setRecording] = useState(false)
      const [elapsed, setElapsed] = useState(0) // 已录秒数
      const [liveText, setLiveText] = useState('') // 已定稿文本（[HH:mm:ss] 逐行）
      const [interim, setInterim] = useState('') // 中间结果（灰色斜体）
      const [audioUrl, setAudioUrl] = useState('') // 录音回放 blob URL
      const [liveBusy, setLiveBusy] = useState(false) // 结束后自动生成中
      const [liveStarting, setLiveStarting] = useState(false)
      const [liveStage, setLiveStage] = useState('')
      const [captionStatus, setCaptionStatus] = useState('')
      const [captionSource, setCaptionSource] = useState('browser')
      // Future local stream events update these round-scoped, untrusted preview-only records.
      const [captionEntries, setCaptionEntries] = useState([])
      const [speakerNames, setSpeakerNames] = useState({})
      const liveRoundRef = useRef(null)
      const liveMountedRef = useRef(true)
      // upload 上传录音态
      const [uploadRec, setUploadRec] = useState(restored?.uploadRec || null)
      const [upProgress, setUpProgress] = useState(-1) // -1 = 未在上传中；0-100 上传进度
      const [upTranscript, setUpTranscript] = useState(restored?.upTranscript || '')
      const [upBusy, setUpBusy] = useState(false)
       const [upStage, setUpStage] = useState('')
      const [upSaving, setUpSaving] = useState(false)
      const dropRef = useRef(null)
      const upTxtRef = useRef(null)
      const upAudioRef = useRef(null)
      // 录音/识别运行时句柄（不参与渲染；均为浏览器对象，仅在事件回调内触达）
      const recRef = useRef(null) // MediaRecorder
      const streamRef = useRef(null) // MediaStream
      const chunksRef = useRef([]) // 音频分片
      const liveFinalRef = useRef('') // 已定稿文本累积（避免闭包旧值）
      const firstSeenRef = useRef(null) // 各转写段首次到达时刻（Map）
      const timerRef = useRef(null) // 计时器句柄
      const stoppedRef = useRef(true) // 是否已主动停止（onend 判断是否自动重启）
      const upXhrRef = useRef(null) // 上传 XHR 句柄

      // 原有浏览器临时字幕仅作预览，可能由浏览器供应商处理音频；正式录音仍由 MediaRecorder 独立保存。
      const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null
      const MR = typeof window !== 'undefined' ? window.MediaRecorder : null
      const liveSupported = Boolean(MR && typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext)

      const nowStamp = () => {
        const d = new Date()
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
      }
      const mmss = (s) => `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`

      const loadMinutes = useCallback(async (meetingId) => {
        const seq = ++minuteLoadSeq.current
        setMinutes(null); setDraft(null); setEditing(false)
        setMinuteLoad(meetingId ? 'loading' : 'idle')
        if (!meetingId) return
        try {
          const data = await request('/minutes/meeting/' + encodeURIComponent(meetingId))
          if (seq !== minuteLoadSeq.current) return
          setMinutes(data.minutes || null); setMinuteLoad('ready')
        } catch (error) {
          if (seq !== minuteLoadSeq.current) return
          setMinutes(null); setMinuteLoad(error.code === 'NOT_FOUND' || error.message === '纪要不存在' ? 'empty' : 'error')
        }
      }, [])

      useEffect(() => {
        if (seed && seed.nonce && (seed.meetingId || '') !== targetId) changeMeeting(seed.meetingId || '')
      }, [seed && seed.nonce])
      useEffect(() => {
        if (skipInitialLoad.current) { skipInitialLoad.current = false; return }
        loadMinutes(targetId)
      }, [targetId, loadMinutes])

      // Internal pages keep this owner mounted. Actual module unmount seals the final Blob first.
      useEffect(() => {
        liveMountedRef.current = true
        const recovered = retainedLiveRound
        if (recovered && !recovered.cancelled && (!seed?.meetingId || seed.meetingId === recovered.meetingId)) {
          recovered.done.then(blob => {
            if (!blob || !blob.size || !liveMountedRef.current || liveRoundRef.current) return
            const round = { ...recovered, blob, chunks: [], stopped: true, processing: false, cancelled: false, controller: new AbortController() }
            round.done = Promise.resolve(blob)
            round.url = recovered.url || URL.createObjectURL(blob)
            liveRoundRef.current = round
            setTargetId(round.meetingId || ''); setTemplate(round.template); setAudioUrl(round.url)
            setElapsed(round.snapshot?.elapsed || 0); setLiveText(round.transcript || round.snapshot?.liveText || '')
            if (round.snapshot?.minutes && !round.meetingId) setMinutes(round.snapshot.minutes)
            setCaptionStatus('已恢复本模块保留的完整录音；刷新页面或关闭浏览器仍会丢失未下载音频。')
            setLiveStage('完整录音已封存，可回放、下载或显式生成。')
          })
        }
        return () => {
          retainedMinutesSnapshot = recoverySnapshot.current
          liveMountedRef.current = false
          operationRef.current = null
          minuteLoadSeq.current++
          const round = liveRoundRef.current
          if (round && !round.cancelled) {
            round.snapshot = recoverySnapshot.current
            retainedLiveRound = round
            stopLive() // leaves dataavailable active until recorder onstop seals every chunk
            round.controller.abort()
            clearTimeout(round.timer); clearTimeout(round.captionTimer)
            round.done.then(blob => { round.processing = false; round.chunks = []; if (!blob || !blob.size) round.cancelled = true })
          }
          try { streamRef.current?.getTracks().forEach(track => track.stop()) } catch { /* device cleanup */ }
          upXhrRef.current?.abort()
        }
      }, [])

      const content = draft !== null ? draft : minutes ? minutes.content : ''
      const meeting = meetings.find((m) => m.id === targetId)
      const statusValue = minutes ? minutes.is_archived ? 'archived' : 'ready' : meeting ? meeting.minutes_status || 'none' : 'none'
      const dirty = nativeWordState.dirty || (draft !== null && draft !== (minutes?.content || ''))
      const contextBusy = nativeWordState.busy || recording || liveStarting || liveBusy || busy || wordBusy || upBusy || upSaving || upProgress >= 0
      const templateReady = templateCatalog.state === 'ready' && templateCatalog.rows.some(row => row.id === template)
      const previewReady = Boolean(minutes && (minutes.word_document || content.trim()))
      const contextLocked = contextBusy || Boolean(audioUrl)
      recoverySnapshot.current = { targetId, template, wordTemplate, minutes, draft, editing, transcript, srcMode, uploadRec, upTranscript, taskModel, elapsed, liveText }
      uploadRecRef.current = uploadRec
      useEffect(() => {
        registerGuard?.({ recording: recording || liveStarting, busy: contextBusy, hasBlob: Boolean(audioUrl), dirty, targetId, seal: sealLive })
      }, [registerGuard, recording, liveStarting, contextBusy, audioUrl, dirty, targetId])
      useEffect(() => {
        const beforeUnload = event => { if (recording || liveStarting || audioUrl || dirty || contextBusy) { event.preventDefault(); event.returnValue = '' } }
        const onResize = () => setCaptionPosition(pos => clampCaptionPosition(pos.x, pos.y, window.innerWidth, window.innerHeight))
        window.addEventListener('beforeunload', beforeUnload); window.addEventListener('resize', onResize)
        return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('resize', onResize) }
      }, [recording, liveStarting, audioUrl, dirty, contextBusy])
      function beginCaptionDrag(event) {
        if (event.target.tagName === 'BUTTON') return
        captionDragRef.current = { id: event.pointerId, x: event.clientX - captionPosition.x, y: event.clientY - captionPosition.y }
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      function moveCaption(event) {
        const drag = captionDragRef.current
        if (drag && drag.id === event.pointerId) setCaptionPosition(clampCaptionPosition(event.clientX - drag.x, event.clientY - drag.y, window.innerWidth, window.innerHeight))
      }
      function discardLive() {
        if ((audioUrl || recording) && !window.confirm('放弃本页录音？未下载的音频将丢失。')) return
        cancelLive()
      }
      function changeMeeting(id) {
        if (contextBusy || operationRef.current || upXhrRef.current) return showToast('录音、上传或处理期间绑定已锁定；任务完成后再切换。', 'warn')
        if ((dirty || audioUrl) && !window.confirm('切换会议将放弃当前未保存修改及页面录音。请先保存或下载。继续？')) return
        if (liveRoundRef.current) cancelLive()
        uploadRecRef.current = null
        setUploadRec(null); setUpTranscript(''); setTargetId(id)
      }

      function beginOperation() {
        if (!liveMountedRef.current || operationRef.current || contextBusy || upXhrRef.current) return null
        const token = {}
        operationRef.current = token
        minuteLoadSeq.current++ // a pending GET must not overwrite this operation's result or draft
        return token
      }
      function operationActive(token) { return liveMountedRef.current && operationRef.current === token }
      function endOperation(token) { if (operationRef.current === token) operationRef.current = null }

      /* —— 模式 C：粘贴文本（mtPasteUnboundFix-20261012：不再强制绑定会议，与上传录音/实时录音一致） —— */
      async function generate() {
        // mtPasteUnboundFix-20261012：去掉 !targetId 拦截。后端 handleGenerateParsed 支持未绑定
        //（prompt 分支「未绑定会议，请从转写内容推断主题」），minutesTaskBody 在 meetingId 为空时
        // 不发送 meeting_id，因此未绑定可生成独立纪要。旧行为下该分支被按钮 disabled 遮蔽，用户无任何提示。
        if (!transcript.trim()) return showToast(t.transcriptLabel, 'warn')
        if (!templateReady || contextBusy) return
        if (dirty && !window.confirm('生成新纪要将替换预览中的未保存修改。继续？')) return
        const body = minutesTaskBody({ transcript, template, meetingId: targetId, model: taskModel, wordTemplateId: wordTemplate?.templateId || '' })
        minuteLoadSeq.current++; setMinuteLoad('ready')
        setBusy(true)
        try {
          const data = await runGeneration035(body)
          setWordTemplate(null)
          setMinutes(data.minutes)
          setDraft(null); setEditing(false)
          setTranscript('')
          showToast(t.generated, 'success')
          refreshMeetings()
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      async function saveNativeWord(download) {
        if (!nativeWordApi.current?.ready || contextBusy) return showToast('本地Word编辑器未就绪或正在处理，未下载旧版。','warn')
        try { await nativeWordApi.current.save(download); showToast(download?'最新Word已保存并开始下载。':t.saved,'success') }
        catch(error){ if(error.name!=='AbortError') showToast('Word保存／导出失败：'+error.message,'error') }
      }
      async function saveContent() { return saveNativeWord(false) }

      async function archive() {
        if (!minutes || busy || minutes.is_archived) return
        if (dirty || nativeWordState.busy || draft !== null) return showToast('请先保存文字与排版修改，再正式归档。', 'warn')
        if (minutes.grounding && !window.confirm('自动核验仅说明全部分段已处理、已提取事实已覆盖，并不保证语义无遗漏。确认已对照原文人工复核当前版本，仍要正式归档？')) return
        setBusy(true)
        try {
          const data = await request(`/minutes/${encodeURIComponent(minutes.minutes_id)}/archive`, json({ grounding_reviewed:Boolean(minutes.grounding), expected_version:minutes.version }))
          setMinutes(data.minutes)
          setDraft(null); setEditing(false)
          showToast(t.archivedToast(data.minutes.archive_fingerprint || ''), 'success')
          refreshMeetings()
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      function importFile(event, mode) {
        const file = event.target.files?.[0]; event.target.value = ''
        if (!file || contextBusy) return
        if (file.size > 2 * 1024 * 1024) return showToast('文本导入最多2MiB。', 'error')
        if (mode !== 'transcript' && (!minutes || !/\.(txt|md|markdown)$/i.test(file.name))) return showToast('请选择txt/md修订稿，并先选定真实纪要。', 'warn')
        if (dirty && !window.confirm('导入将替换未保存修改。继续？')) return
        if(mode !== 'transcript' && !window.confirm('导入纯文本修订稿将明确放弃当前Word人工排版，并生成新的文档版本。继续？')) return
        const token = beginOperation()
        if (!token) return
        const currentMinutes = minutes
        const reader = new FileReader()
        setBusy(true)
        const failRead = () => {
          if (operationActive(token)) { setBusy(false); showToast('读取文本失败，未修改服务器记录。', 'error') }
          endOperation(token)
        }
        reader.onerror = failRead
        reader.onload = async () => {
          if (!operationActive(token)) return
          const text = String(reader.result || '')
          try {
            if (text.length > 200000) throw new Error('文本超过200000字符，请缩减后导入。')
            if (mode === 'transcript') setTranscript(text)
            else {
              setDraft(text); setEditing(true) // keep this imported draft if PUT fails
              const data = await request('/minutes/' + encodeURIComponent(currentMinutes.minutes_id), put({ content: text, source: 'import', action_items: currentMinutes.action_items, discard_rich_format: true }))
              if (!operationActive(token)) return
              setMinutes(data.minutes); setDraft(null); setEditing(false)
              showToast(t.imported, 'success'); refreshMeetings()
            }
          } catch (error) { if (operationActive(token)) showToast(t.requestFailed + ': ' + error.message, 'error') }
          finally { if (operationActive(token)) setBusy(false); endOperation(token) }
        }
        try { reader.readAsText(file) } catch { failRead() }
      }

      async function toggleTodo(item) {
        if (!minutes) return
        const next = minutes.action_items.map((a) => (a.task_id === item.task_id ? { ...a, completed: !a.completed } : a))
        if (contextBusy) return
        setBusy(true)
        try {
          const data = await request(`/minutes/${encodeURIComponent(minutes.minutes_id)}`, put({ action_items: next }))
          setMinutes(data.minutes)
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally { setBusy(false) }
      }

      async function copyAll() {
        if (!content.trim()) return
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('当前浏览器不支持剪贴板接口')
          await navigator.clipboard.writeText(content)
          showToast(t.copied, 'success')
        } catch { showToast('复制失败；请下载纪要或手动选取正文复制。', 'error') }
      }
      async function pickWordTemplate(event) {
        const file = event.target.files?.[0]; event.target.value = ''
        if (!file || contextBusy || wordUploadLock.current) return
        if (!/\.docx$/i.test(file.name) || file.size > 10 * 1024 * 1024) return showToast('请上传10MB以内的DOCX模板。', 'warn')
        wordUploadLock.current = true; setWordBusy(true)
        try {
          const uploaded = await request('/word-documents/templates?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: file })
          const previous = wordTemplate
          setWordTemplate(uploaded)
          if (previous?.templateId) await request('/word-documents/templates/' + encodeURIComponent(previous.templateId), { method: 'DELETE' }).catch(() => {})
          showToast('Word模板仅用于下一次成功生成，不覆盖系统模板。', 'success')
        } catch (error) { showToast('Word模板上传失败：' + error.message, 'error') }
        finally { wordUploadLock.current = false; setWordBusy(false) }
      }
      async function removeWordTemplate() {
        if (!wordTemplate || contextBusy || wordUploadLock.current) return
        wordUploadLock.current = true; setWordBusy(true)
        try {
          await request('/word-documents/templates/' + encodeURIComponent(wordTemplate.templateId), { method: 'DELETE' })
          setWordTemplate(null)
        } catch (error) { showToast('移除模板失败：' + error.message, 'error') }
        finally { wordUploadLock.current = false; setWordBusy(false) }
      }
      function safeWordDocument(value) {
        return value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.artifact_id || '') &&
          value.preview_url === '/api/meeting-assistant/word-documents/' + value.artifact_id + '/preview' &&
          value.docx_url === '/api/meeting-assistant/word-documents/' + value.artifact_id + '/download'
      }
      const wordDocument = minutes?.word_document
      const validWordDocument = safeWordDocument(wordDocument)
      useEffect(() => {
        if (!minutes?.minutes_id || !minutes.content) { setWordPreview({ state: 'idle', error: '' }); return }
        if (validWordDocument) { setWordPreview({ state: 'ready', error: '' }); return }
        let active = true
        const ac = new AbortController(), id = minutes.minutes_id, version = minutes.version, savedContent = minutes.content
        setWordPreview({ state: 'loading', error: '' })
        request('/word-documents/from-minutes/' + encodeURIComponent(id), { ...json({}), signal: ac.signal }).then(data => {
          if (!active) return
          if (!safeWordDocument(data.document)) throw new Error('服务器未返回有效的Word成品，不能显示旧文本代替。')
          setMinutes(current => current?.minutes_id === id && current.version === version && current.content === savedContent ? { ...current, word_document: data.document } : current)
        }).catch(error => { if (active) setWordPreview({ state: 'error', error: error.message }) })
        return () => { active = false; ac.abort() }
      }, [minutes?.minutes_id, minutes?.version, minutes?.content, wordDocument?.artifact_id, wordRetry])
      async function downloadMinutes() { return saveNativeWord(true) }
      function cancelEdit() {
        if (draft !== null && draft !== minutes?.content && !window.confirm('放弃未保存的纪要修改？')) return
        setDraft(null); setEditing(false)
      }

      /* —— 模式 A：浏览器字幕仅预览；最终纪要必须依据完整音频的本地阿昆ASR —— */
      const liveActive = (round) => liveMountedRef.current && liveRoundRef.current === round && !round.cancelled
      function stopLive() {
        const round = liveRoundRef.current
        if (!round) return Promise.resolve(null)
        if (!round.stopped && !round.cancelled) {
          round.endCaption?.('stopped')
          if (liveActive(round)) setCaptionStatus('实时字幕已停止；保留音频供本地全文转写。')
        }
        round.stopped = true
        stoppedRef.current = true
        clearTimeout(round.timer)
        clearTimeout(round.captionTimer)
        round.localCaption?.stop()
        if (round.speech) {
          round.speech.onresult = round.speech.onerror = round.speech.onend = null
          try { round.speech.abort() } catch { /* ignore */ }
        }
        if (liveActive(round)) { setInterim(''); setRecording(false) }
        if (round.recorder && round.recorder.state !== 'inactive') {
          try { round.recorder.stop() } catch (error) { round.resolve(null) }
        } else if (!round.recorder) round.resolve(null)
        return round.done
      }

      async function startLive() {
        const previous = liveRoundRef.current
        if (previous?.blob && !window.confirm('重新录制将替换当前完整录音，请先下载。继续？')) return
        if (!templateReady || busy || upBusy) return
        retainedLiveRound = null
        if (!liveSupported || liveBusy || (previous && (!previous.stopped || previous.processing) && !previous.cancelled)) return
        const round = { chunks: [], bytes: 0, cancelled: false, stopped: false, processing: false, controller: new AbortController(), meetingId: targetId, template, captionSource, captionRetries: 0 }
        round.done = new Promise((resolve) => { round.resolve = resolve })
        liveRoundRef.current = round
        // 有效点击为起点；首次里程碑独立保留，最近事件有界且不含语音正文。
        const clock = typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now()
        const started = clock()
        const captionTiming = { startedAt: Date.now(), events: [], first: {}, attempt: 0, reconnects: 0, state: 'start-clicked' }
        window.__meetaiCaptionTiming = captionTiming
        const markCaption = (stage, error = '', terminal = false) => {
          if (liveRoundRef.current !== round || (!terminal && (!liveActive(round) || round.stopped || captionTiming.terminal))) return
          if (terminal) captionTiming.terminal = stage
          const elapsedMs = Math.max(0, clock() - started)
          if (!(stage in captionTiming.first)) captionTiming.first[stage] = elapsedMs
          captionTiming.state = stage
          captionTiming.events.push({ stage, elapsedMs, attempt: captionTiming.attempt, ...(error ? { error } : {}) })
          if (captionTiming.events.length > 80) captionTiming.events.shift()
        }
        round.markCaption = markCaption
        round.endCaption = (stage) => markCaption(stage, '', true)
        markCaption('start-clicked')
        stoppedRef.current = false
        liveFinalRef.current = ''
        setLiveStarting(true)
        setLiveText('')
        setInterim('')
        setCaptionEntries([])
        setSpeakerNames({})
        setElapsed(0)
        setLiveStage('正在请求麦克风权限…')
        setCaptionStatus(round.captionSource === 'local' ? '已选择服务器本地模型；出错不会切换浏览器服务，完整录音独立保留。' : '浏览器临时字幕仅供预览，可能由浏览器供应商处理音频；完整录音仍在本机封存，停录后由阿昆正式转写。')
        if (audioUrl) { try { URL.revokeObjectURL(audioUrl) } catch { /* ignore */ } setAudioUrl('') }
        try {
          markCaption('permission-requested')
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          if (!liveActive(round) || round.stopped) { stream.getTracks().forEach((track) => track.stop()); round.resolve(null); return }
          markCaption('permission-granted')
          round.stream = stream
          streamRef.current = stream
          let opts
          for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
            if (typeof MR.isTypeSupported === 'function' && MR.isTypeSupported(mime)) { opts = { mimeType: mime }; break }
          }
          const mr = new MR(stream, opts)
          round.recorder = mr
          recRef.current = mr
          mr.ondataavailable = (event) => {
            if (round.cancelled || !event.data || !event.data.size) return
            if (round.bytes + event.data.size > 500 * 1024 * 1024) { cancelLive(); showToast(t.recTooBig, 'error'); return }
            round.chunks.push(event.data)
            round.bytes += event.data.size
          }
          mr.onstop = () => {
            stream.getTracks().forEach((track) => track.stop())
            if (round.cancelled) { round.resolve(null); return }
            try {
              const blob = new Blob(round.chunks, { type: (mr.mimeType || 'audio/webm').split(';')[0] })
              round.blob = blob
              if (liveActive(round)) {
                round.url = URL.createObjectURL(blob)
                setAudioUrl(round.url)
                setRecording(false)
              }
              round.resolve(blob)
            } catch (error) { round.resolve(null) }
          }
          mr.onerror = () => { if (liveActive(round)) { stopLive(); showToast('录音设备异常，已停止；可用保留音频重试。', 'error') } }
          stream.getAudioTracks().forEach((track) => { track.onended = () => {
            if (liveActive(round) && !round.stopped) { stopLive(); showToast('麦克风已中断，录音已停止，请检查设备。', 'warn') }
          } })
          mr.start(1000)
          markCaption('recording-start')
          setRecording(true)
          setLiveStage('')
          // User approved legacy browser recognition for TEMPORARY captions only; the full recording remains independent.
          if (round.captionSource === 'local') {
            round.localCaption = startServerLocalCapture(stream, {
              status: message => { if (liveActive(round) && !round.transcript) setCaptionStatus(message) },
              error: message => { if (liveActive(round) && !round.transcript) { markCaption('local-error'); setCaptionStatus('本地字幕错误：' + message + '；不切换浏览器，完整录音继续。') } },
              entries: entries => {
                if (!liveActive(round) || round.transcript) return
                setCaptionEntries(previous => {
                  if (!liveActive(round) || round.transcript) return previous
                  const ids = new Set(entries.map(entry => entry.utteranceId))
                  return [...previous.filter(entry => !ids.has(entry.utteranceId)), ...entries.map(entry => ({ ...entry, speakerId: null, confidenceState: 'unknown', source: '服务器本地模型' }))].slice(-80)
                })
              },
            })
          } else if (SR) {
            try {
              const speech = new SR()
              round.speech = speech
              speech.continuous = true
              speech.interimResults = true
              speech.lang = 'zh-CN'
              let seen = new Map()
              let finals = new Set()
              let epoch = 0
              const requestCaption = () => {
                captionTiming.attempt++
                captionTiming.reconnects = captionTiming.attempt - 1
                markCaption('start-requested')
                setCaptionStatus('已请求浏览器临时字幕；音频可能由浏览器供应商处理，完整录音与正式转写仍走原链路。')
                speech.start()
              }
              speech.onstart = () => { markCaption('service-start'); if (liveActive(round) && !round.stopped) setCaptionStatus('浏览器字幕已启动；仅供临时预览，完整音频仍在录制。') }
              speech.onaudiostart = () => markCaption('audio-start')
              speech.onspeechstart = () => markCaption('speech-start')
              speech.onspeechend = () => markCaption('speech-end')
              speech.onresult = (event) => {
                if (!liveActive(round) || round.stopped) return
                markCaption('result')
                let hasText = false
                for (let i = event.resultIndex; i < event.results.length; i++) {
                  const result = event.results[i]
                  const text = String((result[0] && result[0].transcript) || '').trim()
                  if (!text) continue
                  hasText = true
                  if (!seen.has(i)) seen.set(i, Math.max(0, Math.round(clock() - started)))
                  if (result.isFinal && finals.has(i)) continue
                  if (result.isFinal) finals.add(i)
                  const entry = { utteranceId: `browser-${epoch}-${i}`, startMs: seen.get(i),
                    kind: result.isFinal ? 'final' : 'interim', text, speakerId: null, confidenceState: 'unknown' }
                  setCaptionEntries(previous => {
                    if (!liveActive(round) || round.stopped) return previous
                    const next = previous.filter(row => row.utteranceId !== entry.utteranceId)
                    next.push(entry)
                    return next.slice(-80)
                  })
                }
                if (hasText) { markCaption('text-result'); setCaptionStatus('已收到浏览器临时字幕；说话人未知，停录后仍由本地阿昆正式转写。') }
              }
              speech.onerror = (event) => {
                if (!liveActive(round) || round.stopped) return
                const errorCode = ['no-speech', 'aborted', 'audio-capture', 'network', 'not-allowed', 'service-not-allowed', 'bad-grammar', 'language-not-supported', 'phrases-not-supported'].includes(event.error) ? event.error : 'unknown'
                markCaption('error', errorCode)
                if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(errorCode)) round.captionDisabled = true
                else if (errorCode !== 'no-speech' && errorCode !== 'aborted') round.captionRetries++
                if (round.captionRetries >= 3) round.captionDisabled = true
                setCaptionStatus(`浏览器临时字幕暂不可用（${errorCode}）；完整录音继续，停录后仍可本地正式转写。`)
              }
              speech.onend = () => {
                if (!liveActive(round) || round.stopped) return
                const errorState = captionTiming.state
                markCaption('service-end')
                setCaptionEntries(previous => previous.filter(row => row.kind !== 'interim'))
                if (round.captionDisabled) { captionTiming.state = errorState; return }
                markCaption('reconnect-wait')
                setCaptionStatus('浏览器字幕暂断开，录音继续；等待重新连接。')
                round.captionTimer = setTimeout(() => {
                  if (!liveActive(round) || round.stopped) return
                  epoch++
                  seen = new Map(); finals = new Set()
                  try { requestCaption() } catch { markCaption('error', 'start-failed'); round.captionDisabled = true; setCaptionStatus('浏览器字幕启动失败；不影响完整录音及正式转写。') }
                }, 1000 * Math.min(4, round.captionRetries + 1))
              }
              requestCaption()
            } catch { markCaption('error', 'start-failed'); setCaptionStatus('浏览器临时字幕不可用；完整录音继续，停录后由本地阿昆正式转写。') }
          } else { markCaption('unsupported'); setCaptionStatus('浏览器不支持临时字幕；完整录音继续，停录后由本地阿昆正式转写。') }
          const tick = () => {
            if (!liveActive(round) || round.stopped) return
            setElapsed((seconds) => seconds + 1)
            round.timer = window.setTimeout(tick, 1000)
          }
          round.timer = window.setTimeout(tick, 1000)
        } catch (error) {
          if (round.stream) round.stream.getTracks().forEach((track) => track.stop())
          round.resolve(null)
          if (liveActive(round)) {
            const detail = error.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在站点设置中允许。' : error.name === 'NotFoundError' ? '未找到麦克风设备。' : error.name === 'NotReadableError' ? '麦克风被占用或无法读取。' : error.message || '无法启动录音'
            showToast(detail, 'error')
            setRecording(false)
            setLiveStage('')
            round.cancelled = true
          }
        } finally { if (liveMountedRef.current && liveRoundRef.current === round) setLiveStarting(false) }
      }

      // Stopping never uploads or generates. Await the final recorder chunk, retain Blob and release the mic.
      async function sealLive() {
        const round = liveRoundRef.current
        if (!round || round.cancelled || round.processing || liveStarting) return
        round.processing = true
        setLiveBusy(true)
        setLiveStage('正在停止录音并封存完整音频…')
        try {
          const blob = await stopLive()
          if (!liveActive(round)) return
          if (!blob || !blob.size) throw new Error('没有收到有效录音，请检查麦克风后重录。')
          setLiveStage('完整录音已封存；点击生成纪要后才上传及正式识别。')
          showToast('录音已停止并保留在当前页面，尚未上传或生成纪要。', 'info')
          return blob
        } catch (error) {
          if (liveActive(round)) showToast(error.message || '停录失败，请检查设备。', 'error')
        } finally {
          round.processing = false
          if (liveActive(round)) setLiveBusy(false)
        }
      }

      async function finishLive() {
        const round = liveRoundRef.current
        if (!round || round.cancelled || round.processing || liveStarting || recording || !round.stopped || !round.blob || busy || upBusy) return
        if (!templateReady) return showToast('请先加载真实纪要模板。', 'warn')
        if (dirty && !window.confirm('生成新纪要将替换预览中的未保存修改。继续？')) return
        const modelForRun = taskModel ? { ...taskModel } : null
        minuteLoadSeq.current++; setMinuteLoad('ready')
        round.processing = true
        setLiveBusy(true)
        async function liveRequest(route, options, cleanup = false) {
          const ac = new AbortController()
          const cancel = () => ac.abort()
          if (!cleanup) {
            if (round.controller.signal.aborted) cancel()
            else round.controller.signal.addEventListener('abort', cancel, { once: true })
          }
          const timeout = cleanup ? 15000 : route.includes('/transcribe') ? 31 * 60000 : route === '/generate-text' ? 10 * 60000 : 90000
          const timer = setTimeout(cancel, timeout)
          try {
            const response = await fetch(API + route, { credentials: 'same-origin', ...options, signal: ac.signal })
            let data
            try { data = await response.json() } catch { data = null }
            if (!response.ok || !data || data.error) {
              const error = new Error((data && (data.reason || data.error)) || `HTTP ${response.status}`)
              error.status = response.status
              throw error
            }
            return data
          } finally { clearTimeout(timer); round.controller.signal.removeEventListener('abort', cancel) }
        }
        try {
          setLiveStage('正在准备已封存的完整录音…')
          const blob = round.blob
          if (!liveActive(round)) return
          if (!blob || !blob.size) throw new Error('没有收到有效录音；请检查麦克风后重录。')
          if (!round.recording) {
            const type = blob.type || 'audio/webm'
            const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm'
            const file = new File([blob], `meeting-${Date.now()}.${ext}`, { type })
            round.recording = await uploadInChunks(file, {
              signal: round.controller.signal, meetingId: round.meetingId,
              create: async (meta) => (await liveRequest('/recording-uploads', json(meta))).upload,
              put: async (id, seq, bytes, sha) => (await liveRequest(`/recording-uploads/${id}/chunks/${seq}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha }, body: bytes })).ack,
              commit: async (id) => (await liveRequest(`/recording-uploads/${id}/commit`, { method: 'POST' })).recording,
              abort: (id) => liveRequest(`/recording-uploads/${id}`, { method: 'DELETE' }, true),
              onProgress: (percent, stage) => { if (liveActive(round)) setLiveStage(stage === 'commit' ? '正在校验并封存完整录音…' : `正在上传完整录音（服务器已确认${percent}%）…`) },
            })
          }
          if (!liveActive(round)) return
          if (!round.transcript) {
            setLiveStage('阿昆正在本地识别完整录音…')
            const asr = await liveRequest(`/recordings/${encodeURIComponent(round.recording.recording_id)}/transcribe?force=1`, { method: 'POST' })
            round.transcript = String(asr.transcript || '').trim()
            if (!round.transcript) throw new Error('阿昆未识别到有效语音，未生成纪要。')
          }
          if (!liveActive(round)) return
          setLiveText(round.transcript)
          setCaptionEntries([]); setSpeakerNames({})
          setCaptionStatus('以下为阿昆本地完整录音转写，不是实时字幕。')
          setLiveStage('正在根据阿昆全文生成会议纪要…')
          const body = minutesTaskBody({ transcript: round.transcript, template: round.template, source: 'live-record', recordingId: round.recording.recording_id, meetingId: round.meetingId, model: modelForRun, wordTemplateId: wordTemplate?.templateId || '' })
          const data = await runGeneration035(body, { signal:round.controller.signal, onProgress:setLiveStage })
          if (!liveActive(round)) return
          setWordTemplate(null)
          setMinutes(data.minutes)
          setDraft(null); setEditing(false)
          showToast(t.generated, 'success')
          refreshMeetings()
        } catch (error) { if (liveActive(round)) showToast(`${t.requestFailed}: ${error.message || '处理失败，录音已保留，可重试。'}`, 'error') }
        finally { round.processing = false; if (liveActive(round)) { setLiveBusy(false); setLiveStage('') } }
      }

      function cancelLive() {
        retainedLiveRound = null
        const round = liveRoundRef.current
        if (round) {
          round.endCaption?.('cancelled')
          round.cancelled = true
          round.localCaption?.cancel()
          round.controller.abort()
          stopLive()
          if (round.stream) round.stream.getTracks().forEach((track) => track.stop())
          if (round.url) URL.revokeObjectURL(round.url)
          liveRoundRef.current = null
        }
        liveFinalRef.current = ''
        if (liveMountedRef.current) {
          setRecording(false); setLiveStarting(false); setLiveBusy(false)
          setLiveText(''); setInterim(''); setCaptionEntries([]); setSpeakerNames({}); setElapsed(0); setLiveStage(''); setCaptionStatus(''); setAudioUrl('')
        }
      }

      /* —— 模式 B：小分片+服务端ACK进度，避免隧道大请求及假100% —— */
      async function uploadFile(file) {
        if (!file || upBusy || upSaving) return
        if (!file.size) return showToast('录音文件为空', 'error')
        if (file.size > 500 * 1024 * 1024) return showToast(t.recTooBig, 'error')
        if (!globalThis.crypto || !crypto.subtle) return showToast('请在HTTPS安全页面上传录音', 'error')
        if (upXhrRef.current) upXhrRef.current.abort()
        const controller = new AbortController()
        upXhrRef.current = controller
        setUploadRec(null)
        setUpTranscript('')
        setUpStage('正在分片上传并等待服务器确认…')
        setUpProgress(0)
        async function uploadRequest(route, options, cleanup = false) {
          const requestController = new AbortController()
          const cancel = () => requestController.abort()
          if (!cleanup) {
            if (controller.signal.aborted) cancel()
            else controller.signal.addEventListener('abort', cancel, { once: true })
          }
          const timer = setTimeout(cancel, cleanup ? 15000 : 90000)
          try {
            const response = await fetch(API + route, { credentials: 'same-origin', ...options, signal: requestController.signal })
            let data
            try { data = await response.json() } catch { data = null }
            if (!response.ok || !data || data.error) {
              const error = new Error((data && (data.reason || data.error)) || `HTTP ${response.status}`)
              error.status = response.status
              throw error
            }
            return data
          } finally {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', cancel)
          }
        }
        try {
          const recording = await uploadInChunks(file, {
            signal: controller.signal,
            meetingId: targetId || '',
            create: async (meta) => (await uploadRequest('/recording-uploads', json(meta))).upload,
            put: async (id, seq, bytes, sha) => (await uploadRequest(`/recording-uploads/${encodeURIComponent(id)}/chunks/${seq}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha }, body: bytes })).ack,
            commit: async (id) => (await uploadRequest(`/recording-uploads/${encodeURIComponent(id)}/commit`, { method: 'POST' })).recording,
            abort: (id) => uploadRequest(`/recording-uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }, true),
            onProgress: (percent, stage) => {
              if (upXhrRef.current !== controller) return
              setUpProgress(percent)
              setUpStage(stage === 'commit' ? '正在校验完整录音并确认保存…' : '已确认分片上传，继续传输…')
            },
          })
          if (controller.signal.aborted || upXhrRef.current !== controller) return
          setUploadRec(recording)
          setUpTranscript(recording.transcript || '')
          showToast(t.uploadDone, 'success')
        } catch (error) {
          if (!controller.signal.aborted && upXhrRef.current === controller) showToast(`${t.requestFailed}: ${error.message || '分片上传失败'}`, 'error')
        } finally {
          if (upXhrRef.current === controller) {
            upXhrRef.current = null
            setUpProgress(-1)
            setUpStage('')
          }
        }
      }

      function onPickAudio(e) {
        const file = (e.target.files || [])[0]
        e.target.value = ''
        uploadFile(file)
      }

      function onDropAudio(e) {
        e.preventDefault()
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
        uploadFile(file)
      }

      // 元数据加载后回写录音时长（失败静默）
      function saveRecDuration() {
        try {
          const el = upAudioRef.current
          if (!el || !uploadRec || !Number.isFinite(el.duration) || !el.duration) return
          const secs = Math.round(el.duration)
          if (!secs) return
          request(`/recordings/${encodeURIComponent(uploadRec.recording_id)}`, patch({ duration_seconds: secs }))
            .then((data) => { if (data && data.recording) setUploadRec(current => current?.recording_id === data.recording.recording_id ? data.recording : current) })
            .catch(() => {})
        } catch { /* 静默 */ }
      }

      function importUpTxt(e) {
        const file = (e.target.files || [])[0]
        e.target.value = ''
        if (!file) return
        const reader = new FileReader()
        const boundId = uploadRec?.recording_id
        reader.onload = () => { if (uploadRecRef.current?.recording_id === boundId) setUpTranscript(String(reader.result || '')) }
        reader.onerror = () => showToast('转写文本读取失败。', 'error')
        reader.readAsText(file)
      }

      async function saveUpTranscript() {
        if (!uploadRec || !upTranscript.trim()) return
        setUpSaving(true)
        try {
          const data = await request(`/recordings/${encodeURIComponent(uploadRec.recording_id)}`, patch({ transcript: upTranscript }))
          if (data && data.recording) setUploadRec(data.recording)
          showToast(t.savedTranscript, 'success')
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setUpSaving(false)
        }
      }

       // Candidate: browser speech recognition is forbidden; use the existing local full-file ASR instead.

      async function generateUpload() {
        if (!uploadRec || contextBusy || !templateReady) return
        if (dirty && !window.confirm('生成新纪要将替换预览中的未保存修改。继续？')) return
        const generationBase = minutesTaskBody({ transcript: '', template, meetingId: targetId, recordingId: uploadRec.recording_id, source: 'upload', model: taskModel, wordTemplateId: wordTemplate?.templateId || '' })
        minuteLoadSeq.current++; setMinuteLoad('ready')
        setUpBusy(true)
        try {
          let finalTranscript = upTranscript.trim()
          if (!finalTranscript) {
            setUpStage('阿昆正在转写上传的录音，请稍候…')
            const recognized = await request(`/recordings/${encodeURIComponent(uploadRec.recording_id)}/transcribe`, { method: 'POST' })
            finalTranscript = String(recognized.transcript || '').trim()
            if (!finalTranscript) throw new Error('阿昆未识别到可用语音；未生成会议纪要')
            setUpTranscript(finalTranscript)
            if (recognized.recording) setUploadRec(recognized.recording)
          } else {
            setUpStage('正在保存转写文本…')
            await request(`/recordings/${encodeURIComponent(uploadRec.recording_id)}`, patch({ transcript: finalTranscript }))
          }
          setUpStage('正在根据完整转写生成会议纪要…')
          const body = { ...generationBase, transcript: finalTranscript }
          const data = await runGeneration035(body)
          setWordTemplate(null)
          setMinutes(data.minutes)
          setDraft(null); setEditing(false)
          showToast(t.generated, 'success')
          refreshMeetings()
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setUpStage('')
          setUpBusy(false)
        }
      }

      // Switching source never discards a sealed Blob. In-flight processing keeps the source locked.
      async function switchSrc(mode) {
        if (mode === srcMode) return
        if (recording || liveStarting) {
          if (!window.confirm('切换来源前先停止并保留完整录音？')) return
          if (!await sealLive()) return
        } else if (contextBusy) return showToast('当前任务处理中，稍后切换来源。', 'warn')
        setSrcMode(mode)
      }

      const sourceLabel = { ai: t.sourceAi, edit: t.sourceEdit, import: t.sourceImport, 'live-record': t.sourceLive, upload: t.sourceUpload }

      const liveBlobType = liveRoundRef.current && liveRoundRef.current.blob ? liveRoundRef.current.blob.type : 'audio/webm'
      const liveDownloadExt = liveBlobType.includes('mp4') ? 'm4a' : liveBlobType.includes('ogg') ? 'ogg' : liveBlobType.includes('wav') ? 'wav' : 'webm'
      const recFileName = `meetai-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${liveDownloadExt}`

      // Both sources and the final transcript use the same avatar/bubble renderer.
      const displayCaptionEntries = !recording && liveText ? formalCaptionEntries(liveText) : captionEntries
      const captionLines = h('div', { className: 'mt-livewrap', 'aria-live': 'polite' },
           displayCaptionEntries.map(entry => {
             const speaker = entry.speakerId ? (speakerNames[entry.speakerId] || '发言人 ' + String(entry.speakerId).replace(/^spk-/, '')) : '未知发言人'
             const seconds = Math.max(0, Math.floor(Number(entry.startMs || 0) / 1000))
             const timestamp = `${pad2(Math.floor(seconds / 3600))}:${pad2(Math.floor(seconds / 60) % 60)}:${pad2(seconds % 60)}`
             return h('div', { className: 'mt-caption-row', key: entry.utteranceId },
               h('span', { className: 'mt-caption-avatar', 'aria-hidden': true }, entry.speakerId ? String(entry.speakerId).replace(/^spk-/, '') : '？'),
               h('div', { className: 'mt-caption-bubble' + (entry.kind === 'interim' ? ' interim' : '') },
                 h('div', { className: 'mt-caption-meta' },
                   entry.speakerId ? h('button', { type: 'button', className: 'mt-caption-rename', title: '只修改本轮预览昵称', onClick: () => {
                     const next = window.prompt('仅在当前实时预览中重命名发言人', speaker)
                     if (next && next.trim()) setSpeakerNames(names => ({ ...names, [entry.speakerId]: next.trim().slice(0, 32) }))
                   } }, speaker) : h('span', null, speaker),
                   Number.isFinite(entry.startMs) ? h('span', null, timestamp) : null,
                    entry.source ? h('span', null, entry.source) : null,
                   entry.confidenceState !== 'confirmed' ? h('span', null, '待确认') : null,
                 ),
                 h('div', { className: 'mt-caption-text' }, entry.text || '识别中…'),
               ),
             )
           }),
           !displayCaptionEntries.length ? h('div', { className: 'mt-muted' }, '等待所选来源的字幕；无可靠分人信息时显示未知发言人，完整录音独立保留。') : null,
         )
      const livePanel = h('div', { className: 'mt-stack' },
        !liveSupported ? h('div', { className: 'mt-notice' }, '需要安全HTTPS页面、麦克风权限和MediaRecorder；建议Edge/Chrome。') : null,
        h('div', { className: 'mt-rec-center' },
          h('button', { className: 'mt-record-knob' + (recording ? ' recording' : ''), disabled: liveBusy || liveStarting || busy || upBusy || !liveSupported || !templateReady, onClick: recording ? sealLive : startLive, 'aria-label': recording ? '停止并封存录音' : '开始录音' }, recording ? '■' : '🎙'),
          h('b', { className: 'mt-time' }, mmss(elapsed)),
          h('span', { className: 'mt-muted' }, recording ? '正在录音 · 点击停止只封存，不自动生成' : audioUrl ? '完整录音已封存，可回放和下载' : '点击开始录音'),
        ),
        liveStage ? h('div', { className: 'mt-notice', role: 'status' }, liveBusy || liveStarting ? h('span', { className: 'mt-spin' }) : null, ' ', liveStage) : null,
        h('div', { className: 'mt-row mt-between' }, h('div', { className: 'mt-row', style: { flexWrap: 'wrap' } }, h('b', null, '字幕预览'),
          h('select', { className: 'mt-select', value: captionSource, disabled: recording || liveStarting, 'aria-label': '实时字幕来源', style: { width: 'auto', maxWidth: 260 }, onChange: event => {
            if (!recording && !liveStarting && ['browser', 'local'].includes(event.target.value)) setCaptionSource(event.target.value)
          } }, h('option', { value: 'browser' }, '浏览器 SpeechRecognition'), h('option', { value: 'local' }, '服务器本地模型'))), h('button', { className: 'mt-btn small', disabled: !recording && !displayCaptionEntries.length, onClick: () => { setCaptionPosition(pos => clampCaptionPosition(pos.x, pos.y, window.innerWidth, window.innerHeight)); setFloatingCaption(open => !open) } }, floatingCaption ? '收回字幕' : '悬浮字幕')),
        h('div', { className: 'mt-muted' }, captionStatus || (captionSource === 'local' ? '服务器本地模型分段识别；浏览器需保持局域网连接。' : '浏览器SpeechRecognition提供临时字幕；纪要以完整录音正式转写为准。')),
        floatingCaption ? null : captionLines,
        audioUrl ? h('div', { className: 'mt-stack' },
          h('audio', { ref: liveAudioRef, controls: true, src: audioUrl, style: { width: '100%' }, onLoadedMetadata: event => { const duration = event.currentTarget.duration; setPlayDuration(Number.isFinite(duration) ? duration : elapsed) }, onTimeUpdate: event => setPlayPosition(event.currentTarget.currentTime) }),
          h('div', { className: 'mt-row' }, h('span', { className: 'mt-time' }, mmss(playPosition)), h('input', { type: 'range', min: 0, max: Math.max(1, playDuration || elapsed), step: 0.1, value: Math.min(playPosition, playDuration || elapsed || 1), className: 'mt-seek', disabled: !(playDuration || elapsed), 'aria-label': '录音回放位置', onChange: event => { const seconds = Number(event.target.value); if (liveAudioRef.current) liveAudioRef.current.currentTime = seconds; setPlayPosition(seconds) } }), h('span', { className: 'mt-time' }, mmss(playDuration || elapsed))),
          h('div', { className: 'mt-row' }, h('a', { className: 'mt-btn small', href: audioUrl, download: recFileName }, '↓ ' + t.downloadRec), h('button', { className: 'mt-btn small danger', disabled: liveBusy, onClick: discardLive }, '放弃录音')),
        ) : recording || liveStarting ? h('button', { className: 'mt-btn small danger', onClick: discardLive }, t.cancelRec) : null,
        h('div', { className: 'mt-row mt-between' }, h(TaskModelPicker, { catalog: modelCatalog, value: taskModel, onChange: setTaskModel, disabled: contextBusy }), h('button', { className: 'mt-btn primary', disabled: !audioUrl || contextBusy || !templateReady, onClick: finishLive }, liveBusy ? '正在正式处理…' : '✦ 生成纪要')),
      )

      // —— 面板 B：上传录音 ——
      const uploadPanel = h('div', { className: 'mt-stack' },
        h('div', {
          className: 'mt-drop',
          onClick: () => dropRef.current && dropRef.current.click(),
          onDragOver: (e) => e.preventDefault(),
          onDrop: onDropAudio,
        }, '🎧 ', t.uploadHint),
        h('input', { ref: dropRef, type: 'file', accept: 'audio/*,.mp3,.m4a,.wav,.aac,.ogg,.webm,.amr,.flac', style: { display: 'none' }, onChange: onPickAudio }),
        upProgress >= 0
          ? h('div', { className: 'mt-stack', style: { gap: 4 } },
              h('div', { className: 'mt-row mt-between' }, h('span', { className: 'mt-muted' }, upStage || t.uploadProgress), h('span', { className: 'mt-muted' }, `${upProgress}%`)),
              h('div', { className: 'mt-progress' }, h('i', { style: { width: `${upProgress}%` } })),
            )
          : null,
        uploadRec
          ? h('div', { className: 'mt-recfile' },
              h('div', { className: 'mt-row mt-between' },
                h('span', { className: 'name' }, '🎵 ', uploadRec.filename),
                h('span', { className: 'mt-muted' }, fmtBytes(uploadRec.size_bytes || 0)),
              ),
              h('audio', {
                ref: upAudioRef, controls: true,
                src: `${API}/recordings/${encodeURIComponent(uploadRec.recording_id)}/file`,
                style: { width: '100%' }, onLoadedMetadata: saveRecDuration,
              }),
            )
          : null,
        h('textarea', { className: 'mt-textarea', style: { minHeight: 110 }, value: upTranscript, placeholder: '[14:30:00] 张总：本季度预算……', onChange: (e) => setUpTranscript(e.target.value) }),
        h('div', { className: 'mt-row' },
          h('button', { className: 'mt-btn small', disabled: !uploadRec || !upTranscript.trim() || upSaving, onClick: saveUpTranscript }, '💾 ', t.saveTranscript),
          h('button', { className: 'mt-btn small', onClick: () => upTxtRef.current && upTxtRef.current.click() }, t.importTxtSrt),
          h('input', { ref: upTxtRef, type: 'file', accept: '.txt,.srt', style: { display: 'none' }, onChange: importUpTxt }),
        ),
        h('div', { className: 'mt-muted', role: 'status' }, '上传录音的浏览器语音识别已停用；可继续回放、手工修订，或使用本地阿昆对完整录音正式转写。'),
      )

      // —— 面板 C：粘贴文本（保持旧行为） ——
      const pastePanel = h('div', { className: 'mt-stack' },
        h('div', { className: 'mt-row mt-between' },
          h('span', { className: 'mt-muted' }, t.transcriptLabel),
          h('button', { className: 'mt-btn small', onClick: () => txtRef.current && txtRef.current.click() }, t.importTxt),
        ),
        h('textarea', { className: 'mt-textarea', style: { minHeight: 150 }, value: transcript, placeholder: '[14:30:00] 张总：本季度预算……', onChange: (e) => setTranscript(e.target.value) }),
        h('input', { ref: txtRef, type: 'file', accept: '.txt,.md,.srt', style: { display: 'none' }, onChange: (e) => importFile(e, 'transcript') }),
        h('div', { className: 'mt-row mt-between' }, h(TaskModelPicker, { catalog: modelCatalog, value: taskModel, onChange: setTaskModel, disabled: contextBusy }), h('button', { className: 'mt-btn primary', disabled: !transcript.trim() || contextBusy || !templateReady, title: contextBusy ? t.generating : !templateReady ? '纪要模板未就绪，请先刷新模板 / 模型' : !transcript.trim() ? t.transcriptLabel : (targetId ? '' : '未绑定会议：生成前需填写会议信息（在「生成纪要设置」中）'), onClick: generate }, busy ? t.generating : '✦ ' + t.generateBtn)),
      )

      const splitLatestRef=useRef(null);splitLatestRef.current={targetId,blocked:contextBusy||dirty}
      // mtGenOpt-20261019：纪要概览默认不显示；生成成功或该会议已有纪要时才出现。
      useEffect(() => {
        const id = minutes?.minutes_id || null
        if (id && id !== lastMinutesId035.current) {
          lastMinutesId035.current = id
          setTimeout(() => previewRef035.current?.scrollIntoView?.({ block: 'nearest' }), 0)
        }
      }, [minutes?.minutes_id])
      const minutesFallback035 = minuteLoad === 'loading'
        ? h('div', { className: 'mt-muted', role: 'status' }, L035('正在加载该会议纪要…', 'Loading the minutes for this meeting…'))
        : minuteLoad === 'error'
          ? h('div', { className: 'mt-notice' }, L035('纪要读取失败，不代表无记录。', 'Failed to read the minutes; this does not mean there is none.'), h('button', { className: 'mt-btn small', onClick: () => loadMinutes(targetId) }, L035('重试', 'Retry')))
          : null
      // mtGenOpt-20261019：三项配置（会议绑定 / 纪要模板 / 上传Word模板）收进「生成纪要设置」，默认折叠。
      const genConfig035 = h('section', { className: 'mt-genopt035' },
        h('div', { className: 'mt-row mt-between' },
          h('button', { className: 'mt-btn small', 'aria-expanded': genOptOpen035, 'aria-controls': 'mt-genopt-body035', onClick: () => setGenOptOpen035((open) => !open) }, (genOptOpen035 ? '▾ ' : '▸ ') + L035('生成纪要设置', 'Generation settings')),
          h('span', { className: 'mt-muted' }, L035('会议绑定 / 会议信息 / 纪要模板 / Word模板', 'Meeting / info / template / Word')),
        ),
        genOptOpen035 ? h('div', { className: 'mt-stack mt-genopt-body035', id: 'mt-genopt-body035' },
          h('label', { className: 'mt-field' }, L035('会议绑定（生成纪要必须关联一场会议）', 'Meeting binding (minutes must belong to a meeting)'),
            h('select', { className: 'mt-select', 'data-genopt035': 'bind', value: targetId || '__new__', disabled: contextLocked || newMeetingBusy035, title: audioUrl ? '保留录音的会议绑定已锁定；请先下载并放弃录音再改绑' : contextBusy ? '任务处理中，暂不能改绑' : '', onChange: (event) => changeMeeting(event.target.value === '__new__' ? '' : event.target.value) },
              h('option', { value: '__new__' }, L035('＋ 新建会议（需填写会议信息）', '+ New meeting (meeting info required)')),
              meetings.map((item) => h('option', { value: item.id, key: item.id }, item.title + '（' + fmtDay(item.start_time) + '）')),
            )),
          !targetId ? h('div', { className: 'mt-card mt-stack mt-newmeeting035' },
            h('div', { className: 'mt-row mt-between' },
              h('b', null, L035('会议信息（未绑定会议时必填）', 'Meeting info (required when unbound)')),
              h('span', { className: 'mt-muted' }, L035('点击生成时先创建该会议', 'created when you generate')),
            ),
            h('div', { className: 'mt-grid2' },
              h('label', { className: 'mt-field' }, L035('会议主题 *', 'Meeting title *'), h('input', { className: 'mt-input', 'data-genopt035': 'title', maxLength: 120, value: newMeeting035.title, placeholder: '例如：Q4 算力扩容专项评审会', onChange: (event) => setNewMeeting035((form) => ({ ...form, title: event.target.value })) })),
              h('label', { className: 'mt-field' }, L035('地点', 'Location'), h('input', { className: 'mt-input', value: newMeeting035.location, onChange: (event) => setNewMeeting035((form) => ({ ...form, location: event.target.value })) })),
              h('label', { className: 'mt-field' }, L035('开始时间 *', 'Start *'), h('input', { className: 'mt-input', type: 'datetime-local', 'data-genopt035': 'start', value: newMeeting035.start, onChange: (event) => setNewMeeting035((form) => ({ ...form, start: event.target.value })) })),
              h('label', { className: 'mt-field' }, L035('结束时间 *', 'End *'), h('input', { className: 'mt-input', type: 'datetime-local', 'data-genopt035': 'end', value: newMeeting035.end, onChange: (event) => setNewMeeting035((form) => ({ ...form, end: event.target.value })) })),
              h('label', { className: 'mt-field' }, L035('参会人', 'Participants'), h('input', { className: 'mt-input', value: newMeeting035.participants, placeholder: '张三, 李四', onChange: (event) => setNewMeeting035((form) => ({ ...form, participants: event.target.value })) })),
              h('label', { className: 'mt-field' }, L035('形式', 'Type'), h('select', { className: 'mt-select', value: newMeeting035.type, onChange: (event) => setNewMeeting035((form) => ({ ...form, type: event.target.value })) }, [['offline', L035('线下', 'Offline')], ['online', L035('线上', 'Online')], ['hybrid', L035('混合', 'Hybrid')]].map(([id, label]) => h('option', { key: id, value: id }, label)))),
            ),
            h('div', { className: 'mt-row' },
              h('button', { className: 'mt-btn small', disabled: newMeetingBusy035 || contextBusy, onClick: () => { const now = new Date(); setNewMeeting035((form) => ({ ...form, start: form.start || localInput035(now), end: form.end || localInput035(new Date(now.getTime() + 3600000)), title: form.title || defaultMeetingTitle035() })) } }, L035('按当前时间预填', 'Prefill current time')),
              h('span', { className: 'mt-muted' }, L035('未绑定会议时，点击生成会先创建会议，再生成纪要。', 'When unbound, generating creates the meeting first.')),
            ),
          ) : null,
          h('label', { className: 'mt-field' }, L035('纪要模板', 'Minutes template'), h('select', { className: 'mt-select', value: template, disabled: contextLocked || templateCatalog.state !== 'ready', onChange: (event) => setTemplate(event.target.value) }, templateCatalog.rows.map((item) => h('option', { key: item.id, value: item.id }, item.name)))),
          h('div', { className: 'mt-field' }, h('span', null, L035('上传Word模板（仅本次）', 'Upload Word template (this run only)')),
            h('div', { className: 'mt-word-pick035' }, h('button', { className: 'mt-btn small', disabled: contextBusy || newMeetingBusy035, onClick: () => wordInput.current?.click() }, wordBusy ? L035('验证中…', 'Validating…') : L035('选择文件', 'Choose file')),
              h('span', { className: 'mt-chip', title: wordTemplate?.name || L035('未选择文件', 'No file selected') }, wordTemplate?.name || L035('未选择文件', 'No file selected')),
              wordTemplate ? h('button', { className: 'mt-btn small', disabled: contextBusy, onClick: removeWordTemplate, 'aria-label': '移除本次Word模板' }, L035('移除', 'Remove')) : null),
            h('input', { ref: wordInput, type: 'file', accept: '.docx', style: { display: 'none' }, onChange: pickWordTemplate }),
            h('span', { className: 'mt-muted' }, L035('成功生成后消费一次；人工编辑／导出不会消费模板。', 'Consumed once after a successful generation; manual editing/export does not consume it.'))),
          h('div', { className: 'mt-row mt-context-status035' }, MinutesPill({ value: statusValue, t }), h('button', { className: 'mt-btn small', disabled: contextBusy, onClick: refreshCatalogs }, L035('刷新模板 / 模型', 'Refresh templates / models'))),
          templateCatalog.state !== 'ready' ? h('div', { className: 'mt-notice' }, templateCatalog.state === 'loading' ? L035('模板加载中…', 'Loading templates…') : L035('真实模板加载失败，请重试。', 'Failed to load real templates; please retry.')) : null,
          !minutes ? h('div', { className: 'mt-muted' }, L035('该会议尚无纪要；选择来源、确认生成设置后点击生成。', 'No minutes for this meeting yet. Pick a source, confirm the settings and generate.')) : null,
        ) : null,
      )

      useEffect(()=>()=>{splitLatestRef.current=null},[])
      return h('div', { className: 'mt-stack mt-minutes-view' },
        h(SplitLegacyPanel,{key:targetId,meetingId:targetId,locked:contextBusy||dirty,showToast,onLatest:async id=>{if(splitLatestRef.current?.blocked)return;const owner=targetId,seq=++minuteLoadSeq.current;try{const data=await request('/minutes/'+encodeURIComponent(id));if(splitLatestRef.current?.targetId===owner&&!splitLatestRef.current?.blocked&&seq===minuteLoadSeq.current&&data.minutes?.meeting_id===owner){setMinutes(data.minutes);setDraft(null);setEditing(false)}}catch(error){if(splitLatestRef.current?.targetId===owner)showToast(error.message,'error')}}}),
        h('section', { className: 'mt-card mt-stack', 'aria-label': '纪要来源' },
          h('div', { className: 'mt-seg mt-source-tabs', role: 'tablist' }, [['live', '🎙 实时录音'], ['upload', '📁 上传录音'], ['paste', '⌨ 粘贴文本']].map(([id, label]) => h('button', { key: id, 'aria-pressed': srcMode === id, disabled: contextBusy && !recording && !liveStarting, onClick: () => switchSrc(id) }, label))),
          srcMode === 'live' ? livePanel : null,
          srcMode === 'upload' ? h('div', { className: 'mt-stack' }, uploadPanel, h('div', { className: 'mt-row mt-between' }, h(TaskModelPicker, { catalog: modelCatalog, value: taskModel, onChange: setTaskModel, disabled: contextBusy }), h('button', { className: 'mt-btn primary', disabled: !uploadRec || contextBusy || !templateReady, onClick: generateUpload }, upBusy ? upStage || '正在处理…' : '✦ ' + t.generateBtn))) : null,
          srcMode === 'paste' ? pastePanel : null,
          genConfig035,
        ),
        generationProgress035 ? h("div",{className:"mt-notice",role:"status"},generationProgress035.label,
          generationActive035 && generationProgress035.progress?.phase !== "committing" ? h("button",{className:"mt-btn small",onClick:()=>generationAbort035.current?.abort()},"取消纪要处理（保留录音与转写）") : null,
          !generationActive035 && generationProgress035.task_id && ["interrupted","cancelled","unresolved"].includes(generationProgress035.state) ? h("button",{className:"mt-btn small",disabled:contextBusy,onClick:resumeGeneration035},"恢复上次任务") : null,
          !generationActive035 && generationProgress035.state==="unresolved" ? h("button",{className:"mt-btn small",onClick:()=>inspectGrounding035(generationProgress035.task_id)},"查看待审核验清单") : null,
          generationProgress035.task_id ? h("div",{className:"mt-muted"},"任务参考："+generationProgress035.task_id) : null) : null,
        minutes ? h('section', { className: 'mt-card mt-stack mt-preview', ref: previewRef035, 'aria-label': '纪要概览' },
          h('div', { className: 'mt-row mt-between' },
            h('div', { className: 'mt-row' }, h('h3', { className: 'mt-h3' }, '纪要概览'), minutes ? h('span', { className: 'mt-pill gray' }, t.versionLabel(minutes.version || 1)) : null, minutes ? h('span', { className: 'mt-pill blue' }, sourceLabel[minutes.source] || t.sourceAi) : null),
            h('div', { className: 'mt-minute-tools' },
              h('span', { className:'mt-muted' }, minutes?.is_archived?'已归档，只读查看':'直接在下方Word面板修改文字与排版'),
              h('button', { className: 'mt-btn small primary', disabled: !previewReady || !nativeWordState.ready || !dirty || contextBusy || minutes?.is_archived, onClick: () => saveContent() }, '保存'),
              h('button', { className: 'mt-btn small', disabled: !previewReady || contextBusy, onClick: copyAll }, '复制'),
              h('button', { className: 'mt-btn small', disabled: !previewReady || !nativeWordState.ready || contextBusy, onClick: downloadMinutes }, '导出Word'),
              h('button', { className: 'mt-btn small success', disabled: !previewReady || contextBusy || editing || dirty || minutes?.is_archived, title: editing || dirty ? '请先保存或取消编辑，再正式归档' : minutes?.is_archived ? '当前版本已正式归档' : '对已保存正文生成SHA256指纹', onClick: archive }, '正式归档'),
              h('details', { className: 'mt-more' }, h('summary', { className: 'mt-btn small', 'aria-label': '纪要更多操作', 'aria-disabled': !previewReady || contextBusy, onClick: event => { if (!previewReady || contextBusy) event.preventDefault() } }, '更多 ▾'), h('div', { className: 'mt-more-menu' },
                h('button', { className: 'mt-btn small', disabled: !minutes || contextBusy, onClick: () => impRef.current?.click() }, '导入修正版'),
                h('button', { className: 'mt-btn small', disabled: !editing || contextBusy, onClick: cancelEdit }, '取消编辑'),
                h('div', { className: 'mt-muted' }, '导入 / 保存将解除旧版归档；正式归档需再次明确操作。'),
              )),
              h('input', { ref: impRef, type: 'file', accept: '.txt,.md,.markdown', style: { display: 'none' }, onChange: event => importFile(event, 'import') }),
            ),
          ),
          h('div', { className: 'mt-stack' },
            minutes.is_archived && minutes.archive_fingerprint ? h('div', { className: 'mt-stack' }, h('span', { className: 'mt-pill green' }, '🔐 正式归档指纹'), h('div', { className: 'mt-fp' }, minutes.archive_fingerprint)) : null,
            h(WordEditorPane, { key:minutes.minutes_id + ':' + Boolean(minutes.is_archived), minutes, apiRef:nativeWordApi, onState:setNativeWordState,
              onSaved: saved => { setMinutes(saved); setDraft(null); setEditing(false); refreshMeetings() } }),
            wordDocument?.warnings?.length ? h('details',null,h('summary',null,'字体与渲染差异说明'),wordDocument.warnings.map((warning,i)=>h('div',{key:i,className:'mt-muted'},warning))) : null,
            h('div', null, h('h4', { className: 'mt-h3' }, '☑ ' + t.actionItems), (minutes.action_items || []).length ? minutes.action_items.map(item => h('label', { className: 'mt-todo', key: item.task_id }, h('input', { type: 'checkbox', checked: item.completed === true, disabled: contextBusy, onChange: () => toggleTodo(item) }), h('span', { className: 'mt-grow' + (item.completed ? ' done' : '') }, item.content), item.assignee ? h('span', { className: 'mt-chip' }, item.assignee) : null, item.due_date ? h('span', { className: 'mt-chip' }, item.due_date) : null)) : h('div', { className: 'mt-muted' }, t.noActionItems)),
            minutes.grounding ? h('div', {className:'mt-notice',role:'note'}, minutes.grounding.notice, h('button',{className:'mt-btn small',disabled:contextBusy,onClick:()=>inspectGrounding035()},'查看完整原文与生成时核验清单')) : null,
            minutes.generation_model ? h('div', { className: 'mt-muted' }, '实际生成模型：' + minutes.generation_model.provider + ' / ' + minutes.generation_model.model) : null,
            h('details', null, h('summary', null, '版本历史'), h('div', { className: 'mt-muted' }, (minutes.history || []).map((row, index) => h('div', { key: index }, 'v' + row.version + ' · ' + row.source + ' · ' + row.saved_at)))),
          ),
        ) : minutesFallback035,
        groundingView035 && (groundingView035.owner === "minutes:"+minutes?.minutes_id || groundingView035.owner === "task:"+generationProgress035?.task_id) ? h("section",{className:"mt-card mt-stack","aria-label":"原文与覆盖核验审阅"},
          h("h3",{className:"mt-h3"},"原文与覆盖核验审阅"),h("div",{className:"mt-notice"},"清单针对生成时的草稿，不证明后续人工修改仍覆盖全部事实；自动核验不是人工语义认证。"),
          groundingView035.loading ? h("div",{role:"status"},"正在检查原文哈希并读取清单…") : null,
          groundingView035.error ? h("div",{role:"alert"},groundingView035.error) : null,
          groundingView035.data ? h("div",{className:"mt-stack"},h("details",null,h("summary",null,"完整转写原文（只读，非纪要编辑器）"),h("textarea",{className:"mt-textarea",readOnly:true,value:groundingView035.data.source,"aria-label":"完整转写原文",style:{width:"100%",minHeight:240,maxHeight:400,boxSizing:"border-box"}})),h("pre",{style:{whiteSpace:"pre-wrap",overflowWrap:"anywhere",maxHeight:420,overflow:"auto",margin:0}},groundingView035.data.report)) : null,
          h("button",{className:"mt-btn small",onClick:()=>setGroundingView035(null)},"关闭审阅清单")) : null,
        floatingCaption && visible ? h('div', { className: 'mt-caption-float', style: { left: captionPosition.x, top: captionPosition.y } },
          h('div', { className: 'mt-caption-handle', onPointerDown: beginCaptionDrag, onPointerMove: moveCaption, onPointerUp: () => { captionDragRef.current = null }, onPointerCancel: () => { captionDragRef.current = null } }, h('b', null, liveRoundRef.current?.transcript ? '正式转写 · 完整音频' : '实时字幕 · 临时预览'), h('button', { className: 'mt-btn small', onClick: () => setFloatingCaption(false) }, '收回')),
          captionLines,
        ) : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /* 视图四：会议问答                                                    */
    /* ---------------------------------------------------------------- */

    function renderCitations(text, sources, onCite) {
      const parts = String(text || '').split(/(\[引用\d+\]|\[Citation\s*\d+\])/g)
      return parts.map((part, i) => {
        const m = part.match(/^\[引用(\d+)\]$/) || part.match(/^\[Citation\s*(\d+)\]$/i)
        if (!m) return part
        const n = Number(m[1])
        const src = (sources || []).find((s) => s.index === n) || (sources || [])[n - 1]
        return h('button', {
          key: i, className: 'mt-cite', title: src ? `${src.meeting_title || src.label}` : '',
          onClick: () => src && onCite(src),
        }, n)
      })
    }

// Classic factory helpers; no new Service/API, no external assets.
function QaAvatar035({ role }) {
  const user = role === 'user'
  return h('svg', { viewBox: '0 0 36 36', width: 36, height: 36, role: 'img', 'aria-label': user ? '提问者头像' : '助手头像', className: 'mt-qa-avatar035' },
    h('circle', { cx: 18, cy: 18, r: 17, fill: user ? '#e7f0ff' : '#dff7ef', stroke: user ? '#baceee' : '#b9dfd0' }),
    user ? h('path', { d: 'M8 31c1-8 19-8 20 0', fill: '#86aee5' }) : h('path', { d: 'M18 5v4M11 27v4M25 27v4', stroke: '#64a99a', strokeWidth: 2 }),
    user ? h('circle', { cx: 18, cy: 17, r: 9, fill: '#ffe5cc' }) : h('rect', { x: 8, y: 10, width: 20, height: 17, rx: 6, fill: '#a8dece', stroke: '#64a99a' }),
    user ? h('path', { d: 'M9 16c0-13 20-13 18 1-6-1-9-5-10-6-1 3-4 5-8 5', fill: '#647da5' }) : null,
    h('circle', { cx: 14, cy: 18, r: 1.3, fill: '#34546b' }), h('circle', { cx: 22, cy: 18, r: 1.3, fill: '#34546b' }),
    h('path', { d: 'M14 22q4 4 8 0', fill: 'none', stroke: '#34546b', strokeWidth: 1.5, strokeLinecap: 'round' }))
}
/* mtQaTs-20261005：问答消息时间戳格式化 —— 今日 HH:mm / 同年 MM-DD HH:mm / 跨年 YYYY-MM-DD HH:mm；
 * 无效值返回 ''（调用侧据此不渲染时间行）。与政策解读 paQaTs-20261005 同算法。 */
function fmtQaMsgTime035(v) {
  const p2 = (n) => String(n).padStart(2, '0')
  let d = null
  if (typeof v === 'number' && Number.isFinite(v)) d = new Date(v)
  else if (typeof v === 'string' && v) { const n = new Date(v); if (!Number.isNaN(n.getTime())) d = n }
  if (!d) return ''
  const now = new Date()
  const hm = p2(d.getHours()) + ':' + p2(d.getMinutes())
  if (d.getFullYear() !== now.getFullYear()) return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + hm
  if (d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate()) return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + hm
  return hm
}
function QaMessage035({ role, ts, children }) {
  const user = role === 'user'
  const stamp = fmtQaMsgTime035(ts)
  return h('div', { className: 'mt-qa-message035' + (user ? ' user' : ' assistant'), 'aria-label': user ? '提问者消息' : '助手消息' }, h(QaAvatar035, { role }), h('div', { className: 'mt-qa-col035' }, h('div', { className: 'mt-bubble ' + (user ? 'user' : 'ai') }, children), stamp ? h('div', { className: 'mt-qa-time035', title: stamp }, stamp) : null))
}
function qaAvailable035(top, bottom, padding) { return Math.max(120, Math.floor(bottom - top - padding)) }
// kbcAsk-20261005：输入卡片手拖高度（null = 随内容自适应）
function readDockHeight035(storage) {
  try {
    const raw = storage.getItem('meetai.askDockH.v1')
    const value = Number(raw)
    if (raw !== null && raw !== '' && Number.isFinite(value) && value >= 120 && value <= 1600) return Math.round(value)
  } catch { /* ignore */ }
  return null
}

    function RestrictedAskView({ t, meetings, showToast, seed, refreshMeetings, sessions, refreshSessions, onActiveSession, onNewChat, meetingsKnown }) {
      // 会话列表由 MeetingApp 持有（rail「历史对话」标签下展示），此处只读 + 通过 ref 供 seed.loadSession 查找
      const [localHistory,setLocalHistory]=useState([]),[historyError,setHistoryError]=useState(''),[historyBusy,setHistoryBusy]=useState(false),[historyNext,setHistoryNext]=useState(null)
      const historyEpoch=useRef(0),historyAlive=useRef(true),historyBusyRef=useRef(false),historyListEpoch=useRef(0)
      useEffect(()=>{historyAlive.current=true;return()=>{historyAlive.current=false;historyEpoch.current++;historyListEpoch.current++}},[])
      async function refreshRestrictedHistory(offset=0){const epoch=++historyListEpoch.current;try{const data=await request('/restricted-qa-sessions?limit=100&offset='+offset);if(historyAlive.current&&historyListEpoch.current===epoch){setLocalHistory(value=>offset?[...new Map([...value,...data.sessions].map(row=>[row.session_id,row])).values()]:data.sessions);setHistoryNext(data.nextOffset);setHistoryError('')}}catch(error){if(historyAlive.current&&historyListEpoch.current===epoch)setHistoryError('历史读取失败（未清空已有列表）：'+error.message)}}
      const sessionsRef = useRef([])
      const [activeId, setActiveId] = useState('')
      const [scope, setScope] = useState('all')
      const [messages, setMessages] = useState([])
      const [input, setInput] = useState('')
      const [busy, setBusy] = useState(false)
      useEffect(()=>{if(!busy)void refreshRestrictedHistory()},[busy])
      const [source, setSource] = useState(null)
      // 流式应答态：stream = { text, status, think, tool }（busy 期间渲染接收中的 ai 气泡）
      const [stream, setStream] = useState(null)
      // 附件待发列表（{key,name,size,path?,pending}）；uploading 为在传数量；dragOver 控制拖拽高亮
      const [files, setFiles] = useState([])
      const [uploading, setUploading] = useState(0)
      const [dragOver, setDragOver] = useState(false)
      // @ 引用会议菜单（kbComposer-20261005）：选择后直接复用既有 scope 机制限定检索范围
      const [kbcMention, setKbcMention] = useState(false)
      // 模型目录（GET /models）：state idle|loading|ready|fail；model 为 null = 跟随系统默认
      const [models, setModels] = useState({ state: 'idle', groups: [], def: null })
      const [model, setModel] = useState(null)
      const scrollRef = useRef(null)
      const inputRef = useRef(null)
      const fileRef = useRef(null)
      const seedSeen = useRef(0)
      const fileSeq = useRef(0)
      const dragDepth = useRef(0) // 嵌套 dragenter/leave 计数，避免子元素闪烁
      const abortRef = useRef(null) // 流式请求中止控制器（「■ 停止」按钮）
      const answerRef = useRef('') // 本轮回答的权威累积文本（turn_end 收尾用它，避免 rAF 批次滞后）
      const pendingDelta = useRef('') // rAF 未刷新的 delta 缓冲
      const rafRef = useRef(0)
      const [autoH035, setAutoH035] = useState(520)
      const askWrapRef035 = useRef(null), followRef035 = useRef(true)
      const [unseen035, setUnseen035] = useState(false)
      // kbcAsk-20261005：对话区恒为可用高度；输入卡片高度单独记（null = 随内容自适应）
      const [dockH035, setDockH035] = useState(() => readDockHeight035(window.localStorage))
      const dockRef035 = useRef(null)
      const askH = autoH035
      const askHRef = useRef(askH), resizeRef = useRef(null), startResizeRef = useRef(null)
      const dockMax035 = () => Math.max(160, (askHRef.current || autoH035) - 150)
      const messagesRef = useRef([]), activeIdRef = useRef(''), filesRef = useRef([]), modelRef = useRef(null)
      useEffect(() => { messagesRef.current = messages }, [messages])
      useEffect(() => { activeIdRef.current = activeId }, [activeId])
      useEffect(() => { filesRef.current = files }, [files])
      useEffect(() => { modelRef.current = model }, [model])
      useEffect(() => { sessionsRef.current = Array.isArray(sessions) ? sessions : [] }, [sessions])
      useEffect(() => { askHRef.current = askH }, [askH])
      useEffect(() => {
        try {
          if (dockH035 === null) window.localStorage.removeItem('meetai.askDockH.v1')
          else window.localStorage.setItem('meetai.askDockH.v1', String(Math.round(dockH035)))
        } catch { /* ignore */ }
      }, [dockH035])
      useEffect(() => {
        const root = askWrapRef035.current; if (!root) return
        const stage = root.closest('.mt-stage'), viewport = window.visualViewport
        const box = root.parentElement
        const measure = () => {
          if (!root.isConnected || !root.getClientRects().length) return
          const top = root.getBoundingClientRect().top
          const viewBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight
          const stageBottom = stage?.getBoundingClientRect().bottom || viewBottom
          // kbcAsk-20261005：真正带底部内边距的滚动容器是 .mt-body（.mt-stage 的 padding 恒为 0）。
          // 原先按 .mt-stage 算 → 面板比容器高 14px、出现滚动条 → 「输入框底边不在底部」。
          const padBottom = box ? parseFloat(window.getComputedStyle(box).paddingBottom) || 0 : 0
          const boxBottom = box ? box.getBoundingClientRect().bottom - padBottom : Infinity
          const avail = qaAvailable035(top, Math.min(viewBottom, stageBottom, boxBottom) - 1, 0)
          setAutoH035(avail)
          setDockH035(prev => (prev === null ? prev : Math.min(prev, Math.max(160, avail - 150))))
        }
        measure(); window.addEventListener('resize', measure); viewport?.addEventListener('resize', measure); viewport?.addEventListener('scroll', measure)
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (stage) observer?.observe(stage); if (root.parentElement) observer?.observe(root.parentElement)
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure); viewport?.removeEventListener('resize', measure); viewport?.removeEventListener('scroll', measure) }
      }, [])
      useEffect(() => {
        const remove = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', end); window.removeEventListener('blur', end) }
        // kbcAsk-20261005：把手在卡片上沿，向上拖 = 变高（下沿固定贴底）
        const move = event => {
          const info = resizeRef.current; if (!info) return
          const next = Math.max(120, Math.min(dockMax035(), Math.round(info.height + (info.y - event.clientY))))
          setDockH035(next)
        }
        const end = () => { resizeRef.current?.root?.removeAttribute('data-mt-resizing'); resizeRef.current=null; remove() }
        startResizeRef.current = event => {
          event.preventDefault(); if (resizeRef.current) return
          const root = event.currentTarget.closest('.mt-app')
          const dock = dockRef035.current
          const rect = dock ? dock.getBoundingClientRect() : null
          resizeRef.current = { y: event.clientY, height: rect && rect.height > 0 ? Math.round(rect.height) : 140, root }
          root?.setAttribute('data-mt-resizing','1')
          window.addEventListener('mousemove', move); window.addEventListener('mouseup', end); window.addEventListener('blur', end)
        }
        return () => { end(); startResizeRef.current = null }
      }, [])
      // kbcAsk-20261005：输入框随内容自适应加高（KB 插件同款：按 scrollHeight 回写内联高度，上限 200px）。
      // 固定高度模式下 textarea 撑满卡片；内容比卡片还高时把卡片一并抬高。
      useEffect(() => {
        const el = inputRef.current; if (!el) return
        if (dockH035 !== null) {
          el.style.height = ''
          const deficit = el.scrollHeight - el.clientHeight
          if (deficit > 1) setDockH035(prev => (prev === null ? prev : Math.min(prev + deficit, dockMax035())))
          return
        }
        el.style.height = 'auto'
        el.style.height = Math.max(52, Math.min(el.scrollHeight, 200)) + 'px'
      }, [input, dockH035])

      // 卸载清理：中止进行中的流式请求与未刷新的 rAF 批处理
      useEffect(() => () => {
        try { if (abortRef.current) abortRef.current.abort() } catch { /* ignore */ }
        try { if (rafRef.current && window.cancelAnimationFrame) window.cancelAnimationFrame(rafRef.current) } catch { /* ignore */ }
      }, [])

      // 会话 id 变更统一出口：本地 state + 上报 MeetingApp（rail 高亮当前会话）
      const changeActive = useCallback((id) => {
        setActiveId(id)
        if (onActiveSession) onActiveSession(id)
      }, [onActiveSession])

      // 模型目录：GET /models → optgroup 分组；失败（503 MODEL_UNAVAILABLE 等）→ 选择器降级并提示
      const loadModels = useCallback(async () => {
        setModels((s) => ({ state: 'loading', groups: s.groups || [], def: s.def || null }))
        try {
          const data = await request('/models')
          const groups = (Array.isArray(data.groups) ? data.groups : [])
            .map((g) => ({
              id: String((g && g.id) || ''),
              name: String((g && g.name) || (g && g.id) || ''),
              models: (Array.isArray(g && g.models) ? g.models : [])
                .filter((m) => m && m.id)
                .map((m) => ({ id: String(m.id), name: String(m.name || m.id) })),
            }))
            .filter((g) => g.id && g.models.length)
          const def = data.default && data.default.provider && data.default.model
            ? { provider: String(data.default.provider), model: String(data.default.model) }
            : null
          setModels({ state: 'ready', groups, def })
          // 选中值兜底：当前选择仍在目录内则保留；否则回到「跟随系统默认」
          setModel((cur) => {
            if (!cur) return null
            for (const g of groups) {
              for (const m of g.models) {
                if (g.id === cur.provider && m.id === cur.model) return cur
              }
            }
            return null
          })
        } catch {
          setModels({ state: 'fail', groups: [], def: null })
          setModel(null)
        }
      }, [])
      // Restricted QA is fixed to the approved local Huiwen model; no model discovery/picker.

      // seed：gotoAsk（scope/question/auto）、「新建对话」（reset）与 rail 历史会话点击（loadSession）共用一个 nonce 通道
      useEffect(() => {
        if (!seed || !seed.nonce || seedSeen.current === seed.nonce) return
        seedSeen.current = seed.nonce
        if (seed.reset) {
          // 全新对话：中止进行中的流式请求并清空全部会话态
          try { if (abortRef.current) abortRef.current.abort() } catch { /* ignore */ }
          answerRef.current = ''
          pendingDelta.current = ''
          changeActive('')
          messagesRef.current = []
          setMessages([])
          setStream(null)
          setInput('')
          setFiles([])
          setSource(null)
          return
        }
        if (seed.loadSession) {
          // rail 历史会话点击：优先用列表自带 messages，缺失则取详情
          const s = sessionsRef.current.find((x) => x.session_id === seed.loadSession) || { session_id: seed.loadSession }
          pickSession(s)
          return
        }
        setScope(seed.scope || 'all')
        if (seed.question) setInput(seed.question)
        if (seed.auto && seed.question) send(seed.question, seed.scope || 'all')
      }, [seed && seed.nonce])

      useEffect(() => {
        const el = scrollRef.current
        if (el && followRef035.current) { el.scrollTop = el.scrollHeight; setUnseen035(false) } else if (el) setUnseen035(true)
      }, [messages, busy, stream])

      useEffect(() => { followRef035.current = true; setUnseen035(false); if(scrollRef.current)scrollRef.current.scrollTop=scrollRef.current.scrollHeight }, [activeId])
      // 打开会话：rail「历史对话」点击（经 seed.loadSession）或列表项触发
      async function pickSession(s) {
        if (busy) return // 流式接收中禁止切换会话
        const epoch=++historyEpoch.current;historyBusyRef.current=true;setHistoryBusy(true)
        let msgs = null // Detail is server-owned; never trust list-embedded answers.
        let detailScope=s.scope||'all'
        if (!msgs) {
          try {
            const d = await request(`/restricted-qa-sessions/${encodeURIComponent(s.session_id)}`)
            if(!historyAlive.current||historyEpoch.current!==epoch)return
            if(d.session?.session_id!==s.session_id)throw new Error("历史会话标识不一致")
            detailScope=d.session.scope
            msgs = d.session && Array.isArray(d.session.messages) ? d.session.messages : []
          } catch(error) { if(historyAlive.current&&historyEpoch.current===epoch)showToast('历史读取失败，当前对话保留：'+error.message,'error');return }
          finally{if(historyAlive.current&&historyEpoch.current===epoch){historyBusyRef.current=false;setHistoryBusy(false)}}
        }
        changeActive(s.session_id)
        setScope(detailScope);setSource(null)
        messagesRef.current = Array.isArray(msgs)?msgs:[]
        setMessages(messagesRef.current)
        setStream(null)
      }

      /* —— 附件：📎 选择 / 整区拖拽 → 逐个 POST /upload?name= 落盘 → chips 展示（随 /qa 提交后清空） —— */

      async function uploadOne(file) {
        return showToast('受限问答不接收附件或执行工具。','warn')
        if (!file) return
        if (!UPLOAD_RE.test(file.name)) return showToast(`${t.attUnsupported}：${file.name}`, 'error')
        if (file.size > UPLOAD_MAX) return showToast(`${t.attTooBig}：${file.name}`, 'error')
        fileSeq.current += 1
        const key = `f${fileSeq.current}`
        setFiles((list) => [...list, { key, name: file.name, size: file.size, pending: true }])
        setUploading((n) => n + 1)
        try {
          const resp = await fetch(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            credentials: 'same-origin',
            body: file,
          })
          let data = null
          try { data = await resp.json() } catch { /* 非 JSON 错误体 */ }
          if (resp.ok && data && data.ok === true && data.file && data.file.path) {
            setFiles((list) => list.map((x) => (x.key === key ? { ...x, pending: false, name: data.file.name || file.name, size: Number(data.file.size) || file.size, path: data.file.path } : x)))
          } else {
            const reason = (data && data.message) || `HTTP ${resp.status}`
            setFiles((list) => list.filter((x) => x.key !== key))
            showToast(`${t.attUploadFail}：${file.name} — ${reason}`, 'error')
          }
        } catch (e) {
          setFiles((list) => list.filter((x) => x.key !== key))
          showToast(`${t.attUploadFail}：${file.name} — ${e.message}`, 'error')
        } finally {
          setUploading((n) => Math.max(0, n - 1))
        }
      }

      // 顺序上传（避免并发写盘与提示闪烁）；fileList 可为 FileList 或数组
      async function handleFiles(fileList) {
        return showToast('受限问答不接收附件或执行工具。','warn')
        const arr = []
        for (let i = 0; i < ((fileList && fileList.length) || 0); i++) arr.push(fileList[i])
        for (const f of arr) await uploadOne(f)
      }

      function removeFile(key) {
        setFiles((list) => list.filter((f) => f.key !== key))
      }

      // 拖拽上传：只拦截包含文件的拖拽（dataTransfer.types 含 'Files'），文本/富文本拖放保持默认行为
      const hasFilesInDT = (e) => {
        const dt = e && e.dataTransfer
        if (!dt || !dt.types) return false
        try { return Array.prototype.indexOf.call(dt.types, 'Files') !== -1 } catch { return false }
      }
      const onDragEnter = (e) => {
        e.stopPropagation() /* kbcFix-20261005 */
        if (!hasFilesInDT(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }
      const onDragOver = (e) => {
        e.stopPropagation() /* kbcFix-20261005 */
        if (!hasFilesInDT(e)) return
        e.preventDefault()
        try { e.dataTransfer.dropEffect = 'copy' } catch { /* ignore */ }
      }
      const onDragLeave = (e) => {
        e.stopPropagation() /* kbcFix-20261005 */
        if (!hasFilesInDT(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }
      // kbComposer-20261005：拖拽支持文件夹 —— 用 webkitGetAsEntry 递归收集，readEntries 必须循环取到空。
      // 取不到条目（非 Chromium / 权限受限）时回退 dataTransfer.files，行为与改前一致。
      async function kbcCollectEntry(entry, out) {
        if (!entry) return
        if (entry.isFile) {
          await new Promise((resolve) => {
            try { entry.file((f) => { if (f) out.push(f); resolve() }, () => resolve()) } catch { resolve() }
          })
          return
        }
        if (!entry.isDirectory) return
        const reader = entry.createReader()
        for (;;) {
          const batch = await new Promise((resolve) => {
            try { reader.readEntries((rows) => resolve(Array.prototype.slice.call(rows || [])), () => resolve([])) } catch { resolve([]) }
          })
          if (!batch.length) return
          for (const kid of batch) await kbcCollectEntry(kid, out)
        }
      }
      const onDrop = (e) => {
        e.stopPropagation() /* kbcFix-20261005 */
        if (!hasFilesInDT(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        const dt = e.dataTransfer
        const entries = []
        if (dt && dt.items) {
          const items = Array.prototype.slice.call(dt.items)
          for (const item of items) {
            try { const entry = item.webkitGetAsEntry && item.webkitGetAsEntry(); if (entry) entries.push(entry) } catch { /* ignore */ }
          }
        }
        if (!entries.length) {
          const fl = dt ? dt.files : null
          if (fl && fl.length) void handleFiles(fl)
          return
        }
        // 注意：items 在 await 之后失效，条目必须同步取完再异步递归
        void (async () => {
          const out = []
          for (const entry of entries) await kbcCollectEntry(entry, out)
          if (out.length) await handleFiles(out)
          else showToast('没有可用文件（文件夹为空或类型不支持）。', 'warn')
        })()
      }

      // delta 增量 rAF 批量刷新：先入缓冲，每帧一次性并入气泡文本，降低 setState 频率
      function pushDelta(chunk) {
        pendingDelta.current += chunk
        if (rafRef.current) return
        rafRef.current = window.requestAnimationFrame
          ? window.requestAnimationFrame(flushDelta)
          : window.setTimeout(flushDelta, 16)
      }
      function flushDelta() {
        rafRef.current = 0
        if (!pendingDelta.current) return
        const chunk = pendingDelta.current
        pendingDelta.current = ''
        setStream((s) => (s ? { ...s, text: s.text + chunk } : s))
      }

      /* —— 单一对话框：POST /qa（响应即 SSE）—— status 帧 setSessionId；delta 逐帧追加（rAF 批量）；
       * tool 帧在气泡内显示「🔧 正在调用工具：{name}…」状态行；turn_end 完成（刷新会话列表 +
       * refreshMeetings 日程/统计）；error 帧或网络错误在气泡内显示错误并 toast；
       * busy 时输入框禁用、「发送」变「■ 停止」（AbortController abort）。 —— */

      async function send(questionText, scopeOverride) {
        if(historyBusyRef.current){showToast('请等待历史读取完成。','info');return}
        if (busy) return
        const question = String(questionText !== undefined ? questionText : input || '').trim()
        if (!question) return
        const useScope = scopeOverride || scope
        const attach = filesRef.current.filter((f) => !f.pending).map((f) => ({ name: f.name, path: f.path }))
        const userMsg = { role: 'user', content: question, created_at: new Date().toISOString() }
        const nextMessages = [...messagesRef.current, userMsg]
        messagesRef.current = nextMessages
        setMessages(nextMessages)
        setInput('')
        answerRef.current = ''
        pendingDelta.current = ''
        setStream({ text: '', status: t.thinking, think: '', tool: '', startedAt: Date.now() })
        setBusy(true)
        const body = { question, scope: useScope }
        if (activeIdRef.current) body.session_id = activeIdRef.current
        const ctrl = new AbortController()
        abortRef.current = ctrl
        let errText = ''
        let completed = false // only the server's persisted turn_end confirms completion
        let sources=[],qaTurnId=null
        try {
          const resp = await fetch(API + '/restricted-qa', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
            signal: ctrl.signal,
          })
          // 前置错误（非 200，JSON {ok:false,code,message}）→ 直接抛出展示 message
          if (!resp.ok || !resp.body) {
            let reason = `HTTP ${resp.status}`
            try {
              const d = await resp.json()
              if (d?.error?.code) reason=d.error.code+'：'+(d.error.message||'操作未完成');else if (d && d.message) reason = d.message
            } catch { /* 非 JSON 错误体 */ }
            throw new Error(reason)
          }
          setFiles([]) // 附件已随本次提问提交，清空附件区
          // SSE 帧读取：按 \n\n 切帧 + data: 解析，':' 注释/心跳帧跳过
          const reader = resp.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          let closed = false
          for (;;) {
            const r = await reader.read()
            if (r.done) break
            buf += dec.decode(r.value, { stream: true })
            let idx
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const raw = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              for (const line of raw.split('\n')) {
                if (line.charCodeAt(0) === 58 /* ':' */) continue // SSE 注释/心跳帧
                if (!line.startsWith('data:')) continue
                let ev = null
                try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
                if (!ev || typeof ev !== 'object') continue
                if (ev.type === 'status') {
                  if (ev.sessionId) changeActive(ev.sessionId)
                  if (typeof ev.text === 'string' && ev.text) setStream((s) => (s ? { ...s, status: ev.text } : s))
                } else if (ev.type === 'sources') {
                  sources=Array.isArray(ev.sources)?ev.sources.map((source,index)=>({...source,index:index+1,label:source.title,text:source.quote})):[];qaTurnId=ev.qaTurnId||null
                } else if (ev.type === 'delta' && typeof ev.text === 'string') {
                  answerRef.current += ev.text
                  pushDelta(ev.text)
                } else if (ev.type === 'tool' || ev.type === 'thinking') {
                  throw new Error('受限问答协议不允许工具或未经批准的思考内容。')
                } else if (ev.type === 'turn_end') {
                  // 服务端已把本轮消息落盘；客户端收尾后刷新会话列表与日程/统计
                  completed = true
                  if (ev.sessionId) changeActive(ev.sessionId)
                  closed = true
                  break
                } else if (ev.type === 'error') {
                  errText = String(ev.message || t.askFailed)
                  closed = true
                  break
                }
              }
              if (closed) break
            }
            if (closed) break
          }
          try { reader.cancel() } catch { /* 流已结束 */ }
        } catch (e) {
          if (!(e && e.name === 'AbortError')) errText = String((e && e.message) || e)
        } finally {
          abortRef.current = null
          if (rafRef.current && window.cancelAnimationFrame) {
            try { window.cancelAnimationFrame(rafRef.current) } catch { /* ignore */ }
          }
          rafRef.current = 0
          pendingDelta.current = ''
          // Only turn_end confirms a persisted turn. Keep partial text on error/stop/EOF, never silently call it saved.
          if (!completed) {
            const reason = errText || (ctrl.signal.aborted ? '已停止接收' : '连接已结束，但未收到完成确认')
            errText = `${reason}；本回合未保存（未收到服务端完成确认）。`
          }
          const text = answerRef.current
          let extra = null
          if (errText) extra = { role: 'assistant', content: text, error: errText, created_at: new Date().toISOString() }
          else if (text.trim()) extra = { role: 'assistant', content: text, sources,qaTurnId,queryScope:useScope,created_at: new Date().toISOString() }
          if (extra) {
            const finalMessages = [...messagesRef.current, extra]
            messagesRef.current = finalMessages
            setMessages(finalMessages)
          }
          setStream(null)
          setBusy(false)
          refreshSessions()
          if (completed && !errText && typeof refreshMeetings === 'function') {
            try { refreshMeetings() } catch { /* ignore */ }
          }
        }
        if (errText) showToast(`${t.askFailed}: ${errText}`, 'error')
      }

      function stopStream() {
        try { if (abortRef.current) abortRef.current.abort() } catch { /* ignore */ }
      }

      // 「➕ 新建会议」提示 chip：向输入框插入模板并聚焦（用户补全后发送，服务端建会 → turn_end 后 refreshMeetings 同步日程）
      function insertMeetingTemplate() {
        setInput((cur) => (cur && cur.trim() ? `${cur.replace(/\s*$/, '')}\n\n${MEETING_TEMPLATE}` : MEETING_TEMPLATE))
        try { if (inputRef.current) inputRef.current.focus() } catch { /* ignore */ }
      }

      const presets = useMemo(() => {
        const tomorrow = new Date(Date.now() + 86400000)
        const tomorrowList = meetings.filter((m) => {
          const s = new Date(m.start_time || '')
          return Number.isFinite(s.getTime()) && sameDay(s, tomorrow)
        })
        const archived = meetings.find((m) => m.minutes_status === 'archived')
        return [
          '💡 各场会议有哪些待跟进任务与责任人？',
          tomorrowList.length ? `📅 明天（${fmtDay(tomorrowList[0].start_time)}）有哪些待参加的重点会议？` : '📅 本周还有哪些待开始的重点会议？',
          archived ? `📊 总结《${archived.title}》纪要中的关键决议与预算分配？` : '📊 总结最近会议纪要中的关键决议与预算分配？',
        ]
      }, [meetings])

      const scopeOptions = [
        { value: 'all', label: t.scopeAll(meetings.length) },
        ...meetings.map((m) => ({ value: `meeting:${m.id}`, label: t.scopeMeeting + m.title })),
      ]

      const modelValue = model ? `${model.provider}||${model.model}` : ''

      // 模型选择器：ready → optgroup 分组（首项「跟随系统默认」value=''，default 项 label 加后缀）；
      // fail → 禁用只显示「模型列表不可用」并提供重试；loading → 禁用显示加载中
      function renderModelSelector(){return h('span',{className:'mt-muted'},'汇文大模型 · 本地受限问答 · 无工具')}

      return h('div', {
        className: 'mt-askwrap',
        ref: askWrapRef035,
        style: { height: askH, '--mt-qa-available': autoH035 + 'px' },
        onDragEnter,
        onDragOver,
        onDragLeave,
        onDrop,
      },
        dragOver ? h('div', { className: 'mt-dropoverlay', 'aria-hidden': true }, t.dropHint) : null,
        unseen035 ? h('button', { className:'mt-btn small', onClick:()=>{followRef035.current=true;setUnseen035(false);if(scrollRef.current)scrollRef.current.scrollTop=scrollRef.current.scrollHeight} }, '回到底部') : null,
        // 顶部工具栏：左上角 = 检索范围（全量会议资产 / 仅文档 / 指定会议）
        h('div',{className:'mt-row'},h('label',null,'独立问答历史 ',h('select',{value:activeId,disabled:busy||historyBusy,onChange:event=>{const row=localHistory.find(value=>value.session_id===event.target.value);if(row)void pickSession(row)}},h('option',{value:''},'选择已保存对话'),localHistory.map(row=>h('option',{key:row.session_id,value:row.session_id},row.title)))),h('button',{disabled:busy||historyBusy,onClick:()=>refreshRestrictedHistory()},'刷新历史'),historyNext!==null?h('button',{disabled:busy||historyBusy,onClick:()=>refreshRestrictedHistory(historyNext)},'更多历史'):null),
        historyError?h('div',{role:'alert'},historyError):null,
        h('div', { className: 'mt-asktop' },
          h('select', { className: 'mt-select', value: scope, disabled: busy, 'aria-label': t.askTitle, onChange: (e) => { historyEpoch.current++;historyBusyRef.current=false;setHistoryBusy(false);changeActive('');messagesRef.current=[];setMessages([]);setStream(null);setSource(null);setScope(e.target.value) } },
            scopeOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
          ),
          h('span', { className: 'mt-muted mt-grow' }, '基于所选会议资产范围回答，不限正式归档。', scope === 'docs' ? ' 当前范围：会议材料。' : ' 范围内会议：' + (meetingsKnown ? scope === 'all' ? meetings.length : meetings.filter(item => 'meeting:' + item.id === scope).length : '未知') + '。'),
          h('button', { className: 'mt-btn small', disabled: busy, onClick: () => { historyEpoch.current++; historyBusyRef.current=false; setHistoryBusy(false); answerRef.current=''; pendingDelta.current=''; changeActive(''); messagesRef.current=[]; setMessages([]); setStream(null); setInput(''); setFiles([]); setSource(null); showToast('已开始新会话，原历史记录保留。', 'info') } }, '清空 / 新会话'),
        ),
        h('div', { className: 'mt-askbody' },
          // 对话面板（占满全宽；.mt-msgs flex:1 → 消息区随对话框高度伸缩）
          h('div', { className: 'mt-askpanel' },
            h('div', { className: 'mt-msgs', ref: scrollRef, onScroll: event => { const el=event.currentTarget; followRef035.current=el.scrollHeight-el.clientHeight-el.scrollTop<48; if(followRef035.current)setUnseen035(false) } },
              messages.length === 0 && !busy
                ? h('div', { className: 'mt-welcome' },
                    h('div', { style: { fontSize: 26 } }, '🤖'),
                    h('div', { style: { fontWeight: 750, marginTop: 6, fontSize: 15 } }, t.welcomeTitle),
                    h('div', { className: 'mt-muted', style: { marginTop: 4 } }, t.welcomeSub),
                    h('div', { style: { marginTop: 12, display: 'flex', flexWrap: 'wrap', justifyContent: 'center' } },
                      presets.map((q) => h('button', { key: q, className: 'q', onClick: () => send(q) }, q)),
                    ),
                  )
                : null,
              messages.map((msg, i) =>
                h(QaMessage035, { role: msg.role, key: i, ts: msg.created_at || msg.ts },
                  msg.role === 'assistant'
                    ? h('div', null,
                        renderCitations(msg.content, [], () => {}),
                        msg.error ? h('div', { className: 'mt-errmsg' }, '⚠️ ', msg.error) : null,
                        (msg.sources || []).length
                          ? h('div', { className: 'mt-msgsrc' },
                              h('span', { className: 'mt-muted' }, t.citations),
                              msg.sources.map((s) =>
                                h('button', { key: s.id || s.index, className: 'mt-linkchip', onClick: async()=>{if(!msg.qaTurnId)return;const turn=msg.qaTurnId,session=activeIdRef.current,scope=msg.queryScope||'all';try{const query='?qaTurnId='+encodeURIComponent(turn)+(scope.startsWith('meeting:')?'&meetingId='+encodeURIComponent(scope.slice(8)):'');const verified=await request('/restricted-sources/'+encodeURIComponent(s.id)+'/resolve'+query);if(activeIdRef.current===session)setSource({...verified,label:verified.title,text:verified.quote})}catch(error){showToast('来源已失效或未能复核：'+error.message,'error')}} },
                                  `${t.quote} ${s.index}: ${s.meeting_title || s.label || s.id}`,
                                ),
                              ),
                            )
                          : msg.sources
                            ? h('div', { className: 'mt-msgsrc' }, h('span', { className: 'mt-muted' }, t.noCitations))
                            : null,
                        h('div', { className: 'mt-row', style: { marginTop: 6 } },
                          h('button', { className: 'mt-btn ghost small', onClick: () => navigator.clipboard.writeText(msg.content).catch(() => {}) }, t.copyAnswer),
                        ),
                      )
                    : [msg.content,
                        Array.isArray(msg.files) && msg.files.length
                          ? h('div', { className: 'mt-row', style: { marginTop: 6, justifyContent: 'flex-end' } },
                              msg.files.map((f, j) => h('span', { key: j, className: 'mt-attach' }, '📄 ', f.name)))
                          : null],
                ),
              ),
              // 流式接收中的 ai 气泡：状态行 / 思考 / 工具调用状态行 / 逐帧文本
              busy && stream
                ? h(QaMessage035, { role: 'assistant', key: 'streaming', ts: stream.startedAt },
                    stream.status ? h('div', { className: 'mt-streamstatus' }, h('span', { className: 'mt-spin', 'aria-hidden': true }), ' ', stream.status) : null,
                    stream.think ? h('div', { className: 'mt-streamthink' }, stream.think) : null,
                    stream.tool ? h('div', { className: 'mt-toolrow' }, '🔧 ', t.toolCalling(stream.tool)) : null,
                    stream.text ? h('div', null, renderCitations(stream.text, [], () => {})) : null,
                  )
                : null,
            ),
            // 附件 chips 区（输入栏上方：文件名 + 大小 + ✕ 移除；上传中显示进度态）
            files.length || uploading
              ? h('div', { className: 'mt-attachrow' },
                  files.map((f) =>
                    h('span', { key: f.key, className: 'mt-attach' + (f.pending ? ' uploading' : ''), title: f.path || f.name },
                      h('span', { className: 'nm' }, '📄 ', f.name),
                      h('span', { className: 'mt-muted' }, fmtBytes(f.size)),
                      f.pending ? h('span', { className: 'mt-spin', 'aria-hidden': true }) : null,
                      h('button', { className: 'rm', title: t.attRemove, 'aria-label': t.attRemove, onClick: () => removeFile(f.key) }, '✕'),
                    ),
                  ),
                  uploading ? h('span', { className: 'mt-muted' }, t.attUploading) : null,
                )
              : null,
            // 底部停靠区（sticky 吸底常驻）：输入框上侧一行 =「➕ 新建会议」提示标签 + 模型选择
            h('div', { className: 'mt-askdock' + (dockH035 !== null ? ' mt-askdock-fixed' : ''), ref: dockRef035, style: dockH035 !== null ? { height: dockH035 + 'px' } : null },
              // kbcAsk-20261005：把手贴卡片上沿，向上拖 = 输入区变高；双击恢复自适应
              h('div', {
                className: 'mt-resizer',
                role: 'separator', tabIndex: 0,
                'aria-valuemin': 120, 'aria-valuemax': 1200,
                'aria-valuenow': dockH035 !== null ? Math.round(dockH035) : undefined,
                'aria-orientation': 'horizontal',
                'aria-label': t.resizeHint,
                title: t.resizeHint,
                onKeyDown: event => {
                  if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
                  event.preventDefault()
                  if (event.key === 'Home') { setDockH035(null); return }
                  const base = dockH035 !== null ? dockH035 : (dockRef035.current ? Math.round(dockRef035.current.getBoundingClientRect().height) : 140)
                  setDockH035(Math.max(120, Math.min(dockMax035(), base + (event.key === 'ArrowUp' ? 40 : -40))))
                },
                onDoubleClick: () => setDockH035(null),
                onMouseDown: (e) => { if (startResizeRef.current) startResizeRef.current(e) },
              }, h('span', { className: 'grip', 'aria-hidden': true })),
              h('div', { className: 'mt-asksub' },
                h('button', { className: 'mt-hintchip new', title: t.newMeeting, onClick: insertMeetingTemplate }, '➕ ', t.newMeeting),
                h('span', { style: { flex: 1 } }),
                h('span', { className: 'mt-kbc-hint' }, t.enterHint),
              ),
                            kbcMention
                ? h('div', { className: 'mt-kbc-menu', role: 'listbox', 'aria-label': '引用会议' },
                    h('div', { className: 'mt-kbc-menuhead' }, '引用会议：选定后检索范围锁定到该会议'),
                    meetings.length
                      ? meetings.slice(0, 20).map((m) => h('button', {
                          key: 'kbc-' + m.id, type: 'button',
                          className: 'mt-kbc-menuitem' + (scope === 'meeting:' + m.id ? ' on' : ''),
                          onClick: () => { setScope('meeting:' + m.id); setKbcMention(false) },
                        }, '@' + (m.title || '未命名会议')))
                      : h('div', { className: 'mt-kbc-menuempty' }, '暂无可引用的会议'),
                    h('button', {
                      type: 'button', className: 'mt-kbc-menuitem' + (scope === 'all' ? ' on' : ''),
                      onClick: () => { setScope('all'); setKbcMention(false) },
                    }, '不限会议（全部资产）'),
                  )
                : null,
h('div', { className: 'mt-inputbar' },
              // 📎 附件按钮（隐藏 file input 多选 + accept 白名单）
              h('button', {
                className: 'mt-clipbtn mt-kbc-icon', disabled: true, title: t.attachTip, 'aria-label': t.attachBtn,
                onClick: () => fileRef.current && fileRef.current.click(),
              }, uploading > 0 ? h('span', { className: 'mt-spin', 'aria-hidden': true }) : '+'),
              h('button', {
                type: 'button', className: 'mt-kbc-icon mt-kbc-at',
                title: '引用会议（限定检索范围）', 'aria-label': '引用会议',
                'aria-expanded': kbcMention ? 'true' : 'false',
                onClick: () => setKbcMention((v) => !v),
              }, '@'),
              h('textarea', {
                ref: inputRef, value: input, disabled: busy, placeholder: t.inputPlaceholder,
                onChange: (e) => setInput(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } },
              }),
              h('span', { className: 'mt-kbc-spacer' }),
              h('span', { className: 'mt-kbc-model' }, renderModelSelector()),
              busy
                ? h('button', { className: 'mt-btn stop', onClick: stopStream }, '■ ', t.stopBtn)
                : h('button', { className: 'mt-btn primary', disabled: !input.trim() || uploading > 0, onClick: () => send(), title: t.sendBtn, 'aria-label': t.sendBtn }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, h('path', { d: 'M12 19V5' }), h('path', { d: 'M5 12l7-7 7 7' }))),
            ),
            ),
            h('input', {
              ref: fileRef, type: 'file', multiple: true, accept: '.pdf,.docx,.xlsx,.txt,.md',
              style: { display: 'none' },
              onChange: (e) => { const fl = e.target.files; const picked = fl ? Array.prototype.slice.call(fl) : []; /* kbcFix-20261005 */ e.target.value = ''; if (picked.length) void handleFiles(picked) },
            }),
          ),
        ),
        source
          ? h(Modal, { title: t.srcTitle, narrow: true, onClose: () => setSource(null) },
              h('div', { className: 'mt-stack' },
                h('div', null, h('div', { className: 'mt-muted' }, t.srcSource), h('strong', null, source.meeting_title || source.label || source.id)),
                source.timestamp ? h('div', null, h('div', { className: 'mt-muted' }, t.srcStamp), h('span', { className: 'mt-chip' }, source.timestamp)) : null,
                h('div', null,
                  h('div', { className: 'mt-muted' }, t.srcText),
                  h('div', { style: { background: 'var(--dsw-alias-state-warn-tertiary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '9px 11px', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12, whiteSpace: 'pre-wrap' } }, source.text || t.none),
                ),
                h('div', { className: 'mt-row', style: { justifyContent: 'flex-end' } },
                  h('button', { className: 'mt-btn primary', onClick: () => setSource(null) }, t.close),
                ),
              ),
            )
          : null,
      )
    }


    /* ---- mtBg-20261005：后台问答续跑（客户端侧） ----
     * main 槽是 keyed 槽：切到别的页面会卸载本组件，busy/messages/stream/activeId 全部丢失。
     * 这里把「活动问答会话 id」落 sessionStorage 并在挂载时回读会话行：
     *   - 行内已有回答 → 直接渲染（多轮上下文继续可用）；
     *   - 该会话服务端仍在生成（GET /qa-sessions/:id 返回 busy）→ 显示「生成中」并轮询，
     *     回合结束后自动铺上完整回答（无需手动刷新或切会话）。
     * 「停止」保持有效：显式停止经 POST /qa-sessions/:id/abort 触达服务端（断流不再等于中止）。
     */
    const QA_ACTIVE_KEY = 'meetai.qa.activeSession.v1'
    const QA_PENDING_KEY = 'meetai.qa.pendingQuestion.v1'

    function AskView({ t, meetings, showToast, seed, refreshMeetings, sessions, refreshSessions, onActiveSession, onNewChat, meetingsKnown }) {
      // 会话列表由 MeetingApp 持有（rail「历史对话」标签下展示），此处只读 + 通过 ref 供 seed.loadSession 查找
      const sessionsRef = useRef([])
      // mtBg-20261005：切页面会卸载本组件 —— 活动会话 id 从 sessionStorage 恢复。
      const [activeId, setActiveId] = useState(() => { try { return window.sessionStorage.getItem(QA_ACTIVE_KEY) || '' } catch { return '' } })
      const [scope, setScope] = useState('all')
      const [messages, setMessages] = useState([])
      const [input, setInput] = useState('')
      const [busy, setBusy] = useState(false)
      // mtBg-20261005：服务端仍有回合在跑（本组件未持有该 SSE 流，例如切页面回来后）→ 「生成中」+ 轮询回读。
      const [bgRun, setBgRun] = useState(false)
      const [bgNote, setBgNote] = useState('')
      const bootQaRef = useRef(activeId) // 挂载时的活动会话 id（sessionStorage 恢复值）
      const bgSeqRef = useRef(0)
      const bgAliveRef = useRef(true)
      const bgTimerRef = useRef(0)
      const [source, setSource] = useState(null)
      // 流式应答态：stream = { text, status, think, tool }（busy 期间渲染接收中的 ai 气泡）
      const [stream, setStream] = useState(null)
      // 附件待发列表（{key,name,size,path?,pending}）；uploading 为在传数量；dragOver 控制拖拽高亮
      const [files, setFiles] = useState([])
      const [uploading, setUploading] = useState(0)
      const [dragOver, setDragOver] = useState(false)
      // @ 引用会议菜单（kbComposer-20261005）：选择后直接复用既有 scope 机制限定检索范围
      const [kbcMention, setKbcMention] = useState(false)
      // 模型目录（GET /models）：state idle|loading|ready|fail；model 为 null = 跟随系统默认
      const [models, setModels] = useState({ state: 'idle', groups: [], def: null })
      const [model, setModel] = useState(null)
      const scrollRef = useRef(null)
      const inputRef = useRef(null)
      const fileRef = useRef(null)
      const seedSeen = useRef(0)
      const fileSeq = useRef(0)
      const dragDepth = useRef(0) // 嵌套 dragenter/leave 计数，避免子元素闪烁
      const abortRef = useRef(null) // 流式请求中止控制器（「■ 停止」按钮）
      const answerRef = useRef('') // 本轮回答的权威累积文本（turn_end 收尾用它，避免 rAF 批次滞后）
      const pendingDelta = useRef('') // rAF 未刷新的 delta 缓冲
      const rafRef = useRef(0)
      const [autoH035, setAutoH035] = useState(520)
      const askWrapRef035 = useRef(null), followRef035 = useRef(true)
      const [unseen035, setUnseen035] = useState(false)
      // kbcAsk-20261005：对话区恒为可用高度；输入卡片高度单独记（null = 随内容自适应）
      const [dockH035, setDockH035] = useState(() => readDockHeight035(window.localStorage))
      const dockRef035 = useRef(null)
      const askH = autoH035
      const askHRef = useRef(askH), resizeRef = useRef(null), startResizeRef = useRef(null)
      const dockMax035 = () => Math.max(160, (askHRef.current || autoH035) - 150)
      const messagesRef = useRef([]), activeIdRef = useRef(''), filesRef = useRef([]), modelRef = useRef(null)
      useEffect(() => { messagesRef.current = messages }, [messages])
      // mtBg-20261005：活动会话 id 持久化（同一标签页内切页面/刷新都保留）。
      useEffect(() => {
        activeIdRef.current = activeId
        try {
          if (activeId) window.sessionStorage.setItem(QA_ACTIVE_KEY, activeId)
          else window.sessionStorage.removeItem(QA_ACTIVE_KEY)
        } catch { /* 隐私模式或禁用 sessionStorage：退化为原行为 */ }
      }, [activeId])

      /* ---- mtBg-20261005：后台回合回读 ----
       * 挂载时回读会话行：busy=false → 直接铺消息；busy=true → 「生成中」并每 2.5s 轮询，
       * 服务端回合结束后自动铺上完整回答。 */
      function stopBgWatch() {
        bgSeqRef.current += 1
        if (bgTimerRef.current) { try { window.clearTimeout(bgTimerRef.current) } catch { /* ignore */ } bgTimerRef.current = 0 }
        if (bgAliveRef.current) setBgRun(false)
      }
      async function readSessionRow(id) {
        const d = await request(`/qa-sessions/${encodeURIComponent(id)}`)
        return { row: d && d.session ? d.session : null, busy: Boolean(d && d.busy) }
      }
      function applyRow(row) {
        const msgs = Array.isArray(row && row.messages) ? row.messages : []
        messagesRef.current = msgs
        setMessages(msgs)
        if (row && row.scope) setScope(row.scope)
      }
      async function watchBackgroundTurn(id) {
        const seq = ++bgSeqRef.current
        const deadline = Date.now() + 12 * 60 * 1000
        let sawBusy = false
        setBgNote('')
        for (;;) {
          if (!bgAliveRef.current || bgSeqRef.current !== seq) return
          let d = null
          try { d = await readSessionRow(id) } catch { d = null }
          if (!bgAliveRef.current || bgSeqRef.current !== seq) return
          if (!d || !d.row) { setBgRun(false); return }
          if (!d.busy) {
            applyRow(d.row)
            setBgRun(false)
            bgTimerRef.current = 0
            // 后台失败（模型报错/超时）不会落库：给出可解释提示，而不是静默只剩提问。
            if (sawBusy && !(Array.isArray(d.row.messages) && d.row.messages.some(m => m && m.role === 'assistant'))) {
              setBgNote('上一回合未完成（服务端未保存），可重新提问。')
            }
            try { window.sessionStorage.removeItem(QA_PENDING_KEY) } catch { /* ignore */ }
            refreshSessions()
            return
          }
          sawBusy = true
          setBgRun(true)
          if (Date.now() > deadline) {
            setBgRun(false)
            bgTimerRef.current = 0
            setBgNote('后台回合超过 12 分钟未结束，已停止轮询；可稍后从「历史对话」重开该会话。')
            return
          }
          await new Promise(r => { bgTimerRef.current = window.setTimeout(r, 2500) })
        }
      }
      // 挂载即恢复：优先用 sessionStorage 的活动会话 id；没有则用「提问后立刻切走」的遗留标记找回会话行
      useEffect(() => {
        bgAliveRef.current = true
        const boot = bootQaRef.current
        let cancelled = false
        ;(async () => {
          if (boot) {
            let d = null
            try { d = await readSessionRow(boot) } catch { d = null }
            if (cancelled || !bgAliveRef.current) return
            if (d && d.row) applyRow(d.row)
            if (d && d.busy) { void watchBackgroundTurn(boot); return }
            try { window.sessionStorage.removeItem(QA_PENDING_KEY) } catch { /* ignore */ }
            return
          }
          let pend = null
          try { pend = JSON.parse(window.sessionStorage.getItem(QA_PENDING_KEY) || 'null') } catch { pend = null }
          const fresh = pend && pend.q && Number.isFinite(pend.at) && Date.now() - pend.at < 20 * 60 * 1000
          if (!fresh) { try { window.sessionStorage.removeItem(QA_PENDING_KEY) } catch { /* ignore */ } return }
          let found = null
          try {
            const data = await request('/qa-sessions')
            const list = Array.isArray(data && data.sessions) ? data.sessions : []
            found = list.find(s => s && s.session_id === pend.id) ||
              list.find(s => s && typeof s.title === 'string' && s.title === pend.q) || null
          } catch { found = null }
          if (cancelled || !bgAliveRef.current || !found) return
          changeActive(found.session_id)
          applyRow(found)
          if (found.busy) void watchBackgroundTurn(found.session_id)
          else { try { window.sessionStorage.removeItem(QA_PENDING_KEY) } catch { /* ignore */ } }
        })()
        return () => { cancelled = true; bgAliveRef.current = false; stopBgWatch() }
      }, [])
      useEffect(() => { filesRef.current = files }, [files])
      useEffect(() => { modelRef.current = model }, [model])
      useEffect(() => { sessionsRef.current = Array.isArray(sessions) ? sessions : [] }, [sessions])
      useEffect(() => { askHRef.current = askH }, [askH])
      useEffect(() => {
        try {
          if (dockH035 === null) window.localStorage.removeItem('meetai.askDockH.v1')
          else window.localStorage.setItem('meetai.askDockH.v1', String(Math.round(dockH035)))
        } catch { /* ignore */ }
      }, [dockH035])
      useEffect(() => {
        const root = askWrapRef035.current; if (!root) return
        const stage = root.closest('.mt-stage'), viewport = window.visualViewport
        const box = root.parentElement
        const measure = () => {
          if (!root.isConnected || !root.getClientRects().length) return
          const top = root.getBoundingClientRect().top
          const viewBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight
          const stageBottom = stage?.getBoundingClientRect().bottom || viewBottom
          // kbcAsk-20261005：真正带底部内边距的滚动容器是 .mt-body（.mt-stage 的 padding 恒为 0）。
          // 原先按 .mt-stage 算 → 面板比容器高 14px、出现滚动条 → 「输入框底边不在底部」。
          const padBottom = box ? parseFloat(window.getComputedStyle(box).paddingBottom) || 0 : 0
          const boxBottom = box ? box.getBoundingClientRect().bottom - padBottom : Infinity
          const avail = qaAvailable035(top, Math.min(viewBottom, stageBottom, boxBottom) - 1, 0)
          setAutoH035(avail)
          setDockH035(prev => (prev === null ? prev : Math.min(prev, Math.max(160, avail - 150))))
        }
        measure(); window.addEventListener('resize', measure); viewport?.addEventListener('resize', measure); viewport?.addEventListener('scroll', measure)
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (stage) observer?.observe(stage); if (root.parentElement) observer?.observe(root.parentElement)
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure); viewport?.removeEventListener('resize', measure); viewport?.removeEventListener('scroll', measure) }
      }, [])
      useEffect(() => {
        const remove = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', end); window.removeEventListener('blur', end) }
        // kbcAsk-20261005：把手在卡片上沿，向上拖 = 变高（下沿固定贴底）
        const move = event => {
          const info = resizeRef.current; if (!info) return
          const next = Math.max(120, Math.min(dockMax035(), Math.round(info.height + (info.y - event.clientY))))
          setDockH035(next)
        }
        const end = () => { resizeRef.current?.root?.removeAttribute('data-mt-resizing'); resizeRef.current=null; remove() }
        startResizeRef.current = event => {
          event.preventDefault(); if (resizeRef.current) return
          const root = event.currentTarget.closest('.mt-app')
          const dock = dockRef035.current
          const rect = dock ? dock.getBoundingClientRect() : null
          resizeRef.current = { y: event.clientY, height: rect && rect.height > 0 ? Math.round(rect.height) : 140, root }
          root?.setAttribute('data-mt-resizing','1')
          window.addEventListener('mousemove', move); window.addEventListener('mouseup', end); window.addEventListener('blur', end)
        }
        return () => { end(); startResizeRef.current = null }
      }, [])
      // kbcAsk-20261005：输入框随内容自适应加高（KB 插件同款：按 scrollHeight 回写内联高度，上限 200px）。
      // 固定高度模式下 textarea 撑满卡片；内容比卡片还高时把卡片一并抬高。
      useEffect(() => {
        const el = inputRef.current; if (!el) return
        if (dockH035 !== null) {
          el.style.height = ''
          const deficit = el.scrollHeight - el.clientHeight
          if (deficit > 1) setDockH035(prev => (prev === null ? prev : Math.min(prev + deficit, dockMax035())))
          return
        }
        el.style.height = 'auto'
        el.style.height = Math.max(52, Math.min(el.scrollHeight, 200)) + 'px'
      }, [input, dockH035])

      // 卸载清理：中止本组件持有的读流与未刷新的 rAF 批处理；同时停掉后台轮询。
      // mtBg-20261005：这里 abort 掉的只是「本组件读流」，服务端回合继续跑完并落库（本次修复的核心）。
      useEffect(() => () => {
        bgAliveRef.current = false
        bgSeqRef.current += 1
        if (bgTimerRef.current) { try { window.clearTimeout(bgTimerRef.current) } catch { /* ignore */ } bgTimerRef.current = 0 }
        try { if (abortRef.current) abortRef.current.abort() } catch { /* ignore */ }
        try { if (rafRef.current && window.cancelAnimationFrame) window.cancelAnimationFrame(rafRef.current) } catch { /* ignore */ }
      }, [])

      // 会话 id 变更统一出口：本地 state + 上报 MeetingApp（rail 高亮当前会话）
      const changeActive = useCallback((id) => {
        setActiveId(id)
        if (onActiveSession) onActiveSession(id)
      }, [onActiveSession])

      // 模型目录：GET /models → optgroup 分组；失败（503 MODEL_UNAVAILABLE 等）→ 选择器降级并提示
      const loadModels = useCallback(async () => {
        setModels((s) => ({ state: 'loading', groups: s.groups || [], def: s.def || null }))
        try {
          const data = await request('/models')
          const groups = (Array.isArray(data.groups) ? data.groups : [])
            .map((g) => ({
              id: String((g && g.id) || ''),
              name: String((g && g.name) || (g && g.id) || ''),
              models: (Array.isArray(g && g.models) ? g.models : [])
                .filter((m) => m && m.id)
                .map((m) => ({ id: String(m.id), name: String(m.name || m.id) })),
            }))
            .filter((g) => g.id && g.models.length)
          const def = data.default && data.default.provider && data.default.model
            ? { provider: String(data.default.provider), model: String(data.default.model) }
            : null
          setModels({ state: 'ready', groups, def })
          // 选中值兜底：当前选择仍在目录内则保留；否则回到「跟随系统默认」
          setModel((cur) => {
            if (!cur) return null
            for (const g of groups) {
              for (const m of g.models) {
                if (g.id === cur.provider && m.id === cur.model) return cur
              }
            }
            return null
          })
        } catch {
          setModels({ state: 'fail', groups: [], def: null })
          setModel(null)
        }
      }, [])
      useEffect(() => { loadModels() }, [loadModels])

      // seed：gotoAsk（scope/question/auto）、「新建对话」（reset）与 rail 历史会话点击（loadSession）共用一个 nonce 通道
      useEffect(() => {
        if (!seed || !seed.nonce || seedSeen.current === seed.nonce) return
        seedSeen.current = seed.nonce
        if (seed.reset) {
          // 全新对话：中止进行中的流式请求并清空全部会话态
          try { if (abortRef.current) abortRef.current.abort() } catch { /* ignore */ }
          answerRef.current = ''
          pendingDelta.current = ''
          changeActive('')
          messagesRef.current = []
          setMessages([])
          setStream(null)
          setInput('')
          setFiles([])
          setSource(null)
          return
        }
        if (seed.loadSession) {
          // rail 历史会话点击：优先用列表自带 messages，缺失则取详情
          const s = sessionsRef.current.find((x) => x.session_id === seed.loadSession) || { session_id: seed.loadSession }
          pickSession(s)
          return
        }
        setScope(seed.scope || 'all')
        if (seed.question) setInput(seed.question)
        if (seed.auto && seed.question) send(seed.question, seed.scope || 'all')
      }, [seed && seed.nonce])

      useEffect(() => {
        const el = scrollRef.current
        if (el && followRef035.current) { el.scrollTop = el.scrollHeight; setUnseen035(false) } else if (el) setUnseen035(true)
      }, [messages, busy, stream])

      useEffect(() => { followRef035.current = true; setUnseen035(false); if(scrollRef.current)scrollRef.current.scrollTop=scrollRef.current.scrollHeight }, [activeId])
      // 打开会话：rail「历史对话」点击（经 seed.loadSession）或列表项触发
      async function pickSession(s) {
        if (busy) return // 流式接收中禁止切换会话
        let msgs = Array.isArray(s.messages) ? s.messages : null
        if (!msgs) {
          try {
            const d = await request(`/qa-sessions/${encodeURIComponent(s.session_id)}`)
            msgs = d.session && Array.isArray(d.session.messages) ? d.session.messages : []
          } catch {
            msgs = []
          }
        }
        changeActive(s.session_id)
        setScope(s.scope || 'all')
        messagesRef.current = Array.isArray(msgs) ? msgs : []
        setMessages(messagesRef.current)
        setStream(null)
      }

      /* —— 附件：📎 选择 / 整区拖拽 → 逐个 POST /upload?name= 落盘 → chips 展示（随 /qa 提交后清空） —— */

      async function uploadOne(file) {
        if (!file) return
        if (!UPLOAD_RE.test(file.name)) return showToast(`${t.attUnsupported}：${file.name}`, 'error')
        if (file.size > UPLOAD_MAX) return showToast(`${t.attTooBig}：${file.name}`, 'error')
        fileSeq.current += 1
        const key = `f${fileSeq.current}`
        setFiles((list) => [...list, { key, name: file.name, size: file.size, pending: true }])
        setUploading((n) => n + 1)
        try {
          const resp = await fetch(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            credentials: 'same-origin',
            body: file,
          })
          let data = null
          try { data = await resp.json() } catch { /* 非 JSON 错误体 */ }
          if (resp.ok && data && data.ok === true && data.file && data.file.path) {
            setFiles((list) => list.map((x) => (x.key === key ? { ...x, pending: false, name: data.file.name || file.name, size: Number(data.file.size) || file.size, path: data.file.path } : x)))
          } else {
            const reason = (data && data.message) || `HTTP ${resp.status}`
            setFiles((list) => list.filter((x) => x.key !== key))
            showToast(`${t.attUploadFail}：${file.name} — ${reason}`, 'error')
          }
        } catch (e) {
          setFiles((list) => list.filter((x) => x.key !== key))
          showToast(`${t.attUploadFail}：${file.name} — ${e.message}`, 'error')
        } finally {
          setUploading((n) => Math.max(0, n - 1))
        }
      }

      // 顺序上传（避免并发写盘与提示闪烁）；fileList 可为 FileList 或数组
      async function handleFiles(fileList) {
        const arr = []
        for (let i = 0; i < ((fileList && fileList.length) || 0); i++) arr.push(fileList[i])
        for (const f of arr) await uploadOne(f)
      }

      function removeFile(key) {
        setFiles((list) => list.filter((f) => f.key !== key))
      }

      // 拖拽上传：只拦截包含文件的拖拽（dataTransfer.types 含 'Files'），文本/富文本拖放保持默认行为
      const hasFilesInDT = (e) => {
        const dt = e && e.dataTransfer
        if (!dt || !dt.types) return false
        try { return Array.prototype.indexOf.call(dt.types, 'Files') !== -1 } catch { return false }
      }
      const onDragEnter = (e) => {
        if (!hasFilesInDT(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }
      const onDragOver = (e) => {
        if (!hasFilesInDT(e)) return
        e.preventDefault()
        try { e.dataTransfer.dropEffect = 'copy' } catch { /* ignore */ }
      }
      const onDragLeave = (e) => {
        if (!hasFilesInDT(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }
      // kbComposer-20261005：拖拽支持文件夹 —— 用 webkitGetAsEntry 递归收集，readEntries 必须循环取到空。
      // 取不到条目（非 Chromium / 权限受限）时回退 dataTransfer.files，行为与改前一致。
      async function kbcCollectEntry(entry, out) {
        if (!entry) return
        if (entry.isFile) {
          await new Promise((resolve) => {
            try { entry.file((f) => { if (f) out.push(f); resolve() }, () => resolve()) } catch { resolve() }
          })
          return
        }
        if (!entry.isDirectory) return
        const reader = entry.createReader()
        for (;;) {
          const batch = await new Promise((resolve) => {
            try { reader.readEntries((rows) => resolve(Array.prototype.slice.call(rows || [])), () => resolve([])) } catch { resolve([]) }
          })
          if (!batch.length) return
          for (const kid of batch) await kbcCollectEntry(kid, out)
        }
      }
      const onDrop = (e) => {
        if (!hasFilesInDT(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        const dt = e.dataTransfer
        const entries = []
        if (dt && dt.items) {
          const items = Array.prototype.slice.call(dt.items)
          for (const item of items) {
            try { const entry = item.webkitGetAsEntry && item.webkitGetAsEntry(); if (entry) entries.push(entry) } catch { /* ignore */ }
          }
        }
        if (!entries.length) {
          const fl = dt ? dt.files : null
          if (fl && fl.length) void handleFiles(fl)
          return
        }
        // 注意：items 在 await 之后失效，条目必须同步取完再异步递归
        void (async () => {
          const out = []
          for (const entry of entries) await kbcCollectEntry(entry, out)
          if (out.length) await handleFiles(out)
          else showToast('没有可用文件（文件夹为空或类型不支持）。', 'warn')
        })()
      }

      // delta 增量 rAF 批量刷新：先入缓冲，每帧一次性并入气泡文本，降低 setState 频率
      function pushDelta(chunk) {
        pendingDelta.current += chunk
        if (rafRef.current) return
        rafRef.current = window.requestAnimationFrame
          ? window.requestAnimationFrame(flushDelta)
          : window.setTimeout(flushDelta, 16)
      }
      function flushDelta() {
        rafRef.current = 0
        if (!pendingDelta.current) return
        const chunk = pendingDelta.current
        pendingDelta.current = ''
        setStream((s) => (s ? { ...s, text: s.text + chunk } : s))
      }

      /* —— 单一对话框：POST /qa（响应即 SSE）—— status 帧 setSessionId；delta 逐帧追加（rAF 批量）；
       * tool 帧在气泡内显示「🔧 正在调用工具：{name}…」状态行；turn_end 完成（刷新会话列表 +
       * refreshMeetings 日程/统计）；error 帧或网络错误在气泡内显示错误并 toast；
       * busy 时输入框禁用、「发送」变「■ 停止」（AbortController abort）。 —— */

      async function send(questionText, scopeOverride) {
        if (busy || bgRun) return // mtBg-20261005：后台回合在跑时不允许并发提问（服务端会 409）
        const question = String(questionText !== undefined ? questionText : input || '').trim()
        if (!question) return
        stopBgWatch() // mtBg-20261005：新提问接管，旧的后台轮询立即失效（后台回合中 send 已被 busy||bgRun 拦住）
        setBgNote('')
        const useScope = scopeOverride || scope
        const attach = filesRef.current.filter((f) => !f.pending).map((f) => ({ name: f.name, path: f.path }))
        const userMsg = { role: 'user', content: question, created_at: new Date().toISOString() }
        const nextMessages = [...messagesRef.current, userMsg]
        messagesRef.current = nextMessages
        setMessages(nextMessages)
        setInput('')
        answerRef.current = ''
        pendingDelta.current = ''
        setStream({ text: '', status: t.thinking, think: '', tool: '', startedAt: Date.now() })
        setBusy(true)
        // mtBg-20261005：记录「已提问」标记（q = 服务端会话行标题前缀）。万一在收到 status 帧
        // （拿到会话 id）之前就切走，回到页面还能靠它在会话列表里找回该行并接管轮询。
        try { window.sessionStorage.setItem(QA_PENDING_KEY, JSON.stringify({ id: activeIdRef.current || '', q: question.slice(0, 40), at: Date.now() })) } catch { /* ignore */ }
        const body = { question, scope: useScope, files: attach }
        if (activeIdRef.current) body.sessionId = activeIdRef.current
        const cur = modelRef.current
        if (cur && cur.provider && cur.model) {
          body.provider = cur.provider
          body.model = cur.model
        }
        const ctrl = new AbortController()
        abortRef.current = ctrl
        let errText = ''
        let completed = false // only the server's persisted turn_end confirms completion
        try {
          const resp = await fetch(API + '/qa', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
            signal: ctrl.signal,
          })
          // 前置错误（非 200，JSON {ok:false,code,message}）→ 直接抛出展示 message
          if (!resp.ok || !resp.body) {
            let reason = `HTTP ${resp.status}`
            try {
              const d = await resp.json()
              if (d && d.message) reason = d.message
            } catch { /* 非 JSON 错误体 */ }
            throw new Error(reason)
          }
          setFiles([]) // 附件已随本次提问提交，清空附件区
          // SSE 帧读取：按 \n\n 切帧 + data: 解析，':' 注释/心跳帧跳过
          const reader = resp.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          let closed = false
          for (;;) {
            const r = await reader.read()
            if (r.done) break
            buf += dec.decode(r.value, { stream: true })
            let idx
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const raw = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              for (const line of raw.split('\n')) {
                if (line.charCodeAt(0) === 58 /* ':' */) continue // SSE 注释/心跳帧
                if (!line.startsWith('data:')) continue
                let ev = null
                try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
                if (!ev || typeof ev !== 'object') continue
                if (ev.type === 'status') {
                  if (ev.sessionId) changeActive(ev.sessionId)
                  if (typeof ev.text === 'string' && ev.text) setStream((s) => (s ? { ...s, status: ev.text } : s))
                } else if (ev.type === 'thinking' && typeof ev.text === 'string') {
                  setStream((s) => (s ? { ...s, status: '', think: (s.think ? `${s.think}\n` : '') + ev.text } : s))
                } else if (ev.type === 'delta' && typeof ev.text === 'string') {
                  answerRef.current += ev.text
                  pushDelta(ev.text)
                } else if (ev.type === 'tool' && ev.name) {
                  setStream((s) => (s ? { ...s, tool: String(ev.name) } : s))
                } else if (ev.type === 'turn_end') {
                  // 服务端已把本轮消息落盘；客户端收尾后刷新会话列表与日程/统计
                  completed = true
                  if (ev.sessionId) changeActive(ev.sessionId)
                  closed = true
                  break
                } else if (ev.type === 'error') {
                  errText = String(ev.message || t.askFailed)
                  closed = true
                  break
                }
              }
              if (closed) break
            }
            if (closed) break
          }
          try { reader.cancel() } catch { /* 流已结束 */ }
        } catch (e) {
          if (!(e && e.name === 'AbortError')) errText = String((e && e.message) || e)
        } finally {
          abortRef.current = null
          if (rafRef.current && window.cancelAnimationFrame) {
            try { window.cancelAnimationFrame(rafRef.current) } catch { /* ignore */ }
          }
          rafRef.current = 0
          pendingDelta.current = ''
          // Only turn_end confirms a persisted turn. Keep partial text on error/stop/EOF, never silently call it saved.
          if (!completed) {
            const reason = errText || (ctrl.signal.aborted ? '已停止接收' : '连接已结束，但未收到完成确认')
            errText = `${reason}；本回合未保存（未收到服务端完成确认）。`
          }
          const text = answerRef.current
          let extra = null
          if (errText) extra = { role: 'assistant', content: text, error: errText, created_at: new Date().toISOString() }
          else if (text.trim()) extra = { role: 'assistant', content: text, created_at: new Date().toISOString() }
          if (extra) {
            const finalMessages = [...messagesRef.current, extra]
            messagesRef.current = finalMessages
            setMessages(finalMessages)
          }
          setStream(null)
          setBusy(false)
          // mtBg-20261005：组件已卸载（用户切页面）时不再做 UI 副作用，也不清 pendingQuestion 标记 ——
          // 服务端会继续跑完并落库，由挂载时的回读/轮询接管；否则会在别的页面弹出「问答失败」。
          if (bgAliveRef.current) {
            try { window.sessionStorage.removeItem(QA_PENDING_KEY) } catch { /* ignore */ }
            refreshSessions()
            if (completed && !errText && typeof refreshMeetings === 'function') {
              try { refreshMeetings() } catch { /* ignore */ }
            }
          }
        }
        if (errText && bgAliveRef.current) showToast(`${t.askFailed}: ${errText}`, 'error')
      }

      function stopStream() {
        // mtBg-20261005：「停止」必须仍然真的停下服务端回合 —— 断流本身已不再中止回合，
        // 因此补一条显式通道 POST /qa-sessions/:id/abort（best-effort；失败不阻塞本地中止）。
        // 覆盖两种情形：本组件正在读流（busy）与切页面回来后接管的后台回合（bgRun）。
        const id = activeIdRef.current
        if (id) { try { request(`/qa-sessions/${encodeURIComponent(id)}/abort`, { method: 'POST' }).catch(() => {}) } catch { /* ignore */ } }
        try { if (abortRef.current) abortRef.current.abort() } catch { /* ignore */ }
      }

      // 「➕ 新建会议」提示 chip：向输入框插入模板并聚焦（用户补全后发送，服务端建会 → turn_end 后 refreshMeetings 同步日程）
      function insertMeetingTemplate() {
        setInput((cur) => (cur && cur.trim() ? `${cur.replace(/\s*$/, '')}\n\n${MEETING_TEMPLATE}` : MEETING_TEMPLATE))
        try { if (inputRef.current) inputRef.current.focus() } catch { /* ignore */ }
      }

      const presets = useMemo(() => {
        const tomorrow = new Date(Date.now() + 86400000)
        const tomorrowList = meetings.filter((m) => {
          const s = new Date(m.start_time || '')
          return Number.isFinite(s.getTime()) && sameDay(s, tomorrow)
        })
        const archived = meetings.find((m) => m.minutes_status === 'archived')
        return [
          '💡 各场会议有哪些待跟进任务与责任人？',
          tomorrowList.length ? `📅 明天（${fmtDay(tomorrowList[0].start_time)}）有哪些待参加的重点会议？` : '📅 本周还有哪些待开始的重点会议？',
          archived ? `📊 总结《${archived.title}》纪要中的关键决议与预算分配？` : '📊 总结最近会议纪要中的关键决议与预算分配？',
        ]
      }, [meetings])

      const scopeOptions = [
        { value: 'all', label: t.scopeAll(meetings.length) },
        { value: 'docs', label: t.scopeDocs },
        ...meetings.map((m) => ({ value: `meeting:${m.id}`, label: t.scopeMeeting + m.title })),
      ]

      const modelValue = model ? `${model.provider}||${model.model}` : ''

      // 模型选择器：ready → optgroup 分组（首项「跟随系统默认」value=''，default 项 label 加后缀）；
      // fail → 禁用只显示「模型列表不可用」并提供重试；loading → 禁用显示加载中
      function renderModelSelector() {
        if (models.state === 'ready') {
          return h('select', {
            className: 'mt-select', value: modelValue, disabled: busy,
            title: t.modelLabel, 'aria-label': t.modelLabel,
            style: { maxWidth: 210 },
            onChange: (e) => {
              const v = String(e.target.value || '')
              const sep = v.indexOf('||')
              if (!v || sep < 0) { setModel(null); return }
              setModel({ provider: v.slice(0, sep), model: v.slice(sep + 2) })
            },
          },
            h('option', { value: '' }, t.modelDefaultOption),
            models.groups.map((g) => h('optgroup', { key: g.id, label: g.name },
              g.models.map((m) => {
                const val = `${g.id}||${m.id}`
                const isDef = models.def && models.def.provider === g.id && models.def.model === m.id
                return h('option', { key: val, value: val, label: m.name }, m.name + (isDef ? t.modelDefaultSuffix : ''))
              }),
            )),
          )
        }
        if (models.state === 'fail') {
          return [
            h('select', { key: 'mf', className: 'mt-select', disabled: true, title: t.modelFail, 'aria-label': t.modelLabel }, h('option', null, t.modelFail)),
            h('button', { key: 'mr', className: 'mt-btn ghost small', title: t.modelRetry, onClick: loadModels }, '⟳ ', t.modelRetry),
          ]
        }
        return h('select', { className: 'mt-select', disabled: true, title: t.modelLoading, 'aria-label': t.modelLabel }, h('option', null, t.modelLoading))
      }

      return h('div', {
        className: 'mt-askwrap',
        ref: askWrapRef035,
        style: { height: askH, '--mt-qa-available': autoH035 + 'px' },
        onDragEnter,
        onDragOver,
        onDragLeave,
        onDrop,
      },
        dragOver ? h('div', { className: 'mt-dropoverlay', 'aria-hidden': true }, t.dropHint) : null,
        unseen035 ? h('button', { className:'mt-btn small', onClick:()=>{followRef035.current=true;setUnseen035(false);if(scrollRef.current)scrollRef.current.scrollTop=scrollRef.current.scrollHeight} }, '回到底部') : null,
        // 顶部工具栏：左上角 = 检索范围（全量会议资产 / 仅文档 / 指定会议）
        h('details',{className:'mt-card'},h('summary',null,'新增：本地受限会议问答（原问答功能保留）'),h(RestrictedAskView,{t,meetings,showToast,seed:null,refreshMeetings,sessions:[],refreshSessions,onActiveSession:()=>{},onNewChat:()=>{},meetingsKnown})),
        h('div', { className: 'mt-asktop' },
          h('select', { className: 'mt-select', value: scope, disabled: busy, 'aria-label': t.askTitle, onChange: (e) => setScope(e.target.value) },
            scopeOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
          ),
          h('span', { className: 'mt-muted mt-grow' }, '基于所选会议资产范围回答，不限正式归档。', scope === 'docs' ? ' 当前范围：会议材料。' : ' 范围内会议：' + (meetingsKnown ? scope === 'all' ? meetings.length : meetings.filter(item => 'meeting:' + item.id === scope).length : '未知') + '。'),
          h('button', { className: 'mt-btn small', disabled: busy, onClick: () => { onNewChat(); showToast('已开始新会话，原历史记录保留。', 'info') } }, '清空 / 新会话'),
        ),
        h('div', { className: 'mt-askbody' },
          // 对话面板（占满全宽；.mt-msgs flex:1 → 消息区随对话框高度伸缩）
          h('div', { className: 'mt-askpanel' },
            h('div', { className: 'mt-msgs', ref: scrollRef, onScroll: event => { const el=event.currentTarget; followRef035.current=el.scrollHeight-el.clientHeight-el.scrollTop<48; if(followRef035.current)setUnseen035(false) } },
              messages.length === 0 && !busy && !bgRun
                ? h('div', { className: 'mt-welcome' },
                    h('div', { style: { fontSize: 26 } }, '🤖'),
                    h('div', { style: { fontWeight: 750, marginTop: 6, fontSize: 15 } }, t.welcomeTitle),
                    h('div', { className: 'mt-muted', style: { marginTop: 4 } }, t.welcomeSub),
                    h('div', { style: { marginTop: 12, display: 'flex', flexWrap: 'wrap', justifyContent: 'center' } },
                      presets.map((q) => h('button', { key: q, className: 'q', onClick: () => send(q) }, q)),
                    ),
                  )
                : null,
              messages.map((msg, i) =>
                h(QaMessage035, { role: msg.role, key: i, ts: msg.created_at || msg.ts },
                  msg.role === 'assistant'
                    ? h('div', null,
                        renderCitations(msg.content, msg.sources, setSource),
                        msg.error ? h('div', { className: 'mt-errmsg' }, '⚠️ ', msg.error) : null,
                        (msg.sources || []).length
                          ? h('div', { className: 'mt-msgsrc' },
                              h('span', { className: 'mt-muted' }, t.citations),
                              msg.sources.map((s) =>
                                h('button', { key: s.id || s.index, className: 'mt-linkchip', onClick: () => setSource(s) },
                                  `${t.quote} ${s.index}: ${s.meeting_title || s.label || s.id}`,
                                ),
                              ),
                            )
                          : msg.sources
                            ? h('div', { className: 'mt-msgsrc' }, h('span', { className: 'mt-muted' }, t.noCitations))
                            : null,
                        h('div', { className: 'mt-row', style: { marginTop: 6 } },
                          h('button', { className: 'mt-btn ghost small', onClick: () => navigator.clipboard.writeText(msg.content).catch(() => {}) }, t.copyAnswer),
                        ),
                      )
                    : [msg.content,
                        Array.isArray(msg.files) && msg.files.length
                          ? h('div', { className: 'mt-row', style: { marginTop: 6, justifyContent: 'flex-end' } },
                              msg.files.map((f, j) => h('span', { key: j, className: 'mt-attach' }, '📄 ', f.name)))
                          : null],
                ),
              ),
              // 流式接收中的 ai 气泡：状态行 / 思考 / 工具调用状态行 / 逐帧文本
              busy && stream
                ? h(QaMessage035, { role: 'assistant', key: 'streaming', ts: stream.startedAt },
                    stream.status ? h('div', { className: 'mt-streamstatus' }, h('span', { className: 'mt-spin', 'aria-hidden': true }), ' ', stream.status) : null,
                    stream.think ? h('div', { className: 'mt-streamthink' }, stream.think) : null,
                    stream.tool ? h('div', { className: 'mt-toolrow' }, '🔧 ', t.toolCalling(stream.tool)) : null,
                    stream.text ? h('div', null, renderCitations(stream.text, [], () => {})) : null,
                  )
                : null,
              // mtBg-20261005：切回页面时该会话仍在服务端生成 → 「生成中」占位（轮询到完成后自动替换为真回答）
              bgRun
                ? h(QaMessage035, { role: 'assistant', key: 'bg-running' },
                    h('div', { className: 'mt-streamstatus' }, h('span', { className: 'mt-spin', 'aria-hidden': true }), ' ', '生成中…（已切到后台运行，完成后自动显示）'),
                  )
                : (bgNote ? h(QaMessage035, { role: 'assistant', key: 'bg-note' }, h('div', { className: 'mt-errmsg' }, '⚠️ ', bgNote)) : null),
            ),
            // 附件 chips 区（输入栏上方：文件名 + 大小 + ✕ 移除；上传中显示进度态）
            files.length || uploading
              ? h('div', { className: 'mt-attachrow' },
                  files.map((f) =>
                    h('span', { key: f.key, className: 'mt-attach' + (f.pending ? ' uploading' : ''), title: f.path || f.name },
                      h('span', { className: 'nm' }, '📄 ', f.name),
                      h('span', { className: 'mt-muted' }, fmtBytes(f.size)),
                      f.pending ? h('span', { className: 'mt-spin', 'aria-hidden': true }) : null,
                      h('button', { className: 'rm', title: t.attRemove, 'aria-label': t.attRemove, onClick: () => removeFile(f.key) }, '✕'),
                    ),
                  ),
                  uploading ? h('span', { className: 'mt-muted' }, t.attUploading) : null,
                )
              : null,
            // 底部停靠区（sticky 吸底常驻）：输入框上侧一行 =「➕ 新建会议」提示标签 + 模型选择
            h('div', { className: 'mt-askdock' + (dockH035 !== null ? ' mt-askdock-fixed' : ''), ref: dockRef035, style: dockH035 !== null ? { height: dockH035 + 'px' } : null },
              // kbcAsk-20261005：把手贴卡片上沿，向上拖 = 输入区变高；双击恢复自适应
              h('div', {
                className: 'mt-resizer',
                role: 'separator', tabIndex: 0,
                'aria-valuemin': 120, 'aria-valuemax': 1200,
                'aria-valuenow': dockH035 !== null ? Math.round(dockH035) : undefined,
                'aria-orientation': 'horizontal',
                'aria-label': t.resizeHint,
                title: t.resizeHint,
                onKeyDown: event => {
                  if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
                  event.preventDefault()
                  if (event.key === 'Home') { setDockH035(null); return }
                  const base = dockH035 !== null ? dockH035 : (dockRef035.current ? Math.round(dockRef035.current.getBoundingClientRect().height) : 140)
                  setDockH035(Math.max(120, Math.min(dockMax035(), base + (event.key === 'ArrowUp' ? 40 : -40))))
                },
                onDoubleClick: () => setDockH035(null),
                onMouseDown: (e) => { if (startResizeRef.current) startResizeRef.current(e) },
              }, h('span', { className: 'grip', 'aria-hidden': true })),
              h('div', { className: 'mt-asksub' },
                h('button', { className: 'mt-hintchip new', title: t.newMeeting, onClick: insertMeetingTemplate }, '➕ ', t.newMeeting),
                h('span', { style: { flex: 1 } }),
                h('span', { className: 'mt-kbc-hint' }, t.enterHint),
              ),
                            kbcMention
                ? h('div', { className: 'mt-kbc-menu', role: 'listbox', 'aria-label': '引用会议' },
                    h('div', { className: 'mt-kbc-menuhead' }, '引用会议：选定后检索范围锁定到该会议'),
                    meetings.length
                      ? meetings.slice(0, 20).map((m) => h('button', {
                          key: 'kbc-' + m.id, type: 'button',
                          className: 'mt-kbc-menuitem' + (scope === 'meeting:' + m.id ? ' on' : ''),
                          onClick: () => { setScope('meeting:' + m.id); setKbcMention(false) },
                        }, '@' + (m.title || '未命名会议')))
                      : h('div', { className: 'mt-kbc-menuempty' }, '暂无可引用的会议'),
                    h('button', {
                      type: 'button', className: 'mt-kbc-menuitem' + (scope === 'all' ? ' on' : ''),
                      onClick: () => { setScope('all'); setKbcMention(false) },
                    }, '不限会议（全部资产）'),
                  )
                : null,
h('div', { className: 'mt-inputbar' },
              // 📎 附件按钮（隐藏 file input 多选 + accept 白名单）
              h('button', {
                className: 'mt-clipbtn mt-kbc-icon', disabled: uploading > 0, title: t.attachTip, 'aria-label': t.attachBtn,
                onClick: () => fileRef.current && fileRef.current.click(),
              }, uploading > 0 ? h('span', { className: 'mt-spin', 'aria-hidden': true }) : '+'),
              h('button', {
                type: 'button', className: 'mt-kbc-icon mt-kbc-at',
                title: '引用会议（限定检索范围）', 'aria-label': '引用会议',
                'aria-expanded': kbcMention ? 'true' : 'false',
                onClick: () => setKbcMention((v) => !v),
              }, '@'),
              h('textarea', {
                ref: inputRef, value: input, disabled: busy || bgRun, placeholder: t.inputPlaceholder,
                onChange: (e) => setInput(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } },
              }),
              h('span', { className: 'mt-kbc-spacer' }),
              h('span', { className: 'mt-kbc-model' }, renderModelSelector()),
              busy || bgRun
                ? h('button', { className: 'mt-btn stop', onClick: stopStream }, '■ ', t.stopBtn)
                : h('button', { className: 'mt-btn primary', disabled: !input.trim() || uploading > 0, onClick: () => send(), title: t.sendBtn, 'aria-label': t.sendBtn }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, h('path', { d: 'M12 19V5' }), h('path', { d: 'M5 12l7-7 7 7' }))),
            ),
            ),
            h('input', {
              ref: fileRef, type: 'file', multiple: true, accept: '.pdf,.docx,.xlsx,.txt,.md',
              style: { display: 'none' },
              onChange: (e) => { const fl = e.target.files; const picked = fl ? Array.prototype.slice.call(fl) : []; /* kbcFix-20261005 */ e.target.value = ''; if (picked.length) void handleFiles(picked) },
            }),
          ),
        ),
        source
          ? h(Modal, { title: t.srcTitle, narrow: true, onClose: () => setSource(null) },
              h('div', { className: 'mt-stack' },
                h('div', null, h('div', { className: 'mt-muted' }, t.srcSource), h('strong', null, source.meeting_title || source.label || source.id)),
                source.timestamp ? h('div', null, h('div', { className: 'mt-muted' }, t.srcStamp), h('span', { className: 'mt-chip' }, source.timestamp)) : null,
                h('div', null,
                  h('div', { className: 'mt-muted' }, t.srcText),
                  h('div', { style: { background: 'var(--dsw-alias-state-warn-tertiary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '9px 11px', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12, whiteSpace: 'pre-wrap' } }, source.text || t.none),
                ),
                h('div', { className: 'mt-row', style: { justifyContent: 'flex-end' } },
                  h('button', { className: 'mt-btn primary', onClick: () => setSource(null) }, t.close),
                ),
              ),
            )
          : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /* 应用主体：插件自有导航 rail + 正文（DSH 左侧导航始终保持不变）          */
    /* ---------------------------------------------------------------- */

    function MeetingApp({ ctx }) {
      const [lang, setLang] = useState(() => (ctx.get('locale') && ctx.get('locale').getLocale && ctx.get('locale').getLocale() && ctx.get('locale').getLocale().id === 'en' ? 'en' : 'zh'))
      const t = dict[lang] || dict.zh
      const [tab, setTab] = useState('schedule')
      const [meetings, setMeetings] = useState([])
      const [loading, setLoading] = useState(true)
      const [toasts, setToasts] = useState([])
      const [detail, setDetail] = useState(null)
      const [minutesSeed, setMinutesSeed] = useState(null)
      const [askSeed, setAskSeed] = useState(null)
      // Compact meeting-owned rail; never mutate the DSH global sidebar.
      const [railExpanded, setRailExpanded] = useState(false)
      const compactRail = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width:900px)').matches
      useEffect(() => {
        if (!railExpanded) return undefined
        const escape = event => { if (event.key === 'Escape') setRailExpanded(false) }
        window.addEventListener('keydown', escape)
        return () => window.removeEventListener('keydown', escape)
      }, [railExpanded])
      // 左滑关闭抽屉（mtNavDrawer-20261005）：横向位移 ≥60px 才关，纵向滑动交还抽屉内滚动
      const mtSwipe = useRef({ active: false, x: 0, y: 0, dx: 0, decided: false, moved: false })
      const mtSwipeDown = event => {
        if (!compactRail || !railExpanded) return
        const s = mtSwipe.current
        s.active = true; s.x = event.clientX; s.y = event.clientY; s.dx = 0; s.decided = false; s.moved = false
      }
      const mtSwipeMove = event => {
        const s = mtSwipe.current
        if (!s.active) return
        const mx = event.clientX - s.x, my = event.clientY - s.y
        if (!s.decided) {
          if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
          s.decided = true
          if (Math.abs(my) > Math.abs(mx)) { s.active = false; return }
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch (err) {}
        }
        s.dx = Math.min(0, mx); s.moved = true
        event.currentTarget.style.transition = 'none'
        event.currentTarget.style.transform = 'translateX(' + s.dx + 'px)'
      }
      const mtSwipeEnd = event => {
        const s = mtSwipe.current
        if (!s.active) return
        s.active = false
        const el = event.currentTarget, dx = s.dx, moved = s.moved
        s.dx = 0; s.moved = false
        if (el && el.style) el.style.transition = ''
        if (moved && dx <= -60) setRailExpanded(false)
        const node = el
        window.requestAnimationFrame(() => { if (node && node.style) node.style.transform = '' })
      }
      // Existing MeetingApp QA session state remains authoritative for the nested rail.
      const [qaSessions, setQaSessions] = useState([])
      const [qaSessionsState, setQaSessionsState] = useState('loading')
      const [qaActiveId, setQaActiveId] = useState('')
      /* mtHist-20261019：历史对话「更多操作」（置顶/重命名/归档/删除）+ 归档视图开关。 */
      const [qaSessionMenu, setQaSessionMenu] = useState(null) // { session, anchor }
      const [qaRenaming, setQaRenaming] = useState(null) // { id, value } 行内重命名
      const [qaShowArchived, setQaShowArchived] = useState(false) // 历史区：false=历史对话 / true=归档对话
      const qaMenuRef = useRef(null)
      const [docCount, setDocCount] = useState(null) // 实际已挂载文档数，失败未知
      const [health, setHealth] = useState(null)
      const [meetingState, setMeetingState] = useState('loading')
      const refreshHealth = useCallback(async () => {
        try { setHealth(await request('/health')) }
        catch { setHealth({ error: true }) }
      }, [])
      useEffect(() => { refreshHealth() }, [refreshHealth])
      const toastSeq = useRef(0)
      const navigationSeqRef = useRef(0)
      const minutesGuardRef = useRef(null)
      const tabRef = useRef(tab); tabRef.current = tab
      const registerMinutesGuard = useCallback(guard => { minutesGuardRef.current = guard }, [])
      const navigate = useCallback(async target => {
        const guard = minutesGuardRef.current
        if (tabRef.current === 'minutes' && target !== 'minutes' && guard) {
          if (guard.recording) {
            if (!window.confirm('离开前停止并封存完整录音？录音会保留在本模块。')) return false
            if (!await guard.seal()) return false
          } else if ((guard.busy || guard.dirty || guard.hasBlob) && !window.confirm('切页后本模块继续保留当前录音、草稿和处理任务；刷新页面仍会丢失未下载音频。继续？')) return false
        }
        setTab(target)
        if (target !== 'ask') setRailExpanded(false)
        return true
      }, [])

      const showToast = useCallback((message, type) => {
        const id = ++toastSeq.current
        setToasts((list) => [...list, { id, message, type: type || 'info' }])
        window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 3200)
      }, [])

      useEffect(() => {
        const locale = ctx.get('locale')
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => {
          const cur = locale.getLocale && locale.getLocale()
          setLang(cur && cur.id === 'en' ? 'en' : 'zh')
        })
      }, [ctx])

      const refreshMeetings = useCallback(async () => {
        setLoading(true); setMeetingState('loading')
        try {
          const data = await request('/meetings')
          setMeetings(data.meetings || []); setMeetingState('ready')
        } catch (e) {
          setMeetingState('error')
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setLoading(false)
        }
      }, [t.requestFailed, showToast])
      useEffect(() => { refreshMeetings() }, [refreshMeetings])

      // 问答会话列表：GET /qa-sessions → rail「历史对话」标签下渲染；AskView turn_end 后经 props 刷新
      const refreshQaSessions = useCallback(async () => {
        try {
          const data = await request('/qa-sessions')
          setQaSessions(data.sessions || []); setQaSessionsState('ready')
        } catch {
          setQaSessionsState('error')
        }
      }, [])
      useEffect(() => { refreshQaSessions() }, [refreshQaSessions])

      // rail 历史会话点击：载入该会话（seed.loadSession → AskView pickSession）
      const openQaSession = useCallback(async (s) => {
        if (!await navigate('ask')) return false
        setAskSeed({ loadSession: s.session_id, nonce: ++navigationSeqRef.current })
        return true
      }, [navigate])

      // rail 历史会话删除：DELETE 后刷新列表；删的是当前会话则重置回全新对话
      const removeQaSession = useCallback(async (id) => {
        try {
          await request(`/qa-sessions/${encodeURIComponent(id)}`, del())
          setQaSessions((list) => list.filter((x) => x.session_id !== id))
          if (qaActiveId === id) {
            setQaActiveId('')
            setAskSeed({ reset: true, nonce: ++navigationSeqRef.current })
          }
          showToast(t.deleteSessionFirst, 'info')
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        }
      }, [qaActiveId, t.deleteSessionFirst, t.requestFailed, showToast])

      /* ================= mtHist-20261019：历史对话「更多操作」 =================
         与知识库插件（dsh-raganything-kb）历史对话一致：置顶 / 重命名 / 归档 / 删除。
         服务端真源为 PUT /qa-sessions/:id；本地列表按「置顶优先 + 更新时间倒序」重排。 */
      const sortQaSessions = useCallback((list) => [...list].sort((a, b) =>
        (Number(b.pinned === true) - Number(a.pinned === true))
        || String(b.updated_at || '').localeCompare(String(a.updated_at || ''))), [])

      const qaMenuStyle = useCallback((anchor) => {
        const width = 156, height = 4 * 34 + 12
        let left = 12, top = 120
        try {
          if (anchor && typeof anchor.getBoundingClientRect === 'function') {
            const r = anchor.getBoundingClientRect()
            const vw = window.innerWidth || 1024
            const vh = window.innerHeight || 768
            left = Math.max(8, Math.min(r.left, vw - width - 8))
            top = r.bottom + 6
            if (top + height > vh - 8) top = Math.max(8, r.top - height - 6)
          }
        } catch { /* 退化到默认坐标 */ }
        return { position: 'fixed', left, top, width, zIndex: 80 }
      }, [])

      /* 菜单外点击 / Esc / 滚动即关闭（fixed 定位菜单不随容器裁剪，行为与知识库一致） */
      useEffect(() => {
        if (!qaSessionMenu) return undefined
        const close = (ev) => {
          if (qaMenuRef.current && ev.target && qaMenuRef.current.contains(ev.target)) return
          setQaSessionMenu(null)
        }
        const onKey = (ev) => { if (!ev || ev.key === 'Escape') setQaSessionMenu(null) }
        document.addEventListener('mousedown', close, true)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onKey)
        window.addEventListener('scroll', onKey, true)
        return () => {
          document.removeEventListener('mousedown', close, true)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onKey)
          window.removeEventListener('scroll', onKey, true)
        }
      }, [qaSessionMenu])

      /* 只更新元数据（title/pinned/archived），消息体不动；服务端失败则不改本地。 */
      const patchQaSession = useCallback(async (id, body) => {
        const data = await request(`/qa-sessions/${encodeURIComponent(id)}`, put(body))
        return data && data.session ? data.session : null
      }, [])

      const toggleQaPin = useCallback(async (session) => {
        setQaSessionMenu(null)
        const next = !(session.pinned === true)
        try {
          await patchQaSession(session.session_id, { pinned: next })
          setQaSessions((list) => sortQaSessions(list.map((x) =>
            x.session_id === session.session_id ? { ...x, pinned: next, updated_at: new Date().toISOString() } : x)))
          showToast(next ? t.pinOk : t.unpinOk, 'success')
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        }
      }, [patchQaSession, sortQaSessions, showToast, t.pinOk, t.requestFailed, t.unpinOk])

      const toggleQaArchive = useCallback(async (session) => {
        setQaSessionMenu(null)
        const next = !(session.archived === true)
        try {
          await patchQaSession(session.session_id, { archived: next })
          setQaSessions((list) => list.map((x) =>
            x.session_id === session.session_id ? { ...x, archived: next } : x))
          if (next && qaActiveId === session.session_id) {
            setQaActiveId('')
            setAskSeed({ reset: true, nonce: ++navigationSeqRef.current })
          }
          showToast(next ? t.archiveOk : t.unarchiveOk, 'info')
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        }
      }, [patchQaSession, qaActiveId, showToast, t.archiveOk, t.requestFailed, t.unarchiveOk])

      const commitQaRename = useCallback(async (id, value) => {
        const title = String(value || '').trim().slice(0, 120)
        setQaRenaming(null)
        const cur = qaSessions.find((x) => x.session_id === id)
        if (cur && (cur.title || '') === title) return
        if (!title) { showToast(t.renameEmpty, 'error'); return }
        try {
          await patchQaSession(id, { title })
          setQaSessions((list) => list.map((x) => (x.session_id === id ? { ...x, title } : x)))
          showToast(t.renameOk, 'success')
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        }
      }, [patchQaSession, qaSessions, showToast, t.renameEmpty, t.renameOk, t.requestFailed])

      // 统计卡：已索引文档数（request('/docs') 取 count，失败显示 —）
      useEffect(() => {
        let alive = true
        request('/docs')
          .then((d) => { if (alive) setDocCount(Array.isArray(d && d.docs) ? d.docs.length : null) })
          .catch(() => { if (alive) setDocCount(null) })
        return () => { alive = false }
      }, [])

      // Approved boundary: this module never collapses or expands the DSH global sidebar.

      const gotoMinutes = useCallback(async (meetingId) => {
        if (!await navigate('minutes')) return
        setMinutesSeed({ meetingId, nonce: ++navigationSeqRef.current })
      }, [navigate])
      const gotoAsk = useCallback(async (meeting, autoQuestion) => {
        if (!await navigate('ask')) return
        setAskSeed({
          scope: meeting ? `meeting:${meeting.id}` : 'all',
          question: autoQuestion || (meeting ? t.detailJumpAsk(meeting.title) : ''),
          auto: Boolean(autoQuestion),
          nonce: ++navigationSeqRef.current,
        })
      }, [t, navigate])

      // 「新建对话」二级项：清空当前会话进入全新对话（activeId=''、messages=[]、欢迎页）
      const startNewChat = useCallback(async () => {
        if (!await navigate('ask')) return false
        setAskSeed({ reset: true, nonce: ++navigationSeqRef.current })
        return true
      }, [navigate])

      // 模块级导航桥：cappacks:open-meeting → 'meetai:navigate'（含未挂载时的 pendingNav 补偿）
      const applyNav = useCallback(async (nav) => {
        const sectionTab = { 会议日程: 'schedule', 会议纪要: 'minutes', 会议问答: 'ask', schedule: 'schedule', minutes: 'minutes', ask: 'ask', create: 'create' }
        const target = sectionTab[nav.tab] || 'schedule'
        if (!await navigate(target)) return
        if (target === 'minutes' && nav.meetingId) setMinutesSeed({ meetingId: nav.meetingId, nonce: ++navigationSeqRef.current })
        if (target === 'ask' && (nav.scope || nav.question)) setAskSeed({ scope: nav.scope || 'all', question: nav.question || '', auto: false, nonce: ++navigationSeqRef.current })
      }, [navigate])
      useEffect(() => {
        const onNav = (e) => applyNav((e && e.detail) || {})
        if (pendingNav) {
          const nav = pendingNav
          pendingNav = null
          applyNav(nav)
        }
        window.addEventListener(NAV_EV, onNav)
        return () => window.removeEventListener(NAV_EV, onNav)
      }, [applyNav])

      async function togglePin(m) {
        try {
          const data = await request(`/meetings/${encodeURIComponent(m.id)}`, patch({ is_pinned: !m.is_pinned }))
          setMeetings((list) => list.map((x) => (x.id === m.id ? { ...x, is_pinned: data.meeting.is_pinned } : x)).sort((a, b) => Number(b.is_pinned === true) - Number(a.is_pinned === true) || Date.parse(b.start_time || '') - Date.parse(a.start_time || '')))
          showToast(m.is_pinned ? t.starOff : t.starOn, 'success')
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        }
      }

      const pendingArchive = meetings.filter((m) => m.minutes_status === 'ready').length

      // 统计卡：今日待开会议（今天开始且尚未结束）
      const todayMeetings = useMemo(() => {
        const today = new Date()
        const now = Date.now()
        return meetings.filter((m) => {
          const s = new Date(m.start_time || '')
          return Number.isFinite(s.getTime()) && sameDay(s, today) && deriveStatus(m, now) !== 'completed'
        }).length
      }, [meetings])

      const goBack = async () => {
        if (!await navigate('schedule')) return
        const layout = ctx.layout || (ctx.get && ctx.get('layout'))
        layout?.selectPanel?.(null)
      }

      return h('div', { className: 'mt-app' + (railExpanded ? ' mt-rail-expanded mt-rail-lock' : '') },
        h('style', null, MEETING_CSS),
        railExpanded ? h('button', { type: 'button', className: 'mt-rail-shade', 'aria-label': '收起会议问答导航', onClick: () => setRailExpanded(false) }) : null,
        h('aside', { className: 'mt-rail', 'aria-label': '会议模块左侧栏', onPointerDown: mtSwipeDown, onPointerMove: mtSwipeMove, onPointerUp: mtSwipeEnd, onPointerCancel: mtSwipeEnd },
          h('div', { className: 'mt-brand' }, h('span', { className: 'mt-brandicon', 'aria-hidden': true }, '会'), h('span', { className: 'mt-brandname' }, '会议助手')),
          h('button', { type: 'button', className: 'mt-rail-toggle', 'aria-label': '收起会议导航', onClick: () => setRailExpanded(false) }, '收起导航 ×'),
          h('nav', { className: 'mt-railnav', 'aria-label': '会议子页面' },
            h('div', { className: 'mt-railsection' }, '会议工作区'),
            [['schedule', '会议日程', '日'], ['minutes', '会议纪要', '纪'], ['ask', '会议问答', '问']].map(([id, label, glyph]) => h('button', {
              key: id, type: 'button', className: 'mt-railitem' + (tab === id ? ' active' : ''),
              title: label, 'aria-label': label, 'aria-current': tab === id ? 'page' : undefined,
              'aria-expanded': id === 'ask' ? (compactRail ? railExpanded : tab === 'ask') : undefined,
              onClick: async () => {
                const moved = await navigate(id)
                if (moved && compactRail) setRailExpanded(false)
              },
            }, h('span', { className: 'ic' }, h('span', { 'aria-hidden': true }, glyph), h('span', { className: 'txt' }, label)),
              id === 'minutes' && meetingState === 'ready' && pendingArchive ? h('span', { className: 'mt-railbadge amber', title: '待归档纪要' }, pendingArchive) : null)),
          tab === 'ask' ? h('div', { className: 'mt-railgroup', 'aria-label': '会议问答会话' },
            h('button', { type: 'button', className: 'mt-railitem mt-railchild', title: '新增会话', 'aria-label': '新增会话',
              onClick: async () => { if (await startNewChat()) setRailExpanded(false) } },
              h('span', { className: 'ic' }, h('span', { 'aria-hidden': true }, '＋'), h('span', { className: 'txt' }, '新增会话'))),
            h('section', { className: 'mt-railqa', 'aria-label': '会议问答历史会话' },
              qaSessionsState === 'error' ? h('button', { type: 'button', className: 'mt-railitem', onClick: refreshQaSessions }, '历史读取失败 · 重试') : null,
              (() => {
                const archivedCount = qaSessions.filter(s => s.archived === true).length
                const visible = qaSessions.filter(s => (s.archived === true) === qaShowArchived)
                return [
                  qaShowArchived ? h('button', { type: 'button', className: 'mt-archtoggle', key: 'arch-back',
                    onClick: () => { setQaShowArchived(false); setQaSessionMenu(null) } }, '← ' + t.backToHistory) : null,
                  visible.length ? visible.map(session => {
                    const menuOpen = Boolean(qaSessionMenu && qaSessionMenu.session.session_id === session.session_id)
                    const renaming = Boolean(qaRenaming && qaRenaming.id === session.session_id)
                    return h('div', { className: 'mt-railrow', key: session.session_id },
                      renaming
                        ? h('input', {
                            className: 'mt-reninput', autoFocus: true, value: qaRenaming.value,
                            'aria-label': t.renameSession,
                            onChange: (e) => setQaRenaming({ id: session.session_id, value: e.target.value }),
                            onKeyDown: (e) => {
                              if (e.key === 'Enter') { e.preventDefault(); void commitQaRename(session.session_id, qaRenaming.value) }
                              if (e.key === 'Escape') { e.preventDefault(); setQaRenaming(null) }
                            },
                            onBlur: () => void commitQaRename(session.session_id, qaRenaming.value),
                            onClick: (e) => e.stopPropagation(),
                          })
                        : h('button', { type: 'button', className: 'mt-session' + (qaActiveId === session.session_id ? ' active' : ''),
                            'aria-current': qaActiveId === session.session_id ? 'page' : undefined,
                            title: session.title || session.session_id,
                            onClick: async () => { if (await openQaSession(session)) setRailExpanded(false) } },
                            (session.pinned === true ? '📌 ' : '') + (session.title || session.session_id)),
                      h('button', { type: 'button', className: 'mt-morebtn',
                        title: t.moreActions, 'aria-label': t.moreActions,
                        'aria-haspopup': 'menu', 'aria-expanded': menuOpen ? 'true' : 'false',
                        onClick: (e) => {
                          e.stopPropagation(); e.preventDefault()
                          setQaSessionMenu(menuOpen ? null : { session, anchor: e.currentTarget })
                        } }, '⋯'),
                      menuOpen ? h('div', { ref: qaMenuRef, className: 'mt-sessionmenu', role: 'menu',
                        style: qaMenuStyle(qaSessionMenu.anchor),
                        onClick: (e) => e.stopPropagation() },
                        h('button', { type: 'button', role: 'menuitem', onClick: () => void toggleQaPin(session) },
                          (session.pinned === true ? '📌 ' : '📍 ') + (session.pinned === true ? t.unpinSession : t.pinSession)),
                        h('button', { type: 'button', role: 'menuitem',
                          onClick: () => { setQaRenaming({ id: session.session_id, value: session.title || '' }); setQaSessionMenu(null) } },
                          '✎ ' + t.renameSession),
                        h('button', { type: 'button', role: 'menuitem', onClick: () => void toggleQaArchive(session) },
                          '🗄 ' + (session.archived === true ? t.unarchiveSession : t.archiveSession)),
                        h('button', { type: 'button', role: 'menuitem', className: 'danger',
                          onClick: () => {
                            setQaSessionMenu(null)
                            if (window.confirm(`删除对话「${session.title || '未命名会话'}」？此操作不可恢复。`)) void removeQaSession(session.session_id)
                          } }, '🗑 ' + t.delSession),
                      ) : null,
                    )
                  }) : h('p', { className: 'mt-muted' },
                    qaSessionsState === 'loading' ? '加载历史…'
                      : qaSessionsState === 'error' ? '历史读取失败，请重试'
                        : (qaShowArchived ? t.noArchived : t.noSessions)),
                  qaShowArchived ? null : h('button', { type: 'button', className: 'mt-archtoggle', key: 'arch-toggle',
                    onClick: () => { setQaShowArchived(true); setQaSessionMenu(null) } },
                    t.archivedChat + (archivedCount ? ' · ' + archivedCount : '')),
                ].filter(Boolean)
              })(),
            ),
          ) : null,
          ),
          h('button', { type: 'button', className: 'mt-railback', onClick: goBack, title: '返回主页', 'aria-label': '返回主页' }, '↩ ', h('span', { className: 'txt' }, '返回主页')),
        ),
        h('div', { className: 'mt-stage' },
        h('header', { className: 'mt-topbar' },
          h('button', { type: 'button', className: 'mt-menu', 'aria-label': railExpanded ? '收起会议导航' : '展开会议导航', 'aria-expanded': railExpanded ? 'true' : 'false', onClick: () => setRailExpanded(open => !open) }, h('span', { 'aria-hidden': true }, '☰')),
          h('div', { className: 'mt-grow' }, h('div', { className: 'mt-kicker' }, 'MeetAI Meeting'), h('h2', null, tab === 'schedule' ? '会议日程' : tab === 'minutes' ? '会议纪要' : tab === 'ask' ? '会议问答' : '新建会议'), h('p', null, '会议日程、纪要生成与全资产问答 · 录音字幕仅临时预览')),
          h('span', { className: 'mt-pill blue' }, '今日待开 ', meetingState === 'ready' ? todayMeetings : '未知'),
          h('details', { className: 'mt-more' },
            h('summary', { className: 'mt-btn small' }, health && !health.error ? '服务已连接 · AI未检测 ▾' : '状态待检测 ▾'),
            h('div', { className: 'mt-more-menu mt-health-menu' },
              h('p', null, health && health.error ? '状态查询失败，请重试。' : '服务：' + (health ? '已挂载' : '待检测')),
              h('p', null, 'ASR依赖：', health && health.asr ? health.asr.state === 'available' ? '受控依赖文件存在（未实际推理）' : '依赖未就绪' : '待检测'),
              h('p', null, '文字模型：', health && health.model ? health.model.registered === true ? '存在注册路由，推理可用性未检测' : health.model.registered === false ? '未找到注册路由' : '待检测' : '待检测'),
              h('p', null, '会议 ', meetingState === 'ready' ? meetings.length : '未知', ' · 待归档会议 ', meetingState === 'ready' ? pendingArchive : '未知', ' · 已挂载材料 ', docCount === null ? '未知' : docCount),
              h('button', { className: 'mt-btn small', onClick: refreshHealth }, '重新检查'),
            ),
          ),
        ),
        h('main', { className: 'mt-body' + (tab === 'ask' ? ' mt-body-ask' : '') },
          loading && !meetings.length && tab !== 'ask' ? h('div', { className: 'mt-muted' }, t.loading) : null,
          meetingState === 'error' ? h('div', { className: 'mt-notice' }, '会议清单读取失败，数量暂不可确认；保留已加载内容。', h('button', { className: 'mt-btn small', onClick: refreshMeetings }, '重试')) : null,
          tab === 'schedule'
            ? meetingState !== 'ready' && !meetings.length ? null : h(ScheduleView, { t, lang, meetings, onDetail: setDetail, onNew: () => navigate('create'), gotoMinutes, gotoAsk: (m) => gotoAsk(m), togglePin, showToast, refreshMeetings })
            : null,
          tab === 'create'
            ? h(CreateView, { t, onCreated: () => setTab('schedule'), showToast, refreshMeetings })
            : null,
          h('section', { hidden: tab !== 'minutes', className: 'mt-minutes-owner' }, h(MinutesView, { t, lang, meetings, showToast, seed: minutesSeed, refreshMeetings, registerGuard: registerMinutesGuard, visible: tab === 'minutes', key: 'minutes-view' })),
          tab === 'ask'
            ? h(AskView, { t, meetings, showToast, seed: askSeed, refreshMeetings, sessions: qaSessions, refreshSessions: refreshQaSessions, onActiveSession: setQaActiveId, onNewChat: startNewChat, meetingsKnown: meetingState === 'ready', key: 'ask-view' })
            : null,
        ),
        ),
        detail ? h(DetailModal, { t, meeting: detail, onClose: () => setDetail(null), gotoMinutes, gotoAsk: (m) => gotoAsk(m, t.detailJumpAsk(m.title)) }) : null,
        h(Toasts, { toasts }),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 侧栏图标与插件入口                                                   */
    /* ---------------------------------------------------------------- */

    function EntryIcon(props) {
      const p = props || {}
      return h(P.IconAlarmClockOutlineRegular, { size: p.size || 18, 'aria-hidden': true, style: { display: 'block' } })
    }

    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        const cleanups = []
        const locale = ctx.get('locale')
        const label = () => (locale && locale.getLocale && locale.getLocale() && locale.getLocale().id === 'en' ? 'Meeting Assistant' : '会议助手')

        // 主内容区完整应用（无业务 props，闭包传 ctx）
        cleanups.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'cap:meeting' }, () => h(MeetingApp, { ctx })),
          ),
        )
        // 侧栏能力包行（工作台分组下渲染；label 为函数以跟随语言切换）
        cleanups.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: 'cap:meeting', order: 10, label }, EntryIcon),
          ),
        )

        // cappacks:open-meeting 事件桥 → selectPanel('cap:meeting') + 页签切换
        function onOpenMeeting(ev) {
          const detail = (ev && ev.detail) || {}
          const nav = { tab: detail.section || 'schedule', meetingId: detail.meetingId || '' }
          pendingNav = nav
          try {
            window.dispatchEvent(new CustomEvent(NAV_EV, { detail: nav }))
          } catch {
            /* ignore */
          }
          try {
            const layout = ctx.layout || (ctx.get && ctx.get('layout'))
            if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('cap:meeting')
          } catch {
            /* ignore */
          }
        }
        window.addEventListener(OPEN_EV, onOpenMeeting)
        cleanups.push(() => window.removeEventListener(OPEN_EV, onOpenMeeting))

        return () => {
          for (const dispose of cleanups.reverse()) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* ignore */
            }
          }
        }
      },
    }
  },
})
