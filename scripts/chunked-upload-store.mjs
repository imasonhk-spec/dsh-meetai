import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { MAX_AUDIO_BYTES, CHUNK_BYTES } from './chunked-upload-contract.mjs'
export { MAX_AUDIO_BYTES, CHUNK_BYTES } from './chunked-upload-contract.mjs'
const EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'ogg', 'webm', 'amr', 'flac'])
const fail = (code, message) => Object.assign(new Error(message), { code })
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Each instance belongs to one DSH_HOME. Four unfinished uploads reserve at most 2GiB. */
export class ChunkedUploadStore {
  constructor(root, persistRecording, withMeetingActivity = async (_id, operation) => operation()) {
    this.withMeetingActivity = withMeetingActivity
    this.root = path.resolve(root)
    this.parts = path.join(this.root, 'upload-parts')
    this.files = path.join(this.root, 'recordings', 'files')
    this.persistRecording = persistRecording
    this.active = new Set()
    this.creationTail = Promise.resolve()
  }
  paths(id) {
    if (!/^upl_[a-f0-9]{32}$/.test(id)) throw fail('BAD_UPLOAD_ID', 'Invalid upload id')
    return { state: path.join(this.parts, `${id}.json`), part: path.join(this.parts, `${id}.part`) }
  }
  async save(id, state) {
    const target = this.paths(id).state
    const temporary = `${target}.${randomBytes(4).toString('hex')}.pending`
    try {
      const file = await fs.open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(state)); await file.sync() } finally { await file.close() }
      await fs.rename(temporary, target)
    } finally { await fs.rm(temporary, { force: true }) }
  }
  async load(id) {
    try { return JSON.parse(await fs.readFile(this.paths(id).state, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') throw fail('UPLOAD_NOT_FOUND', 'Upload not found'); throw error }
  }
  async locked(id, operation) {
    this.paths(id)
    if (this.active.has(id)) throw fail('UPLOAD_BUSY', 'Upload is being processed')
    this.active.add(id)
    try { const state=await this.load(id);return await this.withMeetingActivity(state.meetingId,operation) } finally { this.active.delete(id) }
  }
  async assertMeetingIdle(meetingId) {
    const entries=await fs.readdir(this.parts).catch(error=>{if(error.code==='ENOENT')return [];throw error})
    for(const name of entries){
      if(!/^upl_[a-f0-9]{32}\.json$/.test(name))continue
      const state=await this.load(name.slice(0,-5))
      if(state.meetingId===meetingId&&(!state.committed||this.active.has(name.slice(0,-5))))throw fail('MEETING_UPLOAD_ACTIVE','本会议有未完成上传，请先完成或取消上传。')
    }
  }
  async reapExpired(now = Date.now()) {
    const entries = await fs.readdir(this.parts).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
    let unfinished = 0
    for (const name of entries) {
      if (!/^upl_[a-f0-9]{32}\.json$/.test(name)) continue
      const id = name.slice(0, -5)
      if (this.active.has(id)) { unfinished++; continue }
      try {
        const state = await this.load(id)
        const modified = (await fs.stat(this.paths(id).state)).mtimeMs
        const ttl = state.committed ? 3600000 : 24 * 3600000
        if (now - modified > ttl) await this.abort(id)
        else if (!state.committed) unfinished++
      } catch (error) {
        if (['ENOENT', 'UPLOAD_NOT_FOUND'].includes(error.code)) continue
        throw error
      }
    }
    for (const name of entries) {
      if (!/^upl_[a-f0-9]{32}\.part$/.test(name)) continue
      const id = name.slice(0, -5)
      if (this.active.has(id)) continue
      const missingState = await fs.stat(this.paths(id).state).then(() => false, (error) => { if (error.code === 'ENOENT') return true; throw error })
      if (!missingState) continue
      const stat = await fs.stat(this.paths(id).part).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
      if (stat && now - stat.mtimeMs > 24 * 3600000) await fs.rm(this.paths(id).part, { force: true })
    }
    return unfinished
  }
  create(meta) {
    const task = this.creationTail.then(() => this.createSession(meta))
    this.creationTail = task.catch(() => {})
    return task
  }
  async createSession(meta) { return this.withMeetingActivity(meta.meetingId,()=>this.createSessionOriginal(meta)) }
  async createSessionOriginal({ filename, totalBytes, meetingId = '' }) {
    const name = String(filename || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120)
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    if (!name || !EXTENSIONS.has(ext)) throw fail('BAD_EXTENSION', 'Unsupported audio extension')
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_AUDIO_BYTES) throw fail('BAD_UPLOAD_SIZE', 'Audio size must be between 1 byte and 500MiB')
    if (typeof meetingId !== 'string') throw fail('BAD_MEETING_ID', 'Invalid meeting id')
    await fs.mkdir(this.parts, { recursive: true, mode: 0o700 })
    if (await this.reapExpired() >= 4) throw fail('UPLOAD_LIMIT', '已有4个未完成上传，请取消旧上传后重试')
    const id = `upl_${randomBytes(16).toString('hex')}`
    await fs.writeFile(this.paths(id).part, Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
    try { await this.save(id, { filename: name, ext, totalBytes, meetingId, received: 0, chunks: [], recordingId: `rec_${randomBytes(8).toString('hex')}`, createdAt: new Date().toISOString() }) }
    catch (error) { await fs.rm(this.paths(id).part, { force: true }); throw error }
    return { uploadId: id, chunkBytes: CHUNK_BYTES, receivedBytes: 0 }
  }
  async put(id, seq, bytes, sha256) {
    return this.locked(id, async () => {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > CHUNK_BYTES) throw fail('BAD_CHUNK_SIZE', 'Chunk must be 1 byte to 1MiB')
      if (!Number.isSafeInteger(seq) || seq < 0) throw fail('BAD_CHUNK_SEQ', 'Invalid chunk sequence')
      if (!/^[a-f0-9]{64}$/.test(sha256 || '') || digest(bytes) !== sha256) throw fail('CHUNK_HASH_MISMATCH', 'Chunk digest mismatch')
      const state = await this.load(id)
      if (seq < state.chunks.length) {
        const previous = state.chunks[seq]
        if (previous.bytes !== bytes.length || previous.sha256 !== sha256) throw fail('CHUNK_CONFLICT', 'Retry differs from stored chunk')
        return { seq, receivedBytes: state.received, duplicate: true }
      }
      if (seq !== state.chunks.length) throw fail('CHUNK_GAP', 'Only the next contiguous chunk is accepted')
      const expected = Math.min(CHUNK_BYTES, state.totalBytes - state.received)
      if (bytes.length !== expected) throw fail('BAD_CHUNK_SIZE', 'Chunk length does not match declared total')
      const file = await fs.open(this.paths(id).part, 'r+')
      try {
        const stat = await file.stat()
        if (stat.size < state.received) throw fail('UPLOAD_CORRUPT', 'Acknowledged bytes are missing')
        if (stat.size > state.received) await file.truncate(state.received)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, state.received + offset)
          if (!bytesWritten) throw fail('UPLOAD_WRITE_FAILED', 'Short write')
          offset += bytesWritten
        }
        await file.sync()
      } finally { await file.close() }
      state.received += bytes.length
      state.chunks.push({ bytes: bytes.length, sha256 })
      await this.save(id, state)
      return { seq, receivedBytes: state.received, duplicate: false }
    })
  }
  async commit(id) {
    return this.locked(id, async () => {
      const state = await this.load(id)
      if (state.committed) return state.committed
      if (state.received !== state.totalBytes) throw fail('UPLOAD_INCOMPLETE', 'Upload is not complete')
      const part = this.paths(id).part
      const destination = path.join(this.files, `${state.recordingId}.${state.ext}`)
      const hasPart = await fs.stat(part).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
      const file = await fs.open(hasPart ? part : destination, 'r')
      const whole = createHash('sha256')
      try {
        if ((await file.stat()).size !== state.totalBytes) throw fail('UPLOAD_CORRUPT', 'Stored size mismatch')
        let offset = 0
        for (const chunk of state.chunks) {
          const bytes = Buffer.alloc(chunk.bytes)
          let done = 0
          while (done < bytes.length) {
            const result = await file.read(bytes, done, bytes.length - done, offset + done)
            if (!result.bytesRead) throw fail('UPLOAD_CORRUPT', 'Stored chunk truncated')
            done += result.bytesRead
          }
          if (digest(bytes) !== chunk.sha256) throw fail('UPLOAD_CORRUPT', 'Stored chunk digest mismatch')
          whole.update(bytes)
          offset += bytes.length
        }
      } finally { await file.close() }
      const recording = { recording_id: state.recordingId, filename: state.filename,
        ext: state.ext, size_bytes: state.totalBytes, sha256: whole.digest('hex'),
        meeting_id: state.meetingId || null, transcript: '', duration_seconds: null, created_at: state.createdAt }
      await fs.mkdir(this.files, { recursive: true, mode: 0o700 })
      if (hasPart) await fs.rename(part, destination)
      try { await this.persistRecording(recording) }
      catch (error) { if (hasPart) await fs.rename(destination, part); throw error }
      state.committed = recording
      await this.save(id, state)
      return recording
    })
  }
  async abort(id) {
    return this.locked(id, async () => {
      const files = this.paths(id)
      await fs.rm(files.part, { force: true })
      await fs.rm(files.state, { force: true })
    })
  }
}
