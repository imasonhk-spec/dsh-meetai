import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, stat, mkdir, chmod, writeFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOCAL_CAPTION_PREFIX = '/api/meeting-assistant/local-captions'
const RUNTIME = '/home/lgsj/Downloads/AI game/akun-meeting/akun-runtime'
const PYTHON = `${RUNTIME}/.venv/bin/python`
const WORKER = fileURLToPath(new URL('./local-caption-worker.py', import.meta.url))
const ASSETS = { paraformer: ['config.yaml','model.pt','tokens.json','seg_dict','am.mvn'], punc: ['config.yaml','model.pt','tokens.json'] }
const MAX_BYTES = 30 * 16000 * 2
// Shared across mounts/profiles in this Node process, not merely per route.
let activeInference = 0
const MAX_CONCURRENCY = 1
const fail = (status, code) => Object.assign(new Error(code), { status, code })

export async function localCaptionReadiness() {
  const missing = []
  try { if (!(await stat(PYTHON)).isFile()) missing.push('python') } catch { missing.push('python') }
  for (const [model, names] of Object.entries(ASSETS)) {
    try { const d = await lstat(`${RUNTIME}/release/models/${model}`); if (!d.isDirectory() || d.isSymbolicLink()) missing.push(model) } catch { missing.push(model) }
    for (const name of names) {
      try { const s = await lstat(`${RUNTIME}/release/models/${model}/${name}`); if (!s.isFile() || !s.size || s.isSymbolicLink()) missing.push(`${model}/${name}`) } catch { missing.push(`${model}/${name}`) }
    }
  }
  for (const name of ['funasr','torch','numpy','yaml']) {
    try { if (!(await stat(`${RUNTIME}/.venv/lib/python3.12/site-packages/${name}`)).isDirectory()) missing.push(name) } catch { missing.push(name) }
  }
  try { if (!(await stat(WORKER)).isFile()) missing.push('worker') } catch { missing.push('worker') }
  // Linux-specific isolation is required, never silently relaxed.
  if (process.platform !== 'linux') missing.push('linux-seccomp')
  let seccomp = false
  for (const location of ['/lib/x86_64-linux-gnu/libseccomp.so.2','/usr/lib/x86_64-linux-gnu/libseccomp.so.2','/lib/aarch64-linux-gnu/libseccomp.so.2']) {
    try { if ((await stat(location)).isFile()) seccomp = true } catch {}
  }
  if (!seccomp) missing.push('libseccomp')
  return { ready: missing.length === 0, dependencyReady: missing.length === 0, missing,
    inferenceState: 'undetected', backend: 'server-local-paraformer', sampleRate: 16000,
    chunkSeconds: 15, device: 'cpu', networkPolicy: 'worker-kernel-deny', speakerIdentity: false,
    scope: 'preview-only', browserFallback: false }
}

export function createPythonCaptionWorker({ dir, signal }) {
  // No client values become executable, model, environment, or script flags.
  const child = spawn(PYTHON, ['-I', '-u', WORKER], { cwd: dir, stdio: ['pipe','pipe','ignore'],
    env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, XDG_CACHE_HOME: dir,
      HF_HOME: dir, MODELSCOPE_CACHE: dir, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
      MODELSCOPE_OFFLINE: '1', CUDA_VISIBLE_DEVICES: '', OMP_NUM_THREADS: '3', MKL_NUM_THREADS: '3' } })
  let pending, dead = false, buffer = '', readyResolve, readyReject
  const ready = new Promise((resolve,reject) => { readyResolve=resolve; readyReject=reject })
  // ready may fail before the caller reaches await: prevent unhandled rejection.
  ready.catch(() => {})
  function stop() {
    if (dead) return
    dead = true
    child.kill('SIGKILL')
    const error = fail(503,'LOCAL_WORKER_UNAVAILABLE')
    readyReject(error); pending?.reject(error); pending = null
    signal.removeEventListener('abort',stop)
  }
  signal.addEventListener('abort',stop,{once:true})
  if (signal.aborted) stop()
  child.on('error',stop); child.on('exit',stop)
  child.stdin.on('error',stop)
  child.stdout.setEncoding('utf8') // retain split multi-byte Chinese characters
  child.stdout.on('data',data => {
    buffer += data
    if (buffer.length > 65536) { stop(); return }
    let n
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,n); buffer = buffer.slice(n+1)
      let value
      try { value=JSON.parse(line) } catch { stop(); return }
      if (value.error) { stop(); return }
      if (value.state === 'ready' && value.networkBlocked === true && value.device === 'cpu') readyResolve()
      else if (pending && value.seq === pending.seq && typeof value.text === 'string' && value.text.length <= 10000) {
        pending.resolve({ text: value.text }); pending = null
      } else { stop(); return }
    }
  })
  return { real: true, ready, kill: stop, async infer({seq}) {
    await ready
    if (dead || pending) throw fail(503,'LOCAL_WORKER_UNAVAILABLE')
    return new Promise((resolve,reject) => {
      pending = { seq, resolve, reject }
      child.stdin.write(JSON.stringify({seq})+'\n')
    })
  } }
}

