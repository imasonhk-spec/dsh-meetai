/**
 * dsh-meetai — 「会议模型」本地 ASR 模型管理（宿主半 v1）
 *
 * 把会议转写依赖的四个本地 FunASR 模型（paraformer / vad / punc / cam++）以
 * 「手动下载」方式呈现：缺哪个点哪个，服务端从 ModelScope 拉取并落盘。
 *
 * 事实与安全纪律（与项目既有约定一致）：
 *  1. 下载源**文件级 revision 锁定**：PINNED 表里的 revision 取自本机已验收模型
 *     所对应的 ModelScope 提交，字节数与线下基线逐一核对一致；不用 master
 *     浮动版本，避免上游更新后权重与验收基线不一致。
 *     —— 特别注意 paraformer 必须用 ..._large-vad-punc_asr_nat-... 那个仓库
 *        （BiCifParaformer/CifPredictorV3），同名的 ..._large_asr_nat-... 是
 *        另一个模型（Paraformer/CifPredictorV2，880MB），下错了转写会退化。
 *  2. 写权限只给管理员：身份来自宿主启动器绑定的 profileContext + 原生
 *     Connection 准入，**不采信 HTTP 请求里的任何账号/角色字段**；拿不到权威
 *     身份时一律 fail-closed。非管理员只读（可见状态、不可下载）。
 *  3. 绝不留半成品：先写 <models>/.staging/<id>/，逐文件校验字节数后才移入
 *     <models>/<id>/。
 *  4. 不声明未经验证的事实：状态只依据「文件存在且字节数吻合、且非符号链接」
 *     （transcribe.py 的 local_model() 拒绝软链）；转写推理能力不做任何承诺，
 *     固定回报 inference:'undetected'。
 */

import { createReadStream, createWriteStream, lstatSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { rename, rm, mkdir } from 'node:fs/promises'
import https from 'node:https'
import http from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const BASE = '/api/meeting-assistant'
const MODELS_DIR_ENV = 'DSH_AKUN_RELEASE'
const MODELS_DIR_DEFAULT = process.env.DSH_AKUN_RELEASE || '/home/lgsj/Downloads/AI game/akun-meeting/akun-runtime/release'

/** 与 transcribe.py REQUIRED_FILES 对齐的必需成员：缺一即「未就绪」。 */
const PINNED = [
  {
    id: 'paraformer',
    name: 'Paraformer 语音识别',
    role: '语音识别主模型',
    desc: '把会议录音转成文字，中文普通话通用大模型（约 900MB，四个模型里最大）。',
    repo: 'iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    files: [
      ['model.pt', 900702648, '8a65061b5b9d888c93d2700e03fe46d0681c7166'],
      ['config.yaml', 2899, '3fa16d4acb6bcbb97ce1392d46e16c9b022d358a'],
      ['configuration.json', 693, '8a65061b5b9d888c93d2700e03fe46d0681c7166'],
      ['am.mvn', 11203, '9c76a8acdc65372245435d696b0f5472c9e6fe03'],
      ['seg_dict', 8287834, '9c76a8acdc65372245435d696b0f5472c9e6fe03'],
      ['tokens.json', 93676, '8a65061b5b9d888c93d2700e03fe46d0681c7166'],
    ],
  },
  {
    id: 'vad',
    name: 'VAD 语音端点检测',
    role: '切分说话段落',
    desc: '判断哪里是有效人声、在哪里断句，避免把静音和噪声送进识别（约 1.7MB）。',
    repo: 'iic/speech_fsmn_vad_zh-cn-16k-common-pytorch',
    files: [
      ['model.pt', 1721366, '662fc7a38813d81305085696d59eb5b1141a204a'],
      ['config.yaml', 1215, '25f6f166b917e3062ab09c9f7c9fce5e3f708360'],
      ['configuration.json', 365, '662fc7a38813d81305085696d59eb5b1141a204a'],
      ['am.mvn', 8040, 'f2001ab650c1a6a6f14beb4b26288d0f57529278'],
    ],
  },
  {
    id: 'punc',
    name: '标点恢复模型',
    role: '补全标点与断句',
    desc: '给识别结果补上逗号句号，纪要可读性依赖它（约 292MB）。',
    repo: 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
    files: [
      ['model.pt', 291979892, '524de490e17649ffa0900a02ab5b1a66656c7c96'],
      ['config.yaml', 810, '1ac4a02ea37dc2c8f0606d67447e816ea518efa3'],
      ['configuration.json', 373, '524de490e17649ffa0900a02ab5b1a66656c7c96'],
      ['tokens.json', 4207480, 'ef1404c5287d1e1fcb43cb1f5346ee80674b8aff'],
    ],
  },
  {
    id: 'cam++',
    name: 'CAM++ 说话人识别',
    role: '区分不同发言人',
    desc: '给转写结果标注说话人，用于「谁说了什么」（约 28MB）。',
    repo: 'iic/speech_campplus_sv_zh-cn_16k-common',
    files: [
      ['campplus_cn_common.bin', 28036335, '013c18884dffb82846cf472dd06dd4a08d97e2cd'],
      ['config.yaml', 537, 'd7ebb3ed7824a7aa825efab9eea6c4ca05197ef9'],
      ['configuration.json', 581, '930086088e5c5fa8a3f911c20795ca72f7f16397'],
    ],
  },
]

