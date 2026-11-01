// Classic factory helpers; no new Service/API, no external assets.
function QaAvatar035({ role }) {
  const user = role === 'user'
  return h('svg', { viewBox: '0 0 36 36', width: 36, height: 36, role: 'img', 'aria-label': user ? '提问者头像' : '助手头像', className: 'mt-qa-avatar035' },
    h('circle', { cx: 18, cy: 18, r: 17, fill: user ? '#e7f0ff' : '#dff7ef', stroke: user ? '#baceee' : '#b9dfd0' }),
    user ? h('path', { d: 'M8 31c1-8 19-8 20 0', fill: '#86aee5' }) : h('path', { d: 'M18 5v4M11 27v4M25 27v4', stroke: '#64a99a', strokeWidth: 2 }),
    user ? h('circle', { cx: 18, cy: 17, r: 9, fill: '#ffe5cc' }) : h('rect', { x: 8, y: 10, width: 20, height: 17, rx: 6, fill: '#a8dece', stroke: '#64a99a' }),
    user ? h('path', { d: 'M9 16c0-13 20-13 18 1-6-1-9-5-10-6-1 3-4 5-8 5', fill: '#647da5' }) : null,
    h('circle', { cx: 14, cy: 18, r: 1.3, fill: '#34546b' }), h('circle', { cx: 22, cy: 18, r: 1.3, fill: '#34546b' }),
    h('path', { d: 'M14 22q4 4 8 0', fill: 'none', stroke: '#34546b', strokeWidth: 1.5, strokeLinecap: 'round' }))
}
function QaMessage035({ role, children }) {
  const user = role === 'user'
  return h('div', { className: 'mt-qa-message035' + (user ? ' user' : ' assistant'), 'aria-label': user ? '提问者消息' : '助手消息' }, h(QaAvatar035, { role }), h('div', { className: 'mt-bubble ' + (user ? 'user' : 'ai') }, children))
}
function readQaPreference035(storage) {
  try {
    const raw = JSON.parse(storage.getItem('meetai.askLayout.v1') || 'null')
    if (raw?.schemaVersion === 1 && ['auto','manual'].includes(raw.mode) && Number.isFinite(raw.manualHeight) && raw.manualHeight >= 180 && raw.manualHeight <= 2200) return raw
  } catch {}
  let old = 1040
  try { const value = Number(storage.getItem('meetai.askH')); if (value >= 520 && value <= 2200) old = Math.round(value) } catch {}
  return { schemaVersion: 1, mode: 'auto', manualHeight: old }
}
function qaAvailable035(top, bottom, padding) { return Math.max(120, Math.floor(bottom - top - padding)) }
