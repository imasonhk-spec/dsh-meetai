import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, chmod, realpath, writeFile, readFile, copyFile, rename, rm, open } from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, 'word-document-worker.py')
const DEFAULT = path.join(HERE, 'default-minutes-template.docx')
const PREFIX = '/api/meeting-assistant/word-documents'
const MAX_UPLOAD = 10 * 1024 * 1024
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digest = value => createHash('sha256').update(value).digest('hex')
const fail = (code, status = 422) => Object.assign(new Error(code), { code, status })
function send(res, status, value) {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}
async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const item = await lstat(dir)
  if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== process.getuid()) throw fail('WORD_STORAGE_UNAVAILABLE', 503)
  await chmod(dir, 0o700)
}
async function atomicJSON(file, value) {
  const temporary = file + '.' + randomUUID() + '.new'
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, file) }
  finally { await rm(temporary, { force: true }).catch(() => {}) }
}
export function wordWorker(request, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', WORKER], { cwd: path.dirname(WORKER), stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: request.root || HERE, TMPDIR: request.root || HERE, DSH_WORD_WORKER_PG: '1' }, detached: true, signal, timeout: 120000 })
    let text = '', failed = false
    const killGroup = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }
    const abort = code => { if (!failed) { failed = true; killGroup(); reject(fail(code, 503)) } }
    child.stdin.on('error', () => abort('WORD_WORKER_UNAVAILABLE'))
    child.on('error', () => abort(signal?.aborted ? 'WORD_CANCELLED' : 'WORD_WORKER_UNAVAILABLE'))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', value => { text += value; if (text.length > 2 * 1024 * 1024) abort('WORD_WORKER_OUTPUT_LIMIT') })
    child.on('close', code => {
      killGroup()
      if (failed) return
      if (code !== 0) { reject(fail('WORD_WORKER_FAILED', 503)); return }
      try {
        const result = JSON.parse(text)
        if (result.ok !== true) throw fail(result.error?.code || 'WORD_INVALID_DOCUMENT')
        resolve(result)
      } catch (error) { reject(error.code ? error : fail('WORD_WORKER_PROTOCOL', 503)) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}
function validID(value) { if (typeof value !== 'string' || !ID.test(value)) throw fail('WORD_ID_INVALID', 400); return value }

/** All arguments/options are trusted Host state. No request may select worker or filesystem paths. */
export function createWordDocuments({ home = process.env.DSH_HOME, worker = wordWorker, mapFields } = {}) {
  if (!home || !path.isAbsolute(home)) throw new Error('Word documents require a private DSH_HOME')
  const root = path.join(home, 'meeting-assistant', 'word-documents')
  const uploads = path.join(root, 'templates'), artifacts = path.join(root, 'artifacts'), staging = path.join(root, 'staging')
  let storagePromise
  const controllers = new Set()
  let closed = false
  async function storage() {
    if (closed) throw fail('WORD_BACKEND_CLOSED', 503)
    if (!storagePromise) storagePromise = (async () => {
      if (await realpath(home) !== path.resolve(home)) throw fail('WORD_STORAGE_UNAVAILABLE', 503)
      for (const dir of [path.join(home, 'meeting-assistant'), root, uploads, artifacts, staging]) await privateDir(dir)
    })()
    return storagePromise
  }
  async function safeFile(file) {
    const item = await lstat(file)
    if (!item.isFile() || item.isSymbolicLink() || item.uid !== process.getuid() || !path.resolve(file).startsWith(root + path.sep)) throw fail('WORD_STORAGE_UNAVAILABLE', 503)
    return file
  }
  async function metadata(dir) { return JSON.parse(await readFile(await safeFile(path.join(dir, 'meta.json')), 'utf8')) }
  async function uploadTemplate({ bytes, name }) {
    await storage()
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_UPLOAD) throw fail('WORD_TEMPLATE_SIZE', 413)
    if (typeof name !== 'string' || !/\.docx$/i.test(name) || name.length > 160 || /[\x00-\x1f/\\]/.test(name)) throw fail('WORD_DOCX_REQUIRED', 400)
    const id = randomUUID(), dir = path.join(uploads, id)
    await privateDir(dir)
    try {
      const input = path.join(dir, 'template.docx')
      await writeFile(input, bytes, { flag: 'wx', mode: 0o600 })
      const inspected = await worker({ op: 'inspect', input, root })
      if (!Array.isArray(inspected.blocks) || !inspected.blocks.some(block => block.text)) throw fail('WORD_TEMPLATE_EMPTY')
      const data = { templateId: id, name, sha256: digest(bytes), state: 'available', createdAt: new Date().toISOString(), warnings: inspected.warnings || [] }
      await atomicJSON(path.join(dir, 'meta.json'), data)
      return { templateId: id, name, sha256: data.sha256, warnings: data.warnings, fonts: inspected.fonts || [] }
    } catch (error) { await rm(dir, { recursive: true, force: true }); throw error }
  }
  async function removeTemplate(id) {
    await storage(); validID(id)
    const dir = path.join(uploads, id)
    let lock
    try { lock = await open(path.join(dir, 'use.lock'), 'wx', 0o600) }
    catch (error) { if (error.code === 'ENOENT') return; throw fail(error.code === 'EEXIST' ? 'WORD_TEMPLATE_BUSY' : 'WORD_STORAGE_UNAVAILABLE', 409) }
    try { await rm(dir, { recursive: true, force: true }) }
    finally { await lock.close().catch(() => {}) }
  }
  async function validateTemplate(id) {
    await storage(); validID(id)
    const dir = path.join(uploads, id)
    let meta
    try { meta = await metadata(dir) } catch { throw fail('WORD_TEMPLATE_NOT_FOUND', 404) }
    if (meta.state !== 'available') throw fail('WORD_TEMPLATE_CONSUMED', 409)
    try { await lstat(path.join(dir, 'use.lock')); throw fail('WORD_TEMPLATE_BUSY', 409) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return meta
  }
  async function prepare({ templateId = '', sourceArtifactId = '', content, context = {}, signal, expectedTemplateSha256 = '', beforeCommit }) {
    await storage()
    if (typeof content !== 'string' || !content.trim() || content.length > 500000) throw fail('WORD_CONTENT_INVALID', 400)
    const cancel = new AbortController(), abort = () => cancel.abort()
    if (signal?.aborted) throw fail('WORD_CANCELLED', 409)
    signal?.addEventListener('abort', abort, { once: true }); controllers.add(cancel)
    const id = randomUUID(), stage = path.join(staging, id), final = path.join(artifacts, id)
    let templateDir, lock, committed = false, consumed = false, released = false
    async function release() {
      if (released) return
      released = true
      await lock?.close().catch(() => {})
      if (templateDir && lock) await rm(path.join(templateDir, 'use.lock'), { force: true }).catch(() => {})
      signal?.removeEventListener('abort', abort); controllers.delete(cancel)
    }
    try {
      let input = DEFAULT, mode = 'default', sourceMeta
      if (templateId) {
        templateDir = path.join(uploads, validID(templateId))
        sourceMeta = await metadata(templateDir)
        if (sourceMeta.state !== 'available') throw fail('WORD_TEMPLATE_CONSUMED', 409)
        try { lock = await open(path.join(templateDir, 'use.lock'), 'wx', 0o600) } catch (error) { throw fail(error.code === 'EEXIST' ? 'WORD_TEMPLATE_BUSY' : 'WORD_STORAGE_UNAVAILABLE', 409) }
        sourceMeta = await metadata(templateDir)
        if (sourceMeta.state !== 'available') throw fail('WORD_TEMPLATE_CONSUMED', 409)
        input = await safeFile(path.join(templateDir, 'template.docx')); mode = 'fills'
      } else if (sourceArtifactId) {
        const oldDir = path.join(artifacts, validID(sourceArtifactId)); sourceMeta = await metadata(oldDir)
        input = await safeFile(path.join(oldDir, 'source.docx')); mode = sourceMeta.mode
      }
      await privateDir(stage)
      const snapshot = path.join(stage, 'source.docx'), output = path.join(stage, 'minutes.docx')
      await copyFile(input, snapshot); await chmod(snapshot, 0o600)
      if (expectedTemplateSha256 && (!templateId || !/^[a-f0-9]{64}$/.test(expectedTemplateSha256) || digest(await readFile(snapshot)) !== expectedTemplateSha256)) throw fail('WORD_TEMPLATE_CHANGED', 409)
      const inspected = await worker({ op: 'inspect', input: snapshot, root }, { signal: cancel.signal })
      let fills = []
      if (mode === 'fills') {
        if (typeof mapFields !== 'function') throw fail('WORD_MAPPING_UNAVAILABLE', 503)
        fills = await mapFields({ blocks: inspected.blocks, content, context, signal: cancel.signal })
        if (!Array.isArray(fills) || !fills.length || fills.length > 256) throw fail('WORD_NO_IDENTIFIED_PLACEHOLDERS')
        for (const fill of fills) {
          if (!fill || typeof fill.paragraphId !== 'string' || typeof fill.placeholder !== 'string' || !fill.placeholder || typeof fill.value !== 'string' || fill.value.length > 100000) throw fail('WORD_MAPPING_INVALID')
          const block = inspected.blocks.find(item => item.paragraphId === fill.paragraphId || item.id === fill.paragraphId)
          if (!block || !block.text.includes(fill.placeholder)) throw fail('WORD_MAPPING_INVALID')
        }
      }
      const rendered = await worker({ op: 'render', input: snapshot, output, mode, fills, content, root }, { signal: cancel.signal })
      const preview = await worker({ op: 'preview', input: output, workdir: path.join(stage, 'preview'), root }, { signal: cancel.signal })
      if (typeof preview.pdfPath !== 'string' || !path.resolve(preview.pdfPath).startsWith(stage + path.sep)) throw fail('WORD_PREVIEW_PROTOCOL', 503)
      const pdf = await readFile(await safeFile(preview.pdfPath))
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw fail('WORD_PREVIEW_INVALID', 503)
      await chmod(output, 0o600)
      const docx = await readFile(await safeFile(output))
      await copyFile(preview.pdfPath, path.join(stage, 'preview.pdf')); await chmod(path.join(stage, 'preview.pdf'), 0o600)
      const warnings = [...new Set([...(inspected.warnings || []), ...(rendered.warnings || []), ...(preview.warnings || [])])]
      const document = { artifact_id: id, docx_url: `${PREFIX}/${id}/download`, preview_url: `${PREFIX}/${id}/preview`,
        docx_sha256: digest(docx), preview_sha256: digest(pdf), content_sha256: digest(content), page_count: preview.pages || null, warnings }
      await atomicJSON(path.join(stage, 'meta.json'), { ...document, mode, templateName: sourceMeta?.name || sourceMeta?.templateName || '系统默认模板', createdAt: new Date().toISOString() })
      if (cancel.signal.aborted) throw fail('WORD_CANCELLED', 409)
      return { document,
        async commit() {
          if (cancel.signal.aborted || closed) throw fail('WORD_CANCELLED', 409)
          if (committed) return document
          await beforeCommit?.()
          if (expectedTemplateSha256) {
            const current = await metadata(templateDir)
            if (current.state !== 'available' || current.sha256 !== expectedTemplateSha256 || digest(await readFile(await safeFile(path.join(templateDir, 'template.docx')))) !== expectedTemplateSha256) throw fail('WORD_TEMPLATE_CHANGED', 409)
          }
          if (cancel.signal.aborted || closed) throw fail('WORD_CANCELLED', 409)
          await rename(stage, final); committed = true
          if (templateDir) { const meta = await metadata(templateDir); await atomicJSON(path.join(templateDir, 'meta.json'), { ...meta, state: 'consumed', artifactId: id }); consumed = true }
          await release(); return document
        },
        async rollback({ retainCommitted = false } = {}) {
          cancel.abort()
          try {
            if (!(retainCommitted && committed)) await rm(committed ? final : stage, { recursive: true, force: true }).catch(() => {})
            if (templateDir && consumed) { const meta = await metadata(templateDir); await atomicJSON(path.join(templateDir, 'meta.json'), { ...meta, state: 'available', artifactId: '' }) }
          } finally { await release() }
        },
      }
    } catch (error) { cancel.abort(); await rm(stage, { recursive: true, force: true }).catch(() => {}); await release(); throw error }
  }
  // Trusted Host-only APIs. HTTP callers never supply filesystem paths or account homes.
  async function artifactBounds(dir) {
    // Recheck even after cached storage initialization: account ancestors may change.
    if (await realpath(home) !== path.resolve(home)) throw fail('WORD_STORAGE_UNAVAILABLE', 503)
    for (const parent of [path.join(home, 'meeting-assistant'), root, artifacts, dir]) {
      const item = await lstat(parent)
      if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== process.getuid() || (item.mode & 0o077) || await realpath(parent) !== parent) throw fail('WORD_STORAGE_UNAVAILABLE', 503)
    }
  }
  async function artifactBytes(dir, name, maximum, sizeCode) {
    await artifactBounds(dir)
    const file = path.join(dir, name)
    let handle
    try {
      const item = await lstat(file)
      if (!item.isFile() || item.isSymbolicLink() || item.uid !== process.getuid() || (item.mode & 0o077) || item.nlink !== 1) throw fail('WORD_STORAGE_UNAVAILABLE', 503)
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      const before = await handle.stat()
      if (before.dev !== item.dev || before.ino !== item.ino) throw fail('WORD_ARTIFACT_CHANGED', 409)
      if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) || before.nlink !== 1) throw fail('WORD_STORAGE_UNAVAILABLE', 503)
      if (before.size > maximum) throw fail(sizeCode, 413)
      // Bounded allocation/read also protects against growth after the size check.
      const buffer = Buffer.alloc(maximum + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > maximum) throw fail(sizeCode, 413)
      const after = await handle.stat(), current = await lstat(file)
      await artifactBounds(dir)
      if (after.uid !== process.getuid() || (after.mode & 0o077) || after.nlink !== 1 || current.isSymbolicLink()) throw fail('WORD_STORAGE_UNAVAILABLE', 503)
      if (after.size !== length || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino) throw fail('WORD_ARTIFACT_CHANGED', 409)
      return buffer.subarray(0, length)
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('WORD_ARTIFACT_NOT_FOUND', 404)
      if (error.code === 'ELOOP') throw fail('WORD_STORAGE_UNAVAILABLE', 503)
      throw error
    } finally { await handle?.close() }
  }
  async function artifactState(id) {
    await storage(); validID(id)
    const dir = path.join(artifacts, id)
    try {
      const meta = JSON.parse((await artifactBytes(dir, 'meta.json', 65536, 'WORD_METADATA_SIZE')).toString('utf8'))
      return { dir, meta }
    } catch (error) { if (error.code === 'ENOENT') throw fail('WORD_ARTIFACT_NOT_FOUND', 404); throw error }
  }
  async function readDocx(id) {
    const { dir, meta } = await artifactState(id)
    const bytes = await artifactBytes(dir, 'minutes.docx', MAX_UPLOAD, 'WORD_DOCUMENT_SIZE')
    if (digest(bytes) !== meta.docx_sha256) throw fail('WORD_ARTIFACT_CHANGED', 409)
    return bytes
  }
  async function readContent(id) {
    const { dir, meta } = await artifactState(id)
    const bytes = await artifactBytes(dir, 'content.txt', 2000000, 'WORD_CONTENT_SIZE')
    if (digest(bytes) !== meta.content_sha256) throw fail('WORD_ARTIFACT_CHANGED', 409)
    let content
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw fail('WORD_CONTENT_INVALID', 422) }
    if (content.length > 500000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw fail('WORD_CONTENT_INVALID', 422)
    return content
  }
  async function prepareEdited({ bytes, sourceArtifactId, signal }) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_UPLOAD) throw fail('WORD_DOCUMENT_SIZE', 413)
    // Freeze caller-owned bytes before the first asynchronous validation step.
    bytes = Buffer.from(bytes)
    await storage()
    if (signal?.aborted) throw fail('WORD_CANCELLED', 409)
    const { dir: sourceDir, meta: sourceMeta } = await artifactState(sourceArtifactId)
    if (!['default', 'fills'].includes(sourceMeta.mode)) throw fail('WORD_SOURCE_INVALID', 409)
    const cancel = new AbortController(), abort = () => cancel.abort()
    signal?.addEventListener('abort', abort, { once: true }); controllers.add(cancel)
    if (signal?.aborted) cancel.abort()
    const id = randomUUID(), stage = path.join(staging, id), final = path.join(artifacts, id)
    let committed = false, released = false, rolledBack = false, commitPromise
    function release() {
      if (released) return
      released = true; signal?.removeEventListener('abort', abort); controllers.delete(cancel)
    }
    try {
      if (cancel.signal.aborted) throw fail('WORD_CANCELLED', 409)
      await privateDir(stage)
      const output = path.join(stage, 'minutes.docx'), snapshot = path.join(stage, 'source.docx')
      // Bind both the current committed document and original template to this account.
      await readDocx(sourceArtifactId)
      const sourceBytes = await artifactBytes(sourceDir, 'source.docx', MAX_UPLOAD, 'WORD_DOCUMENT_SIZE')
      await writeFile(snapshot, sourceBytes, { flag: 'wx', mode: 0o600 })
      await writeFile(output, bytes, { flag: 'wx', mode: 0o600 })
      const inspected = await worker({ op: 'inspect', input: output, root }, { signal: cancel.signal })
      const content = inspected.content
      if (typeof content !== 'string' || content.length > 500000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw fail('WORD_CONTENT_INVALID', 422)
      if (inspected.sha256 && inspected.sha256 !== digest(bytes)) throw fail('WORD_ARTIFACT_CHANGED', 409)
      const preview = await worker({ op: 'preview', input: output, workdir: path.join(stage, 'preview'), root }, { signal: cancel.signal })
      if (typeof preview.pdfPath !== 'string' || !path.resolve(preview.pdfPath).startsWith(stage + path.sep)) throw fail('WORD_PREVIEW_PROTOCOL', 503)
      const pdf = await readFile(await safeFile(preview.pdfPath))
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw fail('WORD_PREVIEW_INVALID', 503)
      // A converter may read but must never alter the authoritative input.
      if (digest(await readFile(await safeFile(output))) !== digest(bytes)) throw fail('WORD_ARTIFACT_CHANGED', 409)
      await copyFile(preview.pdfPath, path.join(stage, 'preview.pdf')); await chmod(path.join(stage, 'preview.pdf'), 0o600)
      const document = { artifact_id: id, docx_url: `${PREFIX}/${id}/download`, preview_url: `${PREFIX}/${id}/preview`,
        docx_sha256: digest(bytes), preview_sha256: digest(pdf), content_sha256: digest(content), page_count: preview.pages || null,
        warnings: [...new Set([...(inspected.warnings || []), ...(preview.warnings || [])])], source_kind: 'rich-edit',
        artifact_version: (Number.isSafeInteger(sourceMeta.artifact_version) ? sourceMeta.artifact_version : 1) + 1 }
      const contentBytes = Buffer.from(content, 'utf8')
      if (contentBytes.toString('utf8') !== content) throw fail('WORD_CONTENT_INVALID', 422)
      const contentFile = path.join(stage, 'content.txt')
      await writeFile(contentFile, contentBytes, { flag: 'wx', mode: 0o600 })
      if (digest(await readFile(await safeFile(contentFile))) !== document.content_sha256) throw fail('WORD_ARTIFACT_CHANGED', 409)
      await atomicJSON(path.join(stage, 'meta.json'), { ...document, schema_version: 2, source_artifact_id: sourceArtifactId,
        mode: sourceMeta.mode, templateName: sourceMeta.templateName || '系统默认模板', createdAt: new Date().toISOString() })
      if (cancel.signal.aborted || closed) throw fail('WORD_CANCELLED', 409)
      return { document, content,
        async commit() {
          if (rolledBack || cancel.signal.aborted || closed) throw fail('WORD_CANCELLED', 409)
          if (committed) return document
          if (!commitPromise) commitPromise = (async () => { await rename(stage, final); committed = true; release(); return document })()
          return commitPromise
        },
        async rollback({ retainCommitted = false } = {}) {
          rolledBack = true; cancel.abort()
          if (commitPromise) await commitPromise.catch(() => {})
          if (!(retainCommitted && committed)) await rm(committed ? final : stage, { recursive: true, force: true })
          release()
        },
      }
    } catch (error) { cancel.abort(); await rm(stage, { recursive: true, force: true }).catch(() => {}); release(); throw error }
  }
  async function serve(id, type, res) {
    await storage(); validID(id)
    const dir = path.join(artifacts, id), meta = await metadata(dir)
    const preview = type === 'preview', file = await safeFile(path.join(dir, preview ? 'preview.pdf' : 'minutes.docx'))
    const bytes = await readFile(file)
    if (digest(bytes) !== (preview ? meta.preview_sha256 : meta.docx_sha256)) throw fail('WORD_ARTIFACT_CHANGED', 409)
    res.writeHead(200, { 'Content-Type': preview ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="meeting-minutes.${preview ? 'pdf' : 'docx'}"`,
      'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN' })
    const stream = createReadStream(file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res)
  }
  async function handle(req, res, { ensureForMinutes } = {}) {
    try {
      const url = new URL(req.url, 'http://localhost'), suffix = url.pathname.slice(PREFIX.length)
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) throw fail('WORD_ORIGIN_DENIED', 403)
      if (suffix === '/templates' && req.method === 'POST') {
        let size = 0; const buffers = []
        if (req.headers['content-encoding']) throw fail('WORD_UPLOAD_ENCODING', 400)
        for await (const buffer of req) { size += buffer.length; if (size > MAX_UPLOAD) throw fail('WORD_TEMPLATE_SIZE', 413); buffers.push(buffer) }
        send(res, 201, await uploadTemplate({ bytes: Buffer.concat(buffers), name: url.searchParams.get('name') })); return
      }
      const removal = /^\/templates\/([a-f0-9-]+)$/.exec(suffix)
      if (removal && req.method === 'DELETE') { await removeTemplate(removal[1]); send(res, 200, { ok: true }); return }
      const legacy = /^\/from-minutes\/([A-Za-z0-9_-]+)$/.exec(suffix)
      if (legacy && req.method === 'POST' && ensureForMinutes) {
        const ac = new AbortController(), disconnected = () => { if (!res.writableEnded) ac.abort() }
        res.on('close', disconnected)
        try { send(res, 200, { document: await ensureForMinutes(legacy[1], ac.signal) }) }
        finally { res.removeListener('close', disconnected) }
        return
      }
      const artifact = /^\/([a-f0-9-]+)\/(preview|download)$/.exec(suffix)
      if (artifact && req.method === 'GET') { await serve(artifact[1], artifact[2], res); return }
      throw fail('WORD_ROUTE_NOT_FOUND', 404)
    } catch (error) { send(res, error.code === 'ENOENT' ? 404 : error.status || 500, { error: error.code || 'WORD_INTERNAL_ERROR', reason: 'Word 模板或文档处理未完成，请检查格式或重试；没有改用 Markdown 下载。' }) }
  }
  return { uploadTemplate, removeTemplate, validateTemplate, prepare, prepareEdited, readDocx, readContent, handle, get closed() { return closed }, close() { closed = true; for (const cancel of controllers) cancel.abort(); controllers.clear() }, root }
}
export function mountWordDocuments(ctx, runtime, callbacks) {
  const remove = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: (req, res) => runtime.handle(req, res, callbacks) })
  return () => { remove(); runtime.close() }
}