const REQUIRED_IDS = PINNED.map((m) => m.id)

function modelsRoot() {
  const base = String(process.env[MODELS_DIR_ENV] || MODELS_DIR_DEFAULT).trim() || MODELS_DIR_DEFAULT
  return base
}
function modelsDir() { return path.join(modelsRoot(), 'models') }
function dirOf(model) { return path.join(modelsDir(), model.id) }
function stagingDir(model) { return path.join(modelsDir(), '.staging', model.id) }

function totalPinnedBytes(model) { return model.files.reduce((sum, [, size]) => sum + size, 0) }

/* ------------------------------------------------------------------ */
/* 文件事实（只描述可验证的事）                                          */
/* ------------------------------------------------------------------ */

/** 单个成员的真实状态：存在、非软链、字节数与锁定值一致。 */
function fileFact(dir, name, size) {
  const target = path.join(dir, name)
  try {
    const st = lstatSync(target)
    if (st.isSymbolicLink()) return { name, state: 'symlink', size: st.size, want: size }
    if (!st.isFile()) return { name, state: 'notfile', size: 0, want: size }
    if (size && st.size !== size) return { name, state: 'sizemismatch', size: st.size, want: size }
    return { name, state: 'ok', size: st.size, want: size }
  } catch {
    return { name, state: 'absent', size: 0, want: size }
  }
}

function modelFact(model) {
  const dir = dirOf(model)
  const files = model.files.map(([name, size]) => fileFact(dir, name, size))
  const okCount = files.filter((f) => f.state === 'ok').length
  const presentBytes = files.reduce((sum, f) => sum + (f.size || 0), 0)
  let status = 'absent'
  if (files.some((f) => f.state !== 'absent')) status = okCount === files.length ? 'ready' : 'partial'
  return {
    id: model.id,
    name: model.name,
    role: model.role,
    desc: model.desc,
    repo: model.repo,
    sizeTotal: totalPinnedBytes(model),
    status,
    okCount,
    fileCount: files.length,
    presentBytes,
    missing: files.filter((f) => f.state !== 'ok').map((f) => ({ name: f.name, state: f.state, size: f.size, want: f.want })),
  }
}

/* ------------------------------------------------------------------ */
/* 身份：只认宿主权威来源                                                */
/* ------------------------------------------------------------------ */

/** 从 profileContext.home 推导多用户账号；宿主实例推导不出，返回 null。 */
function accountOfHome(home) {
  const parts = String(home || '').split(path.sep).filter(Boolean)
  const i = parts.lastIndexOf('users')
  if (i <= 0 || !parts[i + 1]) return null
  return { account: parts[i + 1], multiUserRoot: path.sep + parts.slice(0, i).join(path.sep) }
}

