/**
 * dsh-meetai 冒烟测试：直接 import index.js，构造假 ctx（webServer / llm /
 * agentDefaultModel / workbenchCapabilities stub），对注册的 handler 发模拟 req/res，
 * 覆盖 templates / meetings CRUD / agenda / generate-text / minutes PUT / archive / ask / docs / qa-sessions
 * / recordings（上传·校验·回放 Range·PATCH·DELETE·generate-text 录音关联）。
 *
 * 运行：node scripts/smoke.mjs
 * 数据目录隔离：DSH_HOME=<本目录>/.smoke-tmp，跑完自动清理。
 */
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.dirname(here)

/* ---------------- 环境隔离 ---------------- */
const smokeHome = mkdtempSync(path.join(pluginRoot, '.smoke-tmp-'))
process.env.DSH_HOME = smokeHome

const plugin = await import('../index.js')

/* ---------------- stub：ctx 与 LLM ---------------- */

/** LLM stub：按调用内容路由不同剧本，产 text-delta + block-end（协议按 index 归并、block-end 优先）。 */
function makeLlmStub() {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const userText = (options.messages?.[0]?.content || []).map((p) => p.text || '').join('\n')
      const system = options.system || ''
      let text
      if (system.includes('会议架构顾问')) {
        text = JSON.stringify({
          agenda: [
            { time_range: '14:00 - 14:20', topic: '背景同步与目标拆解', speaker: '主持人', objective: '对齐目标' },
            { time_range: '14:20 - 15:00', topic: '方案评审', speaker: '架构师', objective: '敲定方案' },
          ],
        })
      } else if (system.includes('阿昆会议纪要助手')) {
        text = [
          '# 一、核心决议摘要 (Executive Summary)',
          '本次会议确认了 GPU 集群扩容预算为 1200 万元（引用见决议）。',
          '# 二、明确共识与关键决议',
          '1. 全员一致通过 GPU 扩容方案，预算 1200 万元。',
          '# 三、跟进待办与责任人 (Action Items)',
          '- 由张三负责采购流程，截止 2026-10-10。',
          '# 四、原始高价值引文摘录',
          '- [14:30:00] 张总：预算就按 1200 万走。',
          '<<<ACTIONS>>>[{"content":"完成 GPU 采购审批","assignee":"张三","due_date":"2026-10-10","completed":false}]',
        ].join('\n')
      } else {
        // 问答剧本：必须带上 [引用X] 标注，便于校验 sources 结构
        text = 'GPU 扩容预算为 1200 万元 [引用1]，由张三负责采购审批 [引用2]。\n【证据链清单】\n- [引用1]：战略评审会纪要，14:30，预算原文。'
      }
      const gen = (async function* () {
        yield { type: 'text-delta', index: 0, text: text.slice(0, 10) }
        yield { type: 'text-delta', index: 0, text: text.slice(10) }
        // 重复索引 + 权威块：应覆盖 text-delta（block-end 优先，避免重复计数）
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
      return gen
    },
  }
}

const registered = { routes: [], workbench: [] }
const unregistered = []

function makeCtx() {
  const services = new Map()
  const llm = makeLlmStub()
  services.set('llm', llm)
  services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) })
  services.set('workbenchCapabilities', {
    register: (m) => registered.workbench.push(m),
    unregister: (id) => unregistered.push(id),
  })
  const ctx = {
    webServer: {
      register: (rec) => {
        registered.routes.push(rec)
        return () => {
          const i = registered.routes.indexOf(rec)
          if (i >= 0) registered.routes.splice(i, 1)
        }
      },
    },
    get(name) {
      return services.get(name)
    },
  }
  return { ctx, llm }
}

/* ---------------- 最小 req/res mock ---------------- */

