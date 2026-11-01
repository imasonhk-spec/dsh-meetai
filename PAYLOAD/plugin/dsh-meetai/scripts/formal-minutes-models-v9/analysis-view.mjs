// Analysis is a mapped view, never a replacement for immutable source memory.
import { hash } from './source-store.mjs'
export const VIEW_VERSION = 'utterance-view-2'
export const EVIDENCE_VERSION = 'utterance-selection-1'
const fail = (code, message) => Object.assign(new Error(message), { code })
const stamp = /^\[(\d{2,}:\d{2}(?::\d{2})?)-(\d{2,}:\d{2}(?::\d{2})?)\]\s+([^:\r\n]+):[ \t]*/
const fullLabel = /^[ \t]*\[FULL TEXT\][ \t]*/
const terminal = /[。！？!?；;][”’"']?\s*$/u
const qualified = /不|未|没|无|尚|拟|建议|考虑|如果|假如|除非|仅当|条件|待|前提|审批|审查|必须|只有|才能|取消|失败|暂缓|尚需|通过.{0,8}(?:后|以后)|(?:若|须)/u
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b)
export function canonicalJSON(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item
  return JSON.stringify(canonical(value))
}
// Conservative allowlist only. Anything not positively recognized remains reviewable.
export function isNoise(text) {
  const compact = text.replace(/[\s，,。.!！?？、；;：:]/gu, '')
  return /^(?:(?:喂|你好|大家好|一二三|123|试音|测试麦克风|欢迎收看|逼|嗯|啊))+$/u.test(compact)
}
export function safeTopic(kind) {
  return { discussion: '原文讨论内容', proposal: '原文建议内容', decision: '原文决议内容', action: '原文行动内容', constraint: '原文限制内容', uncertain: '原文待确认内容' }[kind] || '原文内容'
}
const compare = text => text.replace(/\s/gu, '').toLowerCase()
export function buildAnalysisView(source, maxChars = 1800) {
  if (typeof source !== 'string' || !source.trim() || !Number.isSafeInteger(maxChars) || maxChars < 16) throw fail('MEMORY_INPUT', '分析视图输入不合法')
  const lines = []
  for (const match of source.matchAll(/[^\r\n]+/g)) lines.push({ text: match[0], start: match.index, end: match.index + match[0].length })
  const timed = lines.filter(line => stamp.test(line.text))
  const fullCount = lines.filter(line => fullLabel.test(line.text)).length
  const units = [], formatting = [], secondary = []
  function format(start, end, reason) { if (end > start) formatting.push({ start, end, disposition: 'formatting', reason }) }
  function add(text, start, extra = {}) {
    if (!text.trim()) return
    units.push({ id: 'U' + String(units.length + 1).padStart(6, '0'), text, start, end: start + text.length, speaker: null, timeRange: null, ...extra })
  }
  function plain(text, start) {
    for (const match of text.matchAll(/[^。！？!?；;\r\n]+[。！？!?；;]*|[。！？!?；;]+/gu)) add(match[0], start + match.index)
  }
  const mainComparison = compare(timed.map(line => line.text.slice(line.text.match(stamp)[0].length)).join(''))
  for (let index = 0; index < lines.length;) {
    const line = lines[index], match = line.text.match(stamp), label = line.text.match(fullLabel)
    if (label) {
      const start = line.start + label[0].length
      format(line.start, start, '全文视图标签')
      let next = index + 1
      while (next < lines.length && !stamp.test(lines[next].text) && !fullLabel.test(lines[next].text)) next++
      const end = next < lines.length ? lines[next].start : source.length
      const block = source.slice(start, end)
      // FULL TEXT is a block, including following lines, not only the marker line.
      if (timed.length && block.trim()) {
        const equivalent = fullCount === 1 && compare(block) === mainComparison
        secondary.push({ start, end, disposition: equivalent ? 'duplicate_view' : 'unresolved', reason: equivalent ? '全文与逐句视图仅有空白/大小写展示差异' : '全文与逐句视图存在差异；此完整范围保留待核对，不能声称全部内容已提取', code: equivalent ? 'DUAL_VIEW_EQUIVALENT' : 'DUAL_VIEW_DIFFERENCE' })
      } else if (block.trim()) plain(block, start)
      else format(start, end, '空全文块或分隔')
      index = next
    } else if (match) {
      const start = line.start + match[0].length
      format(line.start, start, '时间戳和说话人展示标签')
      add(source.slice(start, line.end), start, { speaker: match[3].trim(), timeRange: [match[1], match[2]] })
      index++
    } else { plain(line.text, line.start); index++ }
  }
  const occupied = [...units, ...formatting, ...secondary].sort((a, b) => a.start - b.start)
  let cursor = 0
  for (const item of occupied) {
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < cursor || item.end <= item.start || item.end > source.length) throw fail('MEMORY_INTEGRITY', '视图映射重叠或越界')
    if (cursor < item.start) {
      if (!/^\s*$/u.test(source.slice(cursor, item.start))) throw fail('MEMORY_INTEGRITY', '实质原文不能作为格式间隙遗漏')
      format(cursor, item.start, '空白或句间分隔')
    }
    cursor = item.end
  }
  if (cursor < source.length) {
    if (!/^\s*$/u.test(source.slice(cursor))) throw fail('MEMORY_INTEGRITY', '实质尾文不能作为格式字符遗漏')
    format(cursor, source.length, '尾部分隔')
  }
  formatting.sort((a, b) => a.start - b.start)
  for (const unit of units) if (source.slice(unit.start, unit.end) !== unit.text) throw fail('MEMORY_INTEGRITY', '语句与原文不一致')
  const groups = []
  let group = []
  function flush() { if (group.length) groups.push(group); group = [] }
  for (const unit of units) {
    // A budget is not a semantic boundary. Preserve the full unfinished turn.
    if (group.length && unit.speaker !== group[0].speaker) flush()
    group.push(unit)
    if (terminal.test(unit.text) || isNoise(unit.text)) flush()
  }
  flush()
  const segments = []
  let batch = [], size = 0, groupIndex = 0, batchStart = 0
  function emit() {
    if (!batch.length) return
    const selected = batch.flat()
    const context = [...(groups[batchStart - 1] || []), ...(groups[groupIndex] || [])]
    segments.push({ id: 'C' + String(segments.length + 1).padStart(6, '0'), units: selected, groups: batch, maxChars, start: selected[0].start, end: selected.at(-1).end, context })
    batch = []; size = 0; batchStart = groupIndex
  }
  for (const item of groups) {
    const length = item.reduce((n, unit) => n + unit.text.length, 0)
    if (batch.length && size + length > maxChars) emit()
    batch.push(item); size += length; groupIndex++
  }
  emit()
  const definition = { version: VIEW_VERSION, evidenceVersion: EVIDENCE_VERSION, sourceSha256: hash(source), units, formatting, secondary, groups: groups.map(items => items.map(unit => unit.id)), maxChars }
  return { ...definition, definition, segments, sha256: hash(JSON.stringify(definition)) }
}
export function splitAnalysisSegment(segment) {
  if (segment.groups.length < 2) return []
  const middle = Math.ceil(segment.groups.length / 2)
  return [segment.groups.slice(0, middle), segment.groups.slice(middle)].map((groups, index) => {
    const units = groups.flat()
    return { ...segment, id: segment.id + '.' + index, groups, units, start: units[0].start, end: units.at(-1).end, context: [...segment.context, ...segment.units.filter(unit => !units.includes(unit))] }
  })
}
export function validateEvidenceFacts(body, segment, source) {
  const keys = (object, expected) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join('|') === expected.slice().sort().join('|')
  if (!keys(body, ['facts']) || !Array.isArray(body.facts) || body.facts.length > 24) throw fail('FACT_SCHEMA', '事实清单不合法')
  const allowed = new Map(segment.units.map(unit => [unit.id, unit]))
  return body.facts.map(fact => {
    if (!keys(fact, ['topic', 'kind', 'evidence']) || typeof fact.topic !== 'string' || !fact.topic.trim() || fact.topic.length > 80 || !['discussion', 'proposal', 'decision', 'action', 'constraint', 'uncertain'].includes(fact.kind) || !Array.isArray(fact.evidence) || !fact.evidence.length || fact.evidence.length > 24) throw fail('FACT_SCHEMA', '事实字段不合法')
    const seen = new Set()
    let previous = -1
    for (const selection of fact.evidence) {
      if (!keys(selection, ['utteranceId', 'start', 'end'])) throw fail('EVIDENCE_INVALID', '证据字段不合法')
      const unit = allowed.get(selection.utteranceId)
      if (!unit || seen.has(unit.id) || selection.start !== 0 || selection.end !== unit.text.length || unit.start <= previous || isNoise(unit.text)) throw fail('EVIDENCE_INVALID', '证据ID、完整语句范围或顺序不合法')
      if (source.slice(unit.start, unit.end) !== unit.text) throw fail('MEMORY_INTEGRITY', '证据与不可变原文不一致')
      seen.add(unit.id); previous = unit.start
    }
    const expanded = new Map()
    for (const items of segment.groups) if (items.some(unit => seen.has(unit.id))) for (const unit of items) if (!isNoise(unit.text)) expanded.set(unit.id, unit)
    const selectedUnits = [...expanded.values()].sort((a, b) => a.start - b.start)
    if (!selectedUnits.length) throw fail('EVIDENCE_INVALID', '完整话语证据缺失')
    const spans = selectedUnits.map(unit => {
      if (source.slice(unit.start, unit.end) !== unit.text) throw fail('MEMORY_INTEGRITY', '完整话语证据与原文不一致')
      return { utteranceId: unit.id, start: unit.start, end: unit.end, quote: unit.text, speaker: unit.speaker, timeRange: unit.timeRange }
    })
    const quote = spans.map(span => span.quote).join('\n')
    // Complete selected turn + complete read-only neighboring groups, no distance cutoff.
    const contextUnits = new Map([...segment.context, ...selectedUnits].map(unit => [unit.id, unit]))
    const context = [...contextUnits.values()].sort((a, b) => a.start - b.start).map(unit => unit.text).join('\n')
    const attributed = /日报|报道|新闻|据.{0,30}(?:表示|称|报道)|官方表示|欢迎收看/.test(context)
    if (fact.kind === 'decision' && (attributed || !/决定|同意|确定|就按|原则支持/.test(quote) || qualified.test(context))) throw fail('UNSUPPORTED_DECISION', '原文不支持无条件明确会议决议')
    if (fact.kind === 'action' && (attributed || qualified.test(context) || !/(?:负责|分工|提交|整理|安排|请.{1,20}(?:完成|办理|落实)|由.{1,20}(?:完成|办理|落实))/.test(quote))) throw fail('UNSUPPORTED_ACTION', '原文分工存在否定、条件或未明确状态')
    if (selectedUnits.length > 24) throw fail('EVIDENCE_INVALID', '完整话语证据超过上限，保留待复核')
    if (segment.groups.some(items => items.some(unit => seen.has(unit.id)) && items.reduce((length, unit) => length + unit.text.length, 0) > (segment.maxChars ?? 1800))) throw fail('INPUT_BUDGET', '完整话语组超预算，保留全部原话待复核')
    // Model-supplied topic is deliberately discarded; titles cannot add facts.
    return { topic: safeTopic(fact.kind), kind: fact.kind, quote, evidence: { segment: segment.id, start: spans[0].start, end: spans.at(-1).end, spans, quote, context, protocol: EVIDENCE_VERSION } }
  })
}
export function createSourceLedger(view, facts) {
  const units = new Map(view.units.map(unit => [unit.id, unit])), included = new Set()
  for (const fact of facts) {
    if (!Array.isArray(fact.evidence?.spans) || !fact.evidence.spans.length) throw fail('MEMORY_INTEGRITY', '事实证据列表缺失')
    for (const span of fact.evidence.spans) {
      const unit = units.get(span.utteranceId)
      if (!unit || isNoise(unit.text) || span.start !== unit.start || span.end !== unit.end || span.quote !== unit.text || span.speaker !== unit.speaker || !equal(span.timeRange, unit.timeRange)) throw fail('MEMORY_INTEGRITY', '事实证据与重建单元不一致')
      included.add(unit.id)
    }
  }
  return [...view.formatting, ...view.secondary, ...view.units.map(unit => ({ segment: unit.id, utteranceId: unit.id, start: unit.start, end: unit.end, disposition: isNoise(unit.text) ? 'ignored_noise' : included.has(unit.id) ? 'included' : 'unresolved', reason: isNoise(unit.text) ? '保守试音/问候规则' : included.has(unit.id) ? '证据已定位；语义仍待人工复核' : '提取和复查没有选择可靠事实，原话保留待复核', code: isNoise(unit.text) ? 'NOISE_ALLOWLIST' : included.has(unit.id) ? 'EVIDENCE_SELECTED' : 'NO_FACT_SELECTED' }))].sort((a, b) => a.start - b.start)
}
export function validateSourceLedger(view, result, source = null) {
  const expected = createSourceLedger(view, result.facts)
  if (!equal(expected, result.segmentLedger)) throw fail('MEMORY_INTEGRITY', '原文去向与重建视图不一致，实质语句不能冒充格式范围')
  let tail = 0
  for (const item of expected) {
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start !== tail || item.end <= item.start) throw fail('MEMORY_INTEGRITY', '原文去向账本存在缺口或重叠')
    tail = item.end
  }
  if (tail !== result.sourceLengthUtf16) throw fail('MEMORY_INTEGRITY', '原文去向账本长度不一致')
  const pending = expected.filter(item => item.disposition === 'unresolved')
  if (!Array.isArray(result.unresolved) || result.unresolved.length !== pending.length || result.unresolvedCount !== pending.length) throw fail('MEMORY_INTEGRITY', '待复核列表与原文去向不一致')
  for (const [index, item] of pending.entries()) {
    const actual = result.unresolved[index]
    if (!actual || typeof actual.quote !== 'string' || actual.quote.length !== item.end - item.start || !equal({ ...actual, quote: undefined }, { ...item, quote: undefined })) throw fail('MEMORY_INTEGRITY', '待复核范围或理由被修改')
    if (source !== null && source.slice(item.start, item.end) !== actual.quote) throw fail('MEMORY_INTEGRITY', '待复核原话被修改')
  }
  return true
}