/** 账号是否 admin（只读 users.json 的 role 字段，绝不回传凭据字段）。 */
function isAdminAccount(info) {
  if (info === null) return true // 宿主实例 = 操作者本人
  try {
    const raw = readFileSync(path.join(info.multiUserRoot, 'users.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const row = (parsed?.users || []).find((u) => u && u.username === info.account)
    return row?.role === 'admin'
  } catch {
    return false
  }
}

/**
 * 判定当前请求的身份。返回 {authenticated, admin}；不抛异常，便于 GET 只读复用。
 * 权威链：profileContext（启动器绑定） + Connection 原生准入；两者缺失即不可信。
 */
async function probeAuth(ctx, request) {
  let profile = null
  let connection = null
  try { profile = ctx.get('profileContext') } catch { /* 服务缺失 */ }
  try { connection = ctx.get('connection') } catch { /* 服务缺失 */ }
  if (!profile || typeof profile.home !== 'string' || profile.name !== 'web') {
    return { authenticated: false, admin: false, reason: 'PROFILE_UNAVAILABLE' }
  }
  if (typeof connection?.requestRejection !== 'function' || typeof connection?.admit !== 'function' || !connection.operator) {
    return { authenticated: false, admin: false, reason: 'CONNECTION_UNAVAILABLE' }
  }
  try {
    const rejection = await connection.requestRejection(request)
    if (rejection !== undefined) return { authenticated: false, admin: false, reason: 'AUTH_REQUIRED' }
    const admission = connection.admit(request)
    if (admission?.peer !== connection.operator) return { authenticated: false, admin: false, reason: 'AUTH_REQUIRED' }
  } catch {
    return { authenticated: false, admin: false, reason: 'AUTH_UNAVAILABLE' }
  }
  if (request.headers?.['sec-fetch-site'] === 'cross-site') {
    return { authenticated: false, admin: false, reason: 'ORIGIN_FORBIDDEN' }
  }
  const origin = request.headers?.origin
  if (origin) {
    let parsed
    try { parsed = new URL(origin) } catch { return { authenticated: false, admin: false, reason: 'ORIGIN_FORBIDDEN' } }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host !== request.headers.host) {
      return { authenticated: false, admin: false, reason: 'ORIGIN_FORBIDDEN' }
    }
  }
  const info = accountOfHome(profile.home)
  const admin = isAdminAccount(info)
  return { authenticated: true, admin, account: info?.account ?? 'host', reason: null }
}

/* ------------------------------------------------------------------ */
/* 下载                                                               */
/* ------------------------------------------------------------------ */

/** 进程内下载登记：允许同时下载多个模型（用户裁决 2026-10-20）。 */
const downloads = new Map() // id -> record
const active = new Map() // id -> AbortController

const MODELSCOPE = 'https://modelscope.cn/api/v1/models'
function fileUrl(model, name, revision) {
  return `${MODELSCOPE}/${model.repo}/repo?Revision=${revision}&FilePath=${encodeURIComponent(name)}`
}

/** GET 并跟随跳转（ModelScope 会 302 到 CDN），把响应体写进 destPath。 */
function fetchToFile(url, destPath, { signal, onBytes, expectBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => { if (!settled) { settled = true; reject(error) } }
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    const visit = (target, hops) => {
      if (hops > 6) return fail(Object.assign(new Error('模型源跳转次数过多'), { code: 'TOO_MANY_REDIRECTS' }))
      if (signal?.aborted) return fail(Object.assign(new Error('已取消'), { code: 'ABORTED' }))
      const mod = target.startsWith('https:') ? https : http
      const req = mod.get(target, { headers: { 'user-agent': 'dsh-meetai/local-models', accept: '*/*' } }, (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          return visit(new URL(res.headers.location, target).toString(), hops + 1)
        }
        if (status !== 200) {
          res.resume()
          return fail(Object.assign(new Error(`模型源返回 HTTP ${status}`), { code: 'UPSTREAM_STATUS', status }))
        }
        const declared = Number(res.headers['content-length'])
        if (expectBytes && Number.isFinite(declared) && declared !== expectBytes) {
          res.resume()
          return fail(Object.assign(new Error(`上游文件大小与锁定值不一致（${declared} ≠ ${expectBytes}）`), { code: 'UPSTREAM_SIZE_MISMATCH' }))
        }
        let received = 0
        res.on('data', (chunk) => { received += chunk.length; onBytes?.(chunk.length) })
        res.on('error', fail)
        const out = createWriteStream(destPath)
        out.on('error', fail)
        pipeline(res, out).then(() => done({ received, declared })).catch(fail)
      })
      req.on('error', fail)
      req.setTimeout(60000, () => { req.destroy(Object.assign(new Error('模型源 60 秒无响应'), { code: 'UPSTREAM_TIMEOUT' })) })
      signal?.addEventListener('abort', () => req.destroy(Object.assign(new Error('已取消'), { code: 'ABORTED' })), { once: true })
    }
    visit(url, 0)
  })
}