// 用 Readable 模拟 IncomingMessage：与 node:http 一致——只有挂上 data 监听后才开始流动，
// 事件不会在 handler 首个 await 之前丢失（相比 nextTick 直发更接近真实语义）。
function makeReq({ method = 'GET', url = '/', body = null, headers = {} } = {}) {
  const chunks = []
  if (body != null) {
    chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
  }
  const stream = Readable.from(chunks)
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

// res 用真 Writable：录音回放走 stream pipeline，需要可写的 destination。
function makeRes() {
  const chunks = []
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk)
      cb()
    },
  })
  res.statusCode = 0
  res.headers = null
  res.finished = false
  res.writeHead = (code, hdrs) => {
    res.statusCode = code
    res.headers = hdrs || {}
  }
  const rawEnd = res.end.bind(res)
  res.end = (payload) => {
    if (payload != null) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)))
    res.finished = true
    return rawEnd()
  }
  res.bodyBuffer = () => Buffer.concat(chunks)
  Object.defineProperty(res, 'bodyText', { get: () => Buffer.concat(chunks).toString('utf8') })
  return res
}

async function call(handler, options) {
  const req = makeReq(options)
  const res = makeRes()
  await handler(req, res)
  let body = null
  try {
    body = JSON.parse(res.bodyText)
  } catch {
    body = res.bodyText
  }
  return { status: res.statusCode, body }
}

/** 二进制/原始响应读取（录音回放用）：返回 status / headers / buffer。 */
async function callRaw(handler, options) {
  const req = makeReq(options)
  const res = makeRes()
  await handler(req, res)
  return { status: res.statusCode, headers: res.headers || {}, buffer: res.bodyBuffer() }
}

/* ---------------- 用例 ---------------- */

const results = []
async function step(name, fn) {
  try {
    await fn()
    results.push(`  ✅ ${name}`)
    console.error(`  ✅ ${name}`)
  } catch (err) {
    results.push(`  ❌ ${name}: ${err && err.message}`)
    console.error(`  ❌ ${name}: ${err && err.stack || err.message}`)
    process.exitCode = 1
  }
}

const { ctx, llm } = makeCtx()
const disposer = plugin.apply(ctx)
const route = registered.routes.find((r) => r.kind === 'prefix' && r.path === '/api/meeting-assistant')
assert.ok(route, '必须注册 /api/meeting-assistant prefix 路由')
const handler = route.handler

const BASE = '/api/meeting-assistant'

await step('apply() 返回 disposer 且 workbench 清单已注册', () => {
  assert.equal(typeof disposer, 'function')
  const manifest = registered.workbench.find((m) => m.id === 'meeting')
  assert.ok(manifest, 'workbenchCapabilities.register 未收到 meeting 清单')
  assert.equal(manifest.title, '会议助手')
  assert.equal(manifest.entryKey, 'cap:meeting')
  assert.equal(manifest.order, 10)
})

await step('GET /templates 返回阿昆三类会议纪要模板', async () => {
  const { status, body } = await call(handler, { url: `${BASE}/templates` })
  assert.equal(status, 200)
  assert.equal(body.templates.length, 3)
  for (const id of ['weekly', 'communication', 'special']) {
    assert.ok(body.templates.some((x) => x.id === id && x.name), `缺少模板 ${id}`)
  }
})

let meetingId = ''

await step('POST /meetings 创建会议（含议程/标签/置顶）', async () => {
  const { status, body } = await call(handler, {
    method: 'POST',
    url: `${BASE}/meetings`,
    body: {
      title: 'Q4 GPU 集群扩容战略评审会',
      start_time: new Date(Date.now() - 3600 * 1000).toISOString(),
      end_time: new Date(Date.now() + 3600 * 1000).toISOString(),
      type: 'hybrid',
      location: '3F 会议室 + 线上',
      participants: ['张三', '李四', '王五'],
      tags: ['战略决策', 'GPU'],
      is_pinned: true,
      agenda: [{ time_range: '14:00 - 14:20', topic: '背景同步', speaker: '主持人' }],
    },
  })
  assert.equal(status, 200)
  meetingId = body.meeting.id
  assert.match(meetingId, /^meeting_\d{8}_/)
  assert.equal(body.meeting.minutes_status, 'none')
  assert.equal(body.meeting.is_pinned, true)
})

await step('POST /meetings 校验：结束早于开始要报错', async () => {
  const { status, body } = await call(handler, {
    method: 'POST',
    url: `${BASE}/meetings`,
    body: { title: '坏例', start_time: '2026-09-26T15:00:00Z', end_time: '2026-09-26T14:00:00Z' },
  })
  assert.equal(status, 200) // 错误也走 200 + error 字段（沿用参考实现约定）
  assert.ok(body.error)
})