async function privateDirectory(dir) {
  await mkdir(dir,{recursive:true,mode:0o700})
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw fail(503,'LOCAL_STORAGE_UNAVAILABLE')
  await chmod(dir,0o700)
}

/** External audio shares the existing local worker and process inference limit. */
export async function createExternalCaptionSession({dir,readiness=localCaptionReadiness,workerFactory=createPythonCaptionWorker}) {
  if(!(await readiness()).ready)throw fail(503,'LOCAL_DEPENDENCIES_UNAVAILABLE')
  await privateDirectory(dir)
  const cancel=new AbortController()
  let worker,busy=false
  return {
    async infer({seq,pcm,startMs}) {
      if(cancel.signal.aborted)throw fail(410,'LOCAL_SESSION_CANCELLED')
      if(busy||activeInference>=MAX_CONCURRENCY)throw fail(429,'LOCAL_INFERENCE_BUSY')
      if(!Buffer.isBuffer(pcm)||pcm.length<3200||pcm.length>MAX_BYTES||pcm.length%2)throw fail(400,'PCM_SAMPLE_ALIGNMENT')
      busy=true;activeInference++
      const file=path.join(dir,`chunk-${seq}.pcm`)
      let timer
      try{
        await writeFile(file,pcm,{flag:'wx',mode:0o600})
        worker ||= workerFactory({dir,signal:cancel.signal})
        const result=await Promise.race([(async()=>{await worker.ready;return worker.infer({seq})})(),new Promise((_,reject)=>{timer=setTimeout(()=>{cancel.abort();reject(fail(504,'LOCAL_INFERENCE_TIMEOUT'))},120000)})])
        if(typeof result?.text!=='string'||result.text.length>10000)throw fail(503,'LOCAL_INFERENCE_FAILED')
        return {entries:result.text.trim()?[{utteranceId:`external:${seq}`,startMs,endMs:startMs+pcm.length/32,text:result.text.trim(),speakerId:null,kind:'final',confidenceState:'unknown'}]:[]}
      }finally{clearTimeout(timer);await rm(file,{force:true}).catch(()=>{});busy=false;activeInference--}
    },
    async close(){cancel.abort();worker?.kill();await rm(dir,{recursive:true,force:true})}
  }
}
async function readPCM(req, signal) {
  if (req.headers['content-type'] !== 'application/octet-stream' || req.headers['content-encoding']) throw fail(415,'PCM16_REQUIRED')
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > MAX_BYTES)) throw fail(413,'CHUNK_TOO_LARGE')
  const pcm=await new Promise((resolve,reject) => {
    let size=0, chunks=[], settled=false
    const done=(error) => {
      if (settled) return
      settled=true; clearTimeout(timeout)
      req.removeListener('data',data); req.removeListener('end',end)
      req.removeListener('aborted',aborted); req.removeListener('error',aborted)
      signal.removeEventListener('abort',cancelled)
      if (error) { chunks=[]; req.resume(); reject(error) }
      else resolve(Buffer.concat(chunks,size))
    }
    const data=part=> {size+=part.length; if(size>MAX_BYTES) done(fail(413,'CHUNK_TOO_LARGE')); else chunks.push(part)}
    const end=()=>done()
    const aborted=()=>done(fail(400,'LOCAL_PAYLOAD_INTERRUPTED'))
    const cancelled=()=>done(fail(410,'LOCAL_SESSION_CANCELLED'))
    const timeout=setTimeout(()=>done(fail(408,'LOCAL_PAYLOAD_TIMEOUT')),15000)
    req.on('data',data); req.once('end',end); req.once('aborted',aborted); req.once('error',aborted)
    signal.addEventListener('abort',cancelled,{once:true})
    if (signal.aborted) cancelled()
  })
  if (pcm.length < 3200 || pcm.length % 2) throw fail(400,'PCM_SAMPLE_ALIGNMENT')
  const magic=pcm.subarray(0,4).toString('ascii')
  if (['RIFF','RIFX','OggS','fLaC'].includes(magic) || magic.startsWith('ID3') || pcm.readUInt32BE(0)===0x1a45dfa3) throw fail(415,'RAW_PCM_REQUIRED')
  // PCM16 has no NaN/Infinity bit pattern. Float buffers are NOT an accepted format.
  return pcm
}
function integer(value, max) {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) throw fail(400,'INVALID_POSITION')
  const n=Number(value)
  if (!Number.isSafeInteger(n) || n>max) throw fail(400,'INVALID_POSITION')
  return n
}
function respond(res,status,value) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
  res.end(JSON.stringify(value))
}