function publicDownload(record) {
  if (!record) return null
  const pct = record.totalBytes > 0 ? Math.min(100, (record.receivedBytes / record.totalBytes) * 100) : 0
  return {
    modelId: record.modelId,
    status: record.status,
    receivedBytes: record.receivedBytes,
    totalBytes: record.totalBytes,
    pct,
    currentFile: record.currentFile,
    message: record.message,
    error: record.error,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  }
}

async function runDownload(model, record) {
  const controller = new AbortController()
  active.set(model.id, controller)
  const dir = dirOf(model)
  const staging = stagingDir(model)
  try {
    record.status = 'downloading'
    mkdirSync(staging, { recursive: true })
    // 待下载集合：目标目录里已经合法的成员不再重复下载。
    const need = model.files.filter(([name, size]) => fileFact(dir, name, size).state !== 'ok')
    record.totalBytes = need.reduce((sum, [, size]) => sum + size, 0)
    record.receivedBytes = 0
    for (const [name, size, revision] of need) {
      if (controller.signal.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' })
      const staged = path.join(staging, name)
      // 断点续传：staging 里已有完整文件就直接计入进度。
      if (fileFact(staging, name, size).state === 'ok') {
        record.receivedBytes += size
        continue
      }
      record.currentFile = name
      record.message = `正在下载 ${name}`
      await rm(staged, { force: true })
      await fetchToFile(fileUrl(model, name, revision), staged, {
        signal: controller.signal,
        expectBytes: size,
        onBytes: (n) => { record.receivedBytes += n },
      })
      const got = statSync(staged).size
      if (got !== size) throw Object.assign(new Error(`${name} 下载不完整（${got} ≠ ${size}）`), { code: 'DOWNLOAD_INCOMPLETE' })
    }
    record.status = 'verifying'
    record.message = '正在校验并落盘'
    await mkdir(dir, { recursive: true })
    for (const [name, size] of model.files) {
      const staged = path.join(staging, name)
      const target = path.join(dir, name)
      if (fileFact(dir, name, size).state === 'ok') continue
      const stagedFact = fileFact(staging, name, size)
      if (stagedFact.state !== 'ok') throw Object.assign(new Error(`${name} 未通过字节数校验`), { code: 'VERIFY_FAILED' })
      await rename(staged, target).catch(async () => {
        await pipeline(createReadStream(staged), createWriteStream(target))
        await rm(staged, { force: true })
      })
    }
    const fact = modelFact(model)
    if (fact.status !== 'ready') {
      throw Object.assign(new Error('落盘后校验未通过：' + fact.missing.map((m) => m.name).join('、')), { code: 'VERIFY_FAILED' })
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    record.status = 'done'
    record.message = '已就绪'
    record.currentFile = null
  } catch (error) {
    const aborted = error?.code === 'ABORTED' || controller.signal.aborted
    record.status = aborted ? 'cancelled' : 'error'
    record.message = aborted ? '已取消' : '下载失败'
    record.error = aborted ? null : String(error?.message || error)
    record.currentFile = null
  } finally {
    record.finishedAt = new Date().toISOString()
    active.delete(model.id)
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, body, status = 200) {
  if (res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req, limit = 8 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'BODY_INVALID' }) }
}

async function snapshot(ctx, request) {
  const auth = await probeAuth(ctx, request)
  const models = PINNED.map(modelFact)
  const ready = models.filter((m) => m.status === 'ready').length
  const bytesReady = models.reduce((sum, m) => sum + (m.status === 'ready' ? m.sizeTotal : m.presentBytes), 0)
  const list = models.map((m) => ({
    ...m,
    download: publicDownload(downloads.get(m.id)),
  }))
  return {
    ok: true,
    revision: 'meeting-local-models-v1',
    authenticated: auth.authenticated,
    canDownload: auth.authenticated && auth.admin,
    // 目录绝对路径只回给管理员（普通用户只看到共享仓库的相对描述）。
    modelsDir: auth.authenticated && auth.admin ? modelsDir() : null,
    modelsDirLabel: '共享模型仓库',
    asr: {
      state: ready === PINNED.length ? 'available' : 'unavailable',
      basis: 'dependency-files-only',
      inference: 'undetected',
      note: '只核对了模型文件是否齐备，不代表已经跑过推理。',
    },
    counts: { ready, total: PINNED.length, bytesReady, bytesTotal: models.reduce((s, m) => s + m.sizeTotal, 0) },
    models: list,
    downloads: Object.fromEntries(list.filter((m) => m.download).map((m) => [m.id, m.download])),
  }
}

export function mountLocalModels(ctx) {
  const disposers = []
  try {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/models/local`,
      async handler(req, res) {
        if ((req.method || 'GET').toUpperCase() !== 'GET') return sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
        try {
          const body = await snapshot(ctx, req)
          if (!body.authenticated) return sendJson(res, { ok: false, error: 'AUTH_REQUIRED' }, 401)
          sendJson(res, body)
        } catch (error) {
          sendJson(res, { ok: false, error: 'SNAPSHOT_FAILED', reason: String(error?.message || error) }, 500)
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/models/local/download`,
      async handler(req, res) {
        if ((req.method || 'GET').toUpperCase() !== 'POST') return sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
        const auth = await probeAuth(ctx, req)
        if (!auth.authenticated) return sendJson(res, { ok: false, error: 'AUTH_REQUIRED' }, 401)
        if (!auth.admin) return sendJson(res, { ok: false, error: 'ADMIN_REQUIRED', reason: '会议模型是全站共享资产，只有管理员可以下载。' }, 403)
        let body
        try { body = await readJson(req) } catch (error) { return sendJson(res, { ok: false, error: error.code || 'BODY_INVALID' }, 400) }
        const id = String(body?.id || '').trim()
        const model = PINNED.find((m) => m.id === id)
        if (!model) return sendJson(res, { ok: false, error: 'MODEL_UNKNOWN', reason: '未知的模型标识。' }, 400)
        if (!REQUIRED_IDS.includes(id)) return sendJson(res, { ok: false, error: 'MODEL_NOT_ALLOWED' }, 400)
        if (modelFact(model).status === 'ready') return sendJson(res, { ok: false, error: 'MODEL_ALREADY_READY', reason: '该模型已就绪，无需下载。' }, 409)
        if (active.has(id)) return sendJson(res, { ok: false, error: 'MODEL_BUSY', reason: '该模型正在下载中。' }, 409)
        const record = {
          modelId: id,
          status: 'queued',
          receivedBytes: 0,
          totalBytes: totalPinnedBytes(model),
          currentFile: null,
          message: '已排队',
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        }
        downloads.set(id, record)
        // 同时下载多个模型是允许的：每个模型各自一条独立任务，不互相排队。
        void runDownload(model, record)
        sendJson(res, { ok: true, download: publicDownload(record) }, 202)
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${BASE}/models/local/cancel`,
      async handler(req, res) {
        if ((req.method || 'GET').toUpperCase() !== 'POST') return sendJson(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405)
        const auth = await probeAuth(ctx, req)
        if (!auth.authenticated) return sendJson(res, { ok: false, error: 'AUTH_REQUIRED' }, 401)
        if (!auth.admin) return sendJson(res, { ok: false, error: 'ADMIN_REQUIRED' }, 403)
        let body
        try { body = await readJson(req) } catch (error) { return sendJson(res, { ok: false, error: error.code || 'BODY_INVALID' }, 400) }
        const id = String(body?.id || '').trim()
        const controller = active.get(id)
        if (!controller) return sendJson(res, { ok: false, error: 'MODEL_NOT_DOWNLOADING' }, 409)
        controller.abort()
        sendJson(res, { ok: true })
      },
    }))
  } catch (error) {
    for (const dispose of disposers.reverse()) { try { dispose?.() } catch { /* ignore */ } }
    throw error
  }
  return () => {
    // 卸载时中止在途下载；已落盘的 staging 保留，供下次续传。
    for (const controller of active.values()) { try { controller.abort() } catch { /* ignore */ } }
    for (const dispose of disposers.reverse()) { try { dispose?.() } catch { /* ignore */ } }
  }
}

export const __internals = { PINNED, modelFact, accountOfHome, isAdminAccount, modelsDir, mountLocalModels }