await step('GET /meetings 列表：置顶优先 + 开始时间降序 + status 按 now 推导', async () => {
  await call(handler, {
    method: 'POST',
    url: `${BASE}/meetings`,
    body: {
      title: '非置顶的历史会',
      start_time: new Date(Date.now() - 10 * 86400 * 1000).toISOString(),
      end_time: new Date(Date.now() - 10 * 86400 * 1000 + 3600 * 1000).toISOString(),
    },
  })
  const { body } = await call(handler, { url: `${BASE}/meetings` })
  assert.ok(body.meetings.length >= 2)
  assert.equal(body.meetings[0].id, meetingId, '置顶会议应排最前')
  const pinned = body.meetings.find((m) => m.id === meetingId)
  assert.equal(pinned.status, 'in_progress', '当前时刻应推导为进行中')
  const old = body.meetings.find((m) => m.title === '非置顶的历史会')
  assert.equal(old.status, 'completed')
})

await step('PATCH /meetings/:id 切换置顶', async () => {
  const { body } = await call(handler, { method: 'PATCH', url: `${BASE}/meetings/${meetingId}`, body: { is_pinned: false } })
  assert.equal(body.meeting.is_pinned, false)
  const back = await call(handler, { method: 'PATCH', url: `${BASE}/meetings/${meetingId}`, body: { is_pinned: true } })
  assert.equal(back.body.meeting.is_pinned, true)
})

await step('POST /agenda：LLM JSON 议程容错解析回填', async () => {
  const { body } = await call(handler, {
    method: 'POST',
    url: `${BASE}/agenda`,
    body: { title: 'Q4 扩容评审', duration_minutes: '90', participants: '张三、李四' },
  })
  assert.ok(Array.isArray(body.agenda) && body.agenda.length === 2, '应解析出 2 行议程')
  assert.equal(body.agenda[0].time_range, '14:00 - 14:20')
  assert.equal(body.agenda[0].speaker, '主持人')
})

await step('POST /generate-text：生成纪要（ACTIONS 块剥离 + minutes_status 回写 ready）', async () => {
  const { body } = await call(handler, {
    method: 'POST',
    url: `${BASE}/generate-text`,
    body: { meeting_id: meetingId, transcript: '[14:30:00] 张总：预算就按 1200 万走。\n[14:31:00] 李四：同意。', template_type: 'weekly' },
  })
  const m = body.minutes
  assert.ok(m && m.minutes_id, '应返回 minutes 记录')
  assert.match(m.minutes_id, /^min_\d{8}_/)
  assert.equal(m.version, 1)
  assert.equal(m.source, 'ai')
  assert.equal(m.is_archived, false)
  assert.ok(!m.content.includes('<<<ACTIONS>>>'), '结构化标记必须从正文剥离')
  assert.equal(m.action_items.length, 1)
  assert.equal(m.action_items[0].assignee, '张三')
  assert.ok(m.content.includes('核心决议摘要'))
  const meetings = (await call(handler, { url: `${BASE}/meetings` })).body.meetings
  assert.equal(meetings.find((x) => x.id === meetingId).minutes_status, 'ready')
})

let minutesId = ''

await step('GET /minutes 与 /minutes/meeting/:id', async () => {
  const list = (await call(handler, { url: `${BASE}/minutes` })).body.minutes
  assert.ok(list.length === 1)
  minutesId = list[0].minutes_id
  const byMeeting = (await call(handler, { url: `${BASE}/minutes/meeting/${meetingId}` })).body.minutes
  assert.equal(byMeeting.minutes_id, minutesId)
  assert.ok(byMeeting.content.includes('GPU 集群扩容预算'))
})

await step('PUT /minutes/:id 导入修正版覆盖：version+1、source=import、历史记录', async () => {
  const corrected = '# 一、核心决议摘要\n预算 1200 万（修订版）。\n# 二、明确共识与关键决议\n1. 通过。\n'
  const { body } = await call(handler, {
    method: 'PUT',
    url: `${BASE}/minutes/${minutesId}`,
    body: { content: corrected, source: 'import' },
  })
  assert.equal(body.minutes.version, 2)
  assert.equal(body.minutes.source, 'import')
  assert.equal(body.minutes.history.length, 2)
  assert.equal(body.minutes.history[1].source, 'import')
  assert.ok(body.minutes.content.includes('修订版'))
})

