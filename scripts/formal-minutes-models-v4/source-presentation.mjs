// Fresh protected assembly path. Historic assembly/report handling remains unchanged.
import { assembleGroundedMinutes } from './assembly-final.mjs'
import { hash } from './source-store.mjs'
import { buildAnalysisView, canonicalJSON, validateSourceLedger, safeTopic, VIEW_VERSION, EVIDENCE_VERSION } from './analysis-view.mjs'
import { buildRiskReview, renderRiskReview } from './risk-metrics.mjs'
export const SOURCE_ASSEMBLY_VERSION = 'source-bound-presentation-admin-development-1'
const fail = code => Object.assign(new Error(code), { code })
const clean = value => String(value ?? '').replace(/[\r\n\u0000-\u001f]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]#|]/g, '\\$&').trim()
const KINDS = new Set(['discussion', 'proposal', 'decision', 'action', 'constraint', 'uncertain'])
function markers(source) {
  const found = []
  for (const match of source.matchAll(/\[(M[1-9]\d{0,2})\]/g)) {
    if (match.index === 0 || /[。；;\n]\s*$/.test(source.slice(0, match.index))) found.push({ label: match[1], start: match.index })
  }
  return found
}
function labelsFor(spans, regions) {
  const labels = new Set()
  for (const span of spans) {
    const preceding = regions.filter(region => region.start <= span.start).at(-1)
    if (preceding) labels.add(preceding.label)
    for (const region of regions) if (region.start > span.start && region.start < span.end) labels.add(region.label)
  }
  return [...labels]
}
export function dateHeaderCandidate(definition) {
  const candidates = []
  for (const unit of definition.units) {
    const match = unit.text.match(/^\s*(?:\[(M[1-9]\d{0,2})\]\s*)?(\d{4}-\d{2}-\d{2})([^。\r\n]{1,60}会议)。?$/u)
    if (!match || /拟|未|不|待|若|假设|假定|假想|设想|预计|可能|或许|也许|计划|取消|延期|前|后|截止|建议/u.test(match[3])) continue
    const parsed = new Date(match[2] + 'T00:00:00Z')
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== match[2]) continue
    candidates.push({ date: match[2], title: match[3], label: match[1] ?? null, utteranceId: unit.id, start: unit.start, end: unit.end, quote: unit.text, status: 'source_header_date_candidate_not_confirmed_meeting', preciseTimeInvented: false })
  }
  return candidates.length === 1 ? candidates[0] : null
}
export function assembleSourceBoundMinutes(result, source, metadata = {}) {
  const m = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  if (result?.evidenceVersion !== EVIDENCE_VERSION || result?.viewVersion !== VIEW_VERSION) throw fail('EVIDENCE_VERSION_UNSUPPORTED')
  if (typeof source !== 'string' || source.length !== result.sourceLengthUtf16 || hash(source) !== result.analysisDefinition?.sourceSha256) throw fail('SOURCE_BINDING_FAILED')
  const view = buildAnalysisView(source, result.analysisDefinition.maxChars)
  if (view.sha256 !== result.viewSha256 || canonicalJSON(view.definition) !== canonicalJSON(result.analysisDefinition)) throw fail('SOURCE_UNIT_MISMATCH')
  validateSourceLedger(view, result, source)
  // Strict protocol and immutable-source validation precede all template/presentation IO.
  const validated = assembleGroundedMinutes(result, m)
  const regions = markers(source), facts = new Map(result.facts.map(fact => [fact.id, fact])), citations = []
  for (const fact of result.facts) {
    if (!KINDS.has(fact.kind)) throw fail('PRESENTATION_KIND_INVALID')
    for (const span of fact.evidence.spans) if (source.slice(span.start, span.end) !== span.quote) throw fail('SOURCE_SPAN_MISMATCH')
    citations.push({ factId: fact.id, kind: fact.kind, labels: labelsFor(fact.evidence.spans, regions), spans: fact.evidence.spans.map(span => ({ utteranceId: span.utteranceId, start: span.start, end: span.end, quote: span.quote, speaker: span.speaker, timeRange: span.timeRange, sourceSha256: view.sourceSha256 })) })
  }
  const byId = new Map(citations.map(citation => [citation.factId, citation])), header = dateHeaderCandidate(view.definition)
  const scheduledTime = [m.start_time, m.end_time].filter(value => typeof value === 'string' && value.trim()).map(clean).join(' 至 ')
  const participants = Array.isArray(m.participants) ? m.participants.filter(value => typeof value === 'string' && value.trim()).map(clean).join('、') : ''
  const body = ['# ' + clean(m.title || header?.title || '会议内容整理') + '（待人工复核草稿）',
    '**仅整理源材料内容，不是已确认、已印发的正式会议纪要。材料编号是输入内标记，不代表官方来源认证。会议角色、发文主体及缺失信息不推断。**',
    '会议日程记录时间：' + (scheduledTime || '未提供') + '；日程记录不等于实际召开时间已确认。',
    header ? '原文日期候选：' + header.date + '；' + (header.label ? '材料标记：[' + header.label + ']；' : '') + '依据 ' + header.utteranceId + '，UTF-16 ' + header.start + '–' + header.end + '；实际会议日期与具体时刻仍待复核。' : '原文日期信息：未提供可唯一识别的会议日期候选，待人工复核。',
    '日程记录地点：' + (clean(m.location) || '未提供') + '；实际地点待复核。',
    '日程记录参会名单：' + (participants || '未提供') + '；实际出席、主持和发文主体待复核。']
  for (const section of result.sections) {
    const kinds = new Set(section.paragraphs.flatMap(paragraph => paragraph.fact_ids.map(id => facts.get(id)?.kind)))
    if (kinds.size !== 1 || !KINDS.has([...kinds][0])) throw fail('PRESENTATION_KIND_MIXED')
    body.push('## ' + safeTopic([...kinds][0]))
    for (const paragraph of section.paragraphs) {
      const labels = [...new Set(paragraph.fact_ids.flatMap(id => byId.get(id).labels))]
      body.push(clean(paragraph.text), labels.length ? '来源材料标记：' + labels.map(label => '[' + label + ']').join('、') + '；证据ID：' + paragraph.fact_ids.join('、') : '来源：已绑定原始文本，未提供材料编号；证据ID：' + paragraph.fact_ids.join('、'))
    }
  }
  if (!result.facts.some(fact => fact.kind === 'decision')) body.push('会议决议：原文未形成可确认决议，未自动生成决议。')
  const risk = buildRiskReview(source, view.sourceSha256, view.definition), riskText = renderRiskReview(risk)
  if (riskText) body.push(riskText)
  body.push('## 证据与待复核元信息', '全部已提取事实均绑定原始字符范围，不等于已证明所有重要事项全部提取。')
  for (const citation of citations) body.push('- ' + citation.factId + '：' + citation.spans.map(span => span.utteranceId + '，UTF-16 ' + span.start + '–' + span.end).join('；'))
  const reviewStart = validated.content.indexOf('## 待复核清单')
  if (reviewStart < 0) throw fail('REVIEW_LEDGER_PRESENTATION_MISSING')
  body.push(validated.content.slice(reviewStart))
  const riskPending = risk.status === 'not_applicable' ? 0 : 1
  return { content: body.join('\n\n'), actions: [], grounding: { ...validated.grounding, assemblyVersion: SOURCE_ASSEMBLY_VERSION,
    pendingReview: validated.grounding.pendingReview + riskPending, sourceSha256: view.sourceSha256, citationMap: citations, sourceHeader: header,
    sourceLabelsAreInputMarkersOnly: true, meetingMetadataHumanConfirmed: false, derivedMetrics: risk, derivedMetricsAreNotOriginalFacts: risk.status !== 'not_applicable',
    productionEffectVerified: false, releaseDateConfirmed: false, allImportantFactsProvenExtracted: false, semanticAccuracyVerified: false, needsReview: true,
    notice: '原文、证据ID/字符范围及派生计算已绑定；数字、日期、限制与责任仍需人工复核。自动审核不能确认生产效果或正式发布时间。' },
    qualityPassed: false, performanceEligible: false, formalPublicationAuthorized: false }
}
