// Package-internal, dependency-free source memory. No model calls or route registration.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const VERSION = 'meetai-source-memory-1'
const locks = new Map()
export const hash = text => createHash('sha256').update(text, 'utf8').digest('hex')
const fail = (message, code = 'MEMORY_INTEGRITY') => Object.assign(new Error(message), { code })
function boundary(text, end) {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) return end - 1
  return end
}
export function partition(source, maxChars = 1800) {
  if (typeof source !== 'string' || !source.trim()) throw fail('完整转写不能为空', 'MEMORY_INPUT')
  if (!Number.isSafeInteger(maxChars) || maxChars < 16) throw fail('分段预算不合法', 'MEMORY_INPUT')
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = source.charCodeAt(i + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) throw fail('原文含无效Unicode，拒绝替换字符后留存', 'MEMORY_INPUT')
      i++
    } else if (c >= 0xDC00 && c <= 0xDFFF) throw fail('原文含无效Unicode', 'MEMORY_INPUT')
  }
  const segments = []
  for (let start = 0; start < source.length;) {
    let end = boundary(source, Math.min(start + maxChars, source.length))
    if (end < source.length) {
      const newline = start + source.slice(start, end).lastIndexOf('\n')
      if (newline + 1 >= start + maxChars / 2) end = newline + 1
    }
    const text = source.slice(start, end)
    segments.push({ id: `C${String(segments.length + 1).padStart(6, '0')}`, start, end, sha256: hash(text) })
    start = end
  }
  return segments
}
async function optional(file) {
  try { return await readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}
async function exclusive(file, text) {
  try { await writeFile(file, text, { flag: 'wx' }) }
  catch (e) { if (e.code !== 'EEXIST') throw e; if (await readFile(file, 'utf8') !== text) throw fail('既有记忆不一致，拒绝覆盖') }
}
export async function openSourceMemory({ dataRoot, meetingNamespace, source, maxChars = 1800 }) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw fail('宿主须提供本设备用户数据根', 'MEMORY_INPUT')
  if (typeof meetingNamespace !== 'string' || !meetingNamespace.trim()) throw fail('必须提供会议或任务隔离标识', 'MEMORY_INPUT')
  const segments = partition(source, maxChars)
  const definition = { version: VERSION, namespaceSha256: hash(meetingNamespace), sourceSha256: hash(source),
    lengthUtf16: source.length, maxChars, segments }
  const id = hash(JSON.stringify(definition))
  const directory = path.join(dataRoot, 'grounded-minutes', 'sources', id)
  const operation = async () => {
    await mkdir(directory, { recursive: true })
    const sourcePath = path.join(directory, 'source.txt'), manifestPath = path.join(directory, 'manifest.json')
    const original = await optional(sourcePath), previous = await optional(manifestPath)
    // Validate before writes; never overwrite corrupt/interrupted existing inputs.
    if (original !== null && original !== source) throw fail('原文哈希不一致，拒绝覆盖')
    if (previous !== null) {
      let stored
      try { stored = JSON.parse(previous) } catch { throw fail('记忆清单损坏') }
      if (JSON.stringify(stored) !== JSON.stringify(definition) || original === null) throw fail('记忆清单/原文不一致')
    }
    await exclusive(sourcePath, source)
    await exclusive(manifestPath, JSON.stringify(definition))
    return { id, directory, definition, getSegment(segmentId) {
      const s = segments.find(x => x.id === segmentId)
      if (!s) throw fail('未知原文分段', 'MEMORY_INPUT')
      return { ...s, text: source.slice(s.start, s.end) }
    } }
  }
  const run = (locks.get(directory) || Promise.resolve()).catch(() => {}).then(operation)
  locks.set(directory, run)
  try { return await run } finally { if (locks.get(directory) === run) locks.delete(directory) }
}
