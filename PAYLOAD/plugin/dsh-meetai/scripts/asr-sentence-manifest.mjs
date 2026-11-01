import { createHash } from 'node:crypto'

// Internal data validation only: NEVER a producer-attestation or client write API.
// The Host must establish same-subprocess origin, ticket, audio and publication
// eligibility before storing this optional metadata. Synthetic data can pass it.
export const ASR_SENTENCE_MANIFEST_LIMITS = Object.freeze({ bytes: 1024 * 1024, sentences: 10000, inputBytes: 16 * 1024 * 1024, endMs: 14400000 })
const PROVENANCE = 'akun-provider-sentence-info-ms'
const HASH = /^[a-f0-9]{64}$/
const validHash = value => typeof value === 'string' && HASH.test(value)
// Python str.strip() whitespace set, unlike JS trim() (FEFF/0085 differ).
const strip = text => text.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '')
const messages = {
  INPUT_INVALID: '句级绑定输入无效；全文不截断，时间不可用。',
  INPUT_LIMIT: '句级校验输入超过有界读取限制；全文保留，时间不可用。',
  NO_PROVIDER_SENTENCE_INFO: '没有真实 provider sentence_info；不能采用零时全文 fallback。',
  MULTI_RESULT_TIMEBASE_UNKNOWN: '多个 provider result 的全局时基未确认，不能推算偏移。',
  RAW_SENTENCE_INVALID: 'provider 原句区间或文本字段不完整，时间不可用。',
  SENTENCE_OUTPUT_MISMATCH: '句级 JSON 与原始 provider 逐句输出不一致。',
  MANIFEST_LIMIT: '可选句级 manifest 超过 1MiB 或 10000 句；全文保留，时间不可用。',
  MANIFEST_MISSING: '没有可选句级 manifest；全文仍可读。',
  MANIFEST_INVALID: '可选句级 manifest 结构或标志无效。',
  MANIFEST_HASH_MISMATCH: '句级 manifest 内容哈希不匹配。',
  SOURCE_BINDING_MISMATCH: '句级 manifest 不属于当前精确正文或音频版本。',
}
const unavailable = code => ({ available: false, manifest: null, reason: { code, message: messages[code] }, producerVerified: false })
const success = manifest => ({ available: true, manifest, reason: null, producerVerified: false })
const sha256 = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const sameKeys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key))
function canonical(value, depth = 0, parents = new Set()) {
  if (depth > 64) throw Error('JSON depth')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw Error('JSON number'); return JSON.stringify(value) }
  if (!Array.isArray(value) && !object(value) || parents.has(value)) throw Error('JSON data')
  parents.add(value)
  const result = Array.isArray(value)
    ? '[' + value.map(item => canonical(item, depth + 1, parents)).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1, parents)).join(',') + '}'
  parents.delete(value)
  return result
}
const boundedJSON = value => { const text = canonical(value); if (Buffer.byteLength(text) > ASR_SENTENCE_MANIFEST_LIMITS.inputBytes) throw Error('input limit'); return text }
const interval = row => Number.isFinite(row.startMs) && Number.isFinite(row.endMs) && row.startMs >= 0 && row.endMs > row.startMs && row.endMs <= ASR_SENTENCE_MANIFEST_LIMITS.endMs
// Matches Python f"SPK{sentence.get('spk', '?')}" for JSON primitive IDs.
// Floats and structured IDs are conservatively rejected, never coerced to identity.
function pythonSpeaker(sentence) {
  const value = Object.hasOwn(sentence, 'spk') ? sentence.spk : '?'
  if (value === null) return 'SPKNone'
  if (typeof value === 'boolean') return value ? 'SPKTrue' : 'SPKFalse'
  if (typeof value === 'number' && Number.isSafeInteger(value)) return 'SPK' + value
  if (typeof value === 'string' && value.length <= 32 && !/[\u0000-\u001f]/.test(value)) return 'SPK' + value
  return null
}
const unknownSpeaker = speaker => ['SPK?', 'SPKNone', 'SPK'].includes(speaker)
const normalizedKeys = ['index', 'resultIndex', 'startMs', 'endMs', 'text', 'speakerId']
function validNormalized(row, index) {
  return sameKeys(row, normalizedKeys) && row.index === index + 1 && row.resultIndex === 0 && interval(row) &&
    typeof row.text === 'string' && row.text.length > 0 && row.text === strip(row.text) &&
    (row.speakerId === null || typeof row.speakerId === 'string' && /^SPK[^\u0000-\u001f]{1,32}$/.test(row.speakerId) && !unknownSpeaker(row.speakerId))
}
const bodyKeys = ['schemaVersion', 'sourceSha256', 'audioSha256', 'rawResultSha256', 'timingLevel', 'timingProvenance', 'reviewRequired', 'accuracyVerified', 'sentences']