await step('PUT /minutes/:id 仅勾选待办：版本不变', async () => {
  const { body } = await call(handler, {
    method: 'PUT',
    url: `${BASE}/minutes/${minutesId}`,
    body: { action_items: [{ task_id: 'task_1', content: '完成 GPU 采购审批', assignee: '张三', due_date: '2026-10-10', completed: true }] },
  })
  assert.equal(body.minutes.version, 2, '仅待办勾选不应 bump 版本')
  assert.equal(body.minutes.action_items[0].completed, true)
})

await step('POST /minutes/:id/archive：SHA-256 指纹 + minutes_status=archived', async () => {
  const { body } = await call(handler, { method: 'POST', url: `${BASE}/minutes/${minutesId}/archive` })
  const m = body.minutes
  assert.equal(m.is_archived, true)
  assert.ok(m.archived_at)
  const expectFp = createHash('sha256').update(readFileSync(path.join(smokeHome, 'meeting-assistant', 'minutes', m.date, `${m.minutes_id}.md`), 'utf8'), 'utf8').digest('hex')
  assert.equal(m.archive_fingerprint, expectFp, '指纹须等于正文文件的 SHA-256')
  const meetings = (await call(handler, { url: `${BASE}/meetings` })).body.meetings
  assert.equal(meetings.find((x) => x.id === meetingId).minutes_status, 'archived')
})

await step('POST /docs：TXT 文本入库（indexed）+ 元数据 only（queued）', async () => {
  const withText = await call(handler, {
    method: 'POST',
    url: `${BASE}/docs`,
    body: { name: '技术架构路线图.md', size: 2048, meeting_id: meetingId, text: '技术架构路线图：GPU 集群采用 InfiniBand 组网，2027 年完成液冷改造。'.repeat(5) },
  })
  assert.equal(withText.body.doc.vector_status, 'indexed')
  const metaOnly = await call(handler, {
    method: 'POST',
    url: `${BASE}/docs`,
    body: { name: '预算表.xlsx', size: 4096, meeting_id: meetingId },
  })
  assert.equal(metaOnly.body.doc.vector_status, 'queued')
  const oversize = await call(handler, { method: 'POST', url: `${BASE}/docs`, body: { name: 'big.bin', size: 11 * 1024 * 1024 } })
  assert.ok(oversize.body.error, '超过 10MB 须拒绝')
})

await step('POST /ask：BM25 检索 + sources 结构（引用编号与上下文对应）', async () => {
  const { body } = await call(handler, {
    method: 'POST',
    url: `${BASE}/ask`,
    body: { question: 'GPU 扩容的预算是多少？谁负责采购审批？', scope: 'all' },
  })
  assert.ok(body.answer && body.answer.includes('[引用1]'), '回答应带 [引用X] 标注')
  assert.ok(Array.isArray(body.sources) && body.sources.length >= 1 && body.sources.length <= 5)
  const src = body.sources[0]
  for (const key of ['id', 'label', 'meeting_title', 'timestamp', 'text']) assert.ok(key in src, `source 缺字段 ${key}`)
  assert.ok(body.sources.some((s) => s.text.includes('1200')), 'Top-K 引用中应包含预算片段')
  // 引用编号与 LLM 收到的上下文块编号一致
  const askCall = llm.calls.filter((c) => (c.system || '').includes('会议知识检索助手')).pop()
  assert.ok(askCall, 'ask 应调用 LLM')
  const ctxText = askCall.messages[0].content[0].text
  assert.ok(ctxText.includes('[引用1] 来源:'), '上下文块须带 [引用N] 来源: 前缀')
})

await step('POST /ask scope=docs：只检索文档切片', async () => {
  const { body } = await call(handler, {
    method: 'POST',
    url: `${BASE}/ask`,
    body: { question: '液冷改造什么时候完成？', scope: 'docs' },
  })
  assert.ok(body.answer && body.sources.length === 1)
  assert.equal(body.sources[0].source_type, 'document')
})

