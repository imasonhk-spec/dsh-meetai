import path from 'node:path'
import { constants } from 'node:fs'
import { mkdir, lstat, open, rename, rm, readdir, rmdir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

const requestContext = new AsyncLocalStorage()
export const generationRequestRevision = () => requestContext.getStore()


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TERMINAL = new Set(['completed', 'unresolved', 'cancelled', 'interrupted'])
const RESERVED = /^(?:dataRoot|path|account|accountId|user|userId|username|taskId|task_id|apiKey|token|secret|__proto__|constructor|prototype)$/i
const failure = (code, status, message) => Object.assign(new Error(message), { code, status, statusCode: status })
const copy = value => JSON.parse(JSON.stringify(value))
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.transcript !== 'string' || !input.transcript.trim() || input.transcript.length > 200000) {
    throw failure('INVALID_INPUT', 400, 'transcript must be a nonempty string of at most 200000 characters')
  }
  function inspect(value) {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (RESERVED.test(key)) throw failure('RESERVED_INPUT', 400, 'Client identity, paths and secrets are not task input')
      inspect(item)
    }
  }
  let snapshot
  try { snapshot = copy(input) } catch { throw failure('INVALID_INPUT', 400, 'Input must be JSON serializable') }
  inspect(snapshot)
  return canonical(snapshot)
}

/** One manager per isolated user root; HTTP authentication/routing belongs to the caller.
 * All API methods return promises. Work runs at most one task at a time.
 * Restarted queued/running tasks become interrupted; retry explicitly resumes them.
 */
