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
// One shared display layer for live, uploaded and saved captions. No ASR or guessed alignment.
function captionHasInterval(row) {
  return row.playbackTimingVerified === true && Number.isFinite(row.startMs) && Number.isFinite(row.endMs) && row.startMs >= 0 &&
    row.endMs > row.startMs && Boolean(row.timingProvenance) && row.timingProvenance !== 'unavailable'
}
function captionSeekIdentity(row, index) {
  return JSON.stringify([String(row.id ?? row.utteranceId ?? index), row.startMs, row.endMs, row.text, row.timingProvenance])
}
function currentCaptionSeek(seek, latest) {
  if (!seek || !latest || seek.sourceKey !== latest.sourceKey || !Array.isArray(latest.entries)) return null
  return latest.entries.find((row, index) => captionHasInterval(row) && captionSeekIdentity(row, index) === seek.sentenceIdentity) || null
}
// Layout-only evidence; never changes timing/audio authority or following state.
function sampleCaptionLayout(element, nodes, sourceKey, contentKey) {
  const textElement=element.querySelector?.('.mt-caption-text')||element
  const css=typeof window.getComputedStyle==='function'?window.getComputedStyle(textElement):{}
  const font=['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','wordSpacing'].map(key=>css[key]||'')
  const measurements=Object.create(null)
  nodes.forEach((node,id)=>{const height=node.getBoundingClientRect().height;if(Number.isFinite(height)&&height>0)measurements[id]=height})
  return {signature:JSON.stringify([sourceKey,contentKey,element.clientWidth,window.devicePixelRatio||1,window.visualViewport?.scale||1,font]),height:element.clientHeight,measurements}
}
function CaptionViewport({ entries = [], sourceKey, sourceUrl = '', audioRef, live = false, speakerNames = {}, onRename, state = 'ready', error = '', onRetry }) {
  const viewport = useRef(null), nodes = useRef(new Map()), pendingSeek = useRef(null), currentBinding = useRef(sourceKey), latestCaptionSource = useRef(null)
  currentBinding.current = sourceKey
  latestCaptionSource.current = { sourceKey, entries }
  const [position, setPosition] = useState(null), [following, setFollowing] = useState(true), [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(260), [heights, setHeights] = useState({}), [focused, setFocused] = useState(null), [seekError, setSeekError] = useState('')
  const timed = entries.some(captionHasInterval)
  const active = live ? entries[entries.length - 1] : position === null ? null : entries.find(row => captionHasInterval(row) && row.startMs <= position && position < row.endMs)
  const idFor = (row, index) => String(row.id ?? row.utteranceId ?? index)
  const activeIndex = active ? entries.indexOf(active) : -1
  const layoutSignature=useRef(null),layoutInputs=useRef(null)
  const layoutContentKey=JSON.stringify(entries.map((row,index)=>[idFor(row,index),row.text,row.speakerId,row.speakerId?speakerNames[row.speakerId]||'':'']))
  layoutInputs.current={sourceKey,contentKey:layoutContentKey}
  const offsets = useMemo(() => { let total = 0; const result = entries.map((row, index) => { const top = total; total += heights[idFor(row, index)] || 104; return top }); return { rows: result, total } }, [entries, heights])
  const visible = []
  for (let i = 0; i < entries.length; i++) if (entries.length <= 60 || offsets.rows[i] + (heights[idFor(entries[i], i)] || 104) >= scrollTop - 320 && offsets.rows[i] <= scrollTop + viewportHeight + 320 || idFor(entries[i], i) === focused) visible.push(i)
  function boundAudio() {
    const audio = audioRef?.current
    if (currentBinding.current !== sourceKey || !sourceUrl || !audio || audio.getAttribute('src') !== sourceUrl) return null
    if (audio.currentSrc && audio.currentSrc !== new URL(sourceUrl, window.location.href).href) return null
    return audio
  }
  function applyPending() {
    const seek = pendingSeek.current, audio = boundAudio()
    if (seek && !currentCaptionSeek(seek, latestCaptionSource.current)) { pendingSeek.current = null; return }
    if (!seek || seek.sourceKey !== currentBinding.current || !audio || audio.readyState < 1) return
    pendingSeek.current = null
    if (!Number.isFinite(audio.duration) || seek.ms >= audio.duration * 1000) { setSeekError('无法确认录音时长或字幕超出录音范围，未执行跳转。'); return }
    audio.currentTime = seek.ms / 1000; setPosition(seek.ms); setSeekError('')
  }
  function seek(row) {
    if (live || !captionHasInterval(row) || !boundAudio()) return
    pendingSeek.current = { sourceKey, ms: row.startMs, sentenceIdentity: captionSeekIdentity(row, entries.indexOf(row)) }; applyPending()
  }
  function followActive() {
    const element = viewport.current
    if (!element || activeIndex < 0 || currentBinding.current !== sourceKey) return
    const top = offsets.rows[activeIndex], height = heights[idFor(active, activeIndex)] || 104
    if (top < element.scrollTop || top + height > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, top - element.clientHeight / 3)
  }
  useEffect(() => {
    setPosition(null); setFollowing(true); setFocused(null); setSeekError(''); setHeights({}); setScrollTop(0); pendingSeek.current = null
    if (viewport.current) viewport.current.scrollTop = 0
    const audio = boundAudio(), binding = sourceKey
    if (!audio || live) return () => { pendingSeek.current = null }
    const update = () => { if (currentBinding.current === binding && boundAudio() === audio) setPosition(Number.isFinite(audio.currentTime) ? audio.currentTime * 1000 : null) }
    const metadata = () => { applyPending(); update() }
    let frame=null,disposed=false
    const tick=()=>{frame=null;if(disposed||boundAudio()!==audio)return;update();if(!audio.paused&&!audio.ended&&typeof window.requestAnimationFrame==='function')frame=window.requestAnimationFrame(tick)}
    const start=()=>{update();if(frame===null)tick()}
    const stop=()=>{update();if(frame!==null)window.cancelAnimationFrame?.(frame);frame=null}
    const events = ['timeupdate', 'seeking', 'seeked', 'durationchange']
    events.forEach(event => audio.addEventListener(event, update)); audio.addEventListener('loadedmetadata', metadata);audio.addEventListener('play',start);audio.addEventListener('playing',start);audio.addEventListener('pause',stop);audio.addEventListener('ended',stop);start()
    return () => { disposed=true;if(frame!==null)window.cancelAnimationFrame?.(frame);events.forEach(event => audio.removeEventListener(event, update)); audio.removeEventListener('loadedmetadata', metadata);audio.removeEventListener('play',start);audio.removeEventListener('playing',start);audio.removeEventListener('pause',stop);audio.removeEventListener('ended',stop); pendingSeek.current = null }
  }, [sourceKey, sourceUrl, live])
  useEffect(() => {
    if (pendingSeek.current && !currentCaptionSeek(pendingSeek.current, latestCaptionSource.current)) pendingSeek.current = null
  }, [sourceKey, entries])
  useEffect(() => { if (following) followActive() }, [activeIndex, active?.text, following, offsets, viewportHeight])
  useEffect(() => {
    const element=viewport.current,binding=sourceKey;let disposed=false
    if(!element)return
    function measure(force=false){
      if(disposed||currentBinding.current!==binding||layoutInputs.current?.sourceKey!==binding)return
      const sample=sampleCaptionLayout(element,nodes.current,binding,layoutInputs.current.contentKey)
      const reset=force||layoutSignature.current!==sample.signature;layoutSignature.current=sample.signature
      if(Number.isFinite(sample.height)&&sample.height>0)setViewportHeight(sample.height)
      setHeights(previous=>{
        if(!reset&&Object.entries(sample.measurements).every(([id,height])=>previous[id]===height))return previous
        return {...(reset?{}:previous),...sample.measurements}
      })
    }
    const resize=()=>measure(),fontsChanged=()=>measure(true)
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(resize):null
    observer?.observe(element);nodes.current.forEach(node=>observer?.observe(node));measure()
    window.addEventListener?.('resize',resize);window.visualViewport?.addEventListener?.('resize',resize)
    const fonts=typeof document!=='undefined'?document.fonts:null
    fonts?.addEventListener?.('loadingdone',fontsChanged);fonts?.addEventListener?.('loadingerror',fontsChanged)
    return ()=>{disposed=true;observer?.disconnect();window.removeEventListener?.('resize',resize);window.visualViewport?.removeEventListener?.('resize',resize);fonts?.removeEventListener?.('loadingdone',fontsChanged);fonts?.removeEventListener?.('loadingerror',fontsChanged)}
  }, [sourceKey, visible.join(','), entries, layoutContentKey])
  const pauseFollowing = () => setFollowing(false)
  return h('section', { className: 'mt-caption-view', 'aria-label': live ? '实时字幕' : '录音字幕' },
    h('div', { className: 'mt-row mt-between' }, h('span', { className: 'mt-muted', role: 'status' }, live ? '实时识别 · 当前句高亮（非回放时间）' : timed ? '原文句级时间 · 待人工复核' : '缺少可靠时间信息：回放同步高亮和字幕跳转已禁用'),
      h('button', { type: 'button', className: 'mt-btn small', disabled: following, onClick: () => { setFollowing(true); followActive() } }, following ? '正在跟随' : '恢复跟随')),
    !live && entries.length > 0 && !timed ? h('details', { className: 'mt-notice' }, h('summary', null, '如何获得可靠时间戳？'), h('p', null, '旧转写可能只保存了文字，升级不会自动补齐句级时间。请保留当前转写，从上传录音入口重新上传同一原音频并执行正式转写；新录音保留独立记录，不覆盖这份历史文字。只有识别引擎返回有效句级起止时间且与原音频校验一致，才开放回放同步和句首定位。'), h('p', null, '不要手工填写或按字数估算时间。若重新转写后仍提示缺少时间，说明本次识别未提供可验证的句级时间；全文仍可阅读。')) : null,
    state === 'loading' ? h('p', { role: 'status' }, '正在加载字幕…') : null,
    state === 'partial' ? h('p', { role: 'status' }, '字幕部分加载，正在读取后续页…') : null,
    error || seekError ? h('div', { role: 'alert', className: 'mt-notice' }, error || seekError, onRetry ? h('button', { className: 'mt-btn small', onClick: onRetry }, '重试字幕加载') : null) : null,
    h('div', { ref: viewport, className: 'mt-livewrap mt-caption-viewport', tabIndex: 0, onWheel: pauseFollowing, onTouchMove: pauseFollowing,
      onPointerDown: event => { if (event.target === event.currentTarget) pauseFollowing() },
      onKeyDown: event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pauseFollowing() },
      onScroll: event => setScrollTop(event.currentTarget.scrollTop) },
      !entries.length && state === 'ready' && !error ? h('p', { className: 'mt-muted' }, '暂无字幕；未知发言人不推断身份。') : null,
      h('div', { style: { position: 'relative', height: offsets.total } }, visible.map(index => {
        const row = entries[index], id = idFor(row, index), isActive = activeIndex === index, canSeek = !live && sourceUrl && captionHasInterval(row)
        const speaker = row.speakerId ? speakerNames[row.speakerId] || '发言人 ' + String(row.speakerId).replace(/^spk-/, '') : '未知发言人'
        return h('div', { key: id, 'data-caption-id': id, ref: node => { if (node) nodes.current.set(id, node); else nodes.current.delete(id) }, style: { position: 'absolute', top: offsets.rows[index], left: 0, right: 0, paddingBottom: 12 } },
          h('div', { className: 'mt-caption-row' }, h('span', { className: 'mt-caption-avatar', 'aria-hidden': true }, row.speakerId ? String(row.speakerId).replace(/^spk-/, '') : '？'),
            h('div', { className: 'mt-caption-bubble' + (row.kind === 'interim' ? ' interim' : '') + (isActive ? ' active' : ''),
              role: canSeek ? 'button' : undefined, tabIndex: canSeek ? 0 : undefined, 'aria-current': isActive ? 'true' : undefined,
              'aria-label': canSeek ? '定位到句首：' + row.text : undefined, onClick: canSeek ? () => seek(row) : undefined,
              onFocus: () => setFocused(id), onBlur: () => setFocused(null), onKeyDown: canSeek ? event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); seek(row) } } : undefined },
              h('div', { className: 'mt-caption-meta' }, row.speakerId && onRename ? h('button', { type: 'button', className: 'mt-caption-rename', onClick: event => { event.stopPropagation(); onRename(row.speakerId, speaker) } }, speaker) : h('span', null, speaker),
                captionHasInterval(row) ? h('span', null, (row.startMs / 1000).toFixed(1) + '秒') : null,
                h('span', null, row.source || (live ? '临时预览' : '已保存转写')), row.confidenceState !== 'confirmed' ? h('span', null, '待确认') : null),
              h('div', { className: 'mt-caption-text' }, row.text || '识别中…'))))
      }))))
}
// Pure binding validation inside the classic factory. No source or ASR writes.
function legacyCaptionBinding(data,expected){
 const keys=['meetingId','transcriptVersionId','legacyRecordingId','audioRevisionId','sourceSha256','audioSha256','manifestSha256','revision','timingLevel','timingProvenance']
 const invalid=()=>Object.assign(new Error('字幕音频、正文或句级版本绑定失效，请刷新资产'),{integrity:true})
 if(!data||keys.some(key=>!Object.hasOwn(data,key)))throw invalid()
 if(data.meetingId!==expected.meetingId||data.transcriptVersionId!==expected.version||data.legacyRecordingId!==expected.recordingId||data.audioRevisionId!==null||data.revision!==null||data.timingLevel!=='sentence'||data.timingProvenance!=='akun-provider-sentence-info-ms')throw invalid()
 for(const key of ['sourceSha256','audioSha256','manifestSha256'])if(typeof data[key]!=='string'||!/^[a-f0-9]{64}$/.test(data[key]))throw invalid()
 return JSON.stringify(keys.map(key=>data[key]))
}
function revokeLegacyCaptionLoad(load,error){
 load.failedIntegrity=Boolean(error.integrity)||(Number.isInteger(error.status)&&error.status>=400&&error.status<500)
 if(load.failedIntegrity){load.entries=[];load.ids.clear();load.accepted.clear();load.cursor=null}
 return {entries:load.entries.map(row=>({...row,playbackTimingVerified:false})),state:load.entries.length?'partial':'error',error:error.message,hash:load.hash,revoked:true}
}
// Inline into classic factory; no dynamic imports, job submissions or source writes.
function useLegacyCaptionSource({meetingId,recordingId,recording,audio,onInvalidation,reload=0}){
 const [captions,setCaptions]=useState({entries:[],state:'loading',error:'',hash:null}),[text,setText]=useState(''),[retryEpoch,setRetryEpoch]=useState(0)
 const axis=useRef(''),loadState=useRef(null)
 const owner=JSON.stringify([meetingId,recordingId,['transcriptVersionId','sourceSha256','audioSha256','manifestSha256','audioRevisionId','revision','timingProvenance','timingLevel','timingsAvailable','mediaURL','meetingId','recording_id'].map(key=>[Object.hasOwn(recording||{},key),recording?.[key]]),reload,retryEpoch]);axis.current=owner
 async function continueCaptions(load){
  if(load.busy||load.complete||load.failedIntegrity)return;load.busy=true
  try{
   while(axis.current===load.owner&&!load.controller.signal.aborted&&!load.complete){
    const cursor=load.cursor
    const data=await request('/transcripts/'+encodeURIComponent(load.version)+'/segments?meetingId='+encodeURIComponent(meetingId)+'&level=sentence&limit=100'+(cursor!==null?'&cursor='+encodeURIComponent(cursor):''),{signal:load.controller.signal})
    if(axis.current!==load.owner||loadState.current!==load)return
    if(!Array.isArray(data.items)||!Object.hasOwn(data,'nextCursor')||data.nextCursor!==null&&typeof data.nextCursor!=='string')throw Object.assign(new Error('字幕分页合同不完整'),{integrity:true})
    const required=['transcriptVersionId','meetingId','legacyRecordingId','audioRevisionId','sourceSha256','manifestSha256','revision','timingLevel','timingProvenance']
     if(required.some(key=>!Object.hasOwn(data,key)))throw Object.assign(new Error('字幕来源字段缺失，不能将未初始化視为合法空值'),{integrity:true})
     const meta=legacyCaptionBinding(data,{meetingId,recordingId,version:load.version})
    if(data.transcriptVersionId!==load.version||data.meetingId!==meetingId||data.legacyRecordingId!==recordingId||data.sourceSha256!==load.hash||load.metadata===undefined||load.metadata!==meta)throw Object.assign(new Error('字幕来源或版本跨页变化，请刷新资产重新绑定'),{integrity:true})
    if(data.nextCursor!==null&&(data.nextCursor===cursor||load.accepted.has(data.nextCursor)))throw Object.assign(new Error('检测到字幕游标回环'),{integrity:true})
    const incoming=new Map(load.ids)
    const fresh=[];for(const row of data.items){if(typeof row.id!=='string'||!row.id||typeof row.text!=='string'||row.transcriptVersionId!==load.version||row.recordingId!==recordingId||!Number.isFinite(row.startMs)||!Number.isFinite(row.endMs)||row.startMs<0||row.endMs<=row.startMs||row.timingProvenance!==data.timingProvenance)throw Object.assign(new Error('字幕来源或句级时间字段不一致'),{integrity:true});const signature=JSON.stringify(row);if(incoming.has(row.id)){if(incoming.get(row.id)!==signature)throw Object.assign(new Error('字幕ID冲突'),{integrity:true});continue}incoming.set(row.id,signature);fresh.push({...row,playbackTimingVerified:true})}
    load.metadata=meta;load.ids=incoming;load.entries.push(...fresh);load.accepted.add(cursor);load.cursor=data.nextCursor;load.complete=data.nextCursor===null
    setCaptions({entries:[...load.entries],state:load.complete?'ready':'partial',error:'',hash:load.hash})
   }
  }catch(e){if(axis.current===load.owner&&loadState.current===load&&!load.controller.signal.aborted){audio.current?.pause();setCaptions(revokeLegacyCaptionLoad(load,e));if(load.failedIntegrity){setText('');onInvalidation?.()}}}
  finally{load.busy=false}
 }
 useEffect(()=>{
  const load={owner,version:recording?.transcriptVersionId,controller:new AbortController(),cursor:null,accepted:new Set(),ids:new Map(),entries:[],complete:false,busy:false,hash:null};loadState.current=load;setCaptions({entries:[],state:load.version?'loading':'ready',error:'',hash:null});setText('');audio.current?.pause()
  if(recording&&(recording.recording_id!==recordingId||recording.meetingId!==meetingId||recording.mediaURL!==API+'/recordings/'+encodeURIComponent(recordingId)+'/file')){const error=Object.assign(new Error('录音字幕来源身份不一致，未授权全文或音频'),{integrity:true});setCaptions(revokeLegacyCaptionLoad(load,error));onInvalidation?.()}
   else if(load.version)(async()=>{try{const data=await request('/transcripts/'+encodeURIComponent(load.version)+'?meetingId='+encodeURIComponent(meetingId),{signal:load.controller.signal});if(axis.current!==load.owner||loadState.current!==load)return;const meta=data.transcript;if(meta?.id!==load.version||meta.meetingId!==meetingId||meta.legacyRecordingId!==recordingId||typeof data.text!=='string'||Object.hasOwn(meta,'transcriptVersionId')&&meta.transcriptVersionId!==load.version||!/^[a-f0-9]{64}$/.test(meta.sourceSha256||'')||recording.sourceSha256&&recording.sourceSha256!==meta.sourceSha256)throw Object.assign(new Error('字幕版本校验失败，请刷新资产'),{integrity:true});load.hash=meta.sourceSha256;setText(data.text);const provider='akun-provider-sentence-info-ms',legacy='explicit-transcript-range-second-resolution';if(meta.timingProvenance===provider||recording.timingProvenance===provider){
     if(meta.timingsAvailable!==true||recording.timingsAvailable!==true)throw Object.assign(new Error('原provider句级时间声明已变化，不能以旧文字时间降级遮盖'),{integrity:true})
    const expected={meetingId,recordingId,version:load.version}
    const textBinding=legacyCaptionBinding({...meta,transcriptVersionId:meta.id},expected)
    if(recording.timingsAvailable!==true||textBinding!==legacyCaptionBinding(recording,expected))throw Object.assign(new Error('工作区与全文的音频或句级manifest已变化，请刷新资产'),{integrity:true})
    load.metadata=textBinding;await continueCaptions(load)
   }else{if((meta.timingsAvailable===true||recording.timingsAvailable===true)&&(meta.timingProvenance!==legacy||recording.timingProvenance!==legacy))throw Object.assign(new Error('未知句级时间来源，未提供猜测定位'),{integrity:true});load.complete=true;setCaptions({entries:formalCaptionEntries(data.text).map(row=>({...row,startMs:undefined,endMs:undefined,timingProvenance:'unavailable'})),state:'ready',error:'',hash:load.hash})}}catch(e){if(axis.current===load.owner&&loadState.current===load&&!load.controller.signal.aborted){audio.current?.pause();setCaptions(revokeLegacyCaptionLoad(load,e));if(load.failedIntegrity){setText('');onInvalidation?.()}}}})()
  return()=>{load.controller.abort();if(loadState.current===load)loadState.current=null;audio.current?.pause()}
 },[owner])
 return {owner,axis,loadState,captions:loadState.current?.owner===owner?captions:{entries:[],state:recording?.transcriptVersionId?'loading':'ready',error:'',hash:null},text:loadState.current?.owner===owner?text:'',continueCaptions,retry:()=>{const load=loadState.current;if(load?.metadata&&!load.failedIntegrity)void continueCaptions(load);else setRetryEpoch(value=>value+1)}}
}
// Source part: inline inside the existing window.__ModuleLoader__ factory.
// Caller owns per-record confirmation, UI selection, and cancellation lifetime.
async function recoverCaptionTiming({ meetingId, recordingId, signal, onProgress } = {}) {
  const limit = 500 * 1024 * 1024
  const hash = /^[a-f0-9]{64}$/
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value)
  signal = signal || new AbortController().signal
  let stage = 'validate', copyState = 'none', saved = null
  const fail = (message, code = 'RECOVERY_INTEGRITY') => Object.assign(new Error(message), { code })
  const checkAbort = () => { if (signal.aborted) throw Object.assign(new Error('恢复已取消；已提交的副本不会删除'), { name: 'AbortError', code: 'RECOVERY_CANCELLED' }) }
  const progress = (next, percent) => {
    stage = next
    // UI observers must not interrupt commit accounting or cause a false failure.
    try { if (typeof onProgress === 'function') onProgress({ stage, percent, copyState, recordingId: saved?.recording_id || null }) } catch (_) {}
  }
  const metadata = row => {
    if (!row || row.meeting_id !== meetingId || !validId(row.recording_id) || !hash.test(row.sha256) ||
        !Number.isSafeInteger(row.size_bytes) || row.size_bytes <= 0 || row.size_bytes > limit ||
        typeof row.filename !== 'string' || !row.filename.trim() || row.filename.length > 255 || /[\\/\x00-\x1f\x7f]/.test(row.filename)) {
      throw fail('录音来源元数据缺失、不一致或超过 500MiB', 'RECOVERY_METADATA')
    }
    return { recording_id: row.recording_id, meeting_id: row.meeting_id, sha256: row.sha256, size_bytes: row.size_bytes, filename: row.filename }
  }
  const original = async () => {
    checkAbort()
    const data = await request('/recordings', { signal })
    checkAbort()
    if (!Array.isArray(data?.recordings)) throw fail('录音列表合同不完整')
    const rows = data.recordings.filter(row => row?.recording_id === recordingId)
    if (rows.length !== 1) throw fail('原录音不存在或 ID 冲突')
    return metadata(rows[0])
  }
  const equalSource = (a, b) => Object.keys(a).every(key => a[key] === b[key])
  const assertCopy = row => {
    const meta = metadata(row)
    if (meta.recording_id === recordingId || meta.sha256 !== source.sha256 || meta.size_bytes !== source.size_bytes || meta.filename !== source.filename) {
      throw fail('副本与原录音的身份或完整性不符；未启动转写')
    }
    return meta
  }
  let source
  try {
    checkAbort()
    if (!validId(meetingId) || !validId(recordingId)) throw fail('会议和录音 ID 无效', 'RECOVERY_INPUT')
    // Root-relative only: do not trust any media URL from list/record metadata.
    if (typeof API !== 'string' || !/^\/(?!\/)[A-Za-z0-9_/-]+$/.test(API) || API.endsWith('/') || API.split('/').includes('..')) throw fail('API 必须是同源根相对路径')
    source = await original()
    progress('download', 0)
    const response = await fetch(API + '/recordings/' + encodeURIComponent(recordingId) + '/file', {
      signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    })
    checkAbort()
    if (!response.ok || response.status !== 200 || response.redirected) throw fail('原录音下载失败或返回非完整响应', 'RECOVERY_DOWNLOAD')
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== source.size_bytes || Number(length) > limit)) {
      await response.body?.cancel().catch(() => {})
      throw fail('原录音下载大小与已保存元数据不一致', 'RECOVERY_SIZE')
    }
    if (!response.body || typeof response.body.getReader !== 'function') throw fail('此环境无法执行有界流式下载', 'RECOVERY_DOWNLOAD')
    const reader = response.body.getReader(), chunks = []
    let received = 0
    const cancelRead = () => { reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancelRead, { once: true })
    try {
      while (true) {
        checkAbort()
        const { done, value } = await reader.read()
        checkAbort()
        if (done) break
        if (!(value instanceof Uint8Array)) throw fail('下载流格式无效')
        received += value.byteLength
        if (received > source.size_bytes || received > limit) throw fail('原录音下载超出大小边界', 'RECOVERY_SIZE')
        chunks.push(value)
        progress('download', Math.floor(received / source.size_bytes * 100))
      }
    } finally {
      signal.removeEventListener('abort', cancelRead)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    if (received !== source.size_bytes) throw fail('原录音下载不完整', 'RECOVERY_SIZE')
    checkAbort()
    const file = new File(chunks, source.filename, { type: 'application/octet-stream' })
    chunks.length = 0
    const uploadRoute = id => {
      if (!validId(id)) throw fail('上传会话 ID 无效')
      return '/recording-uploads/' + encodeURIComponent(id)
    }
    progress('upload', 0)
    const uploaded = await uploadInChunks(file, {
      signal, meetingId,
      create: async meta => { checkAbort(); return (await request('/recording-uploads', { ...json(meta), signal })).upload },
      put: async (id, seq, bytes, sha) => {
        checkAbort()
        return (await request(uploadRoute(id) + '/chunks/' + seq, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha }, body: bytes, signal })).ack
      },
      commit: async id => {
        checkAbort()
        const route = uploadRoute(id) + '/commit'
        copyState = 'unknown' // A dropped response cannot prove that commit did not persist.
        const result = await request(route, { method: 'POST', signal })
        if (result?.recording && typeof result.recording === 'object') {
          saved = result.recording
          copyState = 'saved'
        }
        return result?.recording
      },
      // Only uncommitted upload sessions can be discarded. Never delete recordings.
      abort: async id => { if (copyState === 'none') await request(uploadRoute(id), { method: 'DELETE' }) },
      onProgress: (percent, next) => progress(next === 'commit' ? 'commit' : 'upload', percent),
    })
    checkAbort()
    const copied = assertCopy(uploaded)
    if (!saved || saved.recording_id !== copied.recording_id) throw fail('上传封存结果与确认不一致')
    progress('recheck', 100)
    if (!equalSource(source, await original())) throw fail('原录音来源在复制期间发生变化；未启动转写', 'RECOVERY_SOURCE_CHANGED')
    checkAbort()
    progress('transcribe', 0)
    // No force, PATCH, original-record writes, or alternate model endpoints.
    const result = await request('/recordings/' + encodeURIComponent(copied.recording_id) + '/transcribe', { method: 'POST', signal })
    checkAbort()
    if (!result?.recording || result.recording.recording_id !== copied.recording_id) throw fail('转写返回了错误的录音身份')
    assertCopy(result.recording)
    saved = result.recording
    progress('verify', 100)
    const captionRecording = await resolveSavedCaptionRecording(meetingId, copied.recording_id, signal)
    checkAbort()
    if (!captionRecording || captionRecording.meetingId !== meetingId || captionRecording.recording_id !== copied.recording_id ||
        captionRecording.mediaURL !== API + '/recordings/' + encodeURIComponent(copied.recording_id) + '/file' || captionRecording.audioSha256 !== source.sha256) {
      throw fail('新字幕的已保存来源未通过身份核验')
    }
    const timed = captionRecording.timingsAvailable === true && captionRecording.timingLevel === 'sentence' &&
      captionRecording.timingProvenance === 'akun-provider-sentence-info-ms' &&
      hash.test(captionRecording.sourceSha256) && hash.test(captionRecording.manifestSha256)
    const reason = timed ? null : (captionRecording.timingsUnavailableReason || 'VERIFIED_PROVIDER_TIMINGS_UNAVAILABLE')
    progress(timed ? 'timed' : 'unavailable', 100)
    return { status: timed ? 'timed' : 'unavailable', timed, recording: saved, captionRecording, originalRecordingId: recordingId, reason }
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    if (signal.aborted) error.name = 'AbortError'
    error.recovery = { stage, originalRecordingId: recordingId, recording: saved, copyState }
    throw error
  }
}