await step('POST /ask scope=meeting:<id>：范围过滤生效', async () => {
  const ok = await call(handler, { method: 'POST', url: `${BASE}/ask`, body: { question: 'GPU 预算', scope: `meeting:${meetingId}` } })
  assert.ok(ok.body.answer)
  const miss = await call(handler, { method: 'POST', url: `${BASE}/ask`, body: { question: 'xyzzyqq', scope: 'all' } })
  assert.equal(miss.body.error, 'NO_MATCH', '零命中应返回 NO_MATCH')
})

await step('问答会话 CRUD', async () => {
  const created = await call(handler, { method: 'POST', url: `${BASE}/qa-sessions`, body: { title: '测试会话', scope: 'all' } })
  const id = created.body.session.session_id
  await call(handler, { method: 'PUT', url: `${BASE}/qa-sessions/${id}`, body: { messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }] } })
  const list = (await call(handler, { url: `${BASE}/qa-sessions` })).body.sessions
  const row = list.find((s) => s.session_id === id)
  assert.equal(row.messages.length, 2)
  await call(handler, { method: 'DELETE', url: `${BASE}/qa-sessions/${id}` })
  const after = (await call(handler, { url: `${BASE}/qa-sessions` })).body.sessions
  assert.ok(!after.some((s) => s.session_id === id))
})

/* ---------------- 录音存储 API（task-2 新增） ---------------- */

const recordingAudio = Buffer.alloc(2048, 7) // 假录音字节
let recordingId = ''
let recording2Id = ''

await step('POST /recordings：m4a 上传→200、索引/文件落盘、sha256、文件名清洗', async () => {
  // 头里的文件名 = encodeURIComponent('记录/临时/会议\u0007录音 v1.M4A')：验证解码 + basename + 控制字符剥离 + 扩展名归一
  const r = await call(handler, {
    method: 'POST',
    url: `${BASE}/recordings`,
    body: recordingAudio,
    headers: { 'x-meetai-filename': encodeURIComponent('记录/临时/会议\u0007录音 v1.M4A'), 'x-meetai-meeting-id': meetingId },
  })
  assert.equal(r.status, 200)
  const rec = r.body.recording
  assert.match(rec.recording_id, /^rec_[0-9a-f]{16}$/)
  assert.equal(rec.filename, '会议录音 v1.M4A')
  assert.equal(rec.ext, 'm4a')
  assert.equal(rec.size_bytes, recordingAudio.length)
  assert.equal(rec.sha256, createHash('sha256').update(recordingAudio).digest('hex'))
  assert.equal(rec.meeting_id, meetingId)
  assert.equal(rec.duration_seconds, null)
  assert.equal(rec.transcript, '')
  assert.ok(rec.created_at)
  recordingId = rec.recording_id
  const idx = JSON.parse(readFileSync(path.join(smokeHome, 'meeting-assistant', 'recordings', 'index.json'), 'utf8'))
  assert.equal(idx[recordingId].filename, '会议录音 v1.M4A')
  assert.ok(readFileSync(path.join(smokeHome, 'meeting-assistant', 'recordings', 'files', `${recordingId}.m4a`)).equals(recordingAudio), '落盘字节须与上传一致')
})

await step('POST /recordings：声明超过 500MB → 413（无需分配500MB内存）', async () => {
  const r = await call(handler, { method: 'POST', url: `${BASE}/recordings`, body: Buffer.from('too big'), headers: { 'x-meetai-filename': 'big.mp3', 'content-length': String(500 * 1024 * 1024 + 1) } })
  assert.equal(r.status, 413)
  assert.equal(r.body.error, 'BODY_TOO_LARGE')
})

await step('POST /recordings：非法/缺失扩展名 → 400', async () => {
  const bad = await call(handler, { method: 'POST', url: `${BASE}/recordings`, body: Buffer.from('x'), headers: { 'x-meetai-filename': 'evil.exe' } })
  assert.equal(bad.status, 400)
  const noext = await call(handler, { method: 'POST', url: `${BASE}/recordings`, body: Buffer.from('x'), headers: { 'x-meetai-filename': 'noext' } })
  assert.equal(noext.status, 400)
})

