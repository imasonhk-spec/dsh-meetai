// Source-bound arithmetic only. No inference, external verification or action creation.
import { hash } from './source-store.mjs'
const fail = code => Object.assign(new Error(code), { code })
const PAIR = /旧版失败率(\d{1,3}(?:\.\d{1,4})?)[%％][，,]\s*新版为(\d{1,3}(?:\.\d{1,4})?)[%％][，,]\s*样本各(\d{1,9})例/g
const LIMIT = /未|不|无|尚|仅|只|拟|待|若|如果|条件|建议|测试|验证|发布|生产|截止|完成|负责|提交|决定/u
const clean = value => String(value ?? '').replace(/[\r\n\u0000-\u001f]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]#|]/g, '\\$&')
function gcd(a, b) { a = a < 0n ? -a : a; while (b) { const next = a % b; a = b; b = next } return a || 1n }
function fraction(n, d) {
  if (d === 0n) throw fail('ZERO_BASE_RATE')
  if (d < 0n) { n = -n; d = -d }
  const divisor = gcd(n, d)
  return { numerator: String(n / divisor), denominator: String(d / divisor), value: Number(n / divisor) / Number(d / divisor) }
}
function rate(value) {
  const [integer, decimal = ''] = value.split('.')
  const n = BigInt(integer + decimal), d = 10n ** BigInt(decimal.length)
  if (n < 0n || n > 100n * d) throw fail('INVALID_PERCENT_RATE')
  return { n, d }
}
function span(unit, sourceSha256) {
  return { utteranceId: unit.id, start: unit.start, end: unit.end, quote: unit.text, sourceSha256 }
}
export function buildRiskReview(source, expectedSourceSha256, definition) {
  if (typeof source !== 'string' || hash(source) !== expectedSourceSha256 || definition?.sourceSha256 !== expectedSourceSha256 || !Array.isArray(definition.units)) throw fail('RISK_SOURCE_BINDING_FAILED')
  for (const unit of definition.units) {
    if (!Number.isSafeInteger(unit.start) || !Number.isSafeInteger(unit.end) || unit.start < 0 || unit.end <= unit.start || unit.end > source.length || source.slice(unit.start, unit.end) !== unit.text) throw fail('RISK_SOURCE_BINDING_FAILED')
  }
  const matches = [...source.matchAll(PAIR)]
  const relevant = matches.length > 0 || /旧版失败率|新版失败率|失败率.*(?:新版|旧版)/u.test(source)
  if (!relevant) return { status: 'not_applicable', schemaVersion: 1, sourceSha256: expectedSourceSha256 }
  const restrictions = definition.units.filter(unit => LIMIT.test(unit.text)).map(unit => span(unit, expectedSourceSha256))
  const base = { schemaVersion: 1, sourceSha256: expectedSourceSha256, scope: 'source-reported-or-hypothetical-numbers-only-not-production-effectiveness', restrictions, humanReviewRequired: true, derivedNotOriginalQuote: true, externalFactualVerification: false, productionEffectVerified: false, releaseDateConfirmed: false, qualityPassed: false, performanceEligible: false }
  if (matches.length !== 1) return { ...base, status: 'pending_review', code: 'REFERENCE_RATE_PAIR_NOT_UNIQUE', pairCount: matches.length }
  const match = matches[0]
  const start = match.index, end = start + match[0].length
  const pairUnits = definition.units.filter(unit => unit.start < end && unit.end > start)
  // Do not derive from a secondary FULL TEXT view or unaccounted source region.
  if (!pairUnits.length || pairUnits[0].start > start || pairUnits.at(-1).end < end) return { ...base, status: 'pending_review', code: 'RATE_PAIR_OUTSIDE_ANALYSIS_UNITS' }
  try {
    const old = rate(match[1]), next = rate(match[2]), samplesEach = Number(match[3])
    if (!Number.isSafeInteger(samplesEach) || samplesEach < 1) throw fail('INVALID_SAMPLE_COUNT')
    if (old.n === 0n) throw fail('ZERO_BASE_RATE')
    const absoluteChange = fraction(old.n * next.d - next.n * old.d, old.d * next.d)
    const relativeReduction = fraction((old.n * next.d - next.n * old.d) * 100n, old.n * next.d)
    return { ...base, status: 'derived_requires_review', oldRatePercent: match[1], newRatePercent: match[2], samplesEach,
      absoluteChange: { ...absoluteChange, unit: 'percentage_points', formula: 'old percent minus new percent' },
      relativeReduction: { ...relativeReduction, unit: 'percent', formula: '(old percent - new percent) / old percent * 100' },
      direction: absoluteChange.value > 0 ? 'rate_reduced' : absoluteChange.value < 0 ? 'rate_increased' : 'unchanged',
      evidence: { start, end, quote: match[0], sourceSha256: expectedSourceSha256, units: pairUnits.map(unit => span(unit, expectedSourceSha256)) } }
  } catch (error) {
    if (!['ZERO_BASE_RATE', 'INVALID_PERCENT_RATE', 'INVALID_SAMPLE_COUNT'].includes(error.code)) throw error
    return { ...base, status: 'pending_review', code: error.code }
  }
}
export function renderRiskReview(review) {
  if (review.status === 'not_applicable') return ''
  const rows = ['## 风险比例与派生计算（待人工复核）', '**以下只对原文报告或假设的数字作数学运算，不认证实测、生产效果、发布日期或模型提速。**']
  if (review.status === 'derived_requires_review') {
    rows.push('|项目|数值|来源与说明|', '|---|---|---|',
      '|原文失败率及样本|旧版' + review.oldRatePercent + '%；新版' + review.newRatePercent + '%；样本各' + review.samplesEach + '例|原文UTF-16 ' + review.evidence.start + '–' + review.evidence.end + '；仅材料报告或假设|',
      '|绝对变化（旧减新）|' + review.absoluteChange.value + '个百分点|派生计算，精确分数 ' + review.absoluteChange.numerator + '/' + review.absoluteChange.denominator + '；不是相对下降百分比|',
      '|相对变化（旧减新／旧）|' + review.relativeReduction.value + '%|派生计算，精确分数 ' + review.relativeReduction.numerator + '/' + review.relativeReduction.denominator + '；小数展示可能近似|')
    rows.push('计算依据原话：“' + clean(review.evidence.quote) + '”。')
    for (const unit of review.evidence.units) rows.push('- 完整依据语句 ' + clean(unit.utteranceId) + '，UTF-16 ' + unit.start + '–' + unit.end + '：“' + clean(unit.quote) + '”。')
  } else rows.push('未自动计算：' + clean(review.code) + '。比例不唯一、零基准或不合法输入保留待复核，不补造数字。')
  rows.push('### 原文限制及后续事项', '完整保留否定、条件、负责人、期限和未决原话；生产验证与发布日不得因数字下降而自动确认。')
  for (const item of review.restrictions) rows.push('- ' + clean(item.utteranceId) + '，UTF-16 ' + item.start + '–' + item.end + '：“' + clean(item.quote) + '”。')
  if (!review.restrictions.length) rows.push('原文未提供可识别的验证限制或后续事项；不据此推断不存在限制。')
  return rows.join('\n\n')
}