export function createGenerationTasks({ dataRoot, run, enterMeeting = () => () => {} }) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || typeof run !== 'function') throw failure('INVALID_CONFIG', 400, 'Absolute dataRoot and run are required')
  const root = path.resolve(dataRoot), storage = path.join(root, 'generation-tasks')
  const records = new Map(), active = new Map(), fingerprints = new Map(), queue = []
  let closed = false, chain = Promise.resolve(), pumping = false
  const serial = operation => {
    const next = chain.then(operation)
    chain = next.catch(() => {})
    return next
  }
  const idPath = id => {
    if (typeof id !== 'string' || !UUID.test(id)) throw failure('INVALID_TASK_ID', 400, 'Task ID must be a UUID v4')
    return path.join(storage, id)
  }
  async function check(file, directory = false) {
    const st = await lstat(file)
    if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()) || (st.mode & 0o077) !== 0 || (!directory && st.nlink !== 1) || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
      throw failure('UNSAFE_STORAGE', 403, 'Unsafe task storage permissions or link')
    }
  }
  async function ancestors() {
    let current = root
    while (true) {
      const st = await lstat(current)
      if (st.isSymbolicLink() || !st.isDirectory()) throw failure('UNSAFE_STORAGE', 403, 'Storage ancestor must not be a link')
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  async function ensureStorage() {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await ancestors()
    await check(root, true)
    await mkdir(storage, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e })
    await check(storage, true)
  }
  async function directory(id) {
    await ensureStorage()
    const dir = idPath(id)
    await check(dir, true)
    return dir
  }
  async function readJSON(file) {
    await check(file)
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    try {
      const st = await handle.stat()
      if (!st.isFile() || (st.mode & 0o077) || st.nlink !== 1) throw failure('UNSAFE_STORAGE', 403, 'Unsafe task file')
      return JSON.parse(await handle.readFile('utf8'))
    } finally { await handle.close() }
  }
  async function atomic(file, value) {
    await check(path.dirname(file), true)
    try { await check(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(tmp, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
      await rename(tmp, file)
    } finally { await rm(tmp, { force: true }).catch(() => {}) }
  }
  const status = record => copy(record.state)
  async function persist(record) {
    record.state.updated = new Date().toISOString()
    await directory(record.state.task_id)
    await atomic(path.join(idPath(record.state.task_id), 'state.json'), record.state)
  }
  async function load(id) {
    const dir = idPath(id)
    try {
      await directory(id)
      // Recheck files even for an in-memory record: never trust substituted storage.
      const state = await readJSON(path.join(dir, 'state.json'))
      const input = validateInput(await readJSON(path.join(dir, 'input.json')))
      if (state.task_id !== id || !['queued', 'running', ...TERMINAL].includes(state.state)) throw failure('CORRUPT_TASK', 500, 'Invalid persisted task')
      let record = records.get(id)
      if (!record) {
        record = { input, fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex'), state }
        records.set(id, record)
        if (['queued', 'running'].includes(state.state) && !active.has(id)) {
          record.state.state = 'interrupted'
          await persist(record)
        }
      }
      return record
    } catch (e) {
      if (e.code === 'ENOENT') throw failure('TASK_NOT_FOUND', 404, 'Task not found')
      throw e
    }
  }
  function schedule() {
    if (pumping || closed) return
    pumping = true
    queueMicrotask(() => {
      pumping = false
      serial(async () => {
        if (closed || active.size || !queue.length) return
        const record = queue.shift(), id = record.state.task_id
        if (record.state.state !== 'queued') { schedule(); return }
        const controller = new AbortController(), token = { controller }
        active.set(id, token)
        record.state.state = 'running'
        try { await persist(record) } catch (e) { active.delete(id); fingerprints.delete(record.fingerprint); schedule(); throw e }
        const onProgress = progress => serial(async () => {
          if (active.get(id) !== token || controller.signal.aborted || record.state.state !== 'running') return
          // Only counters/phase labels enter public status, never arbitrary engine content.
          const safe = {}
          if (progress && typeof progress === 'object') {
            for (const [key, value] of Object.entries(progress)) {
              if (/^(?:percent|completed|total|processedSegments|plannedSegments|processedSubsegments|completionAttempts|cacheHits|rejectedCacheHits|unresolvedCount)$/.test(key) && typeof value === 'number' && Number.isFinite(value)) {
                safe[key] = Math.max(record.state.progress[key] ?? 0, value)
              } else if (key === 'phase' && typeof value === 'string' && /^[a-z_-]{1,40}$/i.test(value)) safe.phase = value
              else if (key === 'lastErrorCode' && typeof value === 'string' && /^[A-Z_]{1,60}$/.test(value)) safe.lastErrorCode = value
              else if (key === 'lastFailedSegment' && typeof value === 'string' && /^C\d{6}(?:\.\d){0,5}$/.test(value)) safe.lastFailedSegment = value
            }
          }
          record.state.progress = { ...record.state.progress, ...safe }
          await persist(record)
          if (safe.phase === 'committing') token.committing = true
        })
        // Observe rejection even if a runner does not await the progress callback.
        const report = progress => { const p = onProgress(progress); p.catch(() => {}); return p }
        Promise.resolve().then(() => requestContext.run(`${id}:${record.state.retryRevision ?? 0}`, () => run(copy(record.input), { signal: controller.signal, onProgress: report, taskId: id, forceRetryRevision: `${id}:${record.state.retryRevision ?? 0}` })))
          .then(result => finish(record, token, result), () => finish(record, token, { error: 'GENERATION_FAILED' }))
          .catch(() => {}).finally(() => { schedule() })
      }).catch(() => {})
    })
  }
  function finish(record, token, result) {
    return serial(async () => {
      const id = record.state.task_id
      if (active.get(id) !== token) return
      try {
        if (!token.controller.signal.aborted && record.state.state === 'running') {
          try { record.state.result = copy(result) } catch { record.state.result = { error: 'INVALID_RUN_RESULT' } }
          record.state.state = record.state.result && typeof record.state.result === 'object' && !Array.isArray(record.state.result)
            ? (Object.hasOwn(record.state.result, 'error') ? 'unresolved' : 'completed') : 'unresolved'
          await persist(record)
        }
      } finally { active.delete(id); fingerprints.delete(record.fingerprint) }
    })
  }
  async function meetingRecords(meetingId) {
    await ensureStorage()
    const result=[]
    for(const id of await readdir(storage)){
      if(!UUID.test(id))continue
      let marker
      try{marker=await readJSON(path.join(idPath(id),'delete-owner.json'))}catch(error){if(error.code!=='ENOENT')throw error}
      const record=marker?{input:{meeting_id:marker.meetingId},state:{task_id:id,state:'completed'}}:await load(id)
      if(marker&&(marker.taskId!==id||typeof marker.meetingId!=='string'))throw failure('CORRUPT_TASK',500,'Invalid deletion owner receipt')
      if(record.input.meeting_id===meetingId)result.push(record)
    }
    for(const record of result)if(active.has(record.state.task_id)||queue.includes(record)||record.state.state==='running'||record.state.state==='queued')throw failure('MEETING_GENERATION_ACTIVE',409,'该会议有正在运行或排队的纪要任务。')
    return result
  }
  return {
    assertMeetingIdle(meetingId){return serial(()=>meetingRecords(meetingId).then(()=>undefined))},
    deleteMeeting(meetingId){return serial(async()=>{
      const rows=await meetingRecords(meetingId),removed=[],retained=[]
      try {
      for(const record of rows){
        const id=record.state.task_id,dir=await directory(id)
        // Body-free owner receipt makes a partial unlink retryable after restart.
        await atomic(path.join(dir,'delete-owner.json'),{taskId:id,meetingId})
        for(const name of ['input.json','state.json']){
          try{await check(path.join(dir,name));await rm(path.join(dir,name));removed.push('grounded-minutes/job-store/generation-tasks/'+id+'/'+name)}catch(error){if(error.code!=='ENOENT')throw error}
        }
        records.delete(id);fingerprints.delete(record.fingerprint)
        for(const name of await readdir(dir))if(name!=='delete-owner.json')retained.push({file:'grounded-minutes/job-store/generation-tasks/'+id+'/'+name,reason:'未识别文件，予以保留'})
      }
      return {removed,retained}
      } catch(error) { error.cleanupReceipt={removed,retained}; throw error }
    })},
    start(input) {
      return serial(async () => {
        if (closed) throw failure('TASK_MANAGER_CLOSED', 503, 'Task manager is closed')
        const snapshot = validateInput(input), fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
        const leave=enterMeeting(snapshot.meeting_id)
        try {
        const existing = fingerprints.get(fingerprint)
        if (existing) return status(await load(existing))
        await ensureStorage()
        const id = randomUUID(), dir = idPath(id)
        await mkdir(dir, { mode: 0o700 })
        const now = new Date().toISOString()
        const record = { input: snapshot, fingerprint, state: { task_id: id, state: 'queued', progress: {}, created: now, updated: now, result: null } }
        await atomic(path.join(dir, 'input.json'), snapshot)
        await atomic(path.join(dir, 'state.json'), record.state)
        records.set(id, record); fingerprints.set(fingerprint, id); queue.push(record); schedule()
        return status(record)
        } finally { leave() }
      })
    },
    get(id) { return serial(async () => status(await load(id))) },
    retry(id) {
      return serial(async () => {
        if (closed) throw failure('TASK_MANAGER_CLOSED', 503, 'Task manager is closed')
        const record = await load(id)
        const leave=enterMeeting(record.input.meeting_id)
        try {
        if (record.state.state === 'completed' || active.has(id) || record.state.state === 'queued') return status(record)
        const duplicate = fingerprints.get(record.fingerprint)
        if (duplicate && duplicate !== id) return status(await load(duplicate))
        if (!Number.isSafeInteger(record.state.retryRevision ?? 0) || (record.state.retryRevision ?? 0) < 0 || (record.state.retryRevision ?? 0) >= Number.MAX_SAFE_INTEGER) throw failure('CORRUPT_TASK', 500, 'Invalid retry revision')
        record.state.retryRevision = (record.state.retryRevision ?? 0) + 1
        record.state.state = 'queued'; record.state.result = null; record.state.progress = {}
        await persist(record)
        fingerprints.set(record.fingerprint, id); queue.push(record); schedule()
        return status(record)
        } finally {leave()}
      })
    },
    cancel(id) {
      return serial(async () => {
        const record = await load(id)
        if (TERMINAL.has(record.state.state)) return status(record)
        if (active.get(id)?.committing) throw failure('TASK_COMMITTING', 409, 'Commit has started; cancellation is no longer accepted')
        active.get(id)?.controller.abort()
        record.state.state = 'cancelled'
        await persist(record)
        if (!active.has(id)) fingerprints.delete(record.fingerprint)
        schedule()
        return status(record)
      })
    },
    close() {
      return serial(async () => {
        closed = true
        for (const record of records.values()) {
          if (!['queued', 'running'].includes(record.state.state)) continue
          if (active.get(record.state.task_id)?.committing) continue
          active.get(record.state.task_id)?.controller.abort()
          record.state.state = 'cancelled'
          await persist(record)
        }
        queue.length = 0
      })
    }
  }
}