await step('POST /recordings：缺 x-meetai-filename → 400；会议不存在 → 400', async () => {
  const noName = await call(handler, { method: 'POST', url: `${BASE}/recordings`, body: Buffer.from('x') })
  assert.equal(noName.status, 400)
  const badMeeting = await call(handler, {
    method: 'POST',
    url: `${BASE}/recordings`,
    body: Buffer.from('x'),
    headers: { 'x-meetai-filename': 'a.mp3', 'x-meetai-meeting-id': 'meeting_no_such_00' },
  })
  assert.equal(badMeeting.status, 400)
})

await step('GET /recordings：created_at 倒序', async () => {
  await new Promise((resolve) => setTimeout(resolve, 20)) // 保证 created_at 毫秒位可区分
  const second = await call(handler, { method: 'POST', url: `${BASE}/recordings`, body: Buffer.from([1, 2, 3]), headers: { 'x-meetai-filename': 'second.webm' } })
  assert.equal(second.status, 200)
  recording2Id = second.body.recording.recording_id
  const list = (await call(handler, { url: `${BASE}/recordings` })).body.recordings
  assert.ok(list.length >= 2)
  const times = list.map((x) => x.created_at)
  assert.deepEqual(times, [...times].sort().reverse(), 'created_at 应倒序')
})

await step('PATCH /recordings/:id：transcript/duration/meeting_id 校验；不存在 404', async () => {
  const missing = await call(handler, { method: 'PATCH', url: `${BASE}/recordings/rec_0000000000000000`, body: { transcript: 'x' } })
  assert.equal(missing.status, 404)
  const patch = await call(handler, {
    method: 'PATCH',
    url: `${BASE}/recordings/${recordingId}`,
    body: { transcript: '[00:01] 张三：开始评审。', duration_seconds: 95.5, meeting_id: null },
  })
  assert.equal(patch.status, 200)
  assert.equal(patch.body.recording.transcript, '[00:01] 张三：开始评审。')
  assert.equal(patch.body.recording.duration_seconds, 95.5)
  assert.equal(patch.body.recording.meeting_id, null)
  const bind = await call(handler, { method: 'PATCH', url: `${BASE}/recordings/${recordingId}`, body: { meeting_id: meetingId } })
  assert.equal(bind.body.recording.meeting_id, meetingId)
  const badMeeting = await call(handler, { method: 'PATCH', url: `${BASE}/recordings/${recordingId}`, body: { meeting_id: 'meeting_xxx' } })
  assert.equal(badMeeting.status, 400)
  const badDur = await call(handler, { method: 'PATCH', url: `${BASE}/recordings/${recordingId}`, body: { duration_seconds: -1 } })
  assert.equal(badDur.status, 400)
  const longTranscript = await call(handler, { method: 'PATCH', url: `${BASE}/recordings/${recordingId}`, body: { transcript: 'x'.repeat(200001) } })
  assert.equal(longTranscript.status, 400)
})

await step('GET /recordings/:id/file：200 + Content-Type/Content-Length/Accept-Ranges；缺失 404', async () => {
  const r = await callRaw(handler, { url: `${BASE}/recordings/${recordingId}/file` })
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'audio/mp4')
  assert.equal(r.headers['content-length'], String(recordingAudio.length))
  assert.equal(r.headers['accept-ranges'], 'bytes')
  assert.ok(r.buffer.equals(recordingAudio), '回放字节须与上传一致')
  const miss = await call(handler, { url: `${BASE}/recordings/rec_ffffffffffffffff/file` })
  assert.equal(miss.status, 404)
})

await step('GET /recordings/:id/file：Range → 206 + Content-Range（含越界钳制/开区间）', async () => {
  const seg = await callRaw(handler, { url: `${BASE}/recordings/${recordingId}/file`, headers: { range: 'bytes=10-19' } })
  assert.equal(seg.status, 206)
  assert.equal(seg.headers['content-range'], `bytes 10-19/${recordingAudio.length}`)
  assert.equal(seg.headers['content-length'], '10')
  assert.ok(seg.buffer.equals(recordingAudio.subarray(10, 20)))
  const clamped = await callRaw(handler, { url: `${BASE}/recordings/${recordingId}/file`, headers: { range: `bytes=${recordingAudio.length - 5}-999999` } })
  assert.equal(clamped.status, 206)
  assert.equal(clamped.headers['content-range'], `bytes ${recordingAudio.length - 5}-${recordingAudio.length - 1}/${recordingAudio.length}`)
  assert.ok(clamped.buffer.equals(recordingAudio.subarray(recordingAudio.length - 5)))
  const open = await callRaw(handler, { url: `${BASE}/recordings/${recordingId}/file`, headers: { range: 'bytes=5-' } })
  assert.equal(open.status, 206)
  assert.ok(open.buffer.equals(recordingAudio.subarray(5)))
})

