import {error} from './llm-adapter.mjs'
import {hash} from './source-store.mjs'
import {VIEW_VERSION, validateSourceLedger, safeTopic} from './analysis-view.mjs'
const clean=v=>String(v??'').replace(/[\r\n\u0000-\u001f]+/g,' ').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]#|]/g,'\\$&').trim()
const number=n=>n<10?'零一二三四五六七八九'[n]:n<100?(n>=20?'零一二三四五六七八九'[Math.floor(n/10)]:'')+'十'+(n%10?'零一二三四五六七八九'[n%10]:''):String(n)
export function assembleGroundedMinutes(r,m={}) {
 if(r?.evidenceVersion==='utterance-selection-1')return assembleEvidenceDraft(r,m)
 const incomplete=()=>{throw error('GROUNDED_INCOMPLETE','原文分段、事实或覆盖账本不完整，未提交纪要。')}
 if(!r||r.status!=='draft_requires_review'||r.sourceProcessingComplete!==true||r.extractedFactCoverageComplete!==true||!Array.isArray(r.facts)||!r.facts.length||!Array.isArray(r.sections)||!r.sections.length||!Array.isArray(r.coverage)||!Array.isArray(r.segmentLedger)||!r.segmentLedger.length||![r.sourceId,r.runId].every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)))incomplete()
 let tail=0
 for(const segment of r.segmentLedger){if(!Number.isSafeInteger(segment.start)||segment.start!==tail||!Number.isSafeInteger(segment.end)||segment.end<=segment.start)incomplete();tail=segment.end}
 if(r.sourceLengthUtf16!==tail)incomplete()
 const facts=new Map(),seen=new Set(),covered=new Set(),issues=[]
 for(const f of r.facts){if(!f?.id||facts.has(f.id)||typeof f.quote!=='string'||!f.quote.trim()||!f.evidence||f.evidence.quote!==f.quote||!Number.isSafeInteger(f.evidence.start)||f.evidence.start<0||f.evidence.end>tail||f.evidence.end!==f.evidence.start+f.quote.length)incomplete();facts.set(f.id,f);if(f.classificationConflict)issues.push({factId:f.id,code:'CLASSIFICATION_CONFLICT'})}
 for(const c of r.coverage){if(!facts.has(c.factId)||covered.has(c.factId)||c.source?.quote!==facts.get(c.factId).quote||c.source.start!==facts.get(c.factId).evidence.start||c.source.end!==facts.get(c.factId).evidence.end)incomplete();covered.add(c.factId);if(c.disposition!=='paraphrased_auto_checked')issues.push({factId:c.factId,code:'COVERAGE_REVIEW'})}
 for(const s of r.sections){if(typeof s.topic!=='string'||!s.topic.trim()||!Array.isArray(s.paragraphs)||!s.paragraphs.length)incomplete();for(const p of s.paragraphs){if(typeof p.text!=='string'||!p.text.trim()||!Array.isArray(p.fact_ids)||!p.fact_ids.length)incomplete();for(const id of p.fact_ids){if(!facts.has(id)||seen.has(id))incomplete();seen.add(id);if(p.sourceQuoteFallback)issues.push({factId:id,code:'SOURCE_QUOTE_REVIEW'})}}}
 if(seen.size!==facts.size||covered.size!==facts.size)incomplete()
 if(issues.length)throw Object.assign(error('GROUNDED_REVIEW_REQUIRED','存在未解决的语义核验或分类问题，处理结果保留但不提交正常纪要。'),{issues})
 const topic=clean(m?.title),title=topic?topic.replace(/会议$/,'')+'会议纪要':'会议纪要（主题待核实）'
 const time=[m?.start_time,m?.end_time].filter(Boolean).map(clean).join(' 至 ')||'会议时间待核实',location=clean(m?.location)||'地点待核实'
 const body=['深圳市龙岗区人民政府办公室　〔印发日期待核实〕','# '+title,time+'，会议在'+location+'听取和研究有关事项，主持人员待核实。纪要如下：']
 r.sections.forEach((s,i)=>body.push('## '+number(i+1)+'、关于'+clean(s.topic)+'事宜',...s.paragraphs.map(p=>clean(p.text))))
 const people=Array.isArray(m?.participants)&&m.participants.length?m.participants.map(clean).join('、'):'待核实'
 body.push('其他参会人员：'+people+'。','分送：待核实。','深圳市龙岗区人民政府办公室　〔印发日期待核实〕印发')
 const actions=r.facts.filter(f=>f.kind==='action').map(f=>({task_id:'task_'+f.id,content:f.quote,assignee:'',due_date:'',completed:false,evidence_fact_id:f.id}))
 return {content:body.join('\n\n'),actions,grounding:{schemaVersion:1,assemblyVersion:'template-2-grounded-2',sourceId:r.sourceId,runId:r.runId,status:'auto_checked_draft',sourceProcessingComplete:true,extractedFactCoverageComplete:true,allImportantFactsProvenExtracted:false,semanticAccuracyVerified:false,crossSegmentContradictionAuditVerified:false,facts:r.facts.length,segments:r.segmentLedger.length,pendingReview:0,notice:'全部分段已处理、已提取事实已覆盖；自动核验不等于人工确认语义无遗漏，正式签署前请核对原文。'}}
}
function assembleEvidenceDraft(r,m={}) {
 const incomplete=()=>{throw error('GROUNDED_INCOMPLETE','原文映射、证据或去向账本不完整，未提交草稿。')}
 if(r.status!=='draft_requires_review'||r.allUnitsAccountedFor!==true||r.includedEvidenceValidated!==true||r.sourceProcessingComplete!==true||r.extractedFactCoverageComplete!==true||!Array.isArray(r.facts)||!r.facts.length||!Array.isArray(r.sections)||!r.sections.length||!Array.isArray(r.coverage)||!Array.isArray(r.segmentLedger)||!r.segmentLedger.length||!Array.isArray(r.unresolved)||![r.sourceId,r.runId,r.viewSha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))incomplete()
 const definition=r.analysisDefinition
 if(r.viewVersion!==VIEW_VERSION||definition?.version!==VIEW_VERSION||definition.evidenceVersion!==r.evidenceVersion||!Array.isArray(definition.units)||!Array.isArray(definition.formatting)||!Array.isArray(definition.secondary)||hash(JSON.stringify(definition))!==r.viewSha256)incomplete()
 // Compare roles and IDs against the hash-bound view, not merely contiguous offsets.
 try{validateSourceLedger(definition,r)}catch{incomplete()}
 const units=new Map(r.segmentLedger.filter(item=>item.utteranceId).map(item=>[item.utteranceId,item]))
 const facts=new Map(),seen=new Set(),covered=new Set(),issues=[]
 for(const fact of r.facts){
  if(!fact?.id||facts.has(fact.id)||typeof fact.quote!=='string'||!fact.quote.trim()||fact.evidence?.protocol!==r.evidenceVersion||!Array.isArray(fact.evidence.spans)||!fact.evidence.spans.length)incomplete()
  let previous=-1
  for(const span of fact.evidence.spans){const unit=units.get(span.utteranceId);if(!unit||unit.disposition!=='included'||span.start!==unit.start||span.end!==unit.end||typeof span.quote!=='string'||span.quote.length!==span.end-span.start||span.start<=previous)incomplete();previous=span.start}
  if(fact.quote!==fact.evidence.spans.map(span=>span.quote).join('\n')||fact.evidence.quote!==fact.quote||fact.evidence.start!==fact.evidence.spans[0].start||fact.evidence.end!==fact.evidence.spans.at(-1).end)incomplete()
  facts.set(fact.id,fact)
  if(fact.classificationConflict)issues.push({factId:fact.id,code:'CLASSIFICATION_CONFLICT'})
 }
 for(const item of r.coverage){const fact=facts.get(item.factId);if(!fact||covered.has(item.factId)||JSON.stringify(item.source)!==JSON.stringify(fact.evidence)||!['paraphrased_auto_checked','quoted_pending_review'].includes(item.disposition))incomplete();covered.add(item.factId);if(item.disposition==='quoted_pending_review')issues.push({factId:item.factId,code:'SOURCE_QUOTE_REVIEW'})}
 for(const section of r.sections){if(typeof section.topic!=='string'||!section.topic.trim()||!Array.isArray(section.paragraphs)||!section.paragraphs.length)incomplete();for(const paragraph of section.paragraphs){if(typeof paragraph.text!=='string'||!paragraph.text.trim()||!Array.isArray(paragraph.fact_ids)||!paragraph.fact_ids.length)incomplete();for(const id of paragraph.fact_ids){if(!facts.has(id)||seen.has(id))incomplete();seen.add(id)}}}
 if(seen.size!==facts.size||covered.size!==facts.size)incomplete()
 const title=clean(m?.title)||'录音内容整理'
 const body=['# '+title+'（待人工复核草稿）','**本稿仅整理录音中有原文证据的内容，不是已确认的正式会议纪要。未解决内容及双视图差异见下方清单；缺失信息不推断。**','会议时间：'+([m?.start_time,m?.end_time].filter(Boolean).map(clean).join(' 至 ')||'原文未明确'),'会议地点：'+(clean(m?.location)||'原文未明确'),'参会人员：'+(Array.isArray(m?.participants)&&m.participants.length?m.participants.map(clean).join('、'):'原文未明确')]
 // Never render model-authored topic text, even if result sections are substituted.
 r.sections.forEach((section,index)=>body.push('## '+number(index+1)+'、原文内容摘录',...section.paragraphs.map(paragraph=>clean(paragraph.text))))
 if(!r.facts.some(fact=>fact.kind==='decision'))body.push('会议决议：原文未明确，未自动生成决议。')
 body.push('## 待复核清单','每个原文范围均记录去向，不代表已证明所有重要事项全部提取；自动审核不等于人工确认。')
 for(const item of r.unresolved)body.push('- 原文UTF-16位置 '+item.start+'–'+item.end+'：'+clean(item.reason)+'（'+clean(item.code)+'）','原话：“'+clean(item.quote)+'”。')
 for(const issue of issues)body.push('- 事实 '+clean(issue.factId)+'：'+clean(issue.code)+'，仅作为原话待核实。')
 if(!r.unresolved.length&&!issues.length)body.push('当前没有定位到未解决片段；仍需人工核对原文与转述。')
 const pendingReview=r.unresolved.length+issues.length
 return {content:body.join('\n\n'),actions:[],grounding:{schemaVersion:2,assemblyVersion:'evidence-draft-2',evidenceVersion:r.evidenceVersion,viewVersion:r.viewVersion,viewSha256:r.viewSha256,sourceId:r.sourceId,runId:r.runId,status:'draft_requires_review',needsReview:true,allUnitsAccountedFor:true,includedEvidenceValidated:true,sourceProcessingComplete:true,extractedFactCoverageComplete:true,allImportantFactsProvenExtracted:false,semanticAccuracyVerified:false,crossSegmentContradictionAuditVerified:false,facts:r.facts.length,segments:r.processingLedger?.length||0,unresolvedCount:r.unresolved.length,pendingReview,notice:'已生成有依据的待复核草稿；不保证全部重要事项已提取。请核对原文、未解决清单及分类后再正式使用。'}}
}
export function renderGroundingReport(r){
 const byId=new Map((r.facts||[]).map(fact=>[fact.id,fact]))
 const heading=item=>r.evidenceVersion==='utterance-selection-1'?safeTopic(byId.get(item.factId)?.kind):item.topic
 return ['# 纪要原文与覆盖核验清单','本清单是审阅附件，不是公文正文；原文去向齐全不代表已证明所有重要事实无遗漏。',...(r.coverage||[]).flatMap(item=>['## '+clean(item.factId)+' · '+clean(heading(item)),...(item.source.spans||[item.source]).flatMap(span=>['UTF-16原文位置：'+span.start+'–'+span.end+'；'+clean(span.utteranceId||item.disposition),clean(span.quote)])]),'# 待复核原文',...(r.unresolved||[]).flatMap(item=>['UTF-16原文位置：'+item.start+'–'+item.end+'；'+clean(item.reason),clean(item.quote)])].join('\n\n')+'\n'
}
