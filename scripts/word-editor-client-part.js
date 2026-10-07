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