/** Runtime integration: mountLocalCaptions(ctx), cleanup once in parent wrapper.
 * Optional dependencies below are server-side TEST seams, never HTTP options. */
export function mountLocalCaptions(ctx, options = {}) {
  const sessions=new Map()
  const workerFactory=options.workerFactory || createPythonCaptionWorker
  const readiness=options.readiness || localCaptionReadiness
  const home=options.home || process.env.DSH_HOME
  const maxSessions=options.maxSessions ?? 2
  const idleMs=options.idleMs ?? 120000
  const timeoutMs=Math.min(options.timeoutMs ?? 120000,180000)
  let closed=false, smokeVerified=false, rootPromise
  if (!home || !path.isAbsolute(home)) throw new Error('DSH_HOME must be an absolute per-profile directory')
  const root=path.join(home,'meeting-assistant','local-captions',`process-${process.pid}-${randomUUID()}`)
  async function storage() {
    if (!rootPromise) rootPromise=(async () => {
      const canonical=await realpath(home)
      if (canonical !== path.resolve(home)) throw fail(503,'LOCAL_STORAGE_UNAVAILABLE')
      for (const dir of [path.join(home,'meeting-assistant'),path.join(home,'meeting-assistant','local-captions'),root]) await privateDirectory(dir)
    })()
    return rootPromise
  }
  async function destroy(session) {
    session.cancel.abort(); session.worker?.kill(); sessions.delete(session.id)
    await rm(session.dir,{recursive:true,force:true}).catch(() => {})
  }
  const timer=setInterval(() => {
    for (const session of sessions.values()) if (Date.now()-session.touched>idleMs) void destroy(session)
  },Math.max(10,Math.min(idleMs,30000)))
  timer.unref()
  const handler=async (req,res) => {
    try {
      if (closed) throw fail(503,'LOCAL_BACKEND_CLOSED')
      const url=new URL(req.url,'http://localhost')
      const suffix=url.pathname.slice(LOCAL_CAPTION_PREFIX.length)
      // Existing webserver authentication remains authoritative; additionally
      // refuse cross-origin browser requests that could allocate a worker.
      const origin=req.headers.origin
      if (origin && new URL(origin).host !== req.headers.host) throw fail(403,'ORIGIN_DENIED')
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403,'ORIGIN_DENIED')
      if (suffix === '/status' && req.method === 'GET') {
        const status=await readiness()
        respond(res,200,{...status,inferenceState:smokeVerified?'verified':'undetected'}); return
      }
      if (suffix === '/session' && req.method === 'POST') {
        // Session creation accepts NO options/body/model flags.
        if (url.search || req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) throw fail(400,'SESSION_OPTIONS_FORBIDDEN')
        if (!(await readiness()).ready) throw fail(503,'LOCAL_DEPENDENCIES_UNAVAILABLE')
        await storage()
        if (closed) throw fail(503,'LOCAL_BACKEND_CLOSED')
        if (sessions.size>=maxSessions) throw fail(429,'LOCAL_SESSION_LIMIT')
        const id=randomUUID(), token=randomBytes(32).toString('hex'), dir=path.join(root,id)
        const session={ id,token,dir,cancel:new AbortController(),next:0,endMs:0,busy:false,touched:Date.now(),history:new Map() }
        // Reserve synchronously before awaiting mkdir; prevents allocation races.
        sessions.set(id,session)
        try { await privateDirectory(dir) } catch (e) { await destroy(session); throw e }
        if (closed || session.cancel.signal.aborted) { await destroy(session); throw fail(410,'LOCAL_SESSION_CANCELLED') }
        respond(res,201,{sessionId:id,token,sampleRate:16000,chunkSeconds:15}); return
      }
      const match=/^\/session\/([0-9a-f-]{36})(\/chunk)?$/.exec(suffix)
      if (!match) throw fail(404,'LOCAL_ROUTE_NOT_FOUND')
      const session=sessions.get(match[1])
      if (!session) throw fail(404,'LOCAL_SESSION_NOT_FOUND')
      const supplied=req.headers['x-caption-token']
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(session.token))) throw fail(403,'LOCAL_TOKEN_INVALID')
      session.touched=Date.now()
      if (!match[2] && req.method === 'DELETE') {
        if (url.search) throw fail(400,'INVALID_POSITION')
        await destroy(session); respond(res,200,{state:'cancelled'}); return
      }
      if (!match[2] || req.method !== 'POST') throw fail(405,'METHOD_NOT_ALLOWED')
      if ([...url.searchParams.keys()].some(k=>!['seq','startMs'].includes(k)) || url.searchParams.getAll('seq').length!==1 || url.searchParams.getAll('startMs').length!==1) throw fail(400,'INVALID_POSITION')
      const seq=integer(url.searchParams.get('seq'),100000), startMs=integer(url.searchParams.get('startMs'),86400000)
      if (session.busy) throw fail(409,'LOCAL_SESSION_BUSY')
      session.busy=true
      let acquired=false, filename
      try {
        const pcm=await readPCM(req,session.cancel.signal)
        const hash=createHash('sha256').update(pcm).digest('hex')
        const old=session.history.get(seq)
        if (old) {
          if (old.hash!==hash || old.startMs!==startMs) throw fail(409,'CHUNK_RETRY_MISMATCH')
          respond(res,200,old.response); return
        }
        if (seq!==session.next || startMs<session.endMs) throw fail(409,'CHUNK_SEQUENCE_INVALID')
        if (activeInference>=MAX_CONCURRENCY) throw fail(429,'LOCAL_INFERENCE_BUSY')
        if (session.cancel.signal.aborted) throw fail(410,'LOCAL_SESSION_CANCELLED')
        activeInference++; acquired=true
        filename=path.join(session.dir,`chunk-${seq}.pcm`)
        await writeFile(filename,pcm,{flag:'wx',mode:0o600})
        const disconnected=() => { if (!res.writableEnded) void destroy(session) }
        res.once('close',disconnected)
        let timeout
        try {
          const abortPromise=new Promise((_,reject) => {
            const aborted=() => reject(fail(410,'LOCAL_SESSION_CANCELLED'))
            session.cancel.signal.addEventListener('abort',aborted,{once:true})
            // Cleared after inference; avoids retaining per-chunk abort listeners.
            session.removeAbort=()=>session.cancel.signal.removeEventListener('abort',aborted)
          })
          const inference=(async () => {
            if (!session.worker) session.worker=workerFactory({dir:session.dir,signal:session.cancel.signal})
            await session.worker.ready
            return session.worker.infer({seq,pcm,startMs,signal:session.cancel.signal})
          })()
          const result=await Promise.race([inference,abortPromise,new Promise((_,reject) => {
            timeout=setTimeout(()=>{ reject(fail(504,'LOCAL_INFERENCE_TIMEOUT')); void destroy(session) },timeoutMs)
          })])
          if (closed || session.cancel.signal.aborted) throw fail(410,'LOCAL_SESSION_CANCELLED')
          if (typeof result?.text!=='string' || result.text.length>10000) throw fail(503,'LOCAL_INFERENCE_FAILED')
          const endMs=startMs+pcm.length/32
          const text=result.text.trim()
          const response={entries:text?[{utteranceId:`${session.id}:${seq}`,startMs,endMs,text,speakerId:null,kind:'final',confidenceState:'unknown'}]:[],state:'ready'}
          session.history.set(seq,{hash,startMs,response}); session.next++; session.endMs=endMs
          // Bounded transcript/idempotency retention. Older retry gets sequence error.
          if (session.history.size>32) session.history.delete(session.history.keys().next().value)
          if (session.worker.real === true) smokeVerified=true
          respond(res,200,response)
        } catch (error) {
          await destroy(session)
          throw error.status?error:fail(503,'LOCAL_INFERENCE_FAILED')
        } finally { clearTimeout(timeout); session.removeAbort?.(); res.removeListener('close',disconnected) }
      } finally {
        session.busy=false; session.touched=Date.now()
        if (acquired) activeInference--
        if (filename) await rm(filename,{force:true}).catch(()=>{})
      }
    } catch (error) {
      // Never log input, output, paths, Python exception text, or transcript.
      respond(res,error.status || 500,{error:error.code || 'LOCAL_INTERNAL_ERROR',fallback:false})
    }
  }
  let unregister
  try { unregister=ctx.webServer.register({kind:'prefix',path:LOCAL_CAPTION_PREFIX,handler}) }
  catch(error) { clearInterval(timer); throw error }
  return () => {
    if (closed) return
    closed=true; clearInterval(timer); unregister()
    const cleanup=[...sessions.values()].map(destroy)
    void Promise.allSettled(cleanup).then(()=>rootPromise?.catch(()=>{})).then(()=>rm(root,{recursive:true,force:true})).catch(()=>{})
  }
}