// One browser-side owner across all panels. No recognition starts before confirmation.
let captionRecoveryOwner = null
function CaptionRecovery({meetingId,recordingId,disabled=false,onBusy,onRecovered}) {
  const operation=useRef(null),live=useRef(null)
  const binding=JSON.stringify([meetingId,recordingId]);live.current=binding
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('')
  useEffect(()=>{live.current=binding;return()=>{live.current=null;operation.current?.abort()}},[binding])
  async function recover() {
    if(disabled||!meetingId||operation.current||captionRecoveryOwner)return
    if(!window.confirm('为当前录音补齐时间戳？将复制原音频并重新识别，生成独立的新记录；旧转写和人工修改全部保留。只有获得可靠句级时间后才自动切换新结果。'))return
    const controller=new AbortController(),owner=binding
    operation.current=controller;captionRecoveryOwner=controller;setBusy(true);onBusy?.(true);setMessage('正在准备原录音副本…')
    const stages={validate:'核对原录音',download:'读取原音频',upload:'上传独立副本',commit:'封存副本',recheck:'复核来源',transcribe:'正式识别中，请保持页面打开',verify:'校验句级时间',timed:'时间戳已补齐',unavailable:'本次识别未提供可靠句级时间'}
    try {
      const result=await recoverCaptionTiming({meetingId,recordingId,signal:controller.signal,onProgress:event=>{if(live.current===owner)setMessage((stages[event.stage]||event.stage)+(['download','upload'].includes(event.stage)&&Number.isFinite(event.percent)?' '+event.percent+'%':''))}})
      if(live.current!==owner||controller.signal.aborted)return
      setMessage(result.timed?'已补齐可靠句级时间，切换到新结果；旧稿仍可在录音下拉框中选择。':'新录音与转写已保存，但本次识别仍未提供可靠句级时间；保留当前旧稿，未启用同步高亮。')
      onRecovered?.(result)
    } catch(error) {
      if(live.current===owner){const state=error.recovery?.copyState;setMessage((error.name==='AbortError'?'已取消补齐。':'补齐失败：'+error.message+'。')+(state==='saved'?'副本已保存，可在录音列表中查看；原稿未改动。':state==='unknown'?'副本可能已保存，请刷新录音列表确认；不要立即重复提交。':'原稿未改动。'))}
    } finally {
      if(captionRecoveryOwner===controller)captionRecoveryOwner=null
      if(operation.current===controller)operation.current=null
      if(live.current===owner)setBusy(false)
      onBusy?.(false)
    }
  }
  return h('div',{className:'mt-notice','aria-label':'补齐录音时间戳'},
    h('button',{type:'button',className:'mt-btn small',disabled:disabled||!meetingId||busy,onClick:recover},busy?'正在补齐时间戳…':'补齐时间戳'),
    busy?h('button',{type:'button',className:'mt-btn small',onClick:()=>operation.current?.abort()},'取消本次处理'):null,
    message?h('p',{role:'status'},message):h('p',null,'逐条确认后重新识别为独立记录，不覆盖这份历史文字；只有可靠句级时间才启用同步高亮。'))
}

function SplitLegacyPanel({meetingId,locked,onLatest,showToast,onRecoveryBusy}){
 const [workspace,setWorkspace]=useState(null),[recordingId,setRecordingId]=useState(''),[reload,setReload]=useState(0),[error,setError]=useState(''),[history,setHistory]=useState(null)
 const [selectedDraft,setSelectedDraft]=useState(''),[draftLoading,setDraftLoading]=useState(false)
 const draftEpoch=useRef(0)
 const audio=useRef(null),workspaceEpoch=useRef(0),historyEpoch=useRef(0),pageBusy=useRef(false)
 useEffect(()=>{draftEpoch.current++;setSelectedDraft('');setDraftLoading(false)},[meetingId,reload])
 const recording=(workspace?.legacyRecordings||[]).find(row=>row.recording_id===recordingId)
 const {owner,axis,loadState,captions,text,continueCaptions}=useLegacyCaptionSource({meetingId,recordingId,recording,audio,reload,onInvalidation:()=>setHistory(null)})
 const url=recording?.meetingId===meetingId&&recording?.recording_id===recordingId&&recording?.mediaURL===API+'/recordings/'+encodeURIComponent(recordingId)+'/file'?recording.mediaURL:''
 useEffect(()=>{const epoch=++workspaceEpoch.current;setWorkspace(null);setRecordingId('');setError('');setHistory(null);historyEpoch.current++;if(meetingId)request('/meetings/'+encodeURIComponent(meetingId)+'/workspace').then(value=>{if(workspaceEpoch.current===epoch){setWorkspace(value);setRecordingId(value.legacyRecordings?.[0]?.recording_id||'')}}).catch(e=>{if(workspaceEpoch.current===epoch)setError(e.message)});return()=>{workspaceEpoch.current++;historyEpoch.current++;loadState.current?.controller.abort();audio.current?.pause()}},[meetingId,reload])
 async function preview(row){const key=owner,epoch=++historyEpoch.current;try{const data=await request('/minutes-revisions/'+encodeURIComponent(row.id)+'?meetingId='+encodeURIComponent(meetingId));if(axis.current===key&&historyEpoch.current===epoch)setHistory(data)}catch(e){if(axis.current===key&&historyEpoch.current===epoch)showToast('历史读取失败，当前Word未替换：'+e.message,'error')}}
 async function more(kind){const next=workspace?.pages?.[kind]?.nextCursor,key=owner;if(!next||pageBusy.current)return;pageBusy.current=true;try{const data=await request('/meetings/'+encodeURIComponent(meetingId)+'/workspace?'+kind+'Cursor='+encodeURIComponent(next));if(axis.current===key)setWorkspace(value=>({...value,[kind]:[...(value[kind]||[]),...(data[kind]||[])],pages:{...value.pages,[kind]:data.pages?.[kind]}}))}catch(e){if(axis.current===key)setError(e.message)}finally{pageBusy.current=false}}
 if(!meetingId)return null
 const binding=JSON.stringify([owner,captions.hash])
 return h('section',{className:'mt-card mt-stack mt-assets','aria-label':'会议资产与历史'},h('div',{className:'mt-row mt-between'},h('h3',null,'会议资产与历史'),h('button',{className:'mt-btn small',disabled:locked,onClick:()=>setReload(value=>value+1)},'刷新资产')),error?h('div',{role:'alert'},'读取失败不代表没有历史：',error):null,
  h('div',{className:'mt-row'},h('select',{className:'mt-select','aria-label':'选择人工纪要稿',value:selectedDraft,disabled:locked||draftLoading,onChange:event=>setSelectedDraft(event.target.value)},h('option',{value:''},workspace?.legacyMinutes?.length?'请选择要载入的人工稿':'暂无可载入的人工稿'),(workspace?.legacyMinutes||[]).map(row=>h('option',{key:row.minutesId,value:row.minutesId},(row.title||'未命名纪要')+' · v'+row.version))),h('button',{className:'mt-btn small',disabled:locked||draftLoading||!(workspace?.legacyMinutes||[]).some(row=>row.minutesId===selectedDraft),onClick:async()=>{const row=(workspace?.legacyMinutes||[]).find(item=>item.minutesId===selectedDraft);if(locked||draftLoading||!row)return;const epoch=++draftEpoch.current;setDraftLoading(true);try{await onLatest(row.logicalMinutesId)}catch(e){if(draftEpoch.current===epoch)showToast('载入失败：'+e.message,'error')}finally{if(draftEpoch.current===epoch)setDraftLoading(false)}}},draftLoading?'正在载入…':'载入最新人工稿')),workspace?.pages?.legacyMinutes?.nextCursor?h('button',{className:'mt-btn small',onClick:()=>more('legacyMinutes')},'更多纪要'):null,
  // Historical revision assets remain on the server; this redundant UI is intentionally removed.
  h('select',{className:'mt-select',value:recordingId,disabled:locked,'aria-label':'选择已保存录音',onChange:event=>setRecordingId(event.target.value)},h('option',{value:''},'选择已保存录音'),(workspace?.legacyRecordings||[]).map(row=>h('option',{key:row.recording_id,value:row.recording_id},row.filename))),workspace?.pages?.legacyRecordings?.nextCursor?h('button',{className:'mt-btn small',onClick:()=>more('legacyRecordings')},'更多录音'):null,
  url&&!loadState.current?.failedIntegrity?h('audio',{key:owner,ref:audio,src:url,controls:true,preload:'metadata',style:{width:'100%'}}):null,
  recordingId&&captions.state==='ready'&&!captions.error&&!captions.entries.some(captionHasInterval)?h(CaptionRecovery,{meetingId,recordingId,disabled:locked,onBusy:onRecoveryBusy,onRecovered:result=>{setWorkspace(value=>({...value,legacyRecordings:[result.captionRecording,...(value?.legacyRecordings||[]).filter(row=>row.recording_id!==result.recording.recording_id)]}));if(result.timed)setRecordingId(result.recording.recording_id)}}):null,
  h(CaptionViewport,{key:binding,sourceKey:binding,sourceUrl:url,audioRef:audio,entries:captions.error&&!loadState.current?.failedIntegrity&&text?formalCaptionEntries(text):captions.entries,state:captions.state,error:captions.error,onRetry:captions.error&&!loadState.current?.failedIntegrity?()=>{const load=loadState.current;if(load?.hash)void continueCaptions(load);else setReload(value=>value+1)}:undefined}),
  null)
}

    // Presentation only: never modify the authoritative transcript/FULL TEXT.
    function formalCaptionEntries(transcript) {
      // Display-only fallback. Text syntax alone never establishes audio alignment.
      const text = typeof transcript === 'string' ? transcript : typeof transcript?.text === 'string' ? transcript.text : ''
      const parts = text.split(/^\[FULL TEXT\][ \t]*/m)
      const pattern = /^\[((?:\d{2}:)?\d{2}:\d{2})-((?:\d{2}:)?\d{2}:\d{2})\]\s*(SPK[^\s:：]{1,32})[:：]\s*(\S.*)$/
      // ASR writes FULL TEXT followed by the same content split into sentences.
      // Display one representation, without deduplicating genuinely repeated speech.
      const prefix = parts[0].split(/\r?\n/).filter(line => line.trim())
      const lines = parts.length > 1 ? parts.slice(1).flatMap(block => {
        const rows = block.split(/\r?\n/).filter(line => line.trim())
        const sentenceStart = rows.findIndex(line => pattern.test(line))
        const full = sentenceStart < 0 ? rows : rows.slice(0, sentenceStart)
        return full.length ? full : rows
      }) : prefix
      return lines.map((line, index) => {
        const match = line.match(pattern)
        return { utteranceId: `formal-${index}`, speakerId: match && match[3] !== 'SPK?' ? match[3] : null, text: match ? match[4].trim() : line.trim(),
          timingProvenance: 'unavailable', playbackTimingVerified: false, kind: 'formal', confidenceState: 'unknown', source: '已保存文字（无对齐时间）' }
      }).filter(row => row.text)
    }
