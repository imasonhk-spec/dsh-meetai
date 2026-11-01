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