/** Return structural binding only. This function cannot prove producer origin. */
export function buildAsrSentenceManifest(input = {}) {
  if (!object(input)) return unavailable('INPUT_INVALID')
  const { transcript, audioSha256, rawResult, sentences } = input
  if (typeof transcript !== 'string' || !transcript.trim() || !validHash(audioSha256) || !Array.isArray(sentences)) return unavailable('INPUT_INVALID')
  if (Buffer.byteLength(transcript) > ASR_SENTENCE_MANIFEST_LIMITS.inputBytes) return unavailable('INPUT_LIMIT')
  const results = object(rawResult) ? [rawResult] : rawResult
  if (!Array.isArray(results) || !results.length || results.some(item => !object(item))) return unavailable('INPUT_INVALID')
  if (results.length !== 1) return unavailable('MULTI_RESULT_TIMEBASE_UNKNOWN')
  const original = results[0].sentence_info
  if (!Array.isArray(original) || !original.length) return unavailable('NO_PROVIDER_SENTENCE_INFO')
  if (original.length > ASR_SENTENCE_MANIFEST_LIMITS.sentences || sentences.length > ASR_SENTENCE_MANIFEST_LIMITS.sentences) return unavailable('MANIFEST_LIMIT')
  let rawJSON
  try { rawJSON = boundedJSON(rawResult); boundedJSON(sentences) } catch { return unavailable('INPUT_LIMIT') }
  const normalized = []
  for (const sentence of original) {
    if (!object(sentence) || typeof sentence.text !== 'string') return unavailable('RAW_SENTENCE_INVALID')
    const text = strip(sentence.text)
    if (!text) continue // Python build_outputs omits empty text before incrementing index.
    const row = { index: normalized.length + 1, resultIndex: 0, startMs: sentence.start, endMs: sentence.end, text, speakerId: null }
    const speaker = pythonSpeaker(sentence)
    if (!Object.hasOwn(sentence, 'start') || !Object.hasOwn(sentence, 'end') || !interval(row) || speaker === null) return unavailable('RAW_SENTENCE_INVALID')
    const output = sentences[normalized.length]
    if (!object(output) || output.index !== row.index || output.result_index !== 0 || output.start_ms !== row.startMs || output.end_ms !== row.endMs || output.text !== text || output.speaker !== speaker) return unavailable('SENTENCE_OUTPUT_MISMATCH')
    row.speakerId = unknownSpeaker(speaker) ? null : speaker
    if (!validNormalized(row, normalized.length)) return unavailable('RAW_SENTENCE_INVALID')
    normalized.push(row)
  }
  if (!normalized.length) return unavailable('NO_PROVIDER_SENTENCE_INFO')
  if (normalized.length !== sentences.length) return unavailable('SENTENCE_OUTPUT_MISMATCH')
  const body = { schemaVersion: 1, sourceSha256: sha256(transcript), audioSha256, rawResultSha256: sha256(rawJSON), timingLevel: 'sentence', timingProvenance: PROVENANCE, reviewRequired: true, accuracyVerified: false, sentences: normalized }
  const manifest = { ...body, manifestSha256: sha256(canonical(body)) }
  if (Buffer.byteLength(JSON.stringify(manifest)) > ASR_SENTENCE_MANIFEST_LIMITS.bytes) return unavailable('MANIFEST_LIMIT')
  return success(manifest)
}

/** Verify stored structure/hash and exact current audio/text; still NOT provenance. */
export function readAsrSentenceManifest(manifest, binding = {}) {
  if (manifest == null) return unavailable('MANIFEST_MISSING')
  if (!object(binding)) return unavailable('INPUT_INVALID')
  const { transcript, audioSha256 } = binding
  if (typeof transcript !== 'string' || !validHash(audioSha256)) return unavailable('INPUT_INVALID')
  if (!sameKeys(manifest, [...bodyKeys, 'manifestSha256']) || !Array.isArray(manifest.sentences)) return unavailable('MANIFEST_INVALID')
  if (manifest.sentences.length > ASR_SENTENCE_MANIFEST_LIMITS.sentences) return unavailable('MANIFEST_LIMIT')
  let serialized
  try { serialized = boundedJSON(manifest) } catch { return unavailable('MANIFEST_INVALID') }
  if (Buffer.byteLength(serialized) > ASR_SENTENCE_MANIFEST_LIMITS.bytes) return unavailable('MANIFEST_LIMIT')
  if (manifest.schemaVersion !== 1 || manifest.timingLevel !== 'sentence' || manifest.timingProvenance !== PROVENANCE || manifest.reviewRequired !== true || manifest.accuracyVerified !== false || !manifest.sentences.length || !['sourceSha256', 'audioSha256', 'rawResultSha256', 'manifestSha256'].every(key => validHash(manifest[key])) || !manifest.sentences.every(validNormalized)) return unavailable('MANIFEST_INVALID')
  const body = Object.fromEntries(bodyKeys.map(key => [key, manifest[key]]))
  if (sha256(canonical(body)) !== manifest.manifestSha256) return unavailable('MANIFEST_HASH_MISMATCH')
  if (sha256(transcript) !== manifest.sourceSha256 || audioSha256 !== manifest.audioSha256) return unavailable('SOURCE_BINDING_MISMATCH')
  // Return detached JSON data so a consumer cannot mutate the stored metadata by alias.
  return success(JSON.parse(serialized))
}