// Inline into existing classic client factory; reuses useLegacyCaptionSource.
// This file is a source part, not another plugin/server or independently loaded script.
async function resolveSavedCaptionRecording(meetingId,recordingId,signal){
 const accepted=new Set();let cursor=null
 while(true){
  if(signal.aborted)throw Object.assign(new Error('字幕来源已切换'),{name:'AbortError'})
  const workspace=await request('/meetings/'+encodeURIComponent(meetingId)+'/workspace'+(cursor===null?'':'?legacyRecordingsCursor='+encodeURIComponent(cursor)),{signal})
  if(!Array.isArray(workspace?.legacyRecordings)||!workspace.pages?.legacyRecordings||!Object.hasOwn(workspace.pages.legacyRecordings,'nextCursor'))throw Object.assign(new Error('录音资产分页合同不完整'),{integrity:true})
  const matches=workspace.legacyRecordings.filter(row=>row?.recording_id===recordingId)
  if(matches.length>1)throw Object.assign(new Error('录音资产ID冲突'),{integrity:true})
  if(matches.length){const row=matches[0];if(row.meetingId!==meetingId||row.mediaURL!==API+'/recordings/'+encodeURIComponent(recordingId)+'/file')throw Object.assign(new Error('录音资产来源不一致'),{integrity:true});return row}
  const next=workspace.pages.legacyRecordings.nextCursor
  if(next===null)return null
  if(typeof next!=='string'||!next||next===cursor||accepted.has(next))throw Object.assign(new Error('录音资产游标回环'),{integrity:true})
  accepted.add(next);cursor=next
 }
}
function SavedCaptionPlayback({meetingId,recordingId,revisionKey='',fallbackText='',audioRef,onLoadedMetadata,onTimeUpdate,onRecovered,onRecoveryBusy,locked=false}){
 const [reload,setReload]=useState(0),[authority,setAuthority]=useState(null),[error,setError]=useState('')
 const key=JSON.stringify([meetingId,recordingId,revisionKey,reload]),latest=useRef(key),denied=useRef(null);latest.current=key
 const recording=authority?.key===key?authority.recording:null
 const source=useLegacyCaptionSource({meetingId,recordingId,recording,audio:audioRef,reload})
 useEffect(()=>{
  const controller=new AbortController();setAuthority(null);setError('');audioRef.current?.pause();denied.current=null
  if(meetingId&&recordingId)resolveSavedCaptionRecording(meetingId,recordingId,controller.signal).then(recording=>{if(!controller.signal.aborted&&latest.current===key){if(!recording)throw Object.assign(new Error('已保存录音来源不存在，请刷新资产'),{integrity:true});setAuthority({key,recording})}}).catch(error=>{if(!controller.signal.aborted&&latest.current===key){audioRef.current?.pause();setAuthority(null);denied.current={key,failed:Boolean(error.integrity)||Number.isInteger(error.status)&&error.status>=400&&error.status<500};setError(error.message)}})
  return()=>{controller.abort();audioRef.current?.pause()}
 },[key])
 const current=source.loadState.current?.owner===source.owner,failed=current&&source.loadState.current?.failedIntegrity
 const blocked=failed||denied.current?.key===key&&denied.current.failed
 const url=recording&&!blocked?recording.mediaURL:''
 const binding=JSON.stringify([key,source.owner,current?source.captions.hash:null])
 // Missing alignment/version is display-only, not an empty transcript or guessed timing.
 // Authority/integrity denial must never be covered by another source's fallback text.
 const fallbackAllowed=!blocked&&!recording?.transcriptVersionId
 const entries=current&&source.captions.error&&!blocked&&source.text?formalCaptionEntries(source.text):recording?.transcriptVersionId&&current?source.captions.entries:fallbackAllowed?formalCaptionEntries(fallbackText):[]
 const fullText=current&&source.text?source.text:fallbackAllowed?fallbackText:''
 const state=error?'error':!meetingId||!recordingId?'ready':recording&&current?source.captions.state:'loading'
 return h('div',{className:'mt-stack'},
  url?h('audio',{key,ref:audioRef,controls:true,preload:'metadata',src:url,style:{width:'100%'},onLoadedMetadata,onTimeUpdate}):null,
  onRecovered&&recording&&state==='ready'&&!blocked&&!error&&!source.captions.error&&!entries.some(captionHasInterval)?h(CaptionRecovery,{meetingId,recordingId,disabled:locked,onBusy:onRecoveryBusy,onRecovered}):null,
  h(CaptionViewport,{key:binding,sourceKey:binding,sourceUrl:url,audioRef,entries,state,error:error||current&&source.captions.error||'',onRetry:error?()=>setReload(value=>value+1):source.captions.error&&!failed?source.retry:undefined}),
  null)
}
    const NAV_EV = 'meetai:navigate'
    const OPEN_EV = 'cappacks:open-meeting'
    let pendingNav = null
    // F2-8：宿主 layout.selectPanel 是同步 void、无任何可取消钩子（基线 §5 门禁 B）。
    // 只能在插件侧包装该方法做「可见确认」。MeetingApp 挂载时登记守卫，卸载时清除。
    let panelLeaveGuard = null
    let selfPanelNav = false
    let panelGuardState = 'unavailable'
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
.mt-modal.wide{width:min(1120px,96vw)}
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
.mt-caption-view{display:flex;flex-direction:column;gap:8px;min-width:0}.mt-caption-viewport{display:block!important;height:260px;min-height:130px;overflow:auto;overscroll-behavior:contain;overflow-anchor:none;scrollbar-gutter:stable;flex:none}.mt-caption-viewport>div{flex:none}
.mt-caption-view .mt-livewrap,.mt-assets,.mt-caption-float,.mt-caption-handle{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.mt-caption-view .mt-caption-bubble{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);width:100%;box-sizing:border-box;transition:background-color .12s}
.mt-caption-view .mt-caption-bubble.active{background:#eaf3ff;color:#243247;border-color:#b9d7fb;box-shadow:inset 3px 0 #78abea}.mt-caption-view .mt-caption-bubble.active .mt-caption-meta,.mt-caption-view .mt-caption-bubble.active .mt-caption-text{color:#345777}
.mt-caption-view .mt-caption-bubble[role=button]{cursor:pointer}.mt-caption-view .mt-caption-bubble:focus-visible,.mt-caption-viewport:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.mt-caption-view .mt-caption-meta,.mt-caption-view .mt-muted,.mt-caption-view .mt-caption-bubble.interim .mt-caption-text{color:var(--dsw-alias-label-secondary)}.mt-caption-view .mt-caption-avatar{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-border-l1)}.mt-caption-view .mt-caption-rename{color:var(--dsw-alias-brand-primary)}
.mt-caption-view .mt-row{flex-wrap:wrap}.mt-asset-item{padding:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:10px}.mt-assets pre{overflow-wrap:anywhere}.mt-caption-float .mt-caption-view{min-height:0;overflow:auto}.mt-caption-float .mt-caption-viewport{height:170px;min-height:100px}
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
const QA035_CSS = "\n.mt-app .mt-askwrap,.mt-app .mt-askbody,.mt-app .mt-askpanel{min-width:0;box-sizing:border-box;max-width:100%}\n.mt-app .mt-askwrap{display:flex;flex-direction:column;min-height:0;padding:12px}\n.mt-app .mt-asktop,.mt-app .mt-asksub{display:flex;flex-wrap:wrap;min-width:0;max-width:100%;gap:8px;box-sizing:border-box;flex:none}\n.mt-app .mt-asktop>.mt-select{flex:1 1 190px;min-width:0;max-width:100%;width:0}\n.mt-app .mt-asktop>.mt-muted{flex:1 1 190px;min-width:0;overflow-wrap:anywhere}\n.mt-app .mt-asksub .mt-select{flex:1 1 190px;min-width:0;width:0;max-width:100%;box-sizing:border-box}\n.mt-app .mt-asksub>.mt-btn,.mt-app .mt-asksub>.mt-hintchip,.mt-app .mt-asktop>.mt-btn{max-width:100%;white-space:normal;overflow-wrap:anywhere}\n.mt-app .mt-askbody,.mt-app .mt-askpanel{display:flex;flex:1;flex-direction:column;min-height:0}\n.mt-app .mt-msgs{flex:1;min-width:0;min-height:0;overflow-y:auto;overflow-wrap:anywhere}\n.mt-app .mt-inputbar{min-width:0;max-width:100%;box-sizing:border-box;flex-wrap:wrap}\n.mt-app .mt-inputbar textarea{min-width:0;flex:1 1 140px;width:0;box-sizing:border-box}\n.mt-app .mt-askdock{background:var(--dsw-alias-bg-layer-1);min-width:0;max-width:100%}\n.mt-app .mt-attachrow,.mt-app .mt-msgsrc{min-width:0;max-width:100%;flex-wrap:wrap;overflow-wrap:anywhere}\n.mt-app .mt-qa-message035{display:flex;align-items:flex-start;gap:8px;width:100%;min-width:0;margin:10px 0}\n.mt-app .mt-qa-message035.user{flex-direction:row-reverse}\n.mt-app .mt-qa-avatar035{width:36px;height:36px;flex:none}\n.mt-app .mt-qa-message035>.mt-bubble{min-width:0;max-width:calc(100% - 44px);margin:0;overflow-wrap:anywhere}\n.mt-app .mt-qa-message035>.mt-qa-col035{display:flex;flex-direction:column;min-width:0;max-width:calc(100% - 44px)}\n.mt-app .mt-qa-message035.user>.mt-qa-col035{align-items:flex-end}\n.mt-app .mt-qa-col035>.mt-bubble{min-width:0;max-width:100%;margin:0;overflow-wrap:anywhere}\n.mt-app .mt-qa-time035{font-size:11px;line-height:1.5;margin-top:3px;color:var(--dsw-alias-label-secondary);opacity:.85;font-variant-numeric:tabular-nums;white-space:nowrap}\n.mt-app .mt-qa-message035 a,.mt-app .mt-qa-message035 .mt-linkchip{overflow-wrap:anywhere;max-width:100%;white-space:normal}\n.mt-app .mt-qa-message035 pre{max-width:100%;overflow:auto}\n.mt-app .mt-context{container-type:inline-size;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:start}\n.mt-app .mt-context>.mt-field{min-width:0;max-width:100%}\n.mt-app .mt-context .mt-select,.mt-app .mt-word-pick035{height:36px;border-radius:8px;min-width:0;max-width:100%;width:100%;box-sizing:border-box}\n.mt-app .mt-word-pick035{display:flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);padding:0 8px;background:var(--dsw-alias-bg-layer-1)}\n.mt-app .mt-word-pick035>.mt-btn{border:0;background:none;padding:3px;flex:none}\n.mt-app .mt-word-pick035>.mt-chip{flex:1;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.mt-app .mt-context>.mt-context-status035,.mt-app .mt-context>.mt-notice{grid-column:1/-1}\n@container(max-width:760px){.mt-app .mt-context>.mt-field{grid-column:1/-1}}\n@media(max-width:600px){.mt-app .mt-context{grid-template-columns:minmax(0,1fr)}.mt-app .mt-qa-avatar035{width:30px;height:30px}.mt-app .mt-qa-message035>.mt-bubble{max-width:calc(100% - 38px)}.mt-app .mt-qa-message035>.mt-qa-col035{max-width:calc(100% - 38px)}}\n.mt-app .mt-genopt-body035{display:flex;flex-direction:column;gap:12px;border:0;padding:0}.mt-app .mt-genopt-body035 .mt-word-pick035{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.mt-app .mt-modal-mask{z-index:1300}.mt-app .mt-modal{position:relative;z-index:1301}"
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
const LOCAL_MODELS_CSS = ".mt-railfoot{display:flex;gap:8px;margin:8px 10px 12px}\n.mt-railfoot>.mt-railback{margin:0;flex:1 1 0;min-width:0}\n.mt-models{display:flex;flex-direction:column;gap:12px}\n.mt-models-info{border:1px solid var(--dsw-alias-border-l2);background:linear-gradient(90deg,rgba(13,157,151,.09),transparent 65%);border-radius:13px;padding:10px 14px;display:flex;flex-direction:column;gap:6px}\n.mt-models-inforow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}\n.mt-models-count{margin-left:auto;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary)}\n.mt-models-count b{color:#0d9d97;font-weight:650}\n.mt-models-dir{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}\n.mt-models-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:13px 15px}\n.mt-models-head{display:flex;align-items:center;gap:9px}\n.mt-models-icon{width:26px;height:26px;flex:none;display:grid;place-items:center;border-radius:8px;color:#0d9d97;background:rgba(13,157,151,.13)}\n.mt-models-name{color:var(--dsw-alias-label-primary);font-size:13.5px;font-weight:650}\n.mt-models-role{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.1));border-radius:999px;padding:2px 9px;font-size:11px}\n.mt-models-desc{color:var(--dsw-alias-label-secondary);margin:4px 0 8px;padding-left:35px;font-size:12px}\n.mt-models-meta{color:var(--dsw-alias-label-secondary);font-size:11.5px;padding-left:35px}\n.mt-models-actions{display:flex;align-items:center;gap:8px;margin-top:10px;padding-left:35px;flex-wrap:wrap}\n.mt-models-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:550}\n.mt-models-chip.ready{color:#059669;background:rgba(16,185,129,.12)}\n.mt-models-chip.ready:before{content:\"\";width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 0 2px rgba(16,185,129,.18)}\n.mt-models-chip.busy{color:#b45309;background:rgba(245,158,11,.14)}\n.mt-models-chip.busy:before{content:\"\";width:6px;height:6px;border-radius:50%;background:#f59e0b;animation:mtModelsPulse 1.1s ease-in-out infinite}\n.mt-models-chip.warn{color:#dc2626;background:rgba(220,38,38,.1)}\n@keyframes mtModelsPulse{0%,100%{opacity:1}50%{opacity:.35}}\n.mt-models-dl{border:0;border-radius:9px;height:30px;padding:0 13px;font-family:inherit;font-size:12px;font-weight:550;color:#fff;background:linear-gradient(135deg,var(--dsw-alias-state-business-primary,#1266e3),#0d9d97);cursor:pointer;display:inline-flex;align-items:center;gap:5px}\n.mt-models-dl:disabled{opacity:.45;cursor:default}\n.mt-models-progress{position:relative;height:18px;border-radius:9px;background:rgba(127,127,127,.15);overflow:hidden;margin:8px 0 0 35px}\n.mt-models-progressbar{position:absolute;inset:0 auto 0 0;width:0;border-radius:9px;background:linear-gradient(135deg,var(--dsw-alias-state-business-primary,#1266e3),#0d9d97);transition:width .3s}\n.mt-models-progresstext{position:absolute;inset:0;display:flex;align-items:center;padding:0 9px;font-size:10.5px;font-weight:550;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.mt-models-error{color:#dc2626;font-size:11.5px;margin-top:6px;padding-left:35px;word-break:break-all}\n.mt-models-note{color:var(--dsw-alias-label-secondary);font-size:11.5px}"
const MEETING_CSS = scopeMeetingCss(CSS.replace(/html\[data-mt-resizing\],html\[data-mt-resizing\] \*\{[^}]*\}/, '') + CLOUD_CSS + FINAL_CLOUD_CSS + NAVIGATION_CSS + QA035_CSS + QA_INPUT_WIDTH_FIX_CSS + KB_COMPOSER_CSS + LOCAL_MODELS_CSS)

    const dict = {
      zh: {
        title: '会议助手', subtitle: '会议日程与 AI 议程、模板纪要生成与签署归档、可溯源会议问答', back: '返回主页',
        modelsBtn: '会议模型', modelsTitle: '会议模型', modelsLoading: '读取模型状态…',
        modelsAsrState: 'ASR 依赖', modelsAsrReady: '已就绪', modelsAsrMissing: '未就绪',
        modelsReadyCount: '已就绪', modelsStorage: '占用', modelsDir: '模型目录',
        modelsAdminOnly: '会议模型是全站共享资产，只有管理员可以下载；你可以查看状态。',
        modelsAdminOnlyShort: '仅管理员可下载',
        modelsReady: '已就绪', modelsDownload: '下载', modelsRetry: '重试', modelsCancel: '取消',
        modelsDownloading: '下载中', modelsDownloadFailed: '下载失败', modelsLoadFailed: '模型状态读取失败',
        modelsRequestFailed: '操作失败，请重试', modelsSize: '体积', modelsFiles: '文件', modelsMissing: '缺失', modelsSource: '来源',
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
        modelsBtn: 'Meeting models', modelsTitle: 'Meeting models', modelsLoading: 'Reading model status…',
        modelsAsrState: 'ASR dependency', modelsAsrReady: 'Ready', modelsAsrMissing: 'Not ready',
        modelsReadyCount: 'Ready', modelsStorage: 'On disk', modelsDir: 'Model directory',
        modelsAdminOnly: 'Meeting models are shared assets; only administrators can download. You can view their status.',
        modelsAdminOnlyShort: 'Administrators only',
        modelsReady: 'Ready', modelsDownload: 'Download', modelsRetry: 'Retry', modelsCancel: 'Cancel',
        modelsDownloading: 'Downloading', modelsDownloadFailed: 'Download failed', modelsLoadFailed: 'Could not read model status',
        modelsRequestFailed: 'The operation failed, please retry', modelsSize: 'Size', modelsFiles: 'Files', modelsMissing: 'Missing', modelsSource: 'Source',
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

    function Modal({ title, narrow, wide, onClose, children, mandatory = false }) {
      const dialogRef = useRef(null)
      useEffect(() => {
        if (!mandatory) return
        const previous = document.activeElement
        const focusable = () => [...dialogRef.current.querySelectorAll('input,select,textarea,button,summary,[tabindex]')].filter(el => !el.matches(':disabled') && el.tabIndex >= 0 && el.getClientRects().length)
        const focus = () => (focusable()[0] || dialogRef.current).focus()
        focus()
        const keepFocus = event => { if (!dialogRef.current.contains(event.target)) focus() }
        const key = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
          if (event.key !== 'Tab') return
          const nodes = focusable(), index = nodes.indexOf(document.activeElement)
          if (!nodes.length || event.shiftKey && index <= 0 || !event.shiftKey && index === nodes.length - 1) {
            event.preventDefault(); (event.shiftKey ? nodes.at(-1) : nodes[0])?.focus()
          }
        }
        document.addEventListener('focusin', keepFocus)
        document.addEventListener('keydown', key, true)
        return () => { document.removeEventListener('focusin', keepFocus); document.removeEventListener('keydown', key, true); previous?.focus() }
      }, [mandatory])
      return h(
        'div',
        { className: 'mt-modal-mask', onMouseDown: (e) => { if (e.target === e.currentTarget && onClose) onClose() } },
        h('div', { ref: dialogRef, tabIndex: -1, className: 'mt-modal' + (narrow ? ' narrow' : '') + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': mandatory || undefined, 'aria-label': title || 'dialog' },
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

    function ScheduleView({ t, lang, meetings, onDetail, onNew, onHistory, gotoAsk, togglePin, showToast, refreshMeetings, onDelete, deletingId }) {
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
            h('button', { className: 'mt-btn small', disabled: Boolean(deletingId), onClick: () => onDelete(m) }, deletingId === m.id ? '删除中…' : '删除'),
            h('button', { className: 'mt-btn small', onClick: () => onHistory(m) }, t.gotoMinutes),
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

    /**
     * 「会议模型」弹窗：把会议转写依赖的四个本地 ASR 模型（paraformer / vad /
     * punc / cam++）以「手动下载」方式呈现——缺哪个点哪个，服务端从 ModelScope
     * 拉取并落盘。视觉与知识库「AI 模型」对齐（信息行 + 卡片 + 就绪徽标 + 条纹
     * 进度条），但代码独立，不复用 KB 的样式类与组件，避免两个插件互相耦合。
     *
     * 只呈现可验证的事实：状态一律来自服务端对「文件存在、非软链、字节数与锁定
     * 值一致」的核对；转写推理能力不做任何声明。
     */
    function LocalModelsModal({ t, onClose }) {
      const [snap, setSnap] = useState(null)
      const [state, setState] = useState('loading')
      const [error, setError] = useState(null)
      const [busyId, setBusyId] = useState(null)
      const [notice, setNotice] = useState(null)
      const timerRef = useRef(null)

      const load = useCallback(async (silent) => {
        if (!silent) setState('loading')
        try {
          const data = await request('/models/local')
          setSnap(data)
          setState('ready')
          setError(null)
        } catch (err) {
          setState('error')
          if (!silent) setError(err.message || '')
        }
      }, [])

      useEffect(() => { void load(false) }, [load])

      const models = (snap && Array.isArray(snap.models)) ? snap.models : []
      const downloading = models.some(m => m.download && (m.download.status === 'queued' || m.download.status === 'downloading' || m.download.status === 'verifying'))

      useEffect(() => {
        if (!downloading) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
          return undefined
        }
        timerRef.current = window.setInterval(() => { void load(true) }, 1200)
        return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } }
      }, [downloading, load])

      const post = async (route, id) => {
        setBusyId(id)
        setNotice(null)
        try {
          await request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
          await load(true)
        } catch (err) {
          setNotice(err.message || t.modelsRequestFailed)
        } finally {
          setBusyId(null)
        }
      }

      const fmt = (bytes) => {
        const n = Number(bytes) || 0
        if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
        if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
        return n + ' B'
      }

      const children = []
      if (notice) children.push(h('div', { className: 'mt-notice', key: 'notice' }, notice))
      if (state === 'loading' && !snap) {
        children.push(h('p', { className: 'mt-muted', key: 'loading' }, t.modelsLoading))
      } else if (state === 'error' && !snap) {
        children.push(h('div', { className: 'mt-models', key: 'failed' },
          h('p', { className: 'mt-notice' }, t.modelsLoadFailed + (error ? '：' + error : '')),
          h('button', { className: 'mt-btn small', onClick: () => void load(false) }, t.modelsRetry),
        ))
      } else if (snap) {
        children.push(h('div', { className: 'mt-models', key: 'body' },
          h('div', { className: 'mt-models-info' },
            h('div', { className: 'mt-models-inforow' },
              h('span', null, t.modelsAsrState + '：'),
              h('span', { className: 'mt-models-chip ' + (snap.asr.state === 'available' ? 'ready' : 'warn') }, snap.asr.state === 'available' ? t.modelsAsrReady : t.modelsAsrMissing),
              h('span', { className: 'mt-models-note' }, snap.asr.note),
              h('span', { className: 'mt-models-count' },
                t.modelsReadyCount + ' ', h('b', null, snap.counts.ready + '/' + snap.counts.total),
                ' · ', t.modelsStorage + ' ', h('b', null, fmt(snap.counts.bytesTotal)),
              ),
            ),
            h('div', { className: 'mt-models-dir' }, t.modelsDir + '：' + (snap.modelsDir || snap.modelsDirLabel)),
            snap.canDownload ? null : h('div', { className: 'mt-models-note' }, t.modelsAdminOnly),
          ),
          ...models.map((m) => {
            const dl = m.download
            const busy = Boolean(dl) && (dl.status === 'queued' || dl.status === 'downloading' || dl.status === 'verifying')
            const failed = Boolean(dl) && dl.status === 'error'
            const cancelled = Boolean(dl) && dl.status === 'cancelled'
            const actions = []
            if (m.status === 'ready') {
              actions.push(h('span', { className: 'mt-models-chip ready', key: 'ready' }, t.modelsReady))
            } else if (busy) {
              actions.push(h('span', { className: 'mt-models-chip busy', key: 'busy' }, t.modelsDownloading))
              if (snap.canDownload) actions.push(h('button', { className: 'mt-btn ghost small', key: 'cancel', disabled: busyId === m.id, onClick: () => void post('/models/local/cancel', m.id) }, t.modelsCancel))
            } else if (snap.canDownload) {
              actions.push(h('button', { className: 'mt-models-dl', key: 'dl', disabled: busyId === m.id, onClick: () => void post('/models/local/download', m.id) }, (failed || cancelled) ? t.modelsRetry : t.modelsDownload))
            } else {
              actions.push(h('span', { className: 'mt-models-note', key: 'ro' }, t.modelsAdminOnlyShort))
            }
            return h('div', { className: 'mt-models-card', key: m.id },
              h('div', { className: 'mt-models-head' },
                h('span', { className: 'mt-models-icon', 'aria-hidden': true }, '🎙'),
                h('span', { className: 'mt-models-name' }, m.name),
                h('span', { className: 'mt-models-role' }, m.role),
              ),
              h('div', { className: 'mt-models-desc' }, m.desc),
              h('div', { className: 'mt-models-meta' },
                t.modelsSize + ' ' + fmt(m.sizeTotal) + ' · ' + t.modelsFiles + ' ' + m.okCount + '/' + m.fileCount,
                m.status === 'partial' && m.missing.length ? ' · ' + t.modelsMissing + ' ' + m.missing.map(x => x.name).join('、') : '',
              ),
              h('div', { className: 'mt-models-actions' }, actions),
              busy ? h('div', { className: 'mt-models-progress', role: 'progressbar', 'aria-valuenow': Math.round(dl.pct || 0), 'aria-valuemin': 0, 'aria-valuemax': 100 },
                h('div', { className: 'mt-models-progressbar', style: { width: Math.min(100, dl.pct || 0) + '%' } }),
                h('span', { className: 'mt-models-progresstext' },
                  t.modelsDownloading + ' ' + Math.round(dl.pct || 0) + '% · ' + fmt(dl.receivedBytes) + ' / ' + fmt(dl.totalBytes),
                  dl.currentFile ? ' · ' + dl.currentFile : '',
                ),
              ) : null,
              failed ? h('div', { className: 'mt-models-error' }, t.modelsDownloadFailed + '：' + (dl.error || '')) : null,
              h('div', { className: 'mt-models-note', style: { paddingLeft: 35, marginTop: 4 } }, t.modelsSource + '：' + m.repo),
            )
          }),
        ))
      }
      return h(Modal, { title: t.modelsTitle, wide: true, onClose }, children)
    }
    function DetailModal({ t, meeting, onClose, onHistory, gotoAsk }) {
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
          h('button', { className: 'mt-btn', onClick: () => onHistory(meeting) }, t.gotoMinutes),
          h('button', { className: 'mt-btn primary', onClick: () => gotoAsk(meeting) }, t.gotoAsk),
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 视图二：新建会议                                                    */
    /* ---------------------------------------------------------------- */

    /* ---------------------------------------------------------------- */
    /* F1：日程/详情「纪要」→ 归属单一 meetingId 的可关闭历史弹窗            */
    /*                                                                  */
    /* 硬约束（R-14）：本组件**不是**第二个 MinutesView。retainedLiveRound /   */
    /* retainedMinutesSnapshot 是单槽（:1285-1286），registerGuard 每次渲染  */
    /* 写同一个 minutesGuardRef（:4715/:2147）；第二实例会接管制作页的离开    */
    /* 保护。因此这里只用自带 epoch 的 SplitLegacyPanel 展示历史，既不读写    */
    /* retained*、也不调用 registerGuard。                                  */
    /* 「全部纪要」不存在列表接口 → 走 workspace 分页（legacyMinutes /       */
    /* legacyRecordings + nextCursor，SplitLegacyPanel 的「更多纪要/录音」）。 */
    /* ---------------------------------------------------------------- */
    function MeetingHistoryModal({ t, meeting, onClose, onOpenProduction, showToast }) {
      const [latest, setLatest] = useState({ state: 'loading' })
      const [docs, setDocs] = useState([])
      // 最新一条：GET /minutes/meeting/{id}（与制作页同一契约）；全部历史走 workspace 分页。
      useEffect(() => {
        let alive = true
        setLatest({ state: 'loading' })
        request('/minutes/meeting/' + encodeURIComponent(meeting.id))
          .then(data => { if (alive) setLatest({ state: data.minutes ? 'ready' : 'empty', minutes: data.minutes || null }) })
          .catch(error => { if (alive) setLatest({ state: error.code === 'NOT_FOUND' || error.message === '纪要不存在' ? 'empty' : 'error', message: error.message }) })
        return () => { alive = false }
      }, [meeting.id])
      useEffect(() => {
        let alive = true
        setDocs([])
        request(`/docs?meeting_id=${encodeURIComponent(meeting.id)}`)
          .then(data => { if (alive) setDocs(data.docs || []) })
          .catch(() => {})
        return () => { alive = false }
      }, [meeting.id])
      const people = peopleOf(meeting)
      return h(Modal, { title: (meeting.title || '会议') + ' · 纪要与历史资料', wide: true, onClose },
        h('div', { className: 'mt-row', style: { marginBottom: 8, flexWrap: 'wrap' } },
          StatusPill({ status: deriveStatus(meeting), t }),
          MinutesPill({ value: meeting.minutes_status || 'none', t }),
          h('span', { className: 'mt-muted' }, '◷ ', fmtRange(meeting)),
          meeting.location ? h('span', { className: 'mt-muted' }, '📍 ', meeting.location) : null,
          h('span', { className: 'mt-muted' }, '🆔 ', meeting.id),
        ),
        people.length ? h('div', { className: 'mt-row', style: { marginBottom: 8 } }, people.map(p => h('span', { className: 'mt-chip', key: p }, '👥 ', p))) : null,
        h('section', { className: 'mt-card mt-stack', 'aria-label': '最新纪要' },
          h('h3', null, '最新一条纪要'),
          latest.state === 'loading' ? h('div', { className: 'mt-muted', role: 'status' }, '正在读取最新纪要…') : null,
          latest.state === 'error' ? h('div', { className: 'mt-notice' }, '最新纪要读取失败，不代表没有记录：', latest.message) : null,
          latest.state === 'empty' ? h('div', { className: 'mt-muted' }, '该会议暂无人工纪要稿。') : null,
          latest.state === 'ready' ? h('div', { className: 'mt-stack' },
            h('div', { className: 'mt-row' },
              h('span', { className: 'mt-pill gray' }, 'v' + (latest.minutes.version || 1)),
              h('span', { className: 'mt-pill ' + (latest.minutes.is_archived ? 'green' : 'blue') }, latest.minutes.is_archived ? '已正式归档' : '最新版本'),
              h('span', { className: 'mt-muted' }, '来源 ' + (latest.minutes.source || '—')),
            ),
            latest.minutes.is_archived && latest.minutes.archive_fingerprint ? h('div', { className: 'mt-fp' }, latest.minutes.archive_fingerprint) : null,
            h('pre', { className: 'mt-fp', style: { maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' } }, String(latest.minutes.content || '').slice(0, 4000) || '（正文为空）'),
          ) : null,
        ),
        h('section', { className: 'mt-card mt-stack', 'aria-label': '关联材料' },
          h('h3', null, '关联材料'),
          docs.length
            ? docs.map(d => h('div', { className: 'mt-file', key: d.file_id },
                h('span', { className: 'name' }, d.name),
                h('span', { className: 'mt-muted' }, fmtBytes(d.size)),
                d.has_text ? h('span', { className: 'mt-pill green' }, t.materialTextReady) : h('span', { className: 'mt-pill gray' }, t.materialQueued),
              ))
            : h('div', { className: 'mt-muted' }, t.none),
        ),
        h('p', { className: 'mt-muted' }, '历史纪要与录音按服务端分页返回：点击「更多纪要」/「更多录音」可继续加载，直到按钮消失才代表已加载全部，不会把第一批冒充为全部。'),
        h(SplitLegacyPanel, { key: meeting.id, meetingId: meeting.id, locked: false, showToast, onRecoveryBusy: () => {}, onLatest: async () => { await onOpenProduction(meeting.id) } }),
        h('div', { className: 'mt-row', style: { justifyContent: 'flex-end', marginTop: 12 } },
          h('button', { className: 'mt-btn', onClick: onClose }, t.close),
          h('button', { className: 'mt-btn primary', onClick: () => onOpenProduction(meeting.id) }, '在制作页打开该会议'),
        ),
      )
    }

    function CreateView({ t, onCreated, showToast, refreshMeetings, beforeMinutes = false, resetToken }) {
      const [form, setForm] = useState(() => ({
        title: '', start: localInput(new Date(Date.now() + 3600000)), end: localInput(new Date(Date.now() + 7200000)),
        type: 'offline', location: '', meeting_link: '', participants: '', tags: '', is_pinned: false,
      }))
      const [agenda, setAgenda] = useState([])
      const [materials, setMaterials] = useState([])
      const [busy, setBusy] = useState(false)
      const [agendaBusy, setAgendaBusy] = useState(false)
      const [materialReading, setMaterialReading] = useState(0)
      const [submitError, setSubmitError] = useState('')
      const submitLock = useRef(false), createdMeeting = useRef(null), savedMaterials = useRef(new Set()), materialReaders = useRef(0)
      const creationRequest = useRef(null), materialRequestIds = useRef(new Map())
      const fileRef = useRef(null)
      const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
      // P0-1/R-15：补填表单常驻不卸载。创建身份（createdMeeting / creationRequest /
      // materialRequestIds / savedMaterials）只在「开启新一轮补填流程」时显式重置，
      // 绝不会被"关闭表单"清掉；关闭再重开必定复用同一身份，不会重复建会。
      const appliedResetToken = useRef(resetToken)
      useEffect(() => {
        if (appliedResetToken.current === resetToken) return
        appliedResetToken.current = resetToken
        createdMeeting.current = null; creationRequest.current = null
        materialRequestIds.current = new Map(); savedMaterials.current.clear()
        setAgenda([]); setMaterials([]); setSubmitError('')
        setForm((f) => ({ ...f, title: '', location: '', meeting_link: '', participants: '', tags: '', is_pinned: false }))
      }, [resetToken])
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
            materialReaders.current++; setMaterialReading(materialReaders.current)
            const reader = new FileReader()
            const done = () => { materialReaders.current--; setMaterialReading(materialReaders.current) }
            reader.onload = () => { setMaterials((list) => [...list, { name: f.name, size: f.size, text: String(reader.result || '') }]); done() }
            reader.onerror = () => { if (beforeMinutes) setSubmitError('材料读取失败：' + f.name + '，请删除此项后重新选择。'); setMaterials((list) => [...list, { name: f.name, size: f.size, text: '', readError: beforeMinutes }]); done() }
            reader.readAsText(f)
          } else {
            setMaterials((list) => [...list, { name: f.name, size: f.size, text: '' }])
          }
        }
      }

      async function submit() {
        if (submitLock.current || materialReaders.current || beforeMinutes && (agendaBusy || materials.some(mat => mat.readError))) return
        if (!form.title.trim()) return showToast(t.needTitle, 'warn')
        const startMs = Date.parse(form.start), endMs = Date.parse(form.end)
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.end) ||
            !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return showToast(t.needTime, 'warn')
        const startIso = new Date(startMs).toISOString(), endIso = new Date(endMs).toISOString()
        submitLock.current = true; setBusy(true); setSubmitError('')
        try {
          if (!createdMeeting.current) {
            const input = {
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
            }
            if (beforeMinutes && !creationRequest.current) creationRequest.current = { ...input, creation_request_id: crypto.randomUUID() }
            const data = await request('/meetings', json(beforeMinutes ? creationRequest.current : input))
            if (!data.meeting?.id) throw new Error('会议创建回执缺失，未继续生成。')
            createdMeeting.current = data.meeting
          }
          const meetingId = createdMeeting.current.id
          for (const mat of materials) {
            if (savedMaterials.current.has(mat)) continue
            if (beforeMinutes && !materialRequestIds.current.has(mat)) materialRequestIds.current.set(mat, crypto.randomUUID())
            const save = request('/docs', json({ name: mat.name, size: mat.size, meeting_id: meetingId, text: mat.text || '', ...(beforeMinutes ? { creation_request_id: materialRequestIds.current.get(mat) } : {}) }))
            if (beforeMinutes) {
              const result = await save
              if (!result.doc?.file_id || result.doc.meeting_id !== meetingId) throw new Error('材料保存回执不一致，未继续生成。')
            }
            else await save.catch(() => {})
            savedMaterials.current.add(mat)
          }
          await refreshMeetings()
          if (!beforeMinutes) {
            setForm((f) => ({ ...f, title: '', location: '', meeting_link: '', participants: '', tags: '', is_pinned: false }))
            setAgenda([]); setMaterials([])
            showToast(t.created, 'success')
          }
          await onCreated(createdMeeting.current)
          if (!beforeMinutes) { createdMeeting.current = null; savedMaterials.current.clear() }
        } catch (e) {
          if (!createdMeeting.current && e.status >= 400 && e.status < 500) creationRequest.current = null
          if (beforeMinutes) setSubmitError((createdMeeting.current ? '会议已创建；材料或关联未完成，重试将复用此会议。' : '') + e.message)
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          submitLock.current = false; setBusy(false)
        }
      }

      const setRow = (i, k, v) => setAgenda((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
      const meetingFieldsLocked = beforeMinutes && Boolean(createdMeeting.current || creationRequest.current)
      const fieldsetStyle = { border: 0, padding: 0, margin: 0, minWidth: 0 }

      return h('div', { className: 'mt-card mt-create mt-stack' },
        h('fieldset', { className: 'mt-stack', disabled: busy, style: fieldsetStyle },
        h('fieldset', { className: 'mt-stack', disabled: meetingFieldsLocked, style: fieldsetStyle },
        h('div', { className: 'mt-row mt-between' }, h('h3', { className: 'mt-h3' }, '新建会议'), h('span', { className: 'mt-muted' }, '时间按浏览器时区 ' + Intl.DateTimeFormat().resolvedOptions().timeZone + ' 保存为ISO时间')),
        h('div', { className: 'mt-grid2' },
          h('label', { className: 'mt-field' }, t.fTitle, h('input', { className: 'mt-input', value: form.title, maxLength: 120, placeholder: lang0(t), onChange: e => set('title', e.target.value) })),
          h('label', { className: 'mt-field' }, locLabel, h('input', { className: 'mt-input', value: form.location, onChange: e => set('location', e.target.value) })),
          h('label', { className: 'mt-field' }, t.fStart, h('input', { className: 'mt-input', type: 'datetime-local', value: form.start, onChange: e => set('start', e.target.value) })),
          h('label', { className: 'mt-field' }, t.fEnd, h('input', { className: 'mt-input', type: 'datetime-local', value: form.end, onChange: e => set('end', e.target.value) })),
          h('label', { className: 'mt-field' }, t.fParticipants, h('input', { className: 'mt-input', value: form.participants, placeholder: '张三, 李四', onChange: e => set('participants', e.target.value) })),
        ),
        ),
        h('details', { className: 'mt-create-more' },
          h('summary', { className: 'mt-btn small' }, '更多会议信息 · 形式 / 标签 / 议程 / 材料'),
          h('div', { className: 'mt-stack' },
            h('fieldset', { className: 'mt-stack', disabled: meetingFieldsLocked, style: fieldsetStyle },
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
            ),
            h('h3', { className: 'mt-h3' }, t.materialTitle),
            h('button', { type: 'button', className: 'mt-drop', onClick: () => fileRef.current?.click() }, t.materialHint),
            h('input', { ref: fileRef, type: 'file', multiple: true, style: { display: 'none' }, onChange: pickFiles }),
            materials.map((mat, i) => h('div', { className: 'mt-file', key: mat.name + '-' + i }, h('span', { className: 'name' }, mat.name), h('span', { className: 'mt-muted' }, fmtBytes(mat.size)), h('span', { className: 'mt-pill gray' }, mat.readError ? '读取失败，请删除后重选' : mat.text ? t.materialTextReady : t.materialQueued), h('button', { className: 'mt-btn small danger', disabled: beforeMinutes && savedMaterials.current.has(mat), onClick: () => setMaterials(list => list.filter((_, j) => j !== i)) }, '×'))),
          ),
        ),
        ),
        beforeMinutes && submitError ? h('div', { role: 'alert', className: 'mt-notice' }, submitError) : null,
        h('div', { className: 'mt-row', style: { justifyContent: 'flex-end' } }, h('button', { className: 'mt-btn primary', disabled: busy || materialReading > 0 || beforeMinutes && (agendaBusy || materials.some(mat => mat.readError)) || !form.title.trim() || !Number.isFinite(Date.parse(form.start)) || !Number.isFinite(Date.parse(form.end)) || Date.parse(form.end) <= Date.parse(form.start), onClick: submit }, busy ? '正在提交…' : beforeMinutes ? '创建会议并生成纪要' : t.submitCreate)),
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


    function MinutesView({ t, lang, meetings, showToast, seed, refreshMeetings, registerGuard, visible, isDeleting }) {
      // F2/R-05/R-18：进入插件即为「全新空白制作」。composing 期间不读取 retained* 快照、
      // 不自动载入旧会议/录音/纪要；只有用户显式绑定会议后才离开该上下文。
      const composeRef = useRef(true)
      const [composing, setComposing] = useState(true)
      const leaveCompose = useCallback(() => { if (composeRef.current) { composeRef.current = false; setComposing(false) } }, [])
      const restored = useRef(!composeRef.current && retainedMinutesSnapshot && (!seed?.meetingId || seed.meetingId === retainedMinutesSnapshot.targetId) ? retainedMinutesSnapshot : null).current
      const [targetId, setTargetId] = useState(restored?.targetId || (seed && seed.meetingId ? seed.meetingId : ''))
      // 绑定同步镜像：所有 targetId 写入都经 bindMeeting，异步续接据此判归属（P0-2/R-16）。
      const targetIdRef = useRef(targetId)
      const bindMeeting = useCallback(id => { targetIdRef.current = id || ''; setTargetId(id || '') }, [])
      const [requiredMeetingSource, setRequiredMeetingSource] = useState(null)
      const [requiredMeetingPending, setRequiredMeetingPending] = useState(false)
      const [createResetToken, setCreateResetToken] = useState(0)
      const [retainedOffer, setRetainedOffer] = useState(null)
      const requiredMeetingRef = useRef(null)
      const [minutes, setMinutes] = useState(restored?.minutes || null)
      const [transcript, setTranscript] = useState(restored?.transcript || '')
      const [template, setTemplate] = useState(restored?.template || 'weekly')
      const [wordTemplate, setWordTemplate] = useState(restored?.wordTemplate || null)
      const [wordBusy, setWordBusy] = useState(false)
      const wordInput = useRef(null), wordUploadLock = useRef(false)
      const [busy, setBusy] = useState(false)
      const [generationProgress035,setGenerationProgress035] = useState(null)
      const [groundingView035,setGroundingView035] = useState(null)
      async function inspectGrounding035(taskId) { const owner=taskId?'task:'+taskId:'minutes:'+minutes?.minutes_id;const route=taskId?'/generation-tasks/'+encodeURIComponent(taskId)+'/grounding':'/minutes/'+encodeURIComponent(minutes.minutes_id)+'/grounding';setGroundingView035({owner,loading:true});try{const data=await request(route);setGroundingView035(v=>v?.owner===owner?{owner,data}:v)}catch(error){setGroundingView035(v=>v?.owner===owner?{owner,error:error.message}:v)}}
      const [generationActive035,setGenerationActive035] = useState(false)
      const generationAbort035=useRef(null),generationInput035=useRef(null)
      useEffect(()=>()=>generationAbort035.current?.abort(),[])
      async function runGeneration035(body,options={}) {
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
        // P0-2/R-16：恢复任务同样必须带 owner/代次令牌，否则迟到响应会写进新的制作页。
        const resumeTaskId=generationProgress035.task_id
        const ownerId=generationInput035.current?.meeting_id||targetId
        const token=beginOperation()
        if(!token)return
        setBusy(true)
        try{const data=await runGeneration035(null,{resumeTaskId});if(!operationActive(token)||!meetingOwned(ownerId)||(data.minutes?.meeting_id&&data.minutes.meeting_id!==ownerId))return;setMinutes(data.minutes);bindMeeting(data.minutes.meeting_id||targetId);setDraft(null);setEditing(false);setWordTemplate(current=>current?.templateId===generationInput035.current?.word_template_id?null:current);refreshMeetings();showToast(t.generated,"success")}
        catch(error){if(operationActive(token))showToast(error.message,"error")}finally{if(operationActive(token))setBusy(false);endOperation(token)}
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
      function associateBrowserRecording(round){
        if(!round?.browserId||!round.recording?.recording_id)return
        void request('/voice-control/browser',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'bind',browserId:round.browserId,recordingId:round.recording.recording_id})}).catch(error=>{if(liveActive(round))setCaptionStatus('原录音已保存，音源记录关联尚未确认：'+error.message)})
      }
      function releaseBrowserRecording(round){
        if(!round?.browserId||round.browserReleased)return
        round.browserReleased=true;clearInterval(round.browserHeartbeat)
        void fetch(API+'/voice-control/browser',{method:'POST',credentials:'same-origin',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'stop',browserId:round.browserId})}).catch(()=>{})
      }
      // P0-2/R-16 归属判定：组件仍挂载，且当前绑定仍是这次异步结果所属的会议。
      const meetingOwned = useCallback(id => liveMountedRef.current && targetIdRef.current === (id || ''), [])
      // upload 上传录音态
      const [uploadRec, setUploadRec] = useState(restored?.uploadRec || null)
      const [recordChoices,setRecordChoices]=useState([]),[recordChoicesError,setRecordChoicesError]=useState(''),[recordChoicesEpoch,setRecordChoicesEpoch]=useState(0),[timingBusy,setTimingBusy]=useState(false)
      const uploadSelectionEpoch=useRef(0)
      useEffect(()=>{const controller=new AbortController();const epoch=++uploadSelectionEpoch.current;setRecordChoices([]);setRecordChoicesError('');request('/recordings',{signal:controller.signal}).then(data=>{if(controller.signal.aborted)return;if(!Array.isArray(data.recordings))throw new Error('录音列表格式无效');const rows=data.recordings.filter(row=>(row.meeting_id||'')===(targetId||''));const current=uploadRecRef.current;setRecordChoices(rows.map(row=>row.recording_id===current?.recording_id?current:row));if(!current&&!upXhrRef.current&&rows.length&&!composeRef.current){setUploadRec(rows[0]);setUpTranscript(rows[0].transcript||'')}}).catch(error=>{if(!controller.signal.aborted)setRecordChoicesError(error.message)});return()=>{controller.abort();uploadSelectionEpoch.current++}},[targetId,recordChoicesEpoch])
      useEffect(()=>{if(uploadRec&&(uploadRec.meeting_id||'')===(targetId||''))setRecordChoices(rows=>[uploadRec,...rows.filter(row=>row.recording_id!==uploadRec.recording_id)])},[uploadRec,targetId])
      function acceptRecoveredRecording(result){setRecordChoices(rows=>[result.recording,...rows.filter(row=>row.recording_id!==result.recording.recording_id)]);if(result.timed){uploadSelectionEpoch.current++;setUploadRec(result.recording);setUpTranscript(result.recording.transcript||'')}}
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

      // 显式恢复：仅在用户点击「恢复该录音」时采用本模块保留的上轮完整录音。
      function adoptRetainedRound(recovered) {
        recovered.done.then(blob => {
          if (!blob || !blob.size || !liveMountedRef.current || liveRoundRef.current) return
          const round = { ...recovered, blob, chunks: [], stopped: true, processing: false, cancelled: false, controller: new AbortController() }
          round.done = Promise.resolve(blob)
          round.url = recovered.url || URL.createObjectURL(blob)
          liveRoundRef.current = round
          leaveCompose()
          bindMeeting(round.meetingId || '')
          setTemplate(round.template); setAudioUrl(round.url)
          setElapsed(round.snapshot?.elapsed || 0); setLiveText(round.transcript || round.snapshot?.liveText || '')
          if (round.snapshot?.minutes && !round.meetingId) setMinutes(round.snapshot.minutes)
          setCaptionStatus('已恢复本模块保留的完整录音；刷新页面或关闭浏览器仍会丢失未下载音频。')
          setLiveStage('完整录音已封存，可回放、下载或显式生成。')
        })
      }

      // Internal pages keep this owner mounted. Actual module unmount seals the final Blob first.
      useEffect(() => {
        liveMountedRef.current = true
        const recovered = retainedLiveRound
        if (recovered && !recovered.cancelled && (!seed?.meetingId || seed.meetingId === recovered.meetingId)) {
          // F2：空白制作不自动载入旧录音；数据保留、改为显式恢复入口，避免静默丢音频。
          if (composeRef.current) setRetainedOffer(recovered)
          else adoptRetainedRound(recovered)
        }
        return () => {
          // R-05：空白制作会话不得用空快照覆盖上一份真实快照。
          if (!composeRef.current) retainedMinutesSnapshot = recoverySnapshot.current
          liveMountedRef.current = false
          requiredMeetingRef.current = null
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
      const dirty = draft !== null && draft !== (minutes?.content || '')
      const contextBusy = Boolean(isDeleting?.(targetId)) || timingBusy || recording || liveStarting || liveBusy || busy || wordBusy || upBusy || upSaving || upProgress >= 0
      const templateReady = templateCatalog.state === 'ready' && templateCatalog.rows.some(row => row.id === template)
      const previewReady = Boolean(minutes && (minutes.word_document || content.trim()))
      const contextLocked = contextBusy || Boolean(audioUrl)
      recoverySnapshot.current = { targetId, template, wordTemplate, minutes, draft, editing, transcript, srcMode, uploadRec, upTranscript, taskModel, elapsed, liveText }
      uploadRecRef.current = uploadRec
      function checkMeetingDeletion(id) {
        const generationOwner = generationInput035.current?.meeting_id
        if ((generationActive035 || generationAbort035.current) && (!generationOwner || generationOwner === id)) return '该会议正在生成纪要，请等待完成。'
        const liveOwner = liveRoundRef.current?.meetingId || targetId
        if (liveOwner === id && (recording || liveStarting || liveBusy || liveRoundRef.current?.processing)) return '该会议正在录音或处理，请先结束任务。'
        const uploadOwner = uploadRec?.meeting_id || targetId
        if (uploadOwner === id && (upBusy || upSaving || upProgress >= 0 || upXhrRef.current)) return '该会议正在上传或转写，请等待完成。'
        if (minutes?.meeting_id === id && dirty) return '该会议有未保存编辑，请先保存或放弃，再重新点击删除。'
        if (uploadRec?.meeting_id === id && upTranscript !== (uploadRec.transcript || '')) return '转写文本有未保存编辑，请先保存或放弃，再重新点击删除。'
        if (targetId === id) {
          if (contextBusy || operationRef.current || wordUploadLock.current) return '该会议有操作正在进行，请等待完成。'
          if (dirty || audioUrl || transcript.trim()) return '该会议有未保存编辑或页面录音，请先保存或放弃，再重新点击删除。'
        }
        return ''
      }
      function clearDeletedMeeting(id) {
        if (retainedMinutesSnapshot?.targetId === id) retainedMinutesSnapshot = null
        if (targetId !== id) return
        minuteLoadSeq.current++; recoverySnapshot.current = null; uploadRecRef.current = null
        bindMeeting(''); setMinutes(null); setDraft(null); setEditing(false); setTranscript('')
        setUploadRec(null); setUpTranscript(''); setGroundingView035(null); setGenerationProgress035(null)
        generationInput035.current = null; setMinuteLoad('idle')
      }
      // R-17：仅粘贴文本(transcript)与已改未保存的转写(upTranscript)此前逃过离开保护。
      const unsavedUpTranscript = Boolean(uploadRec) && upTranscript !== (uploadRec.transcript || '')
      const unsavedText = Boolean(transcript.trim()) || unsavedUpTranscript
      registerGuard?.({ requiresMeeting: Boolean(requiredMeetingSource), requiredPending: Boolean(requiredMeetingRef.current), recording: recording || liveStarting, busy: contextBusy, hasBlob: Boolean(audioUrl), dirty, unsavedText, targetId, seal: sealLive, checkDeletion: checkMeetingDeletion, deleted: clearDeletedMeeting })
      useEffect(() => {
        const beforeUnload = event => { if (recording || liveStarting || audioUrl || dirty || contextBusy || requiredMeetingPending || transcript.trim() || unsavedUpTranscript) { event.preventDefault(); event.returnValue = '' } }
        const onResize = () => setCaptionPosition(pos => clampCaptionPosition(pos.x, pos.y, window.innerWidth, window.innerHeight))
        window.addEventListener('beforeunload', beforeUnload); window.addEventListener('resize', onResize)
        return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('resize', onResize) }
      }, [recording, liveStarting, audioUrl, dirty, contextBusy, requiredMeetingPending, transcript, unsavedUpTranscript])
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
        if (requiredMeetingRef.current) {
          // F2-5：表单可关闭后，这里必须能把表单重新打开，不能变成死路。
          setRequiredMeetingSource(requiredMeetingRef.current); setRequiredMeetingPending(true)
          return showToast('请先填写并提交会议信息（已重新打开表单）。', 'warn')
        }
        if (contextBusy || operationRef.current || upXhrRef.current) return showToast('录音、上传或处理期间绑定已锁定；任务完成后再切换。', 'warn')
        if ((dirty || audioUrl) && !window.confirm('切换会议将放弃当前未保存修改及页面录音。请先保存或下载。继续？')) return
        if (liveRoundRef.current) cancelLive()
        uploadRecRef.current = null
        setUploadRec(null); setUpTranscript(''); leaveCompose(); bindMeeting(id)
      }

      function beginOperation() {
        if (!liveMountedRef.current || isDeleting?.(targetId) || operationRef.current || contextBusy || upXhrRef.current) return null
        const token = {}
        operationRef.current = token
        minuteLoadSeq.current++ // a pending GET must not overwrite this operation's result or draft
        return token
      }
      function operationActive(token) { return liveMountedRef.current && operationRef.current === token }
      function endOperation(token) { if (operationRef.current === token) operationRef.current = null }

      function requireMeetingBeforeGenerate(mode) {
        const existing = requiredMeetingRef.current
        if (existing) {
          // F2-5：保留同一 pending 身份（CreateView 幂等键不丢），只把表单重新变为可见；
          // 模式跟随本次请求，绝不重建 pending（重建会丢 creation_request_id）。
          if (existing.mode !== mode) {
            existing.mode = mode
            existing.round = mode === 'live' ? liveRoundRef.current : null
            existing.recording = mode === 'upload' ? uploadRec : null
          }
          setRequiredMeetingSource(existing); setRequiredMeetingPending(true)
          return
        }
        const pending = { mode, round: mode === 'live' ? liveRoundRef.current : null, recording: mode === 'upload' ? uploadRec : null }
        requiredMeetingRef.current = pending; setRequiredMeetingSource(pending); setRequiredMeetingPending(true)
        // 新一轮补填流程：只在此处复位 CreateView 身份，避免复用上一轮已创建的会议。
        setCreateResetToken(token => token + 1)
      }
      function closeRequiredMeeting() {
        // P0-1/R-15：关闭只改可见性，绝不卸载 CreateView；已填字段与材料全部保留。
        setRequiredMeetingSource(null)
      }

      async function completeRequiredMeeting(created) {
        const pending = requiredMeetingRef.current
        if (!pending || !liveMountedRef.current) throw new Error('当前生成输入已离开，请重新打开会议纪要。')
        const round = pending.round, currentRecording = round?.recording || pending.recording
        if (round && !liveActive(round)) throw new Error('当前录音已变化，未继续生成。')
        if (currentRecording && currentRecording.meeting_id !== created.id) {
          const data = await request('/recordings/' + encodeURIComponent(currentRecording.recording_id), patch({ meeting_id: created.id }))
          if (data.recording?.recording_id !== currentRecording.recording_id || data.recording.meeting_id !== created.id) throw new Error('录音关联回执不一致，未继续生成。')
          if (round) {round.recording = data.recording;associateBrowserRecording(round)}
          else { pending.recording = data.recording; uploadRecRef.current = data.recording; setUploadRec(data.recording) }
        }
        if (!liveMountedRef.current || requiredMeetingRef.current !== pending) throw new Error('当前生成输入已离开，会议及已保存材料保留。')
        if (round) round.meetingId = created.id
        // Binding this input must not load an empty preview or discard the sealed recording.
        skipInitialLoad.current = true; minuteLoadSeq.current++; setMinuteLoad('ready')
        bindMeeting(created.id)
        leaveCompose()
        requiredMeetingRef.current = null; setRequiredMeetingSource(null); setRequiredMeetingPending(false)
        const options = { meetingId: created.id, confirmed: true, recording: pending.recording }
        if (pending.mode === 'live') await finishLive(options)
        else if (pending.mode === 'upload') await generateUpload(options)
        else await generate(options)
      }

      async function generate({ meetingId = targetId, confirmed = false } = {}) {
        if (!transcript.trim()) return showToast(t.transcriptLabel, 'warn')
        if (!templateReady || contextBusy) return
        if (!confirmed && dirty && !window.confirm('生成新纪要将替换预览中的未保存修改。继续？')) return
        if (!meetingId) return requireMeetingBeforeGenerate('paste')
        const token = beginOperation()
        if (!token) return
        const body = minutesTaskBody({ transcript, template, meetingId, model: taskModel, wordTemplateId: wordTemplate?.templateId || '' })
        minuteLoadSeq.current++; setMinuteLoad('ready')
        setBusy(true)
        try {
          const data = await runGeneration035(body)
          // P0-2/R-16：迟到响应只允许写入仍属于本次会议的制作页（范式同 saveContent:operationActive）。
          if (!operationActive(token) || !meetingOwned(meetingId) || (data.minutes?.meeting_id && data.minutes.meeting_id !== meetingId)) return
          setWordTemplate(null)
          setMinutes(data.minutes)
          setDraft(null); setEditing(false)
          setTranscript('')
          showToast(t.generated, 'success')
          refreshMeetings()
        } catch (e) {
          if (operationActive(token)) showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          if (operationActive(token)) setBusy(false); endOperation(token)
        }
      }

      // Admin plain-minutes editor: explicit save; Word layout stays owned by the existing template service.
      async function saveContent() {
        if (!minutes || !dirty || contextBusy || minutes.is_archived) return
        if (!content.trim()) return showToast('纪要正文不能为空，请补充后保存。', 'warn')
        if (content.length > 200000) return showToast('纪要正文超过200000字符，未保存或截断。', 'warn')
        const rich = minutes.word_document?.source_kind === 'rich-edit'
        if (rich && !window.confirm('保存文字修改后，Word将按本纪要原有模板重新排版，不保留此前在Word编辑器中额外调整的排版。继续保存？')) return
        const token = beginOperation()
        if (!token) return
        const currentMinutes = minutes, savedContent = content
        setBusy(true)
        try {
          const data = await request('/minutes/' + encodeURIComponent(currentMinutes.minutes_id), put({ content: savedContent, source: 'edit', discard_rich_format: rich }))
          if (!operationActive(token)) return
          if (data.minutes?.minutes_id !== currentMinutes.minutes_id || data.minutes.content !== savedContent) throw new Error('保存结果与当前正文不一致，已保留编辑内容，请核对后重试。')
          setMinutes(data.minutes); setDraft(null); setEditing(false)
          showToast('正文已保存；导出Word将沿用原有模板排版。', 'success')
          refreshMeetings()
        } catch (error) { if (operationActive(token)) showToast('保存失败：' + error.message, 'error') }
        finally { if (operationActive(token)) setBusy(false); endOperation(token) }
      }

      async function archive() {
        if (!minutes || busy || minutes.is_archived) return
        if (dirty || editing) return showToast('请先保存或取消正文修改，再正式归档。', 'warn')
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
      // Do not mount DocsAPI or generate Word on render/typing. Export is an explicit action.
      async function downloadMinutes() {
        if (dirty) return showToast('正文有未保存的修改，请先点击“保存”，再导出Word。', 'warn')
        if (!minutes || contextBusy) return
        const token = beginOperation()
        if (!token) return
        const currentMinutes = minutes
        setBusy(true)
        try {
          const data = await request('/word-documents/from-minutes/' + encodeURIComponent(currentMinutes.minutes_id), json({}))
          if (!operationActive(token)) return
          if (!safeWordDocument(data.document)) throw new Error('服务器未返回有效的Word文件，未下载旧稿。')
          const bytes = new TextEncoder().encode(currentMinutes.content || '')
          const digest = await crypto.subtle.digest('SHA-256', bytes)
          const hash = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('')
          if (!operationActive(token)) return
          if (data.document.content_sha256 !== hash) throw new Error('服务器正文已变化或Word与已保存正文不一致，请重新打开纪要核对；未下载旧稿。')
          const exported = { ...currentMinutes, word_document: data.document }
          setMinutes(exported)
          downloadConfirmedWord(exported)
          showToast('已按原有模板生成Word，开始下载。', 'success')
        } catch (error) { if (operationActive(token)) showToast('Word导出失败：' + error.message, 'error') }
        finally { if (operationActive(token)) setBusy(false); endOperation(token) }
      }
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
          round.browserId=crypto.randomUUID()
          round.done.then(()=>releaseBrowserRecording(round))
          await request('/voice-control/browser',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'start',browserId:round.browserId})})
          round.browserHeartbeat=setInterval(()=>{void request('/voice-control/browser',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'heartbeat',browserId:round.browserId})}).catch(error=>{if(liveActive(round))setCaptionStatus('录音状态同步失败：'+error.message+'；电脑音频仍保留。')})},5000)
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

      async function finishLive({ meetingId = liveRoundRef.current?.meetingId || targetId, confirmed = false } = {}) {
        const round = liveRoundRef.current
        if (!round || round.cancelled || round.processing || liveStarting || recording || !round.stopped || !round.blob || busy || upBusy) return
        if (!templateReady) return showToast('请先加载真实纪要模板。', 'warn')
        if (!confirmed && dirty && !window.confirm('生成新纪要将替换预览中的未保存修改。继续？')) return
        if (!meetingId) return requireMeetingBeforeGenerate('live')
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
          associateBrowserRecording(round)
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
          // P0-2/R-16：录音轮归属与当前会议绑定都必须仍然一致。
          if (!meetingOwned(round.meetingId) || (data.minutes?.meeting_id && data.minutes.meeting_id !== round.meetingId)) return
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
        if (!file || contextBusy) return
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
          uploadSelectionEpoch.current++;setRecordChoices(rows=>[recording,...rows.filter(row=>row.recording_id!==recording.recording_id)])
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
          if (!secs || secs === uploadRec.duration_seconds) return
          const bound=uploadRec
          request(`/recordings/${encodeURIComponent(uploadRec.recording_id)}`, patch({ duration_seconds: secs }))
            .then((data) => { if (data && data.recording) setUploadRec(current => current === bound ? {...current,duration_seconds:data.recording.duration_seconds} : current) })
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
        if (!uploadRec || !upTranscript.trim() || contextBusy) return
        if (upTranscript === (uploadRec.transcript || '')) return showToast('文字未改变，无需重复保存；原时间绑定保留。', 'success')
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

      async function generateUpload({ meetingId = targetId, confirmed = false, recording: selectedRecording = uploadRec } = {}) {
        if (!selectedRecording || contextBusy || !templateReady) return
        if (!confirmed && dirty && !window.confirm('生成新纪要将替换预览中的未保存修改。继续？')) return
        if (!meetingId) return requireMeetingBeforeGenerate('upload')
        const token = beginOperation()
        if (!token) return
        const generationBase = minutesTaskBody({ transcript: '', template, meetingId, recordingId: selectedRecording.recording_id, source: 'upload', model: taskModel, wordTemplateId: wordTemplate?.templateId || '' })
        minuteLoadSeq.current++; setMinuteLoad('ready')
        setUpBusy(true)
        try {
          let finalTranscript = upTranscript.trim()
          if (!finalTranscript) {
            setUpStage('阿昆正在转写上传的录音，请稍候…')
            const recognized = await request(`/recordings/${encodeURIComponent(selectedRecording.recording_id)}/transcribe`, { method: 'POST' })
            finalTranscript = String(recognized.transcript || '').trim()
            if (!finalTranscript) throw new Error('阿昆未识别到可用语音；未生成会议纪要')
            setUpTranscript(finalTranscript)
            if (recognized.recording) setUploadRec(recognized.recording)
          } else if(finalTranscript !== String(selectedRecording.transcript||'').trim()) {
            setUpStage('正在保存转写文本…')
            const saved=await request(`/recordings/${encodeURIComponent(selectedRecording.recording_id)}`, patch({ transcript: finalTranscript }))
            if(!saved?.recording)throw new Error('转写保存结果缺失，未继续生成')
            setUploadRec(saved.recording)
          }
          setUpStage('正在根据完整转写生成会议纪要…')
          const body = { ...generationBase, transcript: finalTranscript }
          const data = await runGeneration035(body)
          // P0-2/R-16：晚到的上传生成结果不得写入新制作页。
          if (!operationActive(token) || !meetingOwned(meetingId) || (data.minutes?.meeting_id && data.minutes.meeting_id !== meetingId)) return
          setWordTemplate(null)
          setMinutes(data.minutes)
          setDraft(null); setEditing(false)
          showToast(t.generated, 'success')
          refreshMeetings()
        } catch (e) {
          if (operationActive(token)) showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          if (operationActive(token)) { setUpStage(''); setUpBusy(false) }
          endOperation(token)
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
      const captionBinding = JSON.stringify([targetId, audioUrl, recording, liveRoundRef.current?.recording?.recording_id || ''])
      const captionLines = !recording && liveRoundRef.current?.recording?.recording_id ? h(SavedCaptionPlayback, { key: captionBinding, meetingId: targetId, recordingId: liveRoundRef.current.recording.recording_id, revisionKey: liveText, fallbackText: liveText, audioRef: liveAudioRef,locked:contextBusy||dirty,onRecoveryBusy:setTimingBusy,onRecovered:result=>{if(result.timed&&liveRoundRef.current){liveRoundRef.current.recording=result.recording;liveRoundRef.current.transcript=result.recording.transcript||'';setLiveText(result.recording.transcript||'')}}, onLoadedMetadata: event => { const duration = event.currentTarget.duration; setPlayDuration(Number.isFinite(duration) ? duration : elapsed) }, onTimeUpdate: event => setPlayPosition(event.currentTarget.currentTime) }) : h(CaptionViewport, { key: captionBinding, sourceKey: captionBinding, entries: displayCaptionEntries,
        sourceUrl: audioUrl, audioRef: liveAudioRef, live: recording, speakerNames,
        onRename: (speakerId, speaker) => { const next = window.prompt('仅在当前实时预览中重命名发言人', speaker); if (next?.trim()) setSpeakerNames(names => ({ ...names, [speakerId]: next.trim().slice(0, 32) })) } })
      const livePanel = h('div', { className: 'mt-stack' },
        !liveSupported ? h('div', { className: 'mt-notice' }, '需要安全HTTPS页面、麦克风权限和MediaRecorder；建议Edge/Chrome。') : null,
        h('div', { className: 'mt-rec-center' },
          h('button', { className: 'mt-record-knob' + (recording ? ' recording' : ''), disabled: liveBusy || liveStarting || busy || upBusy || !liveSupported || !templateReady, onClick: recording ? sealLive : startLive, 'aria-label': recording ? '停止并封存电脑录音' : '开始电脑麦克风录音' }, recording ? '■' : '🎙'),
          h('b', { className: 'mt-time' }, mmss(elapsed)),
          h('span', { className: 'mt-muted' }, recording ? '正在录音 · 点击停止只封存，不自动生成' : audioUrl ? '完整录音已封存，可回放和下载' : '点击开始录音'),
        ),
        liveStage ? h('div', { className: 'mt-notice', role: 'status' }, liveBusy || liveStarting ? h('span', { className: 'mt-spin' }) : null, ' ', liveStage) : null,
        h('div', { className: 'mt-row mt-between' }, h('div', { className: 'mt-row', style: { flexWrap: 'wrap' } }, h('b', null, '字幕预览'),
          h('select', { className: 'mt-select', value: captionSource, disabled: recording || liveStarting, 'aria-label': '实时字幕来源', style: { width: 'auto', maxWidth: 260 }, onChange: event => {
            if (!recording && !liveStarting && ['browser', 'local'].includes(event.target.value)) setCaptionSource(event.target.value)
          } }, h('option', { value: 'browser' }, '浏览器 SpeechRecognition'), h('option', { value: 'local' }, '服务器本地模型'))), h('button', { className: 'mt-btn small', disabled: !recording && !displayCaptionEntries.length, onClick: () => { setCaptionPosition(pos => clampCaptionPosition(pos.x, pos.y, window.innerWidth, window.innerHeight)); setFloatingCaption(open => !open) } }, floatingCaption ? '收回字幕' : '悬浮字幕')),
        h('div', { className: 'mt-muted' }, captionStatus || (captionSource === 'local' ? '服务器本地模型分段识别；浏览器需保持局域网连接。' : '浏览器SpeechRecognition提供临时字幕；纪要以完整录音正式转写为准。')),
        h('div',{className:floatingCaption&&visible?'mt-caption-float':undefined,style:floatingCaption&&visible?{left:captionPosition.x,top:captionPosition.y}:undefined},
          floatingCaption&&visible?h('div',{className:'mt-caption-handle',onPointerDown:beginCaptionDrag,onPointerMove:moveCaption,onPointerUp:()=>{captionDragRef.current=null},onPointerCancel:()=>{captionDragRef.current=null}},h('b',null,'录音字幕'),h('button',{className:'mt-btn small',onClick:()=>setFloatingCaption(false)},'收回')):null,captionLines),
        audioUrl ? h('div', { className: 'mt-stack' },
          !recording && liveRoundRef.current?.recording?.recording_id ? null : h('audio', { ref: liveAudioRef, controls: true, src: audioUrl, style: { width: '100%' }, onLoadedMetadata: event => { const duration = event.currentTarget.duration; setPlayDuration(Number.isFinite(duration) ? duration : elapsed) }, onTimeUpdate: event => setPlayPosition(event.currentTarget.currentTime) }),
          h('div', { className: 'mt-row' }, h('span', { className: 'mt-time' }, mmss(playPosition)), h('input', { type: 'range', min: 0, max: Math.max(1, playDuration || elapsed), step: 0.1, value: Math.min(playPosition, playDuration || elapsed || 1), className: 'mt-seek', disabled: !(playDuration || elapsed), 'aria-label': '录音回放位置', onChange: event => { const seconds = Number(event.target.value); if (liveAudioRef.current) liveAudioRef.current.currentTime = seconds; setPlayPosition(seconds) } }), h('span', { className: 'mt-time' }, mmss(playDuration || elapsed))),
          h('div', { className: 'mt-row' }, h('a', { className: 'mt-btn small', href: audioUrl, download: recFileName }, '↓ ' + t.downloadRec), h('button', { className: 'mt-btn small danger', disabled: liveBusy, onClick: discardLive }, '放弃录音')),
        ) : recording || liveStarting ? h('button', { className: 'mt-btn small danger', onClick: discardLive }, t.cancelRec) : null,
        h('div', { className: 'mt-row mt-between' }, h(TaskModelPicker, { catalog: modelCatalog, value: taskModel, onChange: setTaskModel, disabled: contextBusy }), h('button', { className: 'mt-btn primary', disabled: !audioUrl || contextBusy || !templateReady, onClick: () => openGenSetup035('live') }, liveBusy ? '正在正式处理…' : '✦ 生成纪要')),
      )

      // —— 面板 B：上传录音 ——
      const uploadPanel = h('div', { className: 'mt-stack' },
        h('label',null,'当前录音',h('select',{className:'mt-select','aria-label':'选择上传录音',value:uploadRec?.recording_id||'',disabled:contextBusy,onChange:event=>{const row=recordChoices.find(item=>item.recording_id===event.target.value);if(!row||row.recording_id===uploadRec?.recording_id)return;if(upTranscript!==(uploadRec?.transcript||'')&&!window.confirm('当前有未保存的转写文字，切换将放弃这些未保存文字。继续？'))return;uploadSelectionEpoch.current++;upAudioRef.current?.pause();setUploadRec(row);setUpTranscript(row.transcript||'')}},h('option',{value:''},'请选择录音'),(uploadRec&&!recordChoices.some(row=>row.recording_id===uploadRec.recording_id)?[uploadRec,...recordChoices]:recordChoices).map((row,index)=>h('option',{key:row.recording_id,value:row.recording_id},row.filename+' · '+(row.created_at||'')+' · '+row.recording_id.slice(-6))))),
        h('button',{className:'mt-btn small',disabled:contextBusy,onClick:()=>setRecordChoicesEpoch(n=>n+1)},'刷新录音列表'),
        recordChoicesError?h('div',{role:'alert'},recordChoicesError,h('button',{className:'mt-btn small',disabled:contextBusy,onClick:()=>setRecordChoicesEpoch(n=>n+1)},'重试录音列表')):null,
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
              // Audio is owned by the shared saved-caption source below.
            )
          : null,
        uploadRec ? h(SavedCaptionPlayback, { key: JSON.stringify([targetId, uploadRec.recording_id]), meetingId: targetId, recordingId: uploadRec.recording_id, revisionKey: JSON.stringify([uploadRec.transcript||'',uploadRec.transcript_origin||'',uploadRec.transcript_audio_sha256||'']), locked:contextBusy||dirty||upTranscript!==(uploadRec.transcript||''),onRecoveryBusy:setTimingBusy,onRecovered:acceptRecoveredRecording, fallbackText: uploadRec.transcript || '', audioRef: upAudioRef, onLoadedMetadata: saveRecDuration }) : null,
        h('details', { className: 'mt-stack' }, h('summary', null, '修订或导入转写文字'),
        h('textarea', { className: 'mt-textarea', style: { minHeight: 110 }, value: upTranscript, disabled:contextBusy, placeholder: '在此修订转写文字；保存修改后需重新获取可靠时间才能同步高亮。', onChange: (e) => setUpTranscript(e.target.value) }),
        h('div', { className: 'mt-row' },
          h('button', { className: 'mt-btn small', disabled: !uploadRec || !upTranscript.trim() || contextBusy, onClick: saveUpTranscript }, '💾 ', t.saveTranscript),
          h('button', { className: 'mt-btn small', disabled:contextBusy, onClick: () => upTxtRef.current && upTxtRef.current.click() }, t.importTxtSrt),
          h('input', { ref: upTxtRef, type: 'file', accept: '.txt,.srt', style: { display: 'none' }, onChange: importUpTxt }),
        )), 
        h('div', { className: 'mt-muted', role: 'status' }, '上传录音的浏览器语音识别已停用；可继续回放、手工修订，或使用本地阿昆对完整录音正式转写。'),
      )

      // —— 面板 C：粘贴文本 ——
      const pastePanel = h('div', { className: 'mt-stack' },
        h('div', { className: 'mt-row mt-between' },
          h('span', { className: 'mt-muted' }, t.transcriptLabel),
          h('button', { className: 'mt-btn small', onClick: () => txtRef.current && txtRef.current.click() }, t.importTxt),
        ),
        h('textarea', { className: 'mt-textarea', style: { minHeight: 150 }, value: transcript, placeholder: '[14:30:00] 张总：本季度预算……', onChange: (e) => setTranscript(e.target.value) }),
        h('input', { ref: txtRef, type: 'file', accept: '.txt,.md,.srt', style: { display: 'none' }, onChange: (e) => importFile(e, 'transcript') }),
        h('div', { className: 'mt-row mt-between' }, h(TaskModelPicker, { catalog: modelCatalog, value: taskModel, onChange: setTaskModel, disabled: contextBusy }), h('button', { className: 'mt-btn primary', disabled: !transcript.trim() || contextBusy || !templateReady, title: contextBusy ? t.generating : !templateReady ? '纪要模板未就绪，请先刷新模板 / 模型' : !transcript.trim() ? t.transcriptLabel : (targetId ? '' : '未绑定会议：生成前须填写会议信息并创建会议'), onClick: () => openGenSetup035('paste') }, busy ? t.generating : '✦ ' + t.generateBtn)),
      )

      const splitLatestRef=useRef(null);splitLatestRef.current={targetId,blocked:contextBusy||dirty}
      useEffect(()=>()=>{splitLatestRef.current=null},[])
      /* mtGenOptFuse-20261019：点「生成纪要」即打开设置弹窗，就地选择 会议绑定 / 纪要模板 / 上传Word模板；
       * 未绑定时沿用弹窗内既有的会议信息表单（CreateView）创建后继续生成。 */
      const [genSetupOpen035, setGenSetupOpen035] = useState(false)
      const [genSetupMode035, setGenSetupMode035] = useState('paste')
      const previewRef035 = useRef(null)
      const lastMinutesId035 = useRef(null)
      useEffect(() => {
        const id = minutes && minutes.minutes_id ? minutes.minutes_id : ''
        if (!id) { lastMinutesId035.current = ''; return undefined }
        if (lastMinutesId035.current === id) return undefined
        lastMinutesId035.current = id
        const timer = setTimeout(() => { try { previewRef035.current?.scrollIntoView?.({ block: 'nearest' }) } catch { /* 非致命 */ } }, 60)
        return () => clearTimeout(timer)
      }, [minutes && minutes.minutes_id])
      const minutesFallback035 = minuteLoad === 'loading'
        ? h('div', { className: 'mt-muted', role: 'status' }, '正在加载该会议纪要…')
        : minuteLoad === 'error'
          ? h('div', { className: 'mt-notice' }, '纪要读取失败，不代表无记录。', h('button', { className: 'mt-btn small', onClick: () => loadMinutes(targetId) }, '重试'))
          : null
      function openGenSetup035(mode) {
        setGenSetupMode035(mode)
        setGenSetupOpen035(true)
        // 未绑定：沿用既有必填流程（同一 pending 身份、幂等键不丢）；已绑定：只开设置弹窗，不加 pending。
        if (!targetId) requireMeetingBeforeGenerate(mode)
      }
      function closeGenSetup035() {
        setGenSetupOpen035(false)
        if (targetId) { requiredMeetingRef.current = null; setRequiredMeetingPending(false); setRequiredMeetingSource(null) }
        else closeRequiredMeeting()
      }
      function changeMeetingFromSetup035(id) {
        if (id === '') { requireMeetingBeforeGenerate(genSetupMode035); return }
        // 选定既有会议：先解除必填 pending，否则 changeMeeting 会以「请先填写会议信息」阻断改绑。
        requiredMeetingRef.current = null
        setRequiredMeetingPending(false)
        setRequiredMeetingSource(null)
        changeMeeting(id)
      }
      async function runGenSetup035() {
        const mode = genSetupMode035
        setGenSetupOpen035(false)
        requiredMeetingRef.current = null
        setRequiredMeetingPending(false)
        setRequiredMeetingSource(null)
        if (mode === 'live') return finishLive({ meetingId: targetId, confirmed: true })
        if (mode === 'upload') return generateUpload({ meetingId: targetId, confirmed: true })
        return generate({ meetingId: targetId, confirmed: true })
      }

      return h('div', { className: 'mt-stack mt-minutes-view' },
        // P0-1/R-15：表单必须常驻（仅 display 隐藏）。卸载会丢弃 creation_request_id /
        // createdMeeting / materialRequestIds，重试将以新 UUID 重新建会。
        // onClose 提供可关闭；不再用 mandatory（其 Escape 阻断与焦点陷阱随之取消）。
        h('div', { className: 'mt-required-host', style: { display: (genSetupOpen035 || requiredMeetingSource) ? '' : 'none' } },
          h(Modal, { title: '生成纪要设置', onClose: closeGenSetup035 },
            h('div', { className: 'mt-genopt-body035' },
              h('label', { className: 'mt-field' }, '会议绑定（未绑定时，生成前须填写会议信息）', h('select', { className: 'mt-select', value: targetId, disabled: contextBusy, title: audioUrl ? '本页已封存录音：确认放弃录音后即可改绑' : contextBusy ? '任务处理中，暂不能改绑' : '' /* mtGenOptSelFix-20261019 */, onChange: event => changeMeetingFromSetup035(event.target.value) }, h('option', { value: '' }, '暂不绑定 / 生成前填写会议信息'), meetings.map(item => h('option', { value: item.id, key: item.id }, item.title + '（' + fmtDay(item.start_time) + '）')))),
              h('label', { className: 'mt-field' }, '纪要模板', h('select', { className:'mt-select', value:template, disabled:templateCatalog.state!=='ready', onChange:event=>setTemplate(event.target.value) }, templateCatalog.rows.map(item=>h('option',{key:item.id,value:item.id},item.name)))),
              h('div', { className:'mt-field' }, h('span', null, '上传Word模板（仅本次）'),
                h('div', {className:'mt-word-pick035'}, h('button',{className:'mt-btn small',disabled:contextBusy,onClick:()=>wordInput.current?.click()},wordBusy?'验证中…':'选择文件'),
                  h('span',{className:'mt-chip',title:wordTemplate?.name || '未选择文件'},wordTemplate?.name || '未选择文件'),wordTemplate?h('button',{className:'mt-btn small',disabled:contextBusy,onClick:removeWordTemplate,'aria-label':'移除本次Word模板'},'移除'):null),
                h('input',{ref:wordInput,type:'file',accept:'.docx',style:{display:'none'},onChange:pickWordTemplate}),
                h('span',{className:'mt-muted'},'成功生成后消费一次；人工编辑／导出不会消费模板。')),
              contextBusy ? h('div', { className: 'mt-muted' }, '任务处理中，暂不能改绑；任务结束后可再调整。') : audioUrl ? h('div', { className: 'mt-muted' }, '本页已封存录音：改绑会议时会先询问是否放弃录音，确认后即可切换。') : null,
              h('div', { className:'mt-row mt-context-status035' }, MinutesPill({value:statusValue,t}),h('button',{className:'mt-btn small',disabled:contextBusy,onClick:refreshCatalogs},'刷新模板 / 模型')),
              templateCatalog.state !== 'ready' ? h('div', { className: 'mt-notice' }, templateCatalog.state === 'loading' ? '模板加载中…' : '真实模板加载失败，请重试。') : null,
            ),
            targetId ? null : h('p', { className: 'mt-muted' }, '本次材料尚未绑定会议。请填写并创建会议，保存材料后将自动生成纪要。本表单可关闭：已填内容与材料会保留，暂停生成；再次点击生成可继续，不会重复建会。'),
            targetId ? null : h(CreateView, { t, beforeMinutes: true, showToast, refreshMeetings, onCreated: completeRequiredMeeting, resetToken: createResetToken }),
            h('div', { className: 'mt-row', style: { justifyContent: 'flex-end', marginTop: 10 } },
              h('button', { className: 'mt-btn', onClick: closeGenSetup035 }, targetId ? '取消' : '稍后再填（关闭表单，保留已填内容与材料）'),
              targetId ? h('button', { className: 'mt-btn primary', disabled: contextBusy || !templateReady, onClick: runGenSetup035 }, '开始生成') : null,
            ),
          ),
        ),
        retainedOffer ? h('div', { className: 'mt-notice', role: 'status' },
          '检测到上次离开本模块时保留的完整录音（未下载）。本次为空白制作，未自动载入。',
          h('button', { className: 'mt-btn small', onClick: () => { const pending = retainedOffer; setRetainedOffer(null); adoptRetainedRound(pending) } }, '恢复该录音'),
          h('button', { className: 'mt-btn small', onClick: () => setRetainedOffer(null) }, '忽略'),
        ) : null,
        composing && !targetId ? h('div', { className: 'mt-notice', role: 'status' }, '本次为全新空白制作：未载入任何旧会议、录音或纪要。可在下方绑定会议，或粘贴文本 / 上传录音后生成。') : null,
        h(SplitLegacyPanel,{key:targetId,meetingId:targetId,locked:contextBusy||dirty,showToast,onRecoveryBusy:setTimingBusy,onLatest:async id=>{if(splitLatestRef.current?.blocked)return;const owner=targetId,seq=++minuteLoadSeq.current;try{const data=await request('/minutes/'+encodeURIComponent(id));if(splitLatestRef.current?.targetId===owner&&!splitLatestRef.current?.blocked&&seq===minuteLoadSeq.current&&data.minutes?.meeting_id===owner){setMinutes(data.minutes);setDraft(null);setEditing(false)}}catch(error){if(splitLatestRef.current?.targetId===owner)showToast(error.message,'error')}}}),
        h('section', { className: 'mt-card mt-stack', 'aria-label': '纪要来源' },
          h('div', { className: 'mt-seg mt-source-tabs', role: 'tablist' }, [['live', '🎙 实时录音'], ['upload', '📁 上传录音'], ['paste', '⌨ 粘贴文本']].map(([id, label]) => h('button', { key: id, 'aria-pressed': srcMode === id, disabled: contextBusy && !recording && !liveStarting, onClick: () => switchSrc(id) }, label))),
          srcMode === 'live' ? livePanel : null,
          srcMode === 'upload' ? h('div', { className: 'mt-stack' }, uploadPanel, h('div', { className: 'mt-row mt-between' }, h(TaskModelPicker, { catalog: modelCatalog, value: taskModel, onChange: setTaskModel, disabled: contextBusy }), h('button', { className: 'mt-btn primary', disabled: !uploadRec || contextBusy || !templateReady, onClick: () => openGenSetup035('upload') }, upBusy ? upStage || '正在处理…' : '✦ ' + t.generateBtn))) : null,
          srcMode === 'paste' ? pastePanel : null,
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
              h('span', { className:'mt-muted', role:'status' }, minutes?.is_archived ? '已归档，只读查看' : dirty ? '正文已修改，请手动保存' : '普通文本编辑 · Word沿用原有模板'),
              h('button', { className: 'mt-btn small primary', disabled: !minutes || !dirty || contextBusy || minutes?.is_archived, onClick: () => saveContent() }, '保存'),
              h('button', { className: 'mt-btn small', disabled: !previewReady || contextBusy, onClick: copyAll }, '复制'),
              h('button', { className: 'mt-btn small', disabled: !minutes || contextBusy || (!previewReady && !dirty), onClick: downloadMinutes }, '导出Word'),
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
            h('textarea', { className: 'mt-textarea', 'aria-label': '纪要正文', 'data-minutes-editor': 'plain-admin-v1',
              style: { minHeight: 260, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12.5, boxSizing: 'border-box' },
              value: content, readOnly: Boolean(minutes.is_archived), disabled: contextBusy,
              onChange: event => { if (!operationRef.current && !contextBusy && !minutes.is_archived) { setDraft(event.target.value); setEditing(true) } } }),
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
      // F2：每次进入插件默认进入「会议纪要」（空白制作由 MinutesView 的 composing 上下文保证）。
      const [tab, setTab] = useState('minutes')
      const [meetings, setMeetings] = useState([])
      const [loading, setLoading] = useState(true)
      const [toasts, setToasts] = useState([])
      const [detail, setDetail] = useState(null)
      const [modelsOpen, setModelsOpen] = useState(false)
      const [minutesSeed, setMinutesSeed] = useState(null)
      const [historyMeeting, setHistoryMeeting] = useState(null)
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
      const deletionLockRef = useRef(null)
      const [deletingId, setDeletingId] = useState('')
      const [deletionResult, setDeletionResult] = useState(null)
      const isMeetingDeleting = useCallback(id => deletionLockRef.current === id, [])
      const tabRef = useRef(tab); tabRef.current = tab
      const registerMinutesGuard = useCallback(guard => { minutesGuardRef.current = guard }, [])
      // F2-8：宿主侧离开守卫。selectPanel 同步不可取消，只能在包装层做「确认后放行」。
      const confirmPanelLeave = useCallback(() => {
        const guard = minutesGuardRef.current
        const reasons = []
        if (guard?.recording) reasons.push('正在录音')
        else if (guard?.hasBlob) reasons.push('有未下载的完整录音')
        if (guard?.busy) reasons.push('有任务正在处理')
        if (guard?.dirty) reasons.push('有未保存的纪要修改')
        if (guard?.unsavedText) reasons.push('有未生成的转写 / 粘贴文本')
        if (guard?.requiredPending) reasons.push('会议信息表单尚未提交')
        if (!reasons.length) return true
        return window.confirm('离开会议助手会卸载本模块页面：' + reasons.join('、') + '。未提交的会议信息、未下载的录音与未保存的编辑都会丢失（刷新页面同样丢失）。确定离开？')
      }, [])
      useEffect(() => {
        panelLeaveGuard = { confirmLeave: confirmPanelLeave }
        return () => { if (panelLeaveGuard?.confirmLeave === confirmPanelLeave) panelLeaveGuard = null }
      }, [confirmPanelLeave])
      async function deleteMeeting(meeting) {
        if (deletionLockRef.current) return
        const check = () => minutesGuardRef.current?.checkDeletion?.(meeting.id) || ''
        let reason = check()
        if (reason) { setDeletionResult({ ok: false, message: reason }); return }
        if (!window.confirm('永久删除会议“' + meeting.title + '”？\n将删除本会议明确专属的录音、字幕、纪要、历史版本及导出文件，不可恢复。共享或归属不明文件将保留并列明。\n不包括聊天历史、知识库独立副本、OnlyOffice内部缓存、系统备份或已下载到设备的文件。')) return
        reason = check()
        if (reason) { setDeletionResult({ ok: false, message: reason }); return }
        deletionLockRef.current = meeting.id; setDeletingId(meeting.id); setDeletionResult(null)
        try {
          // Keep the full partial-failure receipt; the generic request helper discards it.
          const response = await fetch(API + '/meetings/' + encodeURIComponent(meeting.id), { method: 'DELETE', credentials: 'same-origin' })
          const result = await response.json()
          if (!response.ok || result?.ok !== true || result.meetingId !== meeting.id || !Array.isArray(result.retained)) {
            setDeletionResult({ ok:false, message:result?.reason || '删除未完成或结果无法确认，日程保留；请刷新核对后重试。', removed:result?.removed || [], retained:result?.retained || [], pending:result?.pending || [] }); return
          }
          minutesGuardRef.current?.deleted?.(meeting.id)
          setDetail(current => current?.id === meeting.id ? null : current)
          setHistoryMeeting(current => current?.id === meeting.id ? null : current)
          setMeetings(current => current.filter(row => row.id !== meeting.id))
          setMinutesSeed(current => current?.meetingId === meeting.id ? null : current)
          setDeletionResult({ ...result, message:result.retained.length ? '会议已删除，以下文件因共享或归属不明予以保留' : '会议及对应录音、纪要已删除。' })
          await refreshMeetings()
        } catch (error) {
          setDeletionResult({ok:false,message:'删除结果无法确认，请刷新核对后重试。网络错误不代表删除成功。'})
        } finally { deletionLockRef.current = null; setDeletingId('') }
      }
      const navigate = useCallback(async target => {
        const guard = minutesGuardRef.current
        if (guard?.requiresMeeting && target !== 'minutes') {
          // F2-7：原来是静默 return false，用户看不到任何原因。改为可见确认，不再静默拦截。
          if (!window.confirm('「填写会议信息后生成纪要」表单尚未提交。切页后本模块会保留已填内容与材料（刷新页面才会丢失）。确定离开会议纪要页？')) return false
        }
        if (tabRef.current === 'minutes' && target !== 'minutes' && guard) {
          if (guard.recording) {
            if (!window.confirm('离开前停止并封存完整录音？录音会保留在本模块。')) return false
            if (!await guard.seal()) return false
          } else if ((guard.busy || guard.dirty || guard.hasBlob || guard.unsavedText) && !window.confirm('切页后本模块继续保留当前录音、草稿、未生成的转写文本和处理任务；刷新页面仍会丢失未下载音频与未提交内容。继续？')) return false
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
      // F1：日程卡/详情弹窗的「纪要」不再跳制作页，改为打开归属单一 meetingId 的历史弹窗。
      const openMeetingHistory = useCallback(meeting => {
        if (!meeting || !meeting.id) return
        setDetail(null)
        setHistoryMeeting(meeting)
      }, [])
      // 保留 gotoMinutes:4835 既有语义不变：只有用户显式「在制作页打开」才走该路径。
      const openProductionFromHistory = useCallback(async meetingId => {
        setHistoryMeeting(null)
        await gotoMinutes(meetingId)
      }, [gotoMinutes])
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
        const target = sectionTab[nav.tab] || 'minutes'
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
        // 插件自身导航走旁路：否则会被自己安装的离开确认拦住（自锁）。
        selfPanelNav = true
        try { layout?.selectPanel?.(null) } finally { selfPanelNav = false }
      }

      return h('div', { className: 'mt-app' + (railExpanded ? ' mt-rail-expanded mt-rail-lock' : '') },
        h('style', null, MEETING_CSS),
        railExpanded ? h('button', { type: 'button', className: 'mt-rail-shade', 'aria-label': '收起会议问答导航', onClick: () => setRailExpanded(false) }) : null,
        h('aside', { className: 'mt-rail', 'aria-label': '会议模块左侧栏', onPointerDown: mtSwipeDown, onPointerMove: mtSwipeMove, onPointerUp: mtSwipeEnd, onPointerCancel: mtSwipeEnd },
          h('div', { className: 'mt-brand' }, h('span', { className: 'mt-brandicon', 'aria-hidden': true }, '会'), h('span', { className: 'mt-brandname' }, '会议助手')),
          h('button', { type: 'button', className: 'mt-rail-toggle', 'aria-label': '收起会议导航', onClick: () => setRailExpanded(false) }, '收起导航 ×'),
          h('nav', { className: 'mt-railnav', 'aria-label': '会议子页面' },
            h('div', { className: 'mt-railsection' }, '会议工作区'),
            [['minutes', '会议纪要', '纪'], ['schedule', '会议日程', '日'], ['ask', '会议问答', '问']].map(([id, label, glyph]) => h('button', {
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
          h('div', { className: 'mt-railfoot' },
            h('button', { type: 'button', className: 'mt-railback', onClick: goBack, title: '返回主页', 'aria-label': '返回主页' }, '↩ ', h('span', { className: 'txt' }, '返回主页')),
            h('button', { type: 'button', className: 'mt-railback', onClick: () => setModelsOpen(true), title: t.modelsBtn, 'aria-label': t.modelsBtn }, '🧠 ', h('span', { className: 'txt' }, t.modelsBtn)),
          ),
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
          deletionResult ? h('div', { className:'mt-notice', role:'status' },
            h('strong',null,deletionResult.message),
            (deletionResult.retained || []).map((row,i)=>h('div',{key:'retained-'+i}, row.file + '：' + row.reason)),
            !deletionResult.ok && deletionResult.removed?.length ? h('div',null,'已删除：'+deletionResult.removed.join('、')) : null,
            !deletionResult.ok && deletionResult.pending?.length ? h('div',null,'待处理：'+deletionResult.pending.join('、')) : null,
            h('button',{className:'mt-btn small',onClick:()=>setDeletionResult(null)},'关闭提示')) : null,
          loading && !meetings.length && tab !== 'ask' ? h('div', { className: 'mt-muted' }, t.loading) : null,
          meetingState === 'error' ? h('div', { className: 'mt-notice' }, '会议清单读取失败，数量暂不可确认；保留已加载内容。', h('button', { className: 'mt-btn small', onClick: refreshMeetings }, '重试')) : null,
          tab === 'schedule'
            ? meetingState !== 'ready' && !meetings.length ? null : h(ScheduleView, { t, lang, meetings, onDetail: setDetail, onNew: () => navigate('create'), onHistory: openMeetingHistory, gotoAsk: (m) => gotoAsk(m), togglePin, showToast, refreshMeetings, onDelete:deleteMeeting, deletingId })
            : null,
          tab === 'create'
            ? h(CreateView, { t, onCreated: () => setTab('schedule'), showToast, refreshMeetings })
            : null,
          h('section', { hidden: tab !== 'minutes', className: 'mt-minutes-owner' }, h(MinutesView, { t, lang, meetings, showToast, seed: minutesSeed, refreshMeetings, registerGuard: registerMinutesGuard, isDeleting:isMeetingDeleting, visible: tab === 'minutes', key: 'minutes-view' })),
          tab === 'ask'
            ? h(AskView, { t, meetings, showToast, seed: askSeed, refreshMeetings, sessions: qaSessions, refreshSessions: refreshQaSessions, onActiveSession: setQaActiveId, onNewChat: startNewChat, meetingsKnown: meetingState === 'ready', key: 'ask-view' })
            : null,
        ),
        ),
        detail ? h(DetailModal, { t, meeting: detail, onClose: () => setDetail(null), onHistory: openMeetingHistory, gotoAsk: (m) => gotoAsk(m, t.detailJumpAsk(m.title)) }) : null,
        modelsOpen ? h(LocalModelsModal, { t, onClose: () => setModelsOpen(false) }) : null,
        // F1：独立历史弹窗（始终带 onClose，可关闭）。不读写 retained*、不注册 guard。
        historyMeeting ? h(MeetingHistoryModal, { t, meeting: historyMeeting, onClose: () => setHistoryMeeting(null), onOpenProduction: openProductionFromHistory, showToast }) : null,
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
        // F2-8：宿主对 layout.selectPanel 没有任何可取消钩子（同步 void，见基线 §5 门禁 B），
        // 因此保存原方法 → 判守卫 → 放行或拦截 → dispose 时恢复原方法。
        // 若实例被冻结/代理而包装失败，则如实降级为「插件内自保 + beforeunload」，
        // 并把状态写入 window.__meetaiPanelLeaveGuard 供验收取证（只读诊断，不参与业务）。
        const layoutService = ctx.layout || (ctx.get && ctx.get('layout')) || null
        const originalSelectPanel = layoutService && typeof layoutService.selectPanel === 'function' ? layoutService.selectPanel : null
        if (originalSelectPanel) {
          try {
            layoutService.selectPanel = function (panelId, ...rest) {
              if (!selfPanelNav && panelId !== 'cap:meeting' && panelLeaveGuard && typeof panelLeaveGuard.confirmLeave === 'function' && !panelLeaveGuard.confirmLeave()) return undefined
              return originalSelectPanel.call(this, panelId, ...rest)
            }
            if (layoutService.selectPanel !== originalSelectPanel) {
              panelGuardState = 'wrapped'
              cleanups.push(() => { try { layoutService.selectPanel = originalSelectPanel } catch { /* 恢复尽力而为 */ } })
            } else {
              panelGuardState = 'frozen'
            }
          } catch { panelGuardState = 'frozen' }
        }
        try { window.__meetaiPanelLeaveGuard = panelGuardState } catch { /* 仅诊断 */ }
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
          const nav = { tab: detail.section || 'minutes', meetingId: detail.meetingId || '' }
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
        const linkedMeeting=new URL(window.location.href).searchParams.get('huibaoMeeting')
        if(linkedMeeting)request('/meetings').then(data=>{if((data.meetings||[]).some(m=>m.id===linkedMeeting))onOpenMeeting({detail:{section:'minutes',meetingId:linkedMeeting}})}).catch(()=>{})
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

/* PATCH:V5-o2pack-panel */
/* 授权锁屏：内联自 license-panel.js（判 usable，零票轮询） */
/* license-panel.js —— DSH 插件授权锁屏（浏览器侧，零依赖，内联进插件 client.js）
 *
 * v1.2 · 2026-10-29  ★ SILENT：默认**不再弹激活界面** ★
 *
 * 设计约束（改这个文件前必须读）：
 *  0. 【v1.2 最重要】只要 state.silent 为真（门禁 v1.2 默认），本面板**永不锁屏**。
 *     客户装完即用，看不到任何激活码输入框。这是产品决定，不是降级兜底。
 *     要恢复锁屏，需服务端/环境变量把门禁切回严格模式（DSH_LICENSE_SILENT=0）。
 *  1. 判「能不能用」只看 state.usable，**不是** state.ready。
 *     gate.state() 的 ready = !reason && !pending —— pool=0 时它依然是 true。
 *     用 ready 判会出现「界面显示已授权，一点就 403」（方案 §4.5 / 计划 F5）。
 *  2. 软门禁只允许调 /license/state（零票端点）。禁止在轮询里探业务接口 ——
 *     业务接口走 allow() 会消耗票，用户"只是开着页面"就会把票池吃空。
 *  3. 网络故障一律 fail-open：不锁屏、只提示并继续重试。
 *     平台停服/断网不该让客户以为授权丢了（T12）。
 *  4. 不 import 任何东西：由 license_build.py 直接把本文件拼进 client.js。
 *  5. 【v1.2】pool===0 不再兜底成 no_ticket —— 免票模式下 pool 恒为 0，
 *     旧兜底会把“正常可用”误判成“票已用尽”，是 v1.1 误锁屏的元凶之一。
 *
 * 用法（插件 client.js 里）：
 *   mountLicenseGate({ pluginId: 'huiwen-ppt', prefix: '/api/huiwen-ppt' });
 */
(function (global) {
  'use strict';

  var REASONS = {
    offline_no_license: { t: '本机尚未激活', d: '导入离线激活包，或输入激活码后联网激活。', act: true },
    no_ticket: { t: '本地授权票已用尽', d: '联网自动补票，或导入新的离线激活包。', act: true },
    expired: { t: '授权已到期', d: '请联系服务商续期。', act: true },
    revoked: { t: '授权已停用', d: '请联系服务商处理。', act: false },
    pending: { t: '授权正在审核', d: '审核通过后会自动解锁，无需重复操作。', act: false },
    unknown_plugin: { t: '该功能当前不可用', d: '插件未在授权平台登记，请联系服务商。', act: false },
    clock_tamper: { t: '系统时间异常', d: '请校正系统时间后重试（检测到时钟回拨）。', act: false },
    mismatch: { t: '授权与本插件不匹配', d: '导入的包/激活码不属于本插件。', act: true },
    bad_signature: { t: '授权数据校验失败', d: '请重新导入官方激活包。', act: true },
    gate_init_failed: { t: '授权运行时初始化失败', d: '请联系服务商并附上日志。', act: false },
  };

  /* 纯函数：把 state 判成 { lock, title, desc, canAct }
   * 单独抽出来是为了能在 node 里测（见 test/panel_lock.mjs）——
   * 这条判定逻辑出错的代价是"全部客户被锁"或"全部客户免费用"，值得单独的回归测试。 */
  function licenseGateDecision(state) {
    if (!state || typeof state !== 'object') {
      // 拿不到状态（网络/未插桩）→ fail-open，不锁
      return { lock: false, title: '', desc: '', canAct: false, unknown: true };
    }
    /* ★ v1.2b 顺序修正（重要）：
       旧版把 `silent === true → 不锁` 放在最前面，导致**被吊销时也不锁** ——
       客户看到的是「界面能打开、每个功能都 403」，比直接告知"已停用"更糟。
       现在：先看「是否被服务商主动停用」，是就锁；否则静默模式一律不锁。
       ⚠️ 不能用 state.lockable 当前置条件：严格模式（silent=false）下 lockable 恒为 true，
          那会把正常用户也锁掉。这里只认「吊销」这两个原因。 */
    var r0 = state.reason || '';
    if (r0 === 'revoked' || r0 === 'not_active') {
      var bm = REASONS[r0] || REASONS.revoked;
      return { lock: true, reason: r0, title: bm.t, desc: bm.d, canAct: !!bm.act };
    }
    /* 静默模式（v1.2 默认）：客户永远看不到激活界面。 */
    if (state.silent === true) {
      return { lock: false, title: '', desc: '', canAct: false, silent: true };
    }
    if (state.usable === true) return { lock: false, title: '', desc: '', canAct: false };
    /* v1.2：不再用 pool===0 兜底成 no_ticket —— 免票模式下 pool 恒 0，会把正常状态误判成
       “票已用尽”。只在明确拿到 reason 时才锁；拿不到 reason 就 fail-open。 */
    var r = state.reason || (state.pending ? 'pending' : '');
    if (!r) return { lock: false, title: '', desc: '', canAct: false, unknown: true };
    var m = REASONS[r] || { t: '授权不可用', d: '原因：' + (r || '未知') + '，请联系服务商。', act: false };
    return { lock: true, reason: r, title: m.t, desc: m.d, canAct: !!m.act };
  }

  var CSS_ID = 'dshlic-style';
  var CSS = '' +
    '.dshlic-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(8,10,14,.72);' +
    'backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.dshlic-card{width:min(520px,92vw);background:#fff;color:#1b1f24;border-radius:14px;padding:26px 26px 20px;' +
    'box-shadow:0 24px 64px rgba(0,0,0,.36)}' +
    '.dshlic-card h3{margin:0 0 6px;font-size:18px;font-weight:600}' +
    '.dshlic-desc{color:#5b6470;margin:0 0 16px;font-size:13px}' +
    '.dshlic-mc{display:flex;align-items:center;gap:8px;background:#f4f6f8;border:1px solid #e3e7ec;' +
    'border-radius:8px;padding:8px 10px;font:12px/1.4 ui-monospace,Consolas,monospace;word-break:break-all}' +
    '.dshlic-mc b{font-weight:600;color:#0f62fe;cursor:pointer}' +
    '.dshlic-row{display:flex;gap:8px;margin-top:12px}' +
    '.dshlic-row input{flex:1;min-width:0;border:1px solid #ccd3db;border-radius:8px;padding:9px 11px;font:13px ui-monospace,monospace}' +
    '.dshlic-btn{border:0;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;background:#0f62fe;color:#fff}' +
    '.dshlic-btn[disabled]{opacity:.55;cursor:default}' +
    '.dshlic-btn.ghost{background:#eef1f5;color:#1b1f24}' +
    '.dshlic-drop{margin-top:14px;border:1.5px dashed #ccd3db;border-radius:10px;padding:18px;text-align:center;' +
    'color:#7b8694;font-size:13px;cursor:pointer;transition:.15s}' +
    '.dshlic-drop.hot{border-color:#0f62fe;background:#f2f7ff;color:#0f62fe}' +
    '.dshlic-msg{margin-top:12px;font-size:12.5px;min-height:18px}' +
    '.dshlic-msg.err{color:#c62f2f}.dshlic-msg.ok{color:#1a7f45}' +
    '.dshlic-foot{margin-top:14px;display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:#98a2ae}' +
    '.dshlic-foot a{color:#98a2ae;text-decoration:none}';

  function injectCss(doc) {
    if (doc.getElementById(CSS_ID)) return;
    var st = doc.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  function el(doc, tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* 挂载锁屏。返回 { refresh, destroy } —— 幂等，可重复调用。 */
  function mountLicenseGate(opts) {
    opts = opts || {};
    var win = opts.window || (typeof window !== 'undefined' ? window : null);
    if (!win) return { refresh: function () {}, destroy: function () {} };
    var doc = opts.document || win.document;
    var pluginId = String(opts.pluginId || '');
    var prefix = String(opts.prefix || ('/api/' + pluginId)).replace(/\/+$/, '');
    var base = prefix + '/license';
    var pollMs = Math.max(5000, Number(opts.pollMs || 15000));
    var onState = typeof opts.onState === 'function' ? opts.onState : null;
    var fetchImpl = opts.fetch || (win.fetch ? win.fetch.bind(win) : null);

    var mask = null, timer = null, destroyed = false, busy = false;

    function cleanup() {
      if (timer) { win.clearInterval(timer); timer = null; }
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
      mask = null;
    }

    function msg(text, kind) {
      if (!mask) return;
      var m = mask.querySelector('.dshlic-msg');
      if (!m) return;
      m.textContent = text || '';
      m.className = 'dshlic-msg' + (kind ? ' ' + kind : '');
    }

    // ---- 唯一允许的自动请求：零票 state ----
    function getState() {
      if (!fetchImpl) return Promise.resolve(null);
      return fetchImpl(base + '/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plugin_id: pluginId }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });   // 网络故障 → null → fail-open
    }

    function post(path, body, isBinary) {
      if (!fetchImpl) return Promise.reject(new Error('no fetch'));
      var init = { method: 'POST' };
      if (isBinary) {
        init.headers = { 'content-type': 'application/octet-stream' };
        init.body = body;
      } else {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body || {});
      }
      return fetchImpl(base + (path || ''), init).then(function (r) {
        return r.json().catch(function () { return { ok: false, error: 'bad_response' }; })
          .then(function (j) { return { status: r.status, body: j }; });
      });
    }

    function render(state) {
      var d = licenseGateDecision(state);
      if (onState) { try { onState(state, d); } catch (e) {} }
      if (!d.lock) { cleanup(); return; }
      if (mask) { // 已挂载 → 只更新文案
        var h = mask.querySelector('h3'); if (h) h.textContent = d.title;
        var p = mask.querySelector('.dshlic-desc'); if (p) p.textContent = d.desc;
        var act = mask.querySelector('.dshlic-row');
        if (act) act.style.display = d.canAct ? 'flex' : 'none';
        var drop = mask.querySelector('.dshlic-drop');
        if (drop) drop.style.display = d.canAct ? 'block' : 'none';
        return;
      }
      injectCss(doc);
      mask = el(doc, 'div', 'dshlic-mask');
      var card = el(doc, 'div', 'dshlic-card');
      card.appendChild(el(doc, 'h3', null, d.title));
      card.appendChild(el(doc, 'p', 'dshlic-desc', d.desc));

      // 机器码：现场报障的唯一凭据，必须可一键复制
      var mc = el(doc, 'div', 'dshlic-mc');
      mc.appendChild(el(doc, 'span', null, '机器码'));
      var code = el(doc, 'b', null, (state && state.machine_code) || '读取中…');
      code.title = '点击复制完整机器码';
      code.onclick = function () {
        var full = (state && state.hwid) || '';
        try {
          if (win.navigator && win.navigator.clipboard) win.navigator.clipboard.writeText(full);
          else {
            var ta = doc.createElement('textarea');
            ta.value = full; doc.body.appendChild(ta); ta.select(); doc.execCommand('copy'); doc.body.removeChild(ta);
          }
          msg('机器码已复制', 'ok');
        } catch (e) { msg('复制失败，请手动记录：' + full, 'err'); }
      };
      mc.appendChild(code);
      card.appendChild(mc);

      // 激活码
      var row = el(doc, 'div', 'dshlic-row');
      if (!d.canAct) row.style.display = 'none';
      var inp = el(doc, 'input');
      inp.placeholder = '输入激活码（lic_…）';
      inp.autocomplete = 'off';
      var btn = el(doc, 'button', 'dshlic-btn', '激活');
      btn.onclick = function () {
        var v = String(inp.value || '').trim();
        if (!v || busy) return;
        busy = true; btn.disabled = true; msg('正在激活…');
        post('/activate', { code: v }).then(function (r) {
          var st = (r.body && r.body.state) || r.body || {};
          if (r.body && r.body.ok) { msg('激活成功', 'ok'); render(st); }
          else msg('激活失败：' + ((st && st.reason) || (r.body && r.body.error) || '未知原因'), 'err');
        }).catch(function (e) { msg('激活请求失败：' + (e && e.message), 'err'); })
          .then(function () { busy = false; btn.disabled = false; });
      };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
      row.appendChild(inp); row.appendChild(btn);
      card.appendChild(row);

      // 离线包拖拽
      var drop = el(doc, 'div', 'dshlic-drop', '把 .licpack 激活包拖到这里，或点击选择文件');
      if (!d.canAct) drop.style.display = 'none';
      var file = el(doc, 'input');
      file.type = 'file'; file.accept = '.licpack,application/octet-stream'; file.style.display = 'none';
      function doImport(f) {
        if (!f || busy) return;
        busy = true; msg('正在导入 ' + f.name + '…');
        var rd = new win.FileReader();
        rd.onload = function () {
          post('/import', rd.result, true).then(function (r) {
            var b = r.body || {};
            if (b.ok) {
              msg('导入成功：' + (b.via === 'suite' ? '套件证' : '插件证') + '，可用票 ' + (b.pool != null ? b.pool : '?'), 'ok');
              refresh();
            } else msg('导入失败：' + (b.message || b.error || '未知原因'), 'err');
          }).catch(function (e) { msg('导入请求失败：' + (e && e.message), 'err'); })
            .then(function () { busy = false; });
        };
        rd.readAsArrayBuffer(f);
      }
      drop.onclick = function () { file.click(); };
      file.onchange = function () { doImport(file.files && file.files[0]); };
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('hot'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('hot'); });
      });
      drop.addEventListener('drop', function (e) {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        doImport(f);
      });
      card.appendChild(drop);
      card.appendChild(file);

      card.appendChild(el(doc, 'div', 'dshlic-msg'));
      var foot = el(doc, 'div', 'dshlic-foot');
      foot.appendChild(el(doc, 'span', null, pluginId + ' · ' + ((state && state.server) || '')));
      var retry = el(doc, 'a', null, '刷新状态');
      retry.href = 'javascript:void(0)';
      retry.onclick = function () { refresh(); };
      foot.appendChild(retry);
      card.appendChild(foot);

      mask.appendChild(card);
      (doc.body || doc.documentElement).appendChild(mask);
    }

    function refresh() {
      if (destroyed) return Promise.resolve(null);
      return getState().then(function (st) { if (!destroyed) render(st); return st; });
    }

    function startPolling() {
      if (timer) return;
      timer = win.setInterval(function () {
        // 页面不可见时不轮询：既省请求，也避免后台标签页被打断后误判
        if (doc.visibilityState === 'hidden') return;
        refresh();
      }, pollMs);
    }

    startPolling();
    refresh();

    return {
      refresh: refresh,
      destroy: function () { destroyed = true; cleanup(); },
    };
  }

  var api = { mountLicenseGate: mountLicenseGate, licenseGateDecision: licenseGateDecision, REASONS: REASONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.mountLicenseGate = mountLicenseGate, global.licenseGateDecision = licenseGateDecision;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
try { if (typeof mountLicenseGate === 'function') mountLicenseGate({ pluginId: "meeting", prefix: "C:/Program Files/WorkBuddy/resources/vendor/PortableGit/api/meeting-assistant" }); } catch (e) {}
