/**
 * dsh-meetai 客户端结构自检：在 node 中以 stub 执行 client.js（无法真正渲染 UI），
 * 校验：① window.__ModuleLoader__.load 被调用且 factory 可执行；
 *      ② require 的模块名仅限 seed 表（react / @deepseek-ai/dsh-client-ui-primitives）；
 *      ③ exports 形态 { inject, apply }，inject 声明与 slots/layout/locale 用法一致；
 *      ④ apply(ctx) 能完整走通（slot 注册、事件桥挂载、disposer 注销）。
 * 运行：node scripts/client-structure-check.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

const SEED = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'])

const listeners = new Map()
let loaded = null
globalThis.window = {
  addEventListener: (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name).add(fn)
  },
  removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
  dispatchEvent: () => true,
  CustomEvent: class CustomEvent {
    constructor(type, opts) {
      this.type = type
      this.detail = opts && opts.detail
    }
  },
  setTimeout,
}
if (!globalThis.navigator || !globalThis.navigator.clipboard) {
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true })
}
globalThis.localStorage = { getItem: () => null, setItem: () => {} }

window.__ModuleLoader__ = {
  load(def) {
    loaded = def
  },
}

// 执行 client.js 顶层 IIFE
new Function('window', 'globalThis', src)(window, globalThis)
assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-meetai', 'bundle id 应为 dsh-meetai')

const required = []
const reactStub = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'createElement') return (type, ...rest) => ({ type, props: rest })
    if (prop === 'Fragment') return Symbol.for('react.fragment')
    if (typeof prop === 'string' && /^use[A-Z]/.test(prop)) return (fn) => (typeof fn === 'function' ? fn() : fn)
    return () => null
  },
})
const requireStub = (name) => {
  required.push(name)
  assert.ok(SEED.has(name), `require('${name}') 不在 seed 表（需写进 dsh.client.external/inject）`)
  if (name === 'react') return reactStub
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { IconAlarmClockOutlineRegular: function IconAlarmClockOutlineRegular() {} }
  return {}
}

const api = loaded.factory(requireStub)
assert.ok(api && typeof api.apply === 'function', 'factory 须返回 { inject, apply }')
assert.ok(Array.isArray(api.inject), 'inject 须为数组')
for (const svc of api.inject) assert.ok(['slots', 'layout', 'locale', 'sessions', 'uiWorkspace'].includes(svc), `inject 含未核对服务 ${svc}`)

// apply(ctx)：捕获 slot 注册与 disposer
const registeredSlots = []
const disposers = []
const labelFns = []
const ctx = {
  slots: {
    inject: (key, fn) => {
      const dispose = () => {
        const i = disposers.indexOf(dispose)
        if (i >= 0) disposers.splice(i, 1)
      }
      disposers.push(dispose)
      const disposeInner = fn()
      if (typeof disposeInner === 'function') disposers.push(disposeInner)
      registeredSlots.push(key)
      return dispose
    },
    register: (opts, render) => {
      assert.equal(opts.name, opts.name) // 结构存在即可
      if (opts.name === 'main') assert.match(opts.key, /^cap:/, 'main key 应为 cap: 前缀')
      if (opts.name === 'sidebar.panellist') {
        assert.equal(opts.id, 'cap:meeting')
        assert.equal(opts.order, 10)
        assert.equal(typeof opts.label, 'function', 'panellist label 应为函数（跟随语言）')
        labelFns.push(opts.label)
      }
      return opts
    },
  },
  get(name) {
    if (name === 'locale') return { getLocale: () => ({ id: 'zh' }), subscribe: () => () => {} }
    return null
  },
  layout: { selectPanel: () => {} },
}

const dispose = api.apply(ctx)
assert.deepEqual(registeredSlots.sort(), ['main', 'sidebar.panellist'], '应注册 main 与 sidebar.panellist 两个 slot')
assert.ok(listeners.has('cappacks:open-meeting'), '应监听 cappacks:open-meeting')
assert.equal(typeof dispose, 'function', 'apply 须返回 disposer')
assert.ok(labelFns.length >= 1 && labelFns[0]() === '会议助手', 'label() 中文缺省')

// 事件桥：模拟 cappacks 事件 → 应派发模块级导航事件（pendingNav 置位）
const openHandlers = [...listeners.get('cappacks:open-meeting')]
openHandlers.forEach((fn) => fn({ detail: { section: '会议纪要' } }))

dispose()
assert.equal(disposers.length, 0, 'disposer 应注销全部注册')
console.log('client-structure-check: all assertions passed')