await step('DELETE /recordings/:id：索引/文件移除；再删/再取 404', async () => {
  const del = await call(handler, { method: 'DELETE', url: `${BASE}/recordings/${recording2Id}` })
  assert.equal(del.body.ok, true)
  const again = await call(handler, { method: 'DELETE', url: `${BASE}/recordings/${recording2Id}` })
  assert.equal(again.status, 404)
  const file = await call(handler, { url: `${BASE}/recordings/${recording2Id}/file` })
  assert.equal(file.status, 404)
  const idx = JSON.parse(readFileSync(path.join(smokeHome, 'meeting-assistant', 'recordings', 'index.json'), 'utf8'))
  assert.ok(!idx[recording2Id])
  assert.ok(!existsSync(path.join(smokeHome, 'meeting-assistant', 'recordings', 'files', `${recording2Id}.webm`)))
})

await step('POST /generate-text：recording_id + source=upload 落入 minutes meta', async () => {
  const { body } = await call(handler, {
    method: 'POST',
    url: `${BASE}/generate-text`,
    body: { meeting_id: meetingId, transcript: '[00:01] 张三：开始评审。', recording_id: recordingId, source: 'upload', template_type: 'weekly' },
  })
  const m = body.minutes
  assert.ok(m && m.minutes_id)
  assert.equal(m.source, 'upload')
  assert.equal(m.recording_id, recordingId)
  const idx = JSON.parse(readFileSync(path.join(smokeHome, 'meeting-assistant', 'minutes', 'index.json'), 'utf8'))
  assert.equal(idx[m.minutes_id].recording_id, recordingId)
  assert.equal(idx[m.minutes_id].source, 'upload')
})

await step('POST /generate-text：不存在的 recording_id → 400 NOT_FOUND', async () => {
  const { status, body } = await call(handler, {
    method: 'POST',
    url: `${BASE}/generate-text`,
    body: { transcript: '[16:00] 测试。', recording_id: 'rec_00000000000000ff' },
  })
  assert.equal(status, 400)
  assert.equal(body.error, 'NOT_FOUND')
})

await step('POST /generate-text：source 非法值忽略按缺省 ai（既有默认行为不变）', async () => {
  const { body } = await call(handler, { method: 'POST', url: `${BASE}/generate-text`, body: { transcript: '[17:00] 兜底行为。', source: 'bogus' } })
  assert.equal(body.minutes.source, 'ai')
  assert.ok(!('recording_id' in body.minutes), '未带录音时不应出现 recording_id 字段')
})

await step('DELETE /meetings/:id 与 404 路由', async () => {
  const created = await call(handler, { method: 'POST', url: `${BASE}/meetings`, body: { title: '待删除', start_time: '2026-09-26T14:00:00Z', end_time: '2026-09-26T15:00:00Z' } })
  const id = created.body.meeting.id
  const gone = await call(handler, { method: 'DELETE', url: `${BASE}/meetings/${id}` })
  assert.equal(gone.body.ok, true)
  const missing = await call(handler, { url: `${BASE}/meetings/${id}` })
  assert.equal(missing.body.error, 'NOT_FOUND')
  const unknown = await call(handler, { url: `${BASE}/whatever` })
  assert.equal(unknown.body.error, 'NOT_FOUND')
})

await step('disposer：注销路由与工作台清单', () => {
  disposer()
  assert.equal(registered.routes.length, 0, '路由未注销')
  assert.ok(unregistered.includes('meeting'), 'workbench 清单未注销')
})

/* ---------------- 汇总与清理 ---------------- */

console.log('\ndsh-meetai smoke results:')
for (const line of results) console.log(line)
const failed = results.filter((r) => r.startsWith('  ❌')).length
console.log(`\n${results.length - failed}/${results.length} passed`)

rmSync(smokeHome, { recursive: true, force: true })
if (existsSync(smokeHome)) console.warn(`警告：临时目录未能完全清理：${smokeHome}`)
