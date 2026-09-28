/**
 * dsh-meetai — 会议助手插件（浏览器半）
 *
 * 主内容区完整应用（main key = cap:meeting）：左侧插件自有深色导航 rail
 * （品牌区 / 会议日程 / 新建会议 / 会议纪要 / 会议问答 / 统计卡 / 返回会话，
 * 参考 meetai.html 原型，固定配色不随 DSH 主题）+ 右侧正文（mt-body，DSH 主题 token）。
 * 正文页签：会议日程（列表/周/月） · 新建会议（AI 议程） ·
 *   会议纪要（实时录音转写 / 上传录音 / 粘贴文本 → 生成/编辑/归档） · 会议问答（rail 二级导航：
 *   新建对话 / 历史对话；单一对话框 = POST /qa SSE 流式回答 + 📎 附件拖拽上传 + 模型选择 + 提示 chips）。
 * 挂载时若 DSH 侧栏处于展开态则收起一次（仅此一次；除此之外绝不触碰 DSH 左侧导航）。
 *
 * 入口：
 *   - sidebar.panellist 行（cap:meeting，图标 IconAlarmClockOutlineRegular）；
 *   - 监听 cappacks:open-meeting（detail.section ∈ 会议日程/会议纪要/会议问答 或 null）→
 *     模块级 CustomEvent 'meetai:navigate' 桥接 + ctx.layout.selectPanel('cap:meeting')。
 *
 * 仅依赖 seed 表模块：react、@deepseek-ai/dsh-client-ui-primitives。
 * 正文配色全部使用 --dsw-alias-*（已核对 checkout design-platform.css），深浅主题自适应。
 */
window.__ModuleLoader__.load({
  id: 'dsh-meetai',
  factory(require) {
    const React = require('react')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const API = '/api/meeting-assistant'
    const NAV_EV = 'meetai:navigate'
    const OPEN_EV = 'cappacks:open-meeting'
    let pendingNav = null
    // 会议问答附件：扩展名白名单与单文件大小上限（与服务端 /upload 契约一致）
    const UPLOAD_RE = /\.(pdf|docx|xlsx|txt|md)$/i
    const UPLOAD_MAX = 30 * 1024 * 1024
    // 「新建会议」提示 chip 插入输入框的模板（用户补全后发送，服务端 agent 调 meeting_create 建会）
    const MEETING_TEMPLATE = ['【新建会议】', '主题：', '开始时间：（如 2026-09-29 14:00）', '结束时间：', '地点：', '参会人：', '议程：', '补充说明：'].join('\n')

    /* ---------------------------------------------------------------- */
    /* 样式（单条 <style> 注入；正文全部 --dsw-alias-* 变量；rail 固定深色） */
    /* ---------------------------------------------------------------- */

    const CSS = `
.mt-app{height:100%;min-height:0;display:flex;flex-direction:row;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.6 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;overflow:hidden}
.mt-app *{box-sizing:border-box}
.mt-app button{font:inherit;color:inherit}
.mt-app ::placeholder{color:var(--dsw-alias-label-tertiary)}
/* —— 插件自有导航 rail（配色随 DSH「通用设置 → 外观」主题令牌联动，明暗自动切换；结构参考 meetai.html 原型侧栏）—— */
.mt-rail{width:232px;flex:none;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);overflow-y:auto;overflow-x:hidden}
.mt-brand{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.mt-brandicon{width:34px;height:34px;flex:none;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;color:#fff;background:linear-gradient(45deg,var(--dsw-static-blue-600),var(--dsw-static-deepseek-450));box-shadow:0 4px 12px rgba(37,99,235,.28)}
.mt-brandname{font-size:14px;font-weight:750;color:var(--dsw-alias-label-primary);letter-spacing:.01em;white-space:nowrap}
.mt-brandtag{display:inline-block;margin-left:6px;padding:0 5px;border-radius:5px;font-size:10px;font-weight:650;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);vertical-align:1.5px}
.mt-brandsub{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-railnav{flex:1;min-height:0;display:flex;flex-direction:column;gap:4px;padding:10px;overflow-y:auto}
.mt-railsection{padding:2px 10px 5px;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.mt-railitem{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;border:none;background:none;color:var(--dsw-alias-label-secondary);padding:9px 11px;border-radius:10px;font-size:13px;font-weight:550;cursor:pointer;text-align:left}
.mt-railitem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-railitem.active{background:var(--dsw-static-blue-600);color:#fff;font-weight:650;box-shadow:0 4px 12px rgba(37,99,235,.28)}
.mt-railitem .ic{display:flex;align-items:center;gap:9px;min-width:0}
.mt-railitem .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-railbadge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 6px;border-radius:999px;font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);flex:none}
.mt-railitem.active .mt-railbadge{background:rgba(255,255,255,.22);color:#fff}
.mt-railbadge.amber{background:rgba(245,158,11,.18);color:var(--dsw-alias-state-warn-label)}
.mt-railitem.active .mt-railbadge.amber{background:rgba(255,255,255,.22);color:#fff}
.mt-railtag{display:inline-flex;align-items:center;padding:1px 6px;border-radius:6px;font-size:10px;font-weight:650;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);flex:none}
.mt-railitem.active .mt-railtag{color:rgba(255,255,255,.85);border-color:rgba(255,255,255,.35);background:rgba(255,255,255,.14)}
.mt-raildot{position:relative;width:8px;height:8px;flex:none}
.mt-raildot::after{content:'';position:absolute;inset:0;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.mt-raildot::before{content:'';position:absolute;inset:-2px;border-radius:50%;background:var(--dsw-alias-state-success-secondary);opacity:.75;animation:mt-ping 1.6s cubic-bezier(0,0,.2,1) infinite}
@keyframes mt-ping{75%,100%{transform:scale(2.2);opacity:0}}
.mt-railstats{margin-top:8px;padding:11px 12px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.mt-railstats .cap{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:650;color:var(--dsw-alias-label-primary);margin-bottom:7px}
.mt-railstats .live{display:inline-flex;align-items:center;gap:4px;margin-left:auto;color:var(--dsw-alias-state-success-primary);font-weight:600}
.mt-railstats .live i{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.mt-statrow{display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:2.5px 0}
.mt-statrow b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:700}
.mt-statrow b.indigo{color:var(--dsw-static-blue-600)}
.mt-railback{margin:8px 10px 12px;display:flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);border-radius:10px;padding:8px 10px;cursor:pointer;font-size:12.5px;flex:none;white-space:nowrap}
.mt-railback:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
@media (max-width:900px){
  .mt-rail{width:60px}
  .mt-brand{justify-content:center;padding:10px 0}
  .mt-brandname,.mt-brandsub,.mt-railsection,.mt-railstats,.mt-railitem .txt,.mt-railtag,.mt-railback .txt{display:none}
  .mt-railitem{justify-content:center;padding:11px 0}
  .mt-railitem .ic{gap:0}
  .mt-railitem .mt-railbadge{position:absolute;top:2px;right:5px;transform:scale(.82);transform-origin:top right}
  .mt-railitem .mt-raildot{position:absolute;top:7px;right:8px}
  .mt-railback{margin:6px 8px 10px;padding:8px 0;font-size:15px}
}
.mt-kicker{font-size:10px;letter-spacing:.16em;text-transform:uppercase;font-weight:750;color:var(--dsw-alias-state-business-primary)}
.mt-body{flex:1;min-width:0;min-height:0;overflow:auto;padding:15px 20px 44px}
.mt-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:13px 15px}
.mt-card+.mt-card{margin-top:10px}
.mt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mt-between{justify-content:space-between}
.mt-stack{display:grid;gap:10px}
.mt-grow{flex:1;min-width:0}
.mt-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mt-secondary{color:var(--dsw-alias-label-secondary);font-size:12px}
.mt-h3{font-size:14px;font-weight:700;margin:0 0 10px}
.mt-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:6px 12px;cursor:pointer;line-height:1.4;white-space:nowrap}
.mt-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-btn:disabled{opacity:.5;cursor:not-allowed}
.mt-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:650}
.mt-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.mt-btn.success{background:var(--dsw-alias-state-success-primary);border-color:transparent;color:#fff;font-weight:650}
.mt-btn.success:hover{opacity:.9}
.mt-btn.small{padding:3px 9px;font-size:12px;border-radius:7px}
.mt-btn.ghost{border-color:transparent;background:none;color:var(--dsw-alias-label-secondary)}
.mt-btn.ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.mt-input,.mt-select,.mt-textarea{width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.mt-input:focus,.mt-select:focus,.mt-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}
.mt-textarea{min-height:120px;resize:vertical;line-height:1.6}
.mt-select{width:auto;min-width:130px}
.mt-field{display:grid;gap:5px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.mt-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.mt-grid3{display:grid;grid-template-columns:130px minmax(0,1fr) 150px auto;gap:8px;align-items:center}
@media (max-width:860px){.mt-grid3{grid-template-columns:1fr;gap:6px}.mt-grid2{grid-template-columns:1fr}}
.mt-pill{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:650;border:1px solid transparent;white-space:nowrap;font-variant-numeric:tabular-nums;letter-spacing:.01em}
.mt-pill.blue{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.mt-pill.green{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.mt-pill.amber{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));background:var(--dsw-alias-state-warn-tertiary)}
.mt-pill.gray{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3)}
.mt-pill.red{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.mt-breathe{width:7px;height:7px;border-radius:50%;background:currentColor;animation:mt-breathe 1.6s ease-in-out infinite}
@keyframes mt-breathe{0%,100%{opacity:1}50%{opacity:.35}}
.mt-star{border:none;background:none;cursor:pointer;font-size:16px;line-height:1;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));padding:1px 3px}
.mt-star.on{color:var(--dsw-alias-state-warn-primary)}
.mt-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 9px;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.mt-linkchip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 10px;font-size:11.5px;color:var(--dsw-alias-link);background:var(--dsw-alias-bg-layer-2);cursor:pointer;max-width:100%}
.mt-linkchip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-cite{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 4px;margin:0 2px;border:none;border-radius:5px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:10.5px;font-weight:700;cursor:pointer;vertical-align:1px}
.mt-cite:hover{outline:1px solid var(--dsw-alias-state-business-primary)}
.mt-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.mt-seg button{border:none;background:none;padding:5px 12px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mt-seg button[aria-pressed=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:700}
.mt-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;row-gap:8px}
.mt-toggle{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:5px 11px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mt-toggle[aria-pressed=true]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);font-weight:650}
.mt-cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
.mt-calhead{font-size:11px;font-weight:700;color:var(--dsw-alias-label-tertiary);text-align:center;padding:2px 0 6px}
.mt-cell{min-height:78px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:4px 5px;background:var(--dsw-alias-bg-layer-1);position:relative;overflow:visible;transition:border-color .15s ease}
.mt-cell:hover{border-color:var(--dsw-alias-border-l2)}
.mt-cell.dim{opacity:.55}
.mt-cell.today{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}
.mt-daynum{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:650}
.mt-cell.today .mt-daynum{color:var(--dsw-alias-state-business-primary)}
.mt-ev{display:block;width:100%;text-align:left;border:none;border-left:3px solid var(--dsw-static-blue-600);background:var(--dsw-alias-interactive-bg-hover);border-radius:6px;padding:2.5px 7px;margin-top:3px;font-size:11px;font-weight:550;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .15s ease}
.mt-ev:hover{background:var(--dsw-alias-interactive-bg-active)}
.mt-ev.pinned{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));border-left-color:var(--dsw-alias-state-warn-primary)}
.mt-evmore{margin-top:3px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.mt-pop{display:none;position:absolute;z-index:30;top:calc(100% + 4px);left:0;width:230px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 11px;box-shadow:0 12px 32px rgba(0,0,0,.22)}
.mt-cell:hover .mt-pop{display:block}
.mt-pop .mt-ev{white-space:normal}
.mt-tcard{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start}
@media (max-width:960px){.mt-tcard{grid-template-columns:1fr}}
.mt-tplgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mt-tpl{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:9px 11px;text-align:left;cursor:pointer}
.mt-tpl:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-tpl[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.mt-tpl b{display:block;font-size:12.5px}
.mt-tpl span{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:1px}
.mt-fp{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;color:var(--dsw-alias-label-secondary);user-select:all}
.mt-todo{display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mt-todo:last-child{border-bottom:none}
.mt-todo input[type=checkbox]{margin-top:3px;accent-color:var(--dsw-alias-state-business-primary)}
.mt-todo .done{text-decoration:line-through;color:var(--dsw-alias-label-tertiary)}
.mt-msgs{display:flex;flex-direction:column;gap:12px;overflow:auto;min-height:0;flex:1;padding:4px 2px 10px}
.mt-bubble{max-width:82%;border-radius:12px;padding:9px 13px;white-space:pre-wrap;word-break:break-word}
.mt-bubble.user{align-self:flex-end;background:var(--dsw-alias-interactive-bg-active);border:1px solid var(--dsw-alias-border-l1)}
.mt-bubble.ai{align-self:flex-start;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.mt-msgsrc{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.mt-session{display:block;width:100%;text-align:left;border:1px solid transparent;background:none;border-radius:9px;padding:7px 9px;cursor:pointer}
.mt-session:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mt-session.active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.mt-session b{display:block;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-session span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mt-welcome{flex:1;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:18px;text-align:center;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;align-items:center;justify-content:center}
.mt-welcome .q{display:inline-block;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:6px 14px;margin:5px 4px 0;cursor:pointer;font-size:12px}
.mt-welcome .q:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary)}
/* 底部停靠区（sticky 吸底）：新建会议标签 + 模型选择 + 输入栏 + 拖拽把手打包常驻可视区，
   对话框高于视口时无需滚动即可输入与调整高度 */
.mt-askdock{position:sticky;bottom:0;z-index:5;flex:none;display:flex;flex-direction:column;gap:8px}
.mt-asksub{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:none}
.mt-inputbar{display:flex;gap:8px;align-items:flex-end;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:8px;flex:none}
.mt-resizer{flex:none;height:14px;display:flex;align-items:center;justify-content:center;cursor:ns-resize;border-radius:8px;touch-action:none}
.mt-resizer .grip{width:46px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background .15s ease,width .15s ease}
.mt-resizer:hover .grip,.mt-resizer:focus-visible .grip{background:var(--dsw-alias-state-business-primary);width:68px}
.mt-inputbar textarea{flex:1;min-height:40px;max-height:120px;border:none;background:none;resize:none;outline:none;color:var(--dsw-alias-label-primary);font:inherit}
.mt-modal-mask{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;z-index:80;padding:20px}
.mt-modal{width:min(760px,94vw);max-height:86vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px 20px;box-shadow:0 18px 50px rgba(0,0,0,.28)}
.mt-modal.narrow{width:min(560px,94vw)}
.mt-toastwrap{position:fixed;right:18px;bottom:18px;display:grid;gap:8px;z-index:99;max-width:340px}
.mt-toast{background:var(--dsw-alias-toast-bg);color:#fff;border-radius:10px;padding:9px 14px;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.25);border-left:3px solid var(--dsw-alias-label-tertiary);word-break:break-word}
.mt-toast.success{border-left-color:var(--dsw-alias-state-success-primary)}
.mt-toast.error{border-left-color:var(--dsw-alias-state-error-primary)}
.mt-toast.warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.mt-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;padding:32px 20px;text-align:center;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}
.mt-drop{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:14px;text-align:center;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:var(--dsw-alias-bg-layer-2)}
.mt-drop:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-secondary)}
.mt-file{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}
.mt-file:last-child{border-bottom:none}
.mt-file .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-agendaline{display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12.5px}
.mt-agendaline:last-child{border-bottom:none}
.mt-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.mt-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);border-radius:50%;animation:mt-spin .8s linear infinite;vertical-align:-2px}
@keyframes mt-spin{to{transform:rotate(360deg)}}
.mt-notice{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border-radius:9px;padding:7px 12px;font-size:12.5px;margin-bottom:10px}
/* —— 会议纪要：三来源模式（实时录音 / 上传录音 / 粘贴文本）—— */
.mt-recdot{width:10px;height:10px;flex:none;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:mt-breathe 1.2s ease-in-out infinite}
.mt-livewrap{max-height:190px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);padding:8px 10px;font-size:12px;line-height:1.8}
.mt-liveline{white-space:pre-wrap;word-break:break-word}
.mt-liveline.interim{color:var(--dsw-alias-label-tertiary);font-style:italic}
.mt-recfile{display:grid;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:9px 11px}
.mt-recfile .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}
.mt-progress{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.mt-progress i{display:block;height:100%;background:var(--dsw-alias-state-business-primary);transition:width .2s ease}
/* —— 问答 v0.2.5：rail 二级导航（历史=标签+会话列表）/ 全量资产+模型+新建会议同排顶栏 / 可拖拽调高对话框 —— */
.mt-railarrow{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;border-radius:5px;color:var(--dsw-alias-label-tertiary);transition:transform .16s ease,background .15s ease,color .15s ease}
.mt-railarrow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-railitem.active .mt-railarrow{color:rgba(255,255,255,.85)}
.mt-railitem.active .mt-railarrow:hover{background:rgba(255,255,255,.16);color:#fff}
.mt-railarrow.open{transform:rotate(90deg)}
.mt-railsub{position:relative;display:flex;align-items:center;width:calc(100% - 16px);margin-left:16px;border:none;background:none;color:var(--dsw-alias-label-secondary);padding:7px 10px;border-radius:9px;font-size:12.5px;font-weight:500;cursor:pointer;text-align:left}
.mt-railsub:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mt-railsub.active{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-weight:650}
.mt-railsub .ic{display:flex;align-items:center;gap:8px;min-width:0}
.mt-railsub .txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 「历史对话」标签：非按钮的分组标题，其下平铺全部历史会话 */
.mt-raillabel{display:flex;align-items:center;gap:7px;width:calc(100% - 16px);margin-left:16px;padding:8px 10px 3px;font-size:11px;font-weight:750;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}
.mt-raillabel .n{margin-left:auto;font-size:10.5px;font-weight:700;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 7px;line-height:16px}
.mt-railsessrow{position:relative;display:flex;align-items:center;width:calc(100% - 16px);margin-left:16px}
.mt-railsessrow .mt-railsession{flex:1;min-width:0;padding-right:28px}
.mt-railsessdel{position:absolute;right:5px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:6px;background:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;cursor:pointer;opacity:0;transition:opacity .15s ease,background .15s ease,color .15s ease}
.mt-railsessrow:hover .mt-railsessdel{opacity:1}
.mt-railsessdel:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.mt-railempty{width:calc(100% - 16px);margin-left:16px;padding:1px 10px 3px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mt-body-ask{padding-bottom:15px}
/* 对话框高度由状态驱动（默认 2 倍 520=1040，可拖拽 520~2200，localStorage 记忆） */
.mt-askwrap{position:relative;display:flex;flex-direction:column;gap:10px;min-width:0;flex:1}
.mt-asktop{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:none}
.mt-hintchip{display:inline-flex;align-items:center;gap:4px;max-width:340px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-hintchip:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.mt-hintchip.new{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:transparent;font-weight:650;flex:none}
.mt-hintchip.new:hover{background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}
.mt-askbody{display:flex;gap:12px;flex:1;min-height:0}
.mt-askpanel{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:8px}
/* 底部拖拽把手样式并入 .mt-askdock（吸底停靠区内），此处不再单独定位 */
html[data-mt-resizing],html[data-mt-resizing] *{cursor:ns-resize!important;user-select:none!important}
.mt-streamstatus{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.mt-streamthink{font-size:12px;font-style:italic;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;margin-bottom:6px}
.mt-toolrow{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);margin:6px 0 2px;padding:4px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px dashed var(--dsw-alias-border-l2)}
.mt-errmsg{margin-top:7px;padding:6px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:12px}
.mt-attachrow{display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex:none}
.mt-attach{display:inline-flex;align-items:center;gap:6px;max-width:280px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:3px 8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mt-attach.uploading{border-style:dashed;color:var(--dsw-alias-label-tertiary)}
.mt-attach .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mt-attach .rm{border:none;background:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1;padding:1px 2px;flex:none}
.mt-attach .rm:hover{color:var(--dsw-alias-state-error-primary)}
.mt-clipbtn{display:flex;align-items:center;justify-content:center;width:37px;height:37px;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;font-size:15px;color:var(--dsw-alias-label-secondary)}
.mt-clipbtn:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.mt-clipbtn:disabled{opacity:.55;cursor:not-allowed}
.mt-btn.stop{background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-weight:650}
.mt-dropoverlay{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;gap:8px;border:2px dashed var(--dsw-alias-state-business-primary);border-radius:14px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-weight:700;font-size:14px;pointer-events:none}
/* —— 会议日程 v0.2.4 美化：主题色渐变竖条 / hover 抬升 / 日历事件块左侧色条 —— */
.mt-mcard{position:relative;overflow:hidden;padding-left:19px;transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease}
.mt-mcard::before{content:'';position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(180deg,var(--dsw-static-blue-600),var(--dsw-static-deepseek-450))}
.mt-mcard.s-in_progress::before{background:linear-gradient(180deg,var(--dsw-alias-state-success-primary),var(--dsw-alias-state-success-secondary))}
.mt-mcard.s-completed::before{background:linear-gradient(180deg,var(--dsw-alias-label-tertiary),var(--dsw-alias-border-l2))}
.mt-mcard:hover{transform:translateY(-2px);box-shadow:0 10px 26px rgba(15,23,42,.12);border-color:var(--dsw-alias-border-l2)}
.mt-metarow{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin:7px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mt-when{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.mt-when b{font-weight:700;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:1px 7px;font-size:11.5px}
.mt-where,.mt-who{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
@media (max-width:900px){
  .mt-askbody{flex-direction:column}
  .mt-railsub{width:calc(100% - 12px);margin-left:12px;padding:8px 0;justify-content:center}
  .mt-railsub .txt{display:none}
  .mt-railsub .ic{gap:0}
  /* 历史会话行窄屏保留标题（无图标，仅文字），删除按钮常显 */
  .mt-railsessrow{width:calc(100% - 12px);margin-left:12px}
  .mt-railsession{justify-content:flex-start;padding:8px 30px 8px 10px}
  .mt-railsession .txt{display:block}
  .mt-railsessdel{opacity:1}
  .mt-raillabel,.mt-railempty{width:calc(100% - 12px);margin-left:12px}
}
`

    /* ---------------------------------------------------------------- */
    /* i18n 词典                                                          */
    /* ---------------------------------------------------------------- */

    const dict = {
      zh: {
        title: '会议助手', subtitle: '会议日程与 AI 议程、模板纪要生成与签署归档、可溯源会议问答', back: '返回主页',
        brandSub: '企业级智能会议协同系统', brandTag: '智会', railSection: '工作台协同', aiAssistTag: 'AI辅助',
        statTitle: 'AI 助手状态', statOnline: '在线', statTodayMeetings: '今日待开会议', statPendingMinutes: '待归档纪要', statIndexedDocs: '已索引文档',
        unitMeetings: (n) => `${n} 场`, unitFiles: (n) => `${n} 份`, unitDocs: (n) => `${n} 篇`,
        navSchedule: '会议日程', navCreate: '新建会议', navMinutes: '会议纪要', navAsk: '会议问答', pendingArchiveBadge: '待归档',
        searchPlaceholder: '搜索标题 / 地点 / 参会人 / 标签', allStatus: '所有状态', upcoming: '待开始', inProgress: '进行中', completed: '已结束',
        pinnedOnly: '仅看置顶', viewList: '列表', viewWeek: '周日历', viewMonth: '月日历', today: '今天',
        newMeeting: '新建会议', emptySchedule: '暂无符合条件的会议日程', emptyScheduleHint: '调整筛选条件，或点击「新建会议」创建第一场会议。',
        detail: '详情', gotoMinutes: '纪要', gotoAsk: 'AI问答', pinnedBadge: '重要置顶', etc: '等', materialCount: '份材料', noAgenda: '暂无议程',
        starOn: '已置顶', starOff: '已取消置顶',
        weekNo: (y, m, w) => `${y}年${m}月 第${w}周`, monthLabel: (y, m) => `${y}年${m}月`,
        noMeetings: '无会议安排', more: (n) => `更多 ${n} 场`,
        fTitle: '会议主题', fStart: '开始时间', fEnd: '结束时间', fType: '会议形式', typeOnline: '纯线上', typeOffline: '纯线下', typeHybrid: '混合',
        locOnline: '线上视频会议号 / 腾讯会议链接', locOffline: '线下物理会议室与工区地点', locHybrid: '会议地点 / 线上会议室',
        fParticipants: '参会人员（逗号分隔）', fTags: '会议标签（逗号分隔）', fPinned: '设为重要并置顶', meetingLink: '视频会议链接（可选）',
        agendaTitle: '会议议程与指派任务', agendaTime: '时间段', agendaTopic: '议题大纲与目标', agendaSpeaker: '发言/负责人', addAgenda: '添加议程', removeAgenda: '删除',
        aiAgenda: 'AI 一键根据主题生成议程', aiAgendaBusy: 'AI 正在编排议程…', aiAgendaDone: '议程已生成，可继续编辑', aiAgendaEmpty: 'AI 未返回可用议程，请补充会议主题后重试',
        materialTitle: '会议资料与知识挂载', materialHint: '点击选择文件（TXT / MD / PDF / DOCX / PPTX / XLSX，单文件 ≤10MB）', materialTextReady: '文本已提取，可参与问答检索', materialQueued: '仅存元数据（不支持文本抽取的格式）', materialTooBig: '文件超过 10MB 上限',
        submitCreate: '确认并发布会议日程', created: '会议已发布', needTitle: '请填写会议主题', needTime: '请填写开始与结束时间，且结束晚于开始',
        bindMeeting: '当前绑定关联会议', archiveBtn: '正式签署归档', archivedToast: (fp) => `已签署归档 · SHA-256 指纹 ${fp.slice(0, 16)}…`, archiveNoContent: '纪要正文为空，无法归档',
        minutesStatusNone: '待生成纪要', minutesStatusReady: 'AI纪要待签署', minutesStatusArchived: '纪要已归档',
        srcLive: '实时录音转写', srcUpload: '上传录音', srcPaste: '粘贴文本',
        startRec: '开始录音', finishAndGenerate: '结束并生成纪要', cancelRec: '取消', recLive: '录音中',
        recHint: '请开始说话，语音将实时转写为文字…', micDenied: '无法访问麦克风，请检查浏览器录音权限',
        liveUnsupported: '当前浏览器不支持实时录音转写（需 Chrome/Edge 的 Web Speech 与 MediaRecorder），请改用「上传录音」或「粘贴文本」模式。',
        liveAutoHint: '录音结束后将按所选模板自动生成纪要', downloadRec: '下载录音', recEmpty: '转写内容为空，未生成纪要',
        uploadHint: '点击选择或拖入录音文件（MP3 / M4A / WAV / AAC / OGG / WEBM / AMR / FLAC，≤500MB）', uploadProgress: '上传中',
        uploadDone: '录音已上传', recTooBig: '录音文件超过 500MB 上限', saveTranscript: '保存转写', savedTranscript: '转写已保存',
        importTxtSrt: '导入 .txt/.srt', playTranscribe: '播放并实时转写（实验性）', stopPlayTranscribe: '停止',
        playTranscribeHint: '实验性：需外放且环境安静',
        transcriptLabel: '录音转写文本（或粘贴 [HH:mm:ss] 说话人: 内容 格式）', importTxt: '导入转写 .txt', templateLabel: '选择 AI 提炼模板', generateBtn: 'AI 一键生成纪要', generating: '正在生成纪要…',
        generated: '纪要已生成', contentTitle: '纪要正文（Markdown，可直接编辑修订）', saveBtn: '保存修订', saved: '纪要已保存', copyAll: '复制全文', copied: '已复制到剪贴板',
        importFixed: '导入修正版覆盖', imported: '已导入修正版（版本 +1）', versionLabel: (v) => `v${v}`, sourceAi: 'AI 生成', sourceEdit: '在线修订', sourceImport: '导入覆盖', sourceLive: '实时录音', sourceUpload: '上传录音',
        fingerprintLabel: '归档 SHA-256 指纹', actionItems: '跟进待办与责任人', noActionItems: '本篇纪要暂无结构化待办', noMinutes: '该会议尚无纪要', noMinutesHint: '在左侧录音、上传录音或粘贴转写文本，选择模板后生成。',
        pickMeeting: '请先绑定一场会议', noMeetingsForMinutes: '暂无会议可绑定，请先创建会议。',
        askTitle: '会议问答', askSub: '知识检索 RAG 引擎就绪 · 已关联日程与纪要知识库', newSession: '新建问答对话', sessions: '历史对话', noSessions: '暂无会话，点击上方新建。',
        scopeAll: (n) => `全量会议资产（${n} 场会议）`, scopeMeeting: '仅当前：', scopeDocs: '仅检索上传文档', delSession: '删除',
        welcomeTitle: '你好，我是 MeetAI 会议问答助手', welcomeSub: '针对关联会议、日程安排或材料提问，回答均带可溯源引用。',
        thinking: '正在检索会议知识库与转写索引…', citations: '证据与引文溯源', noCitations: '本回答未携带引用', copyAnswer: '复制',
        inputPlaceholder: '针对关联会议、日程安排或材料提问…', sendBtn: '发送', enterHint: 'Enter 发送 / Shift + Enter 换行', askFailed: '问答失败',
        srcTitle: '引文溯源', srcSource: '引文来源', srcStamp: '精确时间戳 / 定位', srcText: '原文片段', close: '我知道了', quote: '引用',
        loading: '加载中…', requestFailed: '请求失败', meetingDeleted: '会议已删除', deleteSessionFirst: '已删除会话', detailJumpAsk: (t) => `请针对《${t}》的核心共识与待办事项做全面梳理`,
        agendaFromMeeting: '议程', none: '—',
        newChat: '新建对话', histChat: '历史对话', resizeHint: '拖动调整对话区高度（520 ~ 2200px，自动记忆）',
        attachBtn: '添加附件', attachTip: '支持 .pdf / .docx / .xlsx / .txt / .md，单文件 ≤30MB', attUploading: '附件上传中…',
        attTooBig: '文件超过 30MB 上限', attUnsupported: '不支持的文件类型（仅 .pdf / .docx / .xlsx / .txt / .md）',
        attUploadFail: '附件上传失败', attRemove: '移除附件', dropHint: '松开以添加附件',
        modelLabel: '模型', modelDefaultOption: '跟随系统默认', modelDefaultSuffix: '（默认）',
        modelLoading: '模型加载中…', modelFail: '模型列表不可用', modelRetry: '重试',
        stopBtn: '停止', toolCalling: (name) => `正在调用工具：${name}…`,
      },
      en: {
        title: 'Meeting Assistant', subtitle: 'Schedules & AI agendas, template minutes with signing & archiving, traceable meeting Q&A', back: 'Back to Home',
        brandSub: 'Enterprise intelligent meeting suite', brandTag: 'Smart', railSection: 'Workspace', aiAssistTag: 'AI assist',
        statTitle: 'AI assistant', statOnline: 'Online', statTodayMeetings: 'Meetings today', statPendingMinutes: 'Minutes to sign', statIndexedDocs: 'Indexed docs',
        unitMeetings: (n) => `${n}`, unitFiles: (n) => `${n}`, unitDocs: (n) => `${n}`,
        navSchedule: 'Schedule', navCreate: 'New meeting', navMinutes: 'Minutes', navAsk: 'Q&A', pendingArchiveBadge: 'to sign',
        searchPlaceholder: 'Search title / place / people / tags', allStatus: 'All statuses', upcoming: 'Upcoming', inProgress: 'In progress', completed: 'Ended',
        pinnedOnly: 'Pinned only', viewList: 'List', viewWeek: 'Week', viewMonth: 'Month', today: 'Today',
        newMeeting: 'New meeting', emptySchedule: 'No meetings match the filters', emptyScheduleHint: 'Adjust the filters, or create your first meeting.',
        detail: 'Details', gotoMinutes: 'Minutes', gotoAsk: 'Ask AI', pinnedBadge: 'Pinned', etc: 'more', materialCount: ' files', noAgenda: 'No agenda yet',
        starOn: 'Pinned', starOff: 'Unpinned',
        weekNo: (y, m, w) => `${y}-${String(m).padStart(2, '0')} · W${w}`, monthLabel: (y, m) => `${y}-${String(m).padStart(2, '0')}`,
        noMeetings: 'No meetings', more: (n) => `+${n} more`,
        fTitle: 'Meeting title', fStart: 'Start time', fEnd: 'End time', fType: 'Format', typeOnline: 'Online', typeOffline: 'On-site', typeHybrid: 'Hybrid',
        locOnline: 'Video meeting ID / link', locOffline: 'Physical room / site', locHybrid: 'Location / online room',
        fParticipants: 'Participants (comma separated)', fTags: 'Tags (comma separated)', fPinned: 'Mark important & pin', meetingLink: 'Meeting link (optional)',
        agendaTitle: 'Agenda & assignments', agendaTime: 'Time range', agendaTopic: 'Topic & goal', agendaSpeaker: 'Speaker / owner', addAgenda: 'Add row', removeAgenda: 'Remove',
        aiAgenda: 'AI: generate agenda from title', aiAgendaBusy: 'AI is drafting the agenda…', aiAgendaDone: 'Agenda generated — feel free to edit', aiAgendaEmpty: 'AI returned no agenda, please refine the title',
        materialTitle: 'Materials & knowledge', materialHint: 'Pick files (TXT / MD / PDF / DOCX / PPTX / XLSX, ≤10MB each)', materialTextReady: 'Text extracted — searchable in Q&A', materialQueued: 'Metadata only (no text extraction for this format)', materialTooBig: 'File exceeds the 10MB limit',
        submitCreate: 'Publish meeting', created: 'Meeting published', needTitle: 'Please enter the meeting title', needTime: 'Start/end time required, and end must be after start',
        bindMeeting: 'Bound meeting', archiveBtn: 'Sign & archive', archivedToast: (fp) => `Archived · SHA-256 ${fp.slice(0, 16)}…`, archiveNoContent: 'Minutes content is empty',
        minutesStatusNone: 'No minutes yet', minutesStatusReady: 'AI minutes to sign', minutesStatusArchived: 'Minutes archived',
        srcLive: 'Live recording', srcUpload: 'Upload audio', srcPaste: 'Paste text',
        startRec: 'Start recording', finishAndGenerate: 'Finish & generate', cancelRec: 'Cancel', recLive: 'Recording',
        recHint: 'Start speaking — your speech is transcribed in real time…', micDenied: 'Microphone unavailable — please check browser permission',
        liveUnsupported: 'Live transcription needs Web Speech + MediaRecorder (e.g. Chrome/Edge). Please use "Upload audio" or "Paste text" instead.',
        liveAutoHint: 'Minutes will be generated automatically with the selected template when the recording finishes.',
        downloadRec: 'Download audio', recEmpty: 'Transcript is empty — minutes not generated',
        uploadHint: 'Click or drop an audio file (MP3 / M4A / WAV / AAC / OGG / WEBM / AMR / FLAC, ≤500MB)', uploadProgress: 'Uploading',
        uploadDone: 'Recording uploaded', recTooBig: 'Audio file exceeds the 500MB limit', saveTranscript: 'Save transcript', savedTranscript: 'Transcript saved',
        importTxtSrt: 'Import .txt/.srt', playTranscribe: 'Play & live transcribe (experimental)', stopPlayTranscribe: 'Stop',
        playTranscribeHint: 'Experimental: requires speaker output and a quiet room',
        transcriptLabel: 'Transcript (or paste [HH:mm:ss] speaker: text lines)', importTxt: 'Import .txt', templateLabel: 'AI template', generateBtn: 'Generate minutes', generating: 'Generating minutes…',
        generated: 'Minutes generated', contentTitle: 'Minutes body (Markdown, editable)', saveBtn: 'Save revision', saved: 'Minutes saved', copyAll: 'Copy all', copied: 'Copied to clipboard',
        importFixed: 'Import corrected version', imported: 'Imported (version +1)', versionLabel: (v) => `v${v}`, sourceAi: 'AI', sourceEdit: 'Edited', sourceImport: 'Imported', sourceLive: 'Live record', sourceUpload: 'Uploaded audio',
        fingerprintLabel: 'Archive SHA-256 fingerprint', actionItems: 'Action items', noActionItems: 'No structured action items in these minutes', noMinutes: 'No minutes for this meeting yet', noMinutesHint: 'Record, upload or paste a transcript on the left, then generate.',
        pickMeeting: 'Bind a meeting first', noMeetingsForMinutes: 'No meetings yet — create one first.',
        askTitle: 'Meeting Q&A', askSub: 'RAG engine ready · schedule, minutes & documents indexed', newSession: 'New session', sessions: 'History', noSessions: 'No sessions yet.',
        scopeAll: (n) => `All meeting assets (${n} meetings)`, scopeMeeting: 'Current: ', scopeDocs: 'Documents only', delSession: 'Delete',
        welcomeTitle: 'Hi, I am the MeetAI Q&A assistant', welcomeSub: 'Ask about meetings, schedules or materials — answers carry traceable citations.',
        thinking: 'Searching meeting knowledge base & transcripts…', citations: 'Citations', noCitations: 'No citations attached', copyAnswer: 'Copy',
        inputPlaceholder: 'Ask about meetings, schedules or materials…', sendBtn: 'Send', enterHint: 'Enter to send / Shift + Enter for newline', askFailed: 'Q&A failed',
        srcTitle: 'Citation source', srcSource: 'Source', srcStamp: 'Timestamp / locator', srcText: 'Original snippet', close: 'Got it', quote: 'Cite',
        loading: 'Loading…', requestFailed: 'Request failed', meetingDeleted: 'Meeting deleted', deleteSessionFirst: 'Session deleted', detailJumpAsk: (t) => `Summarize the key consensus and action items of "${t}"`,
        agendaFromMeeting: 'Agenda', none: '—',
        newChat: 'New chat', histChat: 'History', resizeHint: 'Drag to resize the chat area (520 ~ 2200px, remembered)',
        attachBtn: 'Attach files', attachTip: 'PDF / DOCX / XLSX / TXT / MD, ≤30MB each', attUploading: 'Uploading attachments…',
        attTooBig: 'File exceeds the 30MB limit', attUnsupported: 'Unsupported file type (.pdf / .docx / .xlsx / .txt / .md only)',
        attUploadFail: 'Failed to upload attachment', attRemove: 'Remove attachment', dropHint: 'Release to attach',
        modelLabel: 'Model', modelDefaultOption: 'System default', modelDefaultSuffix: ' (default)',
        modelLoading: 'Loading models…', modelFail: 'Model list unavailable', modelRetry: 'Retry',
        stopBtn: 'Stop', toolCalling: (name) => `Calling tool: ${name}…`,
      },
    }

    /* ---------------------------------------------------------------- */
    /* 工具                                                               */
    /* ---------------------------------------------------------------- */

    async function request(route, options) {
      const res = await fetch(API + route, { credentials: 'same-origin', ...options })
      let data = null
      try {
        data = await res.json()
      } catch {
        /* 非 JSON 响应 */
      }
      if (!res.ok || (data && data.error)) throw new Error((data && (data.reason || data.error)) || `HTTP ${res.status}`)
      return data
    }
    const json = (data) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    const put = (data) => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    const patch = (data) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })

    // 与分片存储合同一致：服务端ACK及封存完成后才允许生成，单请求不超过1MiB。
    async function uploadInChunks(file, options) {
      const { create, put: putChunk, commit, abort, onProgress, signal } = options
      const checkAbort = () => { if (signal.aborted) throw Object.assign(new Error('上传已取消'), { name: 'AbortError' }) }
      async function retry(operation) {
        for (let attempt = 0; ; attempt++) {
          checkAbort()
          try { return await operation() }
          catch (error) { if (signal.aborted || (error.status >= 400 && error.status < 500) || attempt >= 2) throw error }
        }
      }
      let id
      try {
        checkAbort()
        const session = await create({ filename: file.name, totalBytes: file.size, meetingId: options.meetingId || '' })
        id = session.uploadId
        const size = session.chunkBytes
        if (!id || !Number.isSafeInteger(size) || size <= 0 || size > 1024 * 1024 || session.receivedBytes !== 0) throw new Error('服务器上传会话确认无效')
        let seq = 0
        for (let offset = 0; offset < file.size; offset += size, seq++) {
          checkAbort()
          const end = Math.min(file.size, offset + size)
          const bytes = await file.slice(offset, end).arrayBuffer()
          const digest = await crypto.subtle.digest('SHA-256', bytes)
          const sha = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
          const ack = await retry(() => putChunk(id, seq, bytes, sha))
          if (ack.seq !== seq || ack.receivedBytes !== end) throw new Error('服务器已保存字节与分片确认不一致')
          onProgress(Math.min(99, Math.floor(end / file.size * 100)), 'upload')
        }
        onProgress(99, 'commit')
        const recording = await retry(() => commit(id))
        if (!recording || !recording.recording_id || recording.size_bytes !== file.size) throw new Error('服务器封存确认无效')
        return recording
      } catch (error) {
        if (id) await abort(id).catch(() => {})
        throw error
      }
    }
    const del = () => ({ method: 'DELETE' })

    const pad2 = (n) => String(n).padStart(2, '0')
    const localInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    const fmtDay = (iso) => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    }
    const fmtTime = (iso) => {
      const d = new Date(iso)
      return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }
    const fmtRange = (m) => `${fmtDay(m.start_time)} ${fmtTime(m.start_time)} ~ ${fmtTime(m.end_time)}`
    const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    const startOfWeek = (d) => {
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
      return x
    }
    function deriveStatus(m, now = Date.now()) {
      const s = Date.parse(m.start_time || '')
      if (!Number.isFinite(s) || now < s) return 'upcoming'
      const e = Date.parse(m.end_time || '')
      if (Number.isFinite(e) && now > e) return 'completed'
      return 'in_progress'
    }
    const peopleOf = (m) => (Array.isArray(m.participants) ? m.participants : [])
    const matchMeetings = (m, query) =>
      !query ||
      [m.title, m.location, ...(Array.isArray(m.tags) ? m.tags : []), ...peopleOf(m)].join(' ').toLowerCase().includes(query.toLowerCase())

    function Toasts({ toasts }) {
      return h('div', { className: 'mt-toastwrap' }, toasts.map((t) => h('div', { key: t.id, className: `mt-toast ${t.type}` }, t.message)))
    }

    function Modal({ title, narrow, onClose, children }) {
      return h(
        'div',
        { className: 'mt-modal-mask', onMouseDown: (e) => { if (e.target === e.currentTarget && onClose) onClose() } },
        h('div', { className: 'mt-modal' + (narrow ? ' narrow' : ''), role: 'dialog', 'aria-label': title || 'dialog' },
          h('div', { className: 'mt-row mt-between', style: { marginBottom: 10 } },
            h('strong', { style: { fontSize: 15 } }, title),
            onClose ? h('button', { className: 'mt-btn ghost small', onClick: onClose }, '✕') : null,
          ),
          children,
        ),
      )
    }

    function StatusPill({ status, t }) {
      const map = { upcoming: ['blue', t.upcoming], in_progress: ['green', t.inProgress], completed: ['gray', t.completed] }
      const [cls, label] = map[status] || map.upcoming
      return h('span', { className: `mt-pill ${cls}` }, status === 'in_progress' ? h('span', { className: 'mt-breathe' }) : null, label)
    }

    function MinutesPill({ value, t }) {
      const map = {
        none: ['gray', t.minutesStatusNone],
        ready: ['amber', h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, h('span', { className: 'mt-breathe' }), t.minutesStatusReady)],
        archived: ['green', t.minutesStatusArchived],
      }
      const [cls, label] = map[value] || map.none
      return h('span', { className: `mt-pill ${cls}` }, label)
    }

    /* ---------------------------------------------------------------- */
    /* 视图一：会议日程（列表 / 周 / 月）                                    */
    /* ---------------------------------------------------------------- */

    const WEEKDAYS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    const WEEKDAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

    function ScheduleView({ t, lang, meetings, onDetail, onNew, gotoMinutes, gotoAsk, togglePin }) {
      const [view, setView] = useState('list')
      const [anchor, setAnchor] = useState(() => new Date())
      const [pinnedOnly, setPinnedOnly] = useState(false)
      const [statusFilter, setStatusFilter] = useState('all')
      const [query, setQuery] = useState('')
      const now = Date.now()

      const filtered = useMemo(() => {
        const rows = meetings
          .filter((m) => (!pinnedOnly || m.is_pinned) && (statusFilter === 'all' || deriveStatus(m, now) === statusFilter) && matchMeetings(m, query))
        return rows.sort((a, b) => Number(b.is_pinned === true) - Number(a.is_pinned === true) || Date.parse(b.start_time || '') - Date.parse(a.start_time || ''))
      }, [meetings, pinnedOnly, statusFilter, query, now])

      const periodLabel = useMemo(() => {
        const y = anchor.getFullYear()
        const m = anchor.getMonth() + 1
        if (view === 'week') {
          const week = Math.ceil(((anchor - new Date(y, 0, 1)) / 86400000 + new Date(y, 0, 1).getDay() + 1) / 7)
          return t.weekNo(y, m, week)
        }
        if (view === 'month') return t.monthLabel(y, m)
        return ''
      }, [view, anchor, t])

      const shift = (dir) => {
        const d = new Date(anchor)
        if (view === 'week') d.setDate(d.getDate() + dir * 7)
        else if (view === 'month') d.setMonth(d.getMonth() + dir)
        setAnchor(d)
      }

      function MeetingCard({ m }) {
        const people = peopleOf(m)
        const st = deriveStatus(m, now)
        return h('article', { className: `mt-card mt-mcard s-${st}`, key: m.id },
          h('div', { className: 'mt-row mt-between' },
            h('div', { className: 'mt-row', style: { minWidth: 0 } },
              h('button', {
                className: 'mt-star' + (m.is_pinned ? ' on' : ''), title: m.is_pinned ? t.starOff : t.starOn,
                onClick: () => togglePin(m),
              }, m.is_pinned ? '★' : '☆'),
              h('button', { className: 'mt-btn ghost', style: { fontWeight: 700, fontSize: 14, padding: '2px 6px' }, onClick: () => onDetail(m) }, m.title),
              m.is_pinned ? h('span', { className: 'mt-pill amber' }, '⭐ ', t.pinnedBadge) : null,
            ),
            h('div', { className: 'mt-row' },
              StatusPill({ status: st, t }),
              MinutesPill({ value: m.minutes_status || 'none', t }),
            ),
          ),
          // v0.2.4 精致排版：日期徽标（mt-when b）+ 等宽时间段 + 地点/参会人分列（超长省略）
          h('div', { className: 'mt-metarow' },
            h('span', { className: 'mt-when' }, '◷ ', h('b', null, fmtDay(m.start_time)), ' ', fmtTime(m.start_time), ' ~ ', fmtTime(m.end_time)),
            m.location ? h('span', { className: 'mt-where' }, '📍 ', m.location) : null,
            people.length
              ? h('span', { className: 'mt-who' }, '👥 ',
                  `${people.slice(0, 3).join('、')}${people.length > 3 ? ` ${t.etc} ${people.length} ${lang === 'en' ? 'people' : '人'}` : ''}`)
              : null,
          ),
          h('div', { className: 'mt-row' },
            (Array.isArray(m.tags) ? m.tags : []).map((tag) => h('span', { className: 'mt-chip', key: tag }, '# ', tag)),
            h('span', { className: 'mt-chip' }, '📅 ', t.agendaFromMeeting, ' ', (m.agenda || []).length),
            h('span', { style: { flex: 1 } }),
            h('button', { className: 'mt-btn small', onClick: () => onDetail(m) }, t.detail),
            h('button', { className: 'mt-btn small', onClick: () => gotoMinutes(m.id) }, t.gotoMinutes),
            h('button', { className: 'mt-btn small', onClick: () => gotoAsk(m) }, t.gotoAsk),
          ),
        )
      }

      function dayMeetings(date) {
        return filtered.filter((m) => {
          const s = new Date(m.start_time || '')
          return Number.isFinite(s.getTime()) && sameDay(s, date)
        })
      }

      function WeekView() {
        const start = startOfWeek(anchor)
        const days = [...Array(7)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d })
        const today = new Date()
        const wd = lang === 'en' ? WEEKDAYS_EN : WEEKDAYS_ZH
        return h('div', null,
          h('div', { className: 'mt-cal' }, days.map((d) => h('div', { className: 'mt-calhead' + (sameDay(d, today) ? ' mt-cell today' : ''), key: d.toISOString() }, wd[(d.getDay() + 6) % 7], ' ', pad2(d.getDate()), sameDay(d, today) ? (lang === 'en' ? ' (today)' : '（今日）') : ''))),
          h('div', { className: 'mt-cal', style: { marginTop: 4 } }, days.map((d) => {
            const list = dayMeetings(d)
            return h('div', { className: 'mt-cell' + (sameDay(d, today) ? ' today' : ''), key: d.toISOString() },
              list.length
                ? list.map((m) => h('button', { className: 'mt-ev' + (m.is_pinned ? ' pinned' : ''), key: m.id, onClick: () => onDetail(m) }, (m.is_pinned ? '★ ' : '') + `${fmtTime(m.start_time)} ${m.title}`))
                : h('div', { className: 'mt-evmore' }, t.noMeetings),
            )
          })),
        )
      }

      function MonthView() {
        const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
        const start = startOfWeek(first)
        const today = new Date()
        const cells = [...Array(42)].map((_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d })
        return h('div', null,
          h('div', { className: 'mt-cal' }, (lang === 'en' ? WEEKDAYS_EN : WEEKDAYS_ZH).map((w) => h('div', { className: 'mt-calhead', key: w }, w))),
          h('div', { className: 'mt-cal', style: { marginTop: 4 } }, cells.map((d) => {
            const list = dayMeetings(d)
            const inMonth = d.getMonth() === anchor.getMonth()
            return h('div', { className: 'mt-cell' + (sameDay(d, today) ? ' today' : '') + (inMonth ? '' : ' dim'), key: d.toISOString() },
              h('div', { className: 'mt-daynum' }, d.getDate(), sameDay(d, today) ? (lang === 'en' ? ' •' : ' 今') : ''),
              list.slice(0, 3).map((m) => h('button', { className: 'mt-ev' + (m.is_pinned ? ' pinned' : ''), key: m.id, onClick: () => onDetail(m) }, (m.is_pinned ? '★ ' : '') + m.title)),
              list.length > 3 ? h('div', { className: 'mt-evmore' }, t.more(list.length - 3)) : null,
              list.length
                ? h('div', { className: 'mt-pop' },
                    h('div', { className: 'mt-muted', style: { marginBottom: 5 } }, `${d.getMonth() + 1}-${pad2(d.getDate())} · ${list.length}`),
                    list.map((m) => h('button', { className: 'mt-ev', key: m.id, onClick: () => onDetail(m) }, `${fmtTime(m.start_time)} ${m.title}`)),
                  )
                : null,
            )
          })),
        )
      }

      return h('div', null,
        h('div', { className: 'mt-toolbar' },
          h('div', { className: 'mt-seg', role: 'tablist' },
            [['list', t.viewList], ['week', t.viewWeek], ['month', t.viewMonth]].map(([v, label]) =>
              h('button', { key: v, 'aria-pressed': view === v, onClick: () => setView(v) }, label),
            ),
          ),
          view !== 'list' ? h('button', { className: 'mt-btn small', onClick: () => setAnchor(new Date()) }, t.today) : null,
          view !== 'list' ? h('button', { className: 'mt-btn small', onClick: () => shift(-1) }, '‹') : null,
          view !== 'list' ? h('button', { className: 'mt-btn small', onClick: () => shift(1) }, '›') : null,
          periodLabel ? h('span', { className: 'mt-secondary', style: { fontWeight: 650 } }, periodLabel) : null,
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'mt-toggle', 'aria-pressed': pinnedOnly, onClick: () => setPinnedOnly(!pinnedOnly) }, '★ ', t.pinnedOnly),
          h('select', { className: 'mt-select', value: statusFilter, onChange: (e) => setStatusFilter(e.target.value) },
            [['all', t.allStatus], ['upcoming', t.upcoming], ['in_progress', t.inProgress], ['completed', t.completed]].map(([v, label]) =>
              h('option', { key: v, value: v }, label),
            ),
          ),
          h('input', { className: 'mt-input', style: { width: 210 }, value: query, placeholder: t.searchPlaceholder, onChange: (e) => setQuery(e.target.value) }),
          h('button', { className: 'mt-btn primary', onClick: onNew }, '＋ ', t.newMeeting),
        ),
        view === 'list' && h('div', { className: 'mt-stack' },
          filtered.length === 0
            ? h('div', { className: 'mt-empty' }, h('div', { style: { fontWeight: 700, marginBottom: 4 } }, t.emptySchedule), h('div', { className: 'mt-muted' }, t.emptyScheduleHint))
            : filtered.map((m) => h(MeetingCard, { m, key: m.id })),
        ),
        view === 'week' && WeekView(),
        view === 'month' && MonthView(),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 详情弹窗                                                           */
    /* ---------------------------------------------------------------- */

    function DetailModal({ t, meeting, onClose, gotoMinutes, gotoAsk }) {
      const [docs, setDocs] = useState([])
      useEffect(() => {
        let alive = true
        request(`/docs?meeting_id=${encodeURIComponent(meeting.id)}`)
          .then((d) => { if (alive) setDocs(d.docs || []) })
          .catch(() => {})
        return () => { alive = false }
      }, [meeting.id])
      const people = peopleOf(meeting)
      return h(Modal, { title: meeting.title, onClose },
        h('div', { className: 'mt-row', style: { marginBottom: 10 } },
          StatusPill({ status: deriveStatus(meeting), t }),
          MinutesPill({ value: meeting.minutes_status || 'none', t }),
          meeting.is_pinned ? h('span', { className: 'mt-pill amber' }, '⭐ ', t.pinnedBadge) : null,
        ),
        h('div', { className: 'mt-grid2', style: { marginBottom: 10 } },
          h('div', { className: 'mt-muted' }, '◷ ', fmtRange(meeting)),
          h('div', { className: 'mt-muted' }, '📍 ', meeting.location || t.none, meeting.meeting_link ? ` · 🔗 ${meeting.meeting_link}` : ''),
        ),
        people.length ? h('div', { className: 'mt-row', style: { marginBottom: 10 } }, people.map((p) => h('span', { className: 'mt-chip', key: p }, '👥 ', p))) : null,
        h('div', { style: { marginBottom: 10 } },
          h('div', { className: 'mt-h3' }, '📅 ', t.agendaFromMeeting),
          (meeting.agenda || []).length
            ? meeting.agenda.map((row, i) =>
                h('div', { className: 'mt-agendaline', key: i },
                  h('span', { className: 'mt-time' }, row.time_range || '--'),
                  h('span', { className: 'mt-grow' }, row.topic, row.objective ? h('div', { className: 'mt-muted' }, row.objective) : null),
                  row.speaker ? h('span', { className: 'mt-chip' }, row.speaker) : null,
                ),
              )
            : h('div', { className: 'mt-muted' }, t.noAgenda),
        ),
        h('div', { style: { marginBottom: 14 } },
          h('div', { className: 'mt-h3' }, '📎 ', t.materialTitle),
          docs.length
            ? docs.map((d) => h('div', { className: 'mt-file', key: d.file_id },
                h('span', { className: 'name' }, d.name),
                h('span', { className: 'mt-muted' }, fmtBytes(d.size)),
                d.has_text ? h('span', { className: 'mt-pill green' }, t.materialTextReady) : h('span', { className: 'mt-pill gray' }, t.materialQueued),
              ))
            : h('div', { className: 'mt-muted' }, t.none),
        ),
        h('div', { className: 'mt-row', style: { justifyContent: 'flex-end' } },
          h('button', { className: 'mt-btn', onClick: onClose }, t.close),
          h('button', { className: 'mt-btn', onClick: () => gotoMinutes(meeting.id) }, t.gotoMinutes),
          h('button', { className: 'mt-btn primary', onClick: () => gotoAsk(meeting) }, t.gotoAsk),
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 视图二：新建会议                                                    */
    /* ---------------------------------------------------------------- */

    function CreateView({ t, onCreated, showToast, refreshMeetings }) {
      const [form, setForm] = useState(() => ({
        title: '', start: localInput(new Date(Date.now() + 3600000)), end: localInput(new Date(Date.now() + 7200000)),
        type: 'offline', location: '', meeting_link: '', participants: '', tags: '', is_pinned: false,
      }))
      const [agenda, setAgenda] = useState([])
      const [materials, setMaterials] = useState([])
      const [busy, setBusy] = useState(false)
      const [agendaBusy, setAgendaBusy] = useState(false)
      const fileRef = useRef(null)
      const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
      const locLabel = form.type === 'online' ? t.locOnline : form.type === 'offline' ? t.locOffline : t.locHybrid

      async function genAgenda() {
        if (!form.title.trim()) return showToast(t.needTitle, 'warn')
        setAgendaBusy(true)
        try {
          const data = await request('/agenda', json({
            title: form.title.trim(),
            duration_minutes: String(Math.max(15, Math.round((Date.parse(form.end) - Date.parse(form.start)) / 60000)) || 60),
            participants: form.participants,
            start_time: form.start,
          }))
          if (!data.agenda || !data.agenda.length) showToast(t.aiAgendaEmpty, 'warn')
          else { setAgenda(data.agenda); showToast(t.aiAgendaDone, 'success') }
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setAgendaBusy(false)
        }
      }

      function pickFiles(e) {
        const files = [...(e.target.files || [])]
        e.target.value = ''
        for (const f of files) {
          if (f.size > 10 * 1024 * 1024) { showToast(`${f.name}: ${t.materialTooBig}`, 'error'); continue }
          const isText = /\.(txt|md|markdown)$/i.test(f.name)
          if (isText) {
            const reader = new FileReader()
            reader.onload = () => setMaterials((list) => [...list, { name: f.name, size: f.size, text: String(reader.result || '') }])
            reader.onerror = () => setMaterials((list) => [...list, { name: f.name, size: f.size, text: '' }])
            reader.readAsText(f)
          } else {
            setMaterials((list) => [...list, { name: f.name, size: f.size, text: '' }])
          }
        }
      }

      async function submit() {
        if (!form.title.trim()) return showToast(t.needTitle, 'warn')
        const startIso = new Date(form.start).toISOString()
        const endIso = new Date(form.end).toISOString()
        if (!form.start || !form.end || Date.parse(endIso) <= Date.parse(startIso)) return showToast(t.needTime, 'warn')
        setBusy(true)
        try {
          const data = await request('/meetings', json({
            title: form.title.trim(),
            start_time: startIso,
            end_time: endIso,
            type: form.type,
            location: form.location.trim(),
            meeting_link: form.meeting_link.trim(),
            is_pinned: form.is_pinned,
            participants: form.participants.split(/[,，、]/).map((x) => x.trim()).filter(Boolean),
            tags: form.tags.split(/[,，、]/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean),
            agenda: agenda.filter((row) => row.topic || row.time_range),
          }))
          const meetingId = data.meeting && data.meeting.id
          for (const mat of materials) {
            await request('/docs', json({ name: mat.name, size: mat.size, meeting_id: meetingId, text: mat.text || '' })).catch(() => {})
          }
          setForm((f) => ({ ...f, title: '', location: '', meeting_link: '', participants: '', tags: '', is_pinned: false }))
          setAgenda([])
          setMaterials([])
          await refreshMeetings()
          showToast(t.created, 'success')
          onCreated()
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      const setRow = (i, k, v) => setAgenda((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))

      return h('div', { className: 'mt-stack', style: { maxWidth: 980 } },
        h('div', { className: 'mt-card mt-row mt-between' },
          h('div', null,
            h('div', { className: 'mt-kicker' }, '✦ AI 智能辅助编排 · AI-assisted orchestration'),
            h('div', { className: 'mt-muted', style: { marginTop: 2 } }, t.fTitle + ' · ' + t.fStart + ' · ' + t.agendaTitle),
          ),
          h('button', { className: 'mt-btn primary', disabled: agendaBusy, onClick: genAgenda }, agendaBusy ? h('span', { className: 'mt-spin' }) : '✦ ', agendaBusy ? t.aiAgendaBusy : t.aiAgenda),
        ),
        h('div', { className: 'mt-card mt-stack' },
          h('h3', { className: 'mt-h3' }, '🗓 ', t.navCreate),
          h('label', { className: 'mt-row', style: { gap: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: form.is_pinned, onChange: (e) => set('is_pinned', e.target.checked) }),
            '⭐ ', t.fPinned,
          ),
          h('div', { className: 'mt-field' }, t.fTitle, h('input', { className: 'mt-input', value: form.title, maxLength: 120, placeholder: lang0(t), onChange: (e) => set('title', e.target.value) })),
          h('div', { className: 'mt-grid2' },
            h('div', { className: 'mt-field' }, t.fStart, h('input', { className: 'mt-input', type: 'datetime-local', value: form.start, onChange: (e) => set('start', e.target.value) })),
            h('div', { className: 'mt-field' }, t.fEnd, h('input', { className: 'mt-input', type: 'datetime-local', value: form.end, onChange: (e) => set('end', e.target.value) })),
          ),
          h('div', { className: 'mt-grid2' },
            h('div', { className: 'mt-field' }, t.fType,
              h('select', { className: 'mt-input', value: form.type, onChange: (e) => set('type', e.target.value) },
                [['offline', t.typeOffline], ['online', t.typeOnline], ['hybrid', t.typeHybrid]].map(([v, label]) => h('option', { key: v, value: v }, label)),
              ),
            ),
            h('div', { className: 'mt-field' }, locLabel, h('input', { className: 'mt-input', value: form.location, onChange: (e) => set('location', e.target.value) })),
          ),
          h('div', { className: 'mt-grid2' },
            h('div', { className: 'mt-field' }, t.fParticipants, h('input', { className: 'mt-input', value: form.participants, placeholder: '张三, 李四, 王五', onChange: (e) => set('participants', e.target.value) })),
            h('div', { className: 'mt-field' }, t.fTags, h('input', { className: 'mt-input', value: form.tags, placeholder: '#战略决策, Q4', onChange: (e) => set('tags', e.target.value) })),
          ),
          h('div', { className: 'mt-field' }, t.meetingLink, h('input', { className: 'mt-input', value: form.meeting_link, onChange: (e) => set('meeting_link', e.target.value) })),
        ),
        h('div', { className: 'mt-card mt-stack' },
          h('h3', { className: 'mt-h3' }, '📋 ', t.agendaTitle),
          agenda.map((row, i) =>
            h('div', { className: 'mt-grid3', key: i },
              h('input', { className: 'mt-input', value: row.time_range || '', placeholder: t.agendaTime + '（14:30 - 15:00）', onChange: (e) => setRow(i, 'time_range', e.target.value) }),
              h('input', { className: 'mt-input', value: row.topic || '', placeholder: t.agendaTopic, onChange: (e) => setRow(i, 'topic', e.target.value) }),
              h('input', { className: 'mt-input', value: row.speaker || '', placeholder: t.agendaSpeaker, onChange: (e) => setRow(i, 'speaker', e.target.value) }),
              h('button', { className: 'mt-btn small danger', onClick: () => setAgenda((rows) => rows.filter((_, j) => j !== i)) }, '✕'),
            ),
          ),
          h('div', null,
            h('button', { className: 'mt-btn small', onClick: () => setAgenda((rows) => [...rows, { time_range: '', topic: '', speaker: '', objective: '' }]) }, '＋ ', t.addAgenda),
          ),
        ),
        h('div', { className: 'mt-card mt-stack' },
          h('h3', { className: 'mt-h3' }, '📎 ', t.materialTitle),
          h('div', { className: 'mt-drop', onClick: () => fileRef.current && fileRef.current.click() }, t.materialHint),
          h('input', { ref: fileRef, type: 'file', multiple: true, style: { display: 'none' }, onChange: pickFiles }),
          materials.length
            ? materials.map((mat, i) =>
                h('div', { className: 'mt-file', key: `${mat.name}-${i}` },
                  h('span', { className: 'name' }, '📄 ', mat.name),
                  h('span', { className: 'mt-muted' }, fmtBytes(mat.size)),
                  mat.text ? h('span', { className: 'mt-pill green' }, t.materialTextReady) : h('span', { className: 'mt-pill gray' }, t.materialQueued),
                  h('button', { className: 'mt-btn ghost small danger', onClick: () => setMaterials((list) => list.filter((_, j) => j !== i)) }, '✕'),
                ),
              )
            : null,
          h('div', { className: 'mt-row', style: { justifyContent: 'flex-end' } },
            h('button', { className: 'mt-btn primary', disabled: busy, onClick: submit }, busy ? h('span', { className: 'mt-spin' }) : null, t.submitCreate),
          ),
        ),
      )
    }
    const lang0 = (t) => (t.fTitle === '会议主题' ? '例如：Q4 算力扩容专项评审会' : 'e.g. Q4 compute expansion review')

    /* ---------------------------------------------------------------- */
    /* 视图三：会议纪要（实时录音 / 上传录音 / 粘贴文本 三来源）              */
    /* ---------------------------------------------------------------- */

    function MinutesView({ t, lang, meetings, showToast, seed, refreshMeetings }) {
      const [targetId, setTargetId] = useState(seed && seed.meetingId ? seed.meetingId : '')
      const [minutes, setMinutes] = useState(null)
      const [transcript, setTranscript] = useState('')
      const [template, setTemplate] = useState('weekly')
      const [busy, setBusy] = useState(false)
      const [draft, setDraft] = useState(null) // null = 跟随服务端；否则为本地编辑缓冲
      const txtRef = useRef(null)
      const impRef = useRef(null)

      // —— 转写来源三模式：live 实时录音 / upload 上传录音 / paste 粘贴文本 ——
      const [srcMode, setSrcMode] = useState('live')
      // live 实时录音态
      const [recording, setRecording] = useState(false)
      const [elapsed, setElapsed] = useState(0) // 已录秒数
      const [liveText, setLiveText] = useState('') // 已定稿文本（[HH:mm:ss] 逐行）
      const [interim, setInterim] = useState('') // 中间结果（灰色斜体）
      const [audioUrl, setAudioUrl] = useState('') // 录音回放 blob URL
      const [liveBusy, setLiveBusy] = useState(false) // 结束后自动生成中
      const [liveStarting, setLiveStarting] = useState(false)
      const [liveStage, setLiveStage] = useState('')
      const [captionStatus, setCaptionStatus] = useState('')
      const liveRoundRef = useRef(null)
      const liveMountedRef = useRef(true)
      // upload 上传录音态
      const [uploadRec, setUploadRec] = useState(null)
      const [upProgress, setUpProgress] = useState(-1) // -1 = 未在上传中；0-100 上传进度
      const [upTranscript, setUpTranscript] = useState('')
      const [upBusy, setUpBusy] = useState(false)
       const [upStage, setUpStage] = useState('')
      const [upSaving, setUpSaving] = useState(false)
      const [playingRec, setPlayingRec] = useState(false)
      const dropRef = useRef(null)
      const upTxtRef = useRef(null)
      const upAudioRef = useRef(null)
      // 录音/识别运行时句柄（不参与渲染；均为浏览器对象，仅在事件回调内触达）
      const recRef = useRef(null) // MediaRecorder
      const streamRef = useRef(null) // MediaStream
      const chunksRef = useRef([]) // 音频分片
      const srRef = useRef(null) // SpeechRecognition（实时录音）
      const upSrRef = useRef(null) // SpeechRecognition（播放转写）
      const liveFinalRef = useRef('') // 已定稿文本累积（避免闭包旧值）
      const firstSeenRef = useRef(null) // 各转写段首次到达时刻（Map）
      const timerRef = useRef(null) // 计时器句柄
      const stoppedRef = useRef(true) // 是否已主动停止（onend 判断是否自动重启）
      const playingRef = useRef(false) // 「播放并实时转写」进行中
      const upXhrRef = useRef(null) // 上传 XHR 句柄

      // 能力探测（typeof 守卫：Node stub / 不支持的浏览器下为 null）
      const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null
      const MR = typeof window !== 'undefined' ? window.MediaRecorder : null
      const liveSupported = Boolean(MR && typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext)

      const nowStamp = () => {
        const d = new Date()
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
      }
      const mmss = (s) => `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`

      const loadMinutes = useCallback(async (meetingId) => {
        setMinutes(null)
        setDraft(null)
        if (!meetingId) return
        try {
          const data = await request(`/minutes/meeting/${encodeURIComponent(meetingId)}`)
          setMinutes(data.minutes || null)
        } catch {
          setMinutes(null)
        }
      }, [])

      useEffect(() => {
        if (seed && seed.nonce) setTargetId(seed.meetingId || '')
      }, [seed && seed.nonce])
      useEffect(() => {
        loadMinutes(targetId)
      }, [targetId, loadMinutes])

      // 卸载清理：停计时 / 停识别 / 停录音 / 释放麦克风 / 中止上传
      useEffect(() => {
        liveMountedRef.current = true
        return () => {
          liveMountedRef.current = false
          const round = liveRoundRef.current
          if (round) {
            round.cancelled = true
            round.controller.abort()
            clearTimeout(round.timer); clearTimeout(round.captionTimer)
            if (round.url) URL.revokeObjectURL(round.url)
            round.endCaption?.('unmounted')
          }
          stoppedRef.current = true
          playingRef.current = false
          try { if (timerRef.current) window.clearTimeout(timerRef.current) } catch { /* ignore */ }
          try { if (srRef.current) { srRef.current.onresult = srRef.current.onerror = srRef.current.onend = null; srRef.current.abort() } } catch { /* ignore */ }
          try { if (upSrRef.current) { upSrRef.current.onend = null; upSrRef.current.stop() } } catch { /* ignore */ }
          try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop() } catch { /* ignore */ }
          try { if (streamRef.current) streamRef.current.getTracks().forEach((tr) => tr.stop()) } catch { /* ignore */ }
          try { if (upXhrRef.current) upXhrRef.current.abort() } catch { /* ignore */ }
        }
      }, [])

      const content = draft !== null ? draft : minutes ? minutes.content : ''
      const meeting = meetings.find((m) => m.id === targetId)
      const statusValue = minutes && minutes.is_archived ? 'archived' : meeting ? meeting.minutes_status || 'none' : 'none'

      /* —— 模式 C：粘贴文本（沿用原 generate：需绑定会议，保持旧行为） —— */
      async function generate() {
        if (!targetId) return showToast(t.pickMeeting, 'warn')
        if (!transcript.trim()) return showToast(t.transcriptLabel, 'warn')
        setBusy(true)
        try {
          const data = await request('/generate-text', json({ meeting_id: targetId, transcript, template_type: template }))
          setMinutes(data.minutes)
          setDraft(null)
          setTranscript('')
          showToast(t.generated, 'success')
          refreshMeetings()
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      async function saveContent(source) {
        if (!minutes) return
        setBusy(true)
        try {
          const body = { content, action_items: minutes.action_items }
          if (source) body.source = source
          const data = await request(`/minutes/${encodeURIComponent(minutes.minutes_id)}`, put(body))
          setMinutes(data.minutes)
          setDraft(null)
          showToast(source === 'import' ? t.imported : t.saved, 'success')
          refreshMeetings()
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      async function archive() {
        if (!minutes) return
        setBusy(true)
        try {
          if (draft !== null) await request(`/minutes/${encodeURIComponent(minutes.minutes_id)}`, put({ content, source: 'edit' }))
          const data = await request(`/minutes/${encodeURIComponent(minutes.minutes_id)}/archive`, { method: 'POST' })
          setMinutes(data.minutes)
          setDraft(null)
          showToast(t.archivedToast(data.minutes.archive_fingerprint || ''), 'success')
          refreshMeetings()
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      function importFile(e, mode) {
        const file = (e.target.files || [])[0]
        e.target.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onload = async () => {
          const text = String(reader.result || '')
          if (mode === 'transcript') setTranscript(text)
          else if (minutes) {
            setDraft(text)
            try {
              const data = await request(`/minutes/${encodeURIComponent(minutes.minutes_id)}`, put({ content: text, source: 'import', action_items: minutes.action_items }))
              setMinutes(data.minutes)
              setDraft(null)
              showToast(t.imported, 'success')
              refreshMeetings()
            } catch (err) {
              showToast(`${t.requestFailed}: ${err.message}`, 'error')
            }
          }
        }
        reader.readAsText(file)
      }

      async function toggleTodo(item) {
        if (!minutes) return
        const next = minutes.action_items.map((a) => (a.task_id === item.task_id ? { ...a, completed: !a.completed } : a))
        setMinutes({ ...minutes, action_items: next })
        try {
          const data = await request(`/minutes/${encodeURIComponent(minutes.minutes_id)}`, put({ action_items: next }))
          setMinutes(data.minutes)
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        }
      }

      function copyAll() {
        navigator.clipboard.writeText(content).then(() => showToast(t.copied, 'success')).catch(() => {})
      }

      /* —— 模式 A：浏览器字幕仅预览；最终纪要必须依据完整音频的本地阿昆ASR —— */
      const liveActive = (round) => liveMountedRef.current && liveRoundRef.current === round && !round.cancelled
      function stopLive() {
        const round = liveRoundRef.current
        if (!round) return Promise.resolve(null)
        if (!round.stopped && !round.cancelled) {
          round.endCaption?.('stopped')
          if (liveActive(round)) setCaptionStatus('实时字幕已停止；保留音频供本地全文转写。')
        }
        round.stopped = true
        stoppedRef.current = true
        clearTimeout(round.timer)
        clearTimeout(round.captionTimer)
        if (round.speech) {
          round.speech.onresult = round.speech.onerror = round.speech.onend = null
          try { round.speech.abort() } catch { /* ignore */ }
        }
        if (liveActive(round)) { setInterim(''); setRecording(false) }
        if (round.recorder && round.recorder.state !== 'inactive') {
          try { round.recorder.stop() } catch (error) { round.resolve(null) }
        } else if (!round.recorder) round.resolve(null)
        return round.done
      }

      async function startLive() {
        const previous = liveRoundRef.current
        if (!liveSupported || liveBusy || (previous && (!previous.stopped || previous.processing) && !previous.cancelled)) return
        const round = { chunks: [], bytes: 0, cancelled: false, stopped: false, processing: false, controller: new AbortController(), meetingId: targetId, template, captionRetries: 0 }
        round.done = new Promise((resolve) => { round.resolve = resolve })
        liveRoundRef.current = round
        // 有效点击为起点；首次里程碑独立保留，最近事件有界且不含语音正文。
        const clock = typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now()
        const started = clock()
        const captionTiming = { startedAt: Date.now(), events: [], first: {}, attempt: 0, reconnects: 0, state: 'start-clicked' }
        window.__meetaiCaptionTiming = captionTiming
        const markCaption = (stage, error = '', terminal = false) => {
          if (liveRoundRef.current !== round || (!terminal && (!liveActive(round) || round.stopped || captionTiming.terminal))) return
          if (terminal) captionTiming.terminal = stage
          const elapsedMs = Math.max(0, clock() - started)
          if (!(stage in captionTiming.first)) captionTiming.first[stage] = elapsedMs
          captionTiming.state = stage
          captionTiming.events.push({ stage, elapsedMs, attempt: captionTiming.attempt, ...(error ? { error } : {}) })
          if (captionTiming.events.length > 80) captionTiming.events.shift()
        }
        round.markCaption = markCaption
        round.endCaption = (stage) => markCaption(stage, '', true)
        markCaption('start-clicked')
        stoppedRef.current = false
        liveFinalRef.current = ''
        setLiveStarting(true)
        setLiveText('')
        setInterim('')
        setElapsed(0)
        setLiveStage('正在请求麦克风权限…')
        setCaptionStatus('实时字幕仅作预览；停止后由本地阿昆全文识别。')
        if (audioUrl) { try { URL.revokeObjectURL(audioUrl) } catch { /* ignore */ } setAudioUrl('') }
        try {
          markCaption('permission-requested')
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          if (!liveActive(round) || round.stopped) { stream.getTracks().forEach((track) => track.stop()); round.resolve(null); return }
          markCaption('permission-granted')
          round.stream = stream
          streamRef.current = stream
          let opts
          for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
            if (typeof MR.isTypeSupported === 'function' && MR.isTypeSupported(mime)) { opts = { mimeType: mime }; break }
          }
          const mr = new MR(stream, opts)
          round.recorder = mr
          recRef.current = mr
          mr.ondataavailable = (event) => {
            if (round.cancelled || !event.data || !event.data.size) return
            if (round.bytes + event.data.size > 500 * 1024 * 1024) { cancelLive(); showToast(t.recTooBig, 'error'); return }
            round.chunks.push(event.data)
            round.bytes += event.data.size
          }
          mr.onstop = () => {
            stream.getTracks().forEach((track) => track.stop())
            if (round.cancelled) { round.resolve(null); return }
            try {
              const blob = new Blob(round.chunks, { type: (mr.mimeType || 'audio/webm').split(';')[0] })
              round.blob = blob
              if (liveActive(round)) {
                round.url = URL.createObjectURL(blob)
                setAudioUrl(round.url)
                setRecording(false)
              }
              round.resolve(blob)
            } catch (error) { round.resolve(null) }
          }
          mr.onerror = () => { if (liveActive(round)) { stopLive(); showToast('录音设备异常，已停止；可用保留音频重试。', 'error') } }
          stream.getAudioTracks().forEach((track) => { track.onended = () => {
            if (liveActive(round) && !round.stopped) { stopLive(); showToast('麦克风已中断，录音已停止，请检查设备。', 'warn') }
          } })
          mr.start(1000)
          markCaption('recording-start')
          setRecording(true)
          setLiveStage('')
          if (SR) {
            try {
              const speech = new SR()
              round.speech = speech
              srRef.current = speech
              speech.continuous = true
              speech.interimResults = true
              speech.lang = 'zh-CN'
              const requestCaption = () => {
                captionTiming.attempt++
                captionTiming.reconnects = captionTiming.attempt - 1
                markCaption('start-requested')
                setCaptionStatus('已请求浏览器字幕服务，等待启动；可能依赖浏览器语音服务，停止后由本地阿昆全文复核。')
                speech.start()
              }
              speech.onstart = () => { markCaption('service-start'); if (liveActive(round) && !round.stopped) setCaptionStatus('字幕识别服务已启动，等待语音结果；完整音频正在录制。') }
              speech.onaudiostart = () => markCaption('audio-start')
              speech.onspeechstart = () => markCaption('speech-start')
              speech.onspeechend = () => markCaption('speech-end')
              let seen = new Map()
              let finals = new Set()
              speech.onresult = (event) => {
                if (!liveActive(round) || round.stopped) return
                markCaption('result')
                let hasText = false
                let pending = ''
                for (let i = event.resultIndex; i < event.results.length; i++) {
                  const result = event.results[i]
                  if (!seen.has(i)) seen.set(i, nowStamp())
                  const text = String((result[0] && result[0].transcript) || '').trim()
                  if (text) hasText = true
                  if (result.isFinal && text && !finals.has(i)) {
                    finals.add(i)
                    liveFinalRef.current += (liveFinalRef.current ? '\n' : '') + `[${seen.get(i)}] ${text}`
                    setLiveText(liveFinalRef.current)
                  } else if (!result.isFinal) pending += text
                }
                if (hasText) {
                  markCaption('text-result')
                  setCaptionStatus('已收到浏览器实时字幕；仅作预览，停止后由本地阿昆全文复核。')
                }
                setInterim(pending)
              }
              speech.onerror = (event) => {
                if (!liveActive(round) || round.stopped) return
                const errorCode = ['no-speech', 'aborted', 'audio-capture', 'network', 'not-allowed', 'service-not-allowed', 'bad-grammar', 'language-not-supported', 'phrases-not-supported'].includes(event.error) ? event.error : 'unknown'
                markCaption('error', errorCode)
                if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(errorCode)) round.captionDisabled = true
                else if (errorCode !== 'no-speech' && errorCode !== 'aborted') round.captionRetries++
                if (round.captionDisabled || round.captionRetries >= 3) round.captionDisabled = true
                setCaptionStatus(`实时字幕暂不可用（${errorCode}），录音继续，停止后仍可本地全文转写。`)
              }
              speech.onend = () => {
                if (!liveActive(round) || round.stopped) return
                const errorState = captionTiming.state
                markCaption('service-end')
                if (round.captionDisabled) { captionTiming.state = errorState; return }
                markCaption('reconnect-wait')
                setCaptionStatus('字幕服务已断开，等待重新连接；录音继续，停止后仍可本地全文转写。')
                round.captionTimer = setTimeout(() => {
                  if (!liveActive(round) || round.stopped) return
                  seen = new Map(); finals = new Set()
                  try { requestCaption() } catch { markCaption('error', 'start-failed'); round.captionDisabled = true; setCaptionStatus('实时字幕启动失败；不影响录音和停止后的本地全文转写。') }
                }, 1000 * Math.min(4, round.captionRetries + 1))
              }
              requestCaption()
            } catch { markCaption('error', 'start-failed'); setCaptionStatus('此浏览器实时字幕不可用；录音继续，停止后使用本地阿昆全文转写。') }
          } else { markCaption('unsupported'); setCaptionStatus('此浏览器不支持实时字幕；录音继续，停止后使用本地阿昆全文转写。') }
          const tick = () => {
            if (!liveActive(round) || round.stopped) return
            setElapsed((seconds) => seconds + 1)
            round.timer = window.setTimeout(tick, 1000)
          }
          round.timer = window.setTimeout(tick, 1000)
        } catch (error) {
          if (round.stream) round.stream.getTracks().forEach((track) => track.stop())
          round.resolve(null)
          if (liveActive(round)) {
            const detail = error.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在站点设置中允许。' : error.name === 'NotFoundError' ? '未找到麦克风设备。' : error.name === 'NotReadableError' ? '麦克风被占用或无法读取。' : error.message || '无法启动录音'
            showToast(detail, 'error')
            setRecording(false)
            setLiveStage('')
            round.cancelled = true
          }
        } finally { if (liveMountedRef.current && liveRoundRef.current === round) setLiveStarting(false) }
      }

      async function finishLive() {
        const round = liveRoundRef.current
        if (!round || round.cancelled || round.processing || liveStarting) return
        round.processing = true
        setLiveBusy(true)
        async function liveRequest(route, options, cleanup = false) {
          const ac = new AbortController()
          const cancel = () => ac.abort()
          if (!cleanup) {
            if (round.controller.signal.aborted) cancel()
            else round.controller.signal.addEventListener('abort', cancel, { once: true })
          }
          const timeout = cleanup ? 15000 : route.includes('/transcribe') ? 31 * 60000 : route === '/generate-text' ? 10 * 60000 : 90000
          const timer = setTimeout(cancel, timeout)
          try {
            const response = await fetch(API + route, { credentials: 'same-origin', ...options, signal: ac.signal })
            let data
            try { data = await response.json() } catch { data = null }
            if (!response.ok || !data || data.error) {
              const error = new Error((data && (data.reason || data.error)) || `HTTP ${response.status}`)
              error.status = response.status
              throw error
            }
            return data
          } finally { clearTimeout(timer); round.controller.signal.removeEventListener('abort', cancel) }
        }
        try {
          setLiveStage('正在停止录音并保存最后音频…')
          const blob = await stopLive()
          if (!liveActive(round)) return
          if (!blob || !blob.size) throw new Error('没有收到有效录音；请检查麦克风后重录。')
          if (!round.recording) {
            const type = blob.type || 'audio/webm'
            const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm'
            const file = new File([blob], `meeting-${Date.now()}.${ext}`, { type })
            round.recording = await uploadInChunks(file, {
              signal: round.controller.signal, meetingId: round.meetingId,
              create: async (meta) => (await liveRequest('/recording-uploads', json(meta))).upload,
              put: async (id, seq, bytes, sha) => (await liveRequest(`/recording-uploads/${id}/chunks/${seq}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha }, body: bytes })).ack,
              commit: async (id) => (await liveRequest(`/recording-uploads/${id}/commit`, { method: 'POST' })).recording,
              abort: (id) => liveRequest(`/recording-uploads/${id}`, { method: 'DELETE' }, true),
              onProgress: (percent, stage) => { if (liveActive(round)) setLiveStage(stage === 'commit' ? '正在校验并封存完整录音…' : `正在上传完整录音（服务器已确认${percent}%）…`) },
            })
          }
          if (!liveActive(round)) return
          if (!round.transcript) {
            setLiveStage('阿昆正在本地识别完整录音…')
            const asr = await liveRequest(`/recordings/${encodeURIComponent(round.recording.recording_id)}/transcribe?force=1`, { method: 'POST' })
            round.transcript = String(asr.transcript || '').trim()
            if (!round.transcript) throw new Error('阿昆未识别到有效语音，未生成纪要。')
          }
          if (!liveActive(round)) return
          setLiveText(round.transcript)
          setCaptionStatus('以下为阿昆本地完整录音转写，已替换浏览器预览字幕。')
          setLiveStage('正在根据阿昆全文生成会议纪要…')
          const body = { transcript: round.transcript, template_type: round.template, source: 'live-record', recording_id: round.recording.recording_id }
          if (round.meetingId) body.meeting_id = round.meetingId
          const data = await liveRequest('/generate-text', json(body))
          if (!liveActive(round)) return
          setMinutes(data.minutes)
          setDraft(null)
          showToast(t.generated, 'success')
          refreshMeetings()
        } catch (error) { if (liveActive(round)) showToast(`${t.requestFailed}: ${error.message || '处理失败，录音已保留，可重试。'}`, 'error') }
        finally { round.processing = false; if (liveActive(round)) { setLiveBusy(false); setLiveStage('') } }
      }

      function cancelLive() {
        const round = liveRoundRef.current
        if (round) {
          round.endCaption?.('cancelled')
          round.cancelled = true
          round.controller.abort()
          stopLive()
          if (round.stream) round.stream.getTracks().forEach((track) => track.stop())
          if (round.url) URL.revokeObjectURL(round.url)
          liveRoundRef.current = null
        }
        liveFinalRef.current = ''
        if (liveMountedRef.current) {
          setRecording(false); setLiveStarting(false); setLiveBusy(false)
          setLiveText(''); setInterim(''); setElapsed(0); setLiveStage(''); setCaptionStatus(''); setAudioUrl('')
        }
      }

      /* —— 模式 B：小分片+服务端ACK进度，避免隧道大请求及假100% —— */
      async function uploadFile(file) {
        if (!file || upBusy || upSaving) return
        if (!file.size) return showToast('录音文件为空', 'error')
        if (file.size > 500 * 1024 * 1024) return showToast(t.recTooBig, 'error')
        if (!globalThis.crypto || !crypto.subtle) return showToast('请在HTTPS安全页面上传录音', 'error')
        if (upXhrRef.current) upXhrRef.current.abort()
        const controller = new AbortController()
        upXhrRef.current = controller
        setUploadRec(null)
        setUpTranscript('')
        setUpStage('正在分片上传并等待服务器确认…')
        setUpProgress(0)
        async function uploadRequest(route, options, cleanup = false) {
          const requestController = new AbortController()
          const cancel = () => requestController.abort()
          if (!cleanup) {
            if (controller.signal.aborted) cancel()
            else controller.signal.addEventListener('abort', cancel, { once: true })
          }
          const timer = setTimeout(cancel, cleanup ? 15000 : 90000)
          try {
            const response = await fetch(API + route, { credentials: 'same-origin', ...options, signal: requestController.signal })
            let data
            try { data = await response.json() } catch { data = null }
            if (!response.ok || !data || data.error) {
              const error = new Error((data && (data.reason || data.error)) || `HTTP ${response.status}`)
              error.status = response.status
              throw error
            }
            return data
          } finally {
            clearTimeout(timer)
            controller.signal.removeEventListener('abort', cancel)
          }
        }
        try {
          const recording = await uploadInChunks(file, {
            signal: controller.signal,
            meetingId: targetId || '',
            create: async (meta) => (await uploadRequest('/recording-uploads', json(meta))).upload,
            put: async (id, seq, bytes, sha) => (await uploadRequest(`/recording-uploads/${encodeURIComponent(id)}/chunks/${seq}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha }, body: bytes })).ack,
            commit: async (id) => (await uploadRequest(`/recording-uploads/${encodeURIComponent(id)}/commit`, { method: 'POST' })).recording,
            abort: (id) => uploadRequest(`/recording-uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }, true),
            onProgress: (percent, stage) => {
              if (upXhrRef.current !== controller) return
              setUpProgress(percent)
              setUpStage(stage === 'commit' ? '正在校验完整录音并确认保存…' : '已确认分片上传，继续传输…')
            },
          })
          if (controller.signal.aborted || upXhrRef.current !== controller) return
          setUploadRec(recording)
          setUpTranscript(recording.transcript || '')
          showToast(t.uploadDone, 'success')
        } catch (error) {
          if (!controller.signal.aborted && upXhrRef.current === controller) showToast(`${t.requestFailed}: ${error.message || '分片上传失败'}`, 'error')
        } finally {
          if (upXhrRef.current === controller) {
            upXhrRef.current = null
            setUpProgress(-1)
            setUpStage('')
          }
        }
      }

      function onPickAudio(e) {
        const file = (e.target.files || [])[0]
        e.target.value = ''
        uploadFile(file)
      }

      function onDropAudio(e) {
        e.preventDefault()
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
        uploadFile(file)
      }

      // 元数据加载后回写录音时长（失败静默）
      function saveRecDuration() {
        try {
          const el = upAudioRef.current
          if (!el || !uploadRec || !Number.isFinite(el.duration) || !el.duration) return
          const secs = Math.round(el.duration)
          if (!secs) return
          request(`/recordings/${encodeURIComponent(uploadRec.recording_id)}`, patch({ duration_seconds: secs }))
            .then((data) => { if (data && data.recording) setUploadRec(data.recording) })
            .catch(() => {})
        } catch { /* 静默 */ }
      }

      function importUpTxt(e) {
        const file = (e.target.files || [])[0]
        e.target.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => setUpTranscript(String(reader.result || ''))
        reader.readAsText(file)
      }

      async function saveUpTranscript() {
        if (!uploadRec || !upTranscript.trim()) return
        setUpSaving(true)
        try {
          const data = await request(`/recordings/${encodeURIComponent(uploadRec.recording_id)}`, patch({ transcript: upTranscript }))
          if (data && data.recording) setUploadRec(data.recording)
          showToast(t.savedTranscript, 'success')
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setUpSaving(false)
        }
      }

      // 「播放并实时转写」（实验性）：外放音频 + 麦克风收音识别，最终文本并入 textarea
      function playAndTranscribe() {
        if (!uploadRec || !SR || playingRef.current) return
        playingRef.current = true
        setPlayingRec(true)
        try {
          const rec = new SR()
          rec.continuous = true
          rec.interimResults = true
          rec.lang = lang === 'en' ? 'en-US' : 'zh-CN'
          rec.onresult = (ev) => {
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
              const r = ev.results[i]
              if (r.isFinal) {
                const seg = String((r[0] && r[0].transcript) || '').trim()
                if (seg) setUpTranscript((txt) => (txt ? `${txt}\n` : '') + seg)
              }
            }
          }
          rec.onerror = () => { /* 忽略识别错误 */ }
          rec.onend = () => { if (playingRef.current) { try { rec.start() } catch { /* ignore */ } } }
          rec.start()
          upSrRef.current = rec
        } catch { showToast(t.playTranscribeHint, 'warn') }
        try {
          const el = upAudioRef.current
          if (el) { el.currentTime = 0; el.play() }
        } catch { /* ignore */ }
      }

      function stopPlayTranscribe() {
        playingRef.current = false
        setPlayingRec(false)
        try { if (upSrRef.current) { upSrRef.current.onend = null; upSrRef.current.stop(); upSrRef.current = null } } catch { /* ignore */ }
        try { const el = upAudioRef.current; if (el) el.pause() } catch { /* ignore */ }
      }

      async function generateUpload() {
        if (!uploadRec || upBusy || upProgress >= 0) return
        setUpBusy(true)
        try {
          let finalTranscript = upTranscript.trim()
          if (!finalTranscript) {
            setUpStage('阿昆正在转写上传的录音，请稍候…')
            const recognized = await request(`/recordings/${encodeURIComponent(uploadRec.recording_id)}/transcribe`, { method: 'POST' })
            finalTranscript = String(recognized.transcript || '').trim()
            if (!finalTranscript) throw new Error('阿昆未识别到可用语音；未生成会议纪要')
            setUpTranscript(finalTranscript)
            if (recognized.recording) setUploadRec(recognized.recording)
          } else {
            setUpStage('正在保存转写文本…')
            await request(`/recordings/${encodeURIComponent(uploadRec.recording_id)}`, patch({ transcript: finalTranscript }))
          }
          setUpStage('正在根据完整转写生成会议纪要…')
          const body = { transcript: finalTranscript, template_type: template, recording_id: uploadRec.recording_id, source: 'upload' }
          if (targetId) body.meeting_id = targetId
          const data = await request('/generate-text', json(body))
          setMinutes(data.minutes)
          setDraft(null)
          showToast(t.generated, 'success')
          refreshMeetings()
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setUpStage('')
          setUpBusy(false)
        }
      }

      // 切换来源模式：录音中切走则丢弃录音；播放转写中切走则停止
      function switchSrc(mode) {
        if (srcMode === 'live' && mode !== 'live' && liveRoundRef.current) cancelLive()
        if (srcMode === 'upload' && mode !== 'upload' && playingRec) stopPlayTranscribe()
        setSrcMode(mode)
      }

      const sourceLabel = { ai: t.sourceAi, edit: t.sourceEdit, import: t.sourceImport, 'live-record': t.sourceLive, upload: t.sourceUpload }

      const liveBlobType = liveRoundRef.current && liveRoundRef.current.blob ? liveRoundRef.current.blob.type : 'audio/webm'
      const liveDownloadExt = liveBlobType.includes('mp4') ? 'm4a' : liveBlobType.includes('ogg') ? 'ogg' : liveBlobType.includes('wav') ? 'wav' : 'webm'
      const recFileName = `meetai-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${liveDownloadExt}`

      const livePanel = h('div', { className: 'mt-stack' },
        !liveSupported ? h('div', { className: 'mt-notice' }, '需要安全HTTPS页面、麦克风权限和MediaRecorder；建议使用Edge/Chrome。') : null,
        captionStatus ? h('div', { className: 'mt-notice', role: 'status' }, captionStatus) : null,
        liveStage ? h('div', { className: 'mt-row', role: 'status' }, h('span', { className: 'mt-spin' }), ' ', liveStage) : null,
        recording
          ? h('div', { className: 'mt-stack' },
              h('div', { className: 'mt-row' }, h('span', { className: 'mt-recdot', 'aria-hidden': true }), h('span', { className: 'mt-time' }, mmss(elapsed)), h('span', { className: 'mt-pill red' }, t.recLive)),
              h('div', { className: 'mt-livewrap' },
                liveText ? liveText.split('\n').map((line, i) => h('div', { className: 'mt-liveline', key: i }, line)) : null,
                interim ? h('div', { className: 'mt-liveline interim' }, interim) : null,
                !liveText && !interim ? h('div', { className: 'mt-muted' }, t.recHint) : null),
              h('div', { className: 'mt-row' }, h('button', { className: 'mt-btn success', disabled: liveBusy, onClick: finishLive }, '⏹ ', t.finishAndGenerate), h('button', { className: 'mt-btn', onClick: cancelLive }, t.cancelRec)))
          : h('div', { className: 'mt-stack' },
              h('div', { className: 'mt-row' }, h('button', { className: 'mt-btn primary', disabled: !liveSupported || liveBusy || liveStarting, onClick: startLive }, '🎙 ', t.startRec),
                liveStarting || liveBusy ? h('button', { className: 'mt-btn', onClick: cancelLive }, t.cancelRec) : null),
              audioUrl ? h('div', { className: 'mt-stack' },
                h('audio', { controls: true, src: audioUrl, style: { width: '100%' } }),
                h('div', { className: 'mt-row' }, h('a', { className: 'mt-btn small', href: audioUrl, download: recFileName }, '⬇ ', t.downloadRec),
                  h('button', { className: 'mt-btn primary', disabled: liveBusy || liveStarting, onClick: finishLive }, '重试全文识别 / 生成纪要')),
                liveText ? h('div', { className: 'mt-livewrap' }, liveText.split('\n').map((line, i) => h('div', { className: 'mt-liveline', key: i }, line))) : null) : null),
      )

      // —— 面板 B：上传录音 ——
      const uploadPanel = h('div', { className: 'mt-stack' },
        h('div', {
          className: 'mt-drop',
          onClick: () => dropRef.current && dropRef.current.click(),
          onDragOver: (e) => e.preventDefault(),
          onDrop: onDropAudio,
        }, '🎧 ', t.uploadHint),
        h('input', { ref: dropRef, type: 'file', accept: 'audio/*,.mp3,.m4a,.wav,.aac,.ogg,.webm,.amr,.flac', style: { display: 'none' }, onChange: onPickAudio }),
        upProgress >= 0
          ? h('div', { className: 'mt-stack', style: { gap: 4 } },
              h('div', { className: 'mt-row mt-between' }, h('span', { className: 'mt-muted' }, upStage || t.uploadProgress), h('span', { className: 'mt-muted' }, `${upProgress}%`)),
              h('div', { className: 'mt-progress' }, h('i', { style: { width: `${upProgress}%` } })),
            )
          : null,
        uploadRec
          ? h('div', { className: 'mt-recfile' },
              h('div', { className: 'mt-row mt-between' },
                h('span', { className: 'name' }, '🎵 ', uploadRec.filename),
                h('span', { className: 'mt-muted' }, fmtBytes(uploadRec.size_bytes || 0)),
              ),
              h('audio', {
                ref: upAudioRef, controls: true,
                src: `${API}/recordings/${encodeURIComponent(uploadRec.recording_id)}/file`,
                style: { width: '100%' }, onLoadedMetadata: saveRecDuration, onEnded: stopPlayTranscribe,
              }),
              playingRec ? h('div', { className: 'mt-row' }, h('span', { className: 'mt-recdot' }), h('span', { className: 'mt-muted' }, t.playTranscribe)) : null,
            )
          : null,
        h('textarea', { className: 'mt-textarea', style: { minHeight: 110 }, value: upTranscript, placeholder: '[14:30:00] 张总：本季度预算……', onChange: (e) => setUpTranscript(e.target.value) }),
        h('div', { className: 'mt-row' },
          h('button', { className: 'mt-btn small', disabled: !uploadRec || !upTranscript.trim() || upSaving, onClick: saveUpTranscript }, '💾 ', t.saveTranscript),
          h('button', { className: 'mt-btn small', onClick: () => upTxtRef.current && upTxtRef.current.click() }, t.importTxtSrt),
          h('input', { ref: upTxtRef, type: 'file', accept: '.txt,.srt', style: { display: 'none' }, onChange: importUpTxt }),
          h('button', { className: 'mt-btn small', disabled: !uploadRec || !SR || playingRec, title: t.playTranscribeHint, onClick: playAndTranscribe }, '▶ ', t.playTranscribe),
          playingRec ? h('button', { className: 'mt-btn small', onClick: stopPlayTranscribe }, '⏹ ', t.stopPlayTranscribe) : null,
        ),
        h('div', { className: 'mt-muted' }, 'ℹ️ ', t.playTranscribeHint),
      )

      // —— 面板 C：粘贴文本（保持旧行为） ——
      const pastePanel = h('div', { className: 'mt-stack' },
        h('div', { className: 'mt-row mt-between' },
          h('span', { className: 'mt-muted' }, t.transcriptLabel),
          h('button', { className: 'mt-btn small', onClick: () => txtRef.current && txtRef.current.click() }, t.importTxt),
        ),
        h('textarea', { className: 'mt-textarea', style: { minHeight: 150 }, value: transcript, placeholder: '[14:30:00] 张总：本季度预算……', onChange: (e) => setTranscript(e.target.value) }),
        h('input', { ref: txtRef, type: 'file', accept: '.txt,.md,.srt', style: { display: 'none' }, onChange: (e) => importFile(e, 'transcript') }),
      )

      return h('div', { className: 'mt-stack' },
        h('div', { className: 'mt-card mt-row mt-between' },
          h('div', { className: 'mt-row' },
            '🔗 ', h('strong', null, t.bindMeeting),
            h('select', {
              className: 'mt-select', value: targetId,
              disabled: recording || liveStarting || liveBusy || upBusy || upProgress >= 0,
              onChange: (e) => { if (liveRoundRef.current) cancelLive(); setUploadRec(null); setUpTranscript(''); setTargetId(e.target.value) },
            },
              h('option', { value: '' }, meetings.length ? t.pickMeeting : t.noMeetingsForMinutes),
              meetings.map((m) => h('option', { key: m.id, value: m.id }, `${m.title}（${fmtDay(m.start_time)}）`)),
            ),
            MinutesPill({ value: statusValue, t }),
          ),
          h('button', {
            className: 'mt-btn success', disabled: busy || !minutes || (minutes && minutes.is_archived),
            onClick: archive, title: minutes && minutes.is_archived ? t.minutesStatusArchived : '',
          }, '✓ ', t.archiveBtn),
        ),
        // 绑定会议为可选：实时录音/上传录音可独立生成纪要；粘贴文本保持旧行为（需绑定）
        h('div', { className: 'mt-tcard' },
          h('div', { className: 'mt-stack' },
            h('div', { className: 'mt-card mt-stack' },
              h('div', { className: 'mt-seg', role: 'tablist' },
                [['live', '🎙 ', t.srcLive], ['upload', '📁 ', t.srcUpload], ['paste', '⌨️ ', t.srcPaste]].map(([v, icon, label]) =>
                  h('button', { key: v, 'aria-pressed': srcMode === v, onClick: () => switchSrc(v) }, icon, label),
                ),
              ),
              srcMode === 'live' ? livePanel : null,
              srcMode === 'upload' ? uploadPanel : null,
              srcMode === 'paste' ? pastePanel : null,
            ),
            h('div', { className: 'mt-card mt-stack' },
              h('h3', { className: 'mt-h3', style: { margin: 0 } }, '🧩 ', t.templateLabel),
              h('div', { className: 'mt-tplgrid' },
                [['weekly', '周例会', '进展、问题与待办'], ['communication', '项目沟通会', '项目沟通与下一步安排'], ['special', '专题推进会', '专题议题与责任分工']].map(([id, name, sub]) =>
                  h('button', { key: id, className: 'mt-tpl', 'aria-pressed': template === id, onClick: () => setTemplate(id) },
                    h('b', null, name), h('span', null, sub),
                  ),
                ),
              ),
              srcMode === 'live'
                ? h('div', { className: 'mt-muted' }, '✦ ', t.liveAutoHint)
                : srcMode === 'upload'
                  ? h('button', { className: 'mt-btn primary', disabled: upBusy || upProgress >= 0 || !uploadRec, onClick: generateUpload }, upBusy ? h('span', null, h('span', { className: 'mt-spin' }), ' ', upStage || t.generating) : ['✦ ', t.generateBtn])
                  : h('button', { className: 'mt-btn primary', disabled: busy || !transcript.trim(), onClick: generate }, busy ? h('span', { className: 'mt-spin' }) : '✦ ', busy ? t.generating : t.generateBtn),
            ),
          ),
          h('div', { className: 'mt-stack' },
            minutes
              ? h('div', { className: 'mt-card mt-stack' },
                  h('div', { className: 'mt-row mt-between' },
                    h('div', { className: 'mt-row' },
                      h('strong', null, t.contentTitle.split('（')[0]),
                      h('span', { className: 'mt-pill gray' }, t.versionLabel(minutes.version || 1)),
                      h('span', { className: 'mt-pill blue' }, sourceLabel[minutes.source] || t.sourceAi),
                    ),
                    h('div', { className: 'mt-row' },
                      h('button', { className: 'mt-btn small', onClick: copyAll }, t.copyAll),
                      h('button', { className: 'mt-btn small', onClick: () => impRef.current && impRef.current.click() }, t.importFixed),
                      h('input', { ref: impRef, type: 'file', accept: '.txt,.md,.markdown', style: { display: 'none' }, onChange: (e) => importFile(e, 'import') }),
                      h('button', { className: 'mt-btn small primary', disabled: busy || draft === null, onClick: () => saveContent('edit') }, t.saveBtn),
                    ),
                  ),
                  minutes.is_archived && minutes.archive_fingerprint
                    ? h('div', { className: 'mt-stack', style: { gap: 4 } },
                        h('span', { className: 'mt-pill green' }, '🔐 ', t.fingerprintLabel),
                        h('div', { className: 'mt-fp' }, minutes.archive_fingerprint),
                      )
                    : null,
                  h('textarea', { className: 'mt-textarea', style: { minHeight: 260, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12.5 }, value: content, onChange: (e) => setDraft(e.target.value) }),
                  h('div', null,
                    h('div', { className: 'mt-h3' }, '☑ ', t.actionItems),
                    (minutes.action_items || []).length
                      ? minutes.action_items.map((item) =>
                          h('label', { className: 'mt-todo', key: item.task_id },
                            h('input', { type: 'checkbox', checked: item.completed === true, onChange: () => toggleTodo(item) }),
                            h('span', { className: 'mt-grow' + (item.completed ? ' done' : '') }, item.content),
                            item.assignee ? h('span', { className: 'mt-chip' }, '👤 ', item.assignee) : null,
                            item.due_date ? h('span', { className: 'mt-chip' }, '⏱ ', item.due_date) : null,
                          ),
                        )
                      : h('div', { className: 'mt-muted' }, t.noActionItems),
                  ),
                )
              : h('div', { className: 'mt-empty' }, h('div', { style: { fontWeight: 700, marginBottom: 4 } }, t.noMinutes), h('div', { className: 'mt-muted' }, t.noMinutesHint)),
          ),
        ),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 视图四：会议问答                                                    */
    /* ---------------------------------------------------------------- */

    function renderCitations(text, sources, onCite) {
      const parts = String(text || '').split(/(\[引用\d+\]|\[Citation\s*\d+\])/g)
      return parts.map((part, i) => {
        const m = part.match(/^\[引用(\d+)\]$/) || part.match(/^\[Citation\s*(\d+)\]$/i)
        if (!m) return part
        const n = Number(m[1])
        const src = (sources || []).find((s) => s.index === n) || (sources || [])[n - 1]
        return h('button', {
          key: i, className: 'mt-cite', title: src ? `${src.meeting_title || src.label}` : '',
          onClick: () => src && onCite(src),
        }, n)
      })
    }

    function AskView({ t, meetings, showToast, seed, refreshMeetings, sessions, refreshSessions, onActiveSession }) {
      // 会话列表由 MeetingApp 持有（rail「历史对话」标签下展示），此处只读 + 通过 ref 供 seed.loadSession 查找
      const sessionsRef = useRef([])
      const [activeId, setActiveId] = useState('')
      const [scope, setScope] = useState('all')
      const [messages, setMessages] = useState([])
      const [input, setInput] = useState('')
      const [busy, setBusy] = useState(false)
      const [source, setSource] = useState(null)
      // 流式应答态：stream = { text, status, think, tool }（busy 期间渲染接收中的 ai 气泡）
      const [stream, setStream] = useState(null)
      // 附件待发列表（{key,name,size,path?,pending}）；uploading 为在传数量；dragOver 控制拖拽高亮
      const [files, setFiles] = useState([])
      const [uploading, setUploading] = useState(0)
      const [dragOver, setDragOver] = useState(false)
      // 模型目录（GET /models）：state idle|loading|ready|fail；model 为 null = 跟随系统默认
      const [models, setModels] = useState({ state: 'idle', groups: [], def: null })
      const [model, setModel] = useState(null)
      const scrollRef = useRef(null)
      const inputRef = useRef(null)
      const fileRef = useRef(null)
      const seedSeen = useRef(0)
      const fileSeq = useRef(0)
      const dragDepth = useRef(0) // 嵌套 dragenter/leave 计数，避免子元素闪烁
      const abortRef = useRef(null) // 流式请求中止控制器（「■ 停止」按钮）
      const answerRef = useRef('') // 本轮回答的权威累积文本（turn_end 收尾用它，避免 rAF 批次滞后）
      const pendingDelta = useRef('') // rAF 未刷新的 delta 缓冲
      const rafRef = useRef(0)
      // 对话框高度（px）：默认 2 倍 520=1040，可拖拽 520~2200，localStorage 记忆
      const [askH, setAskH] = useState(() => {
        try {
          const v = Number(window.localStorage.getItem('meetai.askH'))
          if (Number.isFinite(v) && v >= 520 && v <= 2200) return Math.round(v)
        } catch { /* localStorage 不可用时用默认值 */ }
        return 1040
      })
      const askHRef = useRef(1040)
      const resizeRef = useRef(null)
      const startResizeRef = useRef(null)
      // 事件回调里要读到的最新值（避免闭包旧 state）：消息 / 会话 id / 附件 / 模型
      const messagesRef = useRef([])
      const activeIdRef = useRef('')
      const filesRef = useRef([])
      const modelRef = useRef(null)

      useEffect(() => { messagesRef.current = messages }, [messages])
      useEffect(() => { activeIdRef.current = activeId }, [activeId])
      useEffect(() => { filesRef.current = files }, [files])
      useEffect(() => { modelRef.current = model }, [model])
      useEffect(() => { sessionsRef.current = Array.isArray(sessions) ? sessions : [] }, [sessions])
      useEffect(() => { askHRef.current = askH }, [askH])
      // 拖拽调高：底部把手 mousedown → 文档级 mousemove/mouseup，松手持久化到 localStorage
      useEffect(() => {
        const clampH = (v) => Math.max(520, Math.min(2200, Math.round(v)))
        function onMove(e) {
          if (!resizeRef.current) return
          const next = clampH(resizeRef.current.startH + (e.clientY - resizeRef.current.startY))
          resizeRef.current.latest = next // 同步记录最新高度（mouseup 时 state/ref 可能尚未刷新）
          setAskH(next)
        }
        function onUp() {
          if (!resizeRef.current) return
          const finalH = typeof resizeRef.current.latest === 'number' ? resizeRef.current.latest : askHRef.current
          resizeRef.current = null
          setAskH(finalH)
          try { document.documentElement.removeAttribute('data-mt-resizing') } catch { /* ignore */ }
          try { window.localStorage.setItem('meetai.askH', String(finalH)) } catch { /* ignore */ }
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
        startResizeRef.current = (e) => {
          e.preventDefault()
          if (resizeRef.current) return
          resizeRef.current = { startY: e.clientY, startH: askHRef.current }
          try { document.documentElement.setAttribute('data-mt-resizing', '1') } catch { /* ignore */ }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }
        return () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
      }, [])
      // 卸载清理：中止进行中的流式请求与未刷新的 rAF 批处理
      useEffect(() => () => {
        try { if (abortRef.current) abortRef.current.abort() } catch { /* ignore */ }
        try { if (rafRef.current && window.cancelAnimationFrame) window.cancelAnimationFrame(rafRef.current) } catch { /* ignore */ }
      }, [])

      // 会话 id 变更统一出口：本地 state + 上报 MeetingApp（rail 高亮当前会话）
      const changeActive = useCallback((id) => {
        setActiveId(id)
        if (onActiveSession) onActiveSession(id)
      }, [onActiveSession])

      // 模型目录：GET /models → optgroup 分组；失败（503 MODEL_UNAVAILABLE 等）→ 选择器降级并提示
      const loadModels = useCallback(async () => {
        setModels((s) => ({ state: 'loading', groups: s.groups || [], def: s.def || null }))
        try {
          const data = await request('/models')
          const groups = (Array.isArray(data.groups) ? data.groups : [])
            .map((g) => ({
              id: String((g && g.id) || ''),
              name: String((g && g.name) || (g && g.id) || ''),
              models: (Array.isArray(g && g.models) ? g.models : [])
                .filter((m) => m && m.id)
                .map((m) => ({ id: String(m.id), name: String(m.name || m.id) })),
            }))
            .filter((g) => g.id && g.models.length)
          const def = data.default && data.default.provider && data.default.model
            ? { provider: String(data.default.provider), model: String(data.default.model) }
            : null
          setModels({ state: 'ready', groups, def })
          // 选中值兜底：当前选择仍在目录内则保留；否则回到「跟随系统默认」
          setModel((cur) => {
            if (!cur) return null
            for (const g of groups) {
              for (const m of g.models) {
                if (g.id === cur.provider && m.id === cur.model) return cur
              }
            }
            return null
          })
        } catch {
          setModels({ state: 'fail', groups: [], def: null })
          setModel(null)
        }
      }, [])
      useEffect(() => { loadModels() }, [loadModels])

      // seed：gotoAsk（scope/question/auto）、「新建对话」（reset）与 rail 历史会话点击（loadSession）共用一个 nonce 通道
      useEffect(() => {
        if (!seed || !seed.nonce || seedSeen.current === seed.nonce) return
        seedSeen.current = seed.nonce
        if (seed.reset) {
          // 全新对话：中止进行中的流式请求并清空全部会话态
          try { if (abortRef.current) abortRef.current.abort() } catch { /* ignore */ }
          answerRef.current = ''
          pendingDelta.current = ''
          changeActive('')
          messagesRef.current = []
          setMessages([])
          setStream(null)
          setInput('')
          setFiles([])
          setSource(null)
          return
        }
        if (seed.loadSession) {
          // rail 历史会话点击：优先用列表自带 messages，缺失则取详情
          const s = sessionsRef.current.find((x) => x.session_id === seed.loadSession) || { session_id: seed.loadSession }
          pickSession(s)
          return
        }
        setScope(seed.scope || 'all')
        if (seed.question) setInput(seed.question)
        if (seed.auto && seed.question) send(seed.question, seed.scope || 'all')
      }, [seed && seed.nonce])

      useEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [messages, busy, stream])

      // 打开会话：rail「历史对话」点击（经 seed.loadSession）或列表项触发
      async function pickSession(s) {
        if (busy) return // 流式接收中禁止切换会话
        let msgs = Array.isArray(s.messages) ? s.messages : null
        if (!msgs) {
          try {
            const d = await request(`/qa-sessions/${encodeURIComponent(s.session_id)}`)
            msgs = d.session && Array.isArray(d.session.messages) ? d.session.messages : []
          } catch {
            msgs = []
          }
        }
        changeActive(s.session_id)
        setScope(s.scope || 'all')
        messagesRef.current = Array.isArray(msgs) ? msgs : []
        setMessages(messagesRef.current)
        setStream(null)
      }

      /* —— 附件：📎 选择 / 整区拖拽 → 逐个 POST /upload?name= 落盘 → chips 展示（随 /qa 提交后清空） —— */

      async function uploadOne(file) {
        if (!file) return
        if (!UPLOAD_RE.test(file.name)) return showToast(`${t.attUnsupported}：${file.name}`, 'error')
        if (file.size > UPLOAD_MAX) return showToast(`${t.attTooBig}：${file.name}`, 'error')
        fileSeq.current += 1
        const key = `f${fileSeq.current}`
        setFiles((list) => [...list, { key, name: file.name, size: file.size, pending: true }])
        setUploading((n) => n + 1)
        try {
          const resp = await fetch(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            credentials: 'same-origin',
            body: file,
          })
          let data = null
          try { data = await resp.json() } catch { /* 非 JSON 错误体 */ }
          if (resp.ok && data && data.ok === true && data.file && data.file.path) {
            setFiles((list) => list.map((x) => (x.key === key ? { ...x, pending: false, name: data.file.name || file.name, size: Number(data.file.size) || file.size, path: data.file.path } : x)))
          } else {
            const reason = (data && data.message) || `HTTP ${resp.status}`
            setFiles((list) => list.filter((x) => x.key !== key))
            showToast(`${t.attUploadFail}：${file.name} — ${reason}`, 'error')
          }
        } catch (e) {
          setFiles((list) => list.filter((x) => x.key !== key))
          showToast(`${t.attUploadFail}：${file.name} — ${e.message}`, 'error')
        } finally {
          setUploading((n) => Math.max(0, n - 1))
        }
      }

      // 顺序上传（避免并发写盘与提示闪烁）；fileList 可为 FileList 或数组
      async function handleFiles(fileList) {
        const arr = []
        for (let i = 0; i < ((fileList && fileList.length) || 0); i++) arr.push(fileList[i])
        for (const f of arr) await uploadOne(f)
      }

      function removeFile(key) {
        setFiles((list) => list.filter((f) => f.key !== key))
      }

      // 拖拽上传：只拦截包含文件的拖拽（dataTransfer.types 含 'Files'），文本/富文本拖放保持默认行为
      const hasFilesInDT = (e) => {
        const dt = e && e.dataTransfer
        if (!dt || !dt.types) return false
        try { return Array.prototype.indexOf.call(dt.types, 'Files') !== -1 } catch { return false }
      }
      const onDragEnter = (e) => {
        if (!hasFilesInDT(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }
      const onDragOver = (e) => {
        if (!hasFilesInDT(e)) return
        e.preventDefault()
        try { e.dataTransfer.dropEffect = 'copy' } catch { /* ignore */ }
      }
      const onDragLeave = (e) => {
        if (!hasFilesInDT(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }
      const onDrop = (e) => {
        if (!hasFilesInDT(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        const fl = e.dataTransfer ? e.dataTransfer.files : null
        if (fl && fl.length) void handleFiles(fl)
      }

      // delta 增量 rAF 批量刷新：先入缓冲，每帧一次性并入气泡文本，降低 setState 频率
      function pushDelta(chunk) {
        pendingDelta.current += chunk
        if (rafRef.current) return
        rafRef.current = window.requestAnimationFrame
          ? window.requestAnimationFrame(flushDelta)
          : window.setTimeout(flushDelta, 16)
      }
      function flushDelta() {
        rafRef.current = 0
        if (!pendingDelta.current) return
        const chunk = pendingDelta.current
        pendingDelta.current = ''
        setStream((s) => (s ? { ...s, text: s.text + chunk } : s))
      }

      /* —— 单一对话框：POST /qa（响应即 SSE）—— status 帧 setSessionId；delta 逐帧追加（rAF 批量）；
       * tool 帧在气泡内显示「🔧 正在调用工具：{name}…」状态行；turn_end 完成（刷新会话列表 +
       * refreshMeetings 日程/统计）；error 帧或网络错误在气泡内显示错误并 toast；
       * busy 时输入框禁用、「发送」变「■ 停止」（AbortController abort）。 —— */

      async function send(questionText, scopeOverride) {
        if (busy) return
        const question = String(questionText !== undefined ? questionText : input || '').trim()
        if (!question) return
        const useScope = scopeOverride || scope
        const attach = filesRef.current.filter((f) => !f.pending).map((f) => ({ name: f.name, path: f.path }))
        const userMsg = { role: 'user', content: question, created_at: new Date().toISOString() }
        const nextMessages = [...messagesRef.current, userMsg]
        messagesRef.current = nextMessages
        setMessages(nextMessages)
        setInput('')
        answerRef.current = ''
        pendingDelta.current = ''
        setStream({ text: '', status: t.thinking, think: '', tool: '' })
        setBusy(true)
        const body = { question, scope: useScope, files: attach }
        if (activeIdRef.current) body.sessionId = activeIdRef.current
        const cur = modelRef.current
        if (cur && cur.provider && cur.model) {
          body.provider = cur.provider
          body.model = cur.model
        }
        const ctrl = new AbortController()
        abortRef.current = ctrl
        let errText = ''
        try {
          const resp = await fetch(API + '/qa', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
            signal: ctrl.signal,
          })
          // 前置错误（非 200，JSON {ok:false,code,message}）→ 直接抛出展示 message
          if (!resp.ok || !resp.body) {
            let reason = `HTTP ${resp.status}`
            try {
              const d = await resp.json()
              if (d && d.message) reason = d.message
            } catch { /* 非 JSON 错误体 */ }
            throw new Error(reason)
          }
          setFiles([]) // 附件已随本次提问提交，清空附件区
          // SSE 帧读取：按 \n\n 切帧 + data: 解析，':' 注释/心跳帧跳过
          const reader = resp.body.getReader()
          const dec = new TextDecoder()
          let buf = ''
          let closed = false
          for (;;) {
            const r = await reader.read()
            if (r.done) break
            buf += dec.decode(r.value, { stream: true })
            let idx
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const raw = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              for (const line of raw.split('\n')) {
                if (line.charCodeAt(0) === 58 /* ':' */) continue // SSE 注释/心跳帧
                if (!line.startsWith('data:')) continue
                let ev = null
                try { ev = JSON.parse(line.slice(5).trim()) } catch { continue }
                if (!ev || typeof ev !== 'object') continue
                if (ev.type === 'status') {
                  if (ev.sessionId) changeActive(ev.sessionId)
                  if (typeof ev.text === 'string' && ev.text) setStream((s) => (s ? { ...s, status: ev.text } : s))
                } else if (ev.type === 'thinking' && typeof ev.text === 'string') {
                  setStream((s) => (s ? { ...s, status: '', think: (s.think ? `${s.think}\n` : '') + ev.text } : s))
                } else if (ev.type === 'delta' && typeof ev.text === 'string') {
                  answerRef.current += ev.text
                  pushDelta(ev.text)
                } else if (ev.type === 'tool' && ev.name) {
                  setStream((s) => (s ? { ...s, tool: String(ev.name) } : s))
                } else if (ev.type === 'turn_end') {
                  // 服务端已把本轮消息落盘；客户端收尾后刷新会话列表与日程/统计
                  if (ev.sessionId) changeActive(ev.sessionId)
                  closed = true
                  break
                } else if (ev.type === 'error') {
                  errText = String(ev.message || t.askFailed)
                  closed = true
                  break
                }
              }
              if (closed) break
            }
            if (closed) break
          }
          try { reader.cancel() } catch { /* 流已结束 */ }
        } catch (e) {
          if (!(e && e.name === 'AbortError')) errText = String((e && e.message) || e)
        } finally {
          abortRef.current = null
          if (rafRef.current && window.cancelAnimationFrame) {
            try { window.cancelAnimationFrame(rafRef.current) } catch { /* ignore */ }
          }
          rafRef.current = 0
          pendingDelta.current = ''
          // 本轮收尾：turn_end → 正常落一条 assistant 消息；error/网络错误 → 气泡内带错误并 toast；
          // 用户主动停止 → 保留已收到的部分文本（若有）
          const text = answerRef.current
          let extra = null
          if (errText) extra = { role: 'assistant', content: text, error: errText, created_at: new Date().toISOString() }
          else if (text.trim()) extra = { role: 'assistant', content: text, created_at: new Date().toISOString() }
          if (extra) {
            const finalMessages = [...messagesRef.current, extra]
            messagesRef.current = finalMessages
            setMessages(finalMessages)
          }
          setStream(null)
          setBusy(false)
          refreshSessions()
          if (!errText && typeof refreshMeetings === 'function') {
            try { refreshMeetings() } catch { /* ignore */ }
          }
        }
        if (errText) showToast(`${t.askFailed}: ${errText}`, 'error')
      }

      function stopStream() {
        try { if (abortRef.current) abortRef.current.abort() } catch { /* ignore */ }
      }

      // 「➕ 新建会议」提示 chip：向输入框插入模板并聚焦（用户补全后发送，服务端建会 → turn_end 后 refreshMeetings 同步日程）
      function insertMeetingTemplate() {
        setInput((cur) => (cur && cur.trim() ? `${cur.replace(/\s*$/, '')}\n\n${MEETING_TEMPLATE}` : MEETING_TEMPLATE))
        try { if (inputRef.current) inputRef.current.focus() } catch { /* ignore */ }
      }

      const presets = useMemo(() => {
        const tomorrow = new Date(Date.now() + 86400000)
        const tomorrowList = meetings.filter((m) => {
          const s = new Date(m.start_time || '')
          return Number.isFinite(s.getTime()) && sameDay(s, tomorrow)
        })
        const archived = meetings.find((m) => m.minutes_status === 'archived')
        return [
          '💡 各场会议有哪些待跟进任务与责任人？',
          tomorrowList.length ? `📅 明天（${fmtDay(tomorrowList[0].start_time)}）有哪些待参加的重点会议？` : '📅 本周还有哪些待开始的重点会议？',
          archived ? `📊 总结《${archived.title}》纪要中的关键决议与预算分配？` : '📊 总结最近会议纪要中的关键决议与预算分配？',
        ]
      }, [meetings])

      const scopeOptions = [
        { value: 'all', label: t.scopeAll(meetings.length) },
        { value: 'docs', label: t.scopeDocs },
        ...meetings.map((m) => ({ value: `meeting:${m.id}`, label: t.scopeMeeting + m.title })),
      ]

      const modelValue = model ? `${model.provider}||${model.model}` : ''

      // 模型选择器：ready → optgroup 分组（首项「跟随系统默认」value=''，default 项 label 加后缀）；
      // fail → 禁用只显示「模型列表不可用」并提供重试；loading → 禁用显示加载中
      function renderModelSelector() {
        if (models.state === 'ready') {
          return h('select', {
            className: 'mt-select', value: modelValue, disabled: busy,
            title: t.modelLabel, 'aria-label': t.modelLabel,
            style: { maxWidth: 280 },
            onChange: (e) => {
              const v = String(e.target.value || '')
              const sep = v.indexOf('||')
              if (!v || sep < 0) { setModel(null); return }
              setModel({ provider: v.slice(0, sep), model: v.slice(sep + 2) })
            },
          },
            h('option', { value: '' }, t.modelDefaultOption),
            models.groups.map((g) => h('optgroup', { key: g.id, label: g.name },
              g.models.map((m) => {
                const val = `${g.id}||${m.id}`
                const isDef = models.def && models.def.provider === g.id && models.def.model === m.id
                return h('option', { key: val, value: val, label: m.name }, m.name + (isDef ? t.modelDefaultSuffix : ''))
              }),
            )),
          )
        }
        if (models.state === 'fail') {
          return [
            h('select', { key: 'mf', className: 'mt-select', disabled: true, title: t.modelFail, 'aria-label': t.modelLabel }, h('option', null, t.modelFail)),
            h('button', { key: 'mr', className: 'mt-btn ghost small', title: t.modelRetry, onClick: loadModels }, '⟳ ', t.modelRetry),
          ]
        }
        return h('select', { className: 'mt-select', disabled: true, title: t.modelLoading, 'aria-label': t.modelLabel }, h('option', null, t.modelLoading))
      }

      return h('div', {
        className: 'mt-askwrap',
        style: { height: askH },
        onDragEnter,
        onDragOver,
        onDragLeave,
        onDrop,
      },
        dragOver ? h('div', { className: 'mt-dropoverlay', 'aria-hidden': true }, '📥 ', t.dropHint) : null,
        // 顶部工具栏：左上角 = 检索范围（全量会议资产 / 仅文档 / 指定会议）
        h('div', { className: 'mt-asktop' },
          h('select', { className: 'mt-select', value: scope, 'aria-label': t.askTitle, onChange: (e) => setScope(e.target.value) },
            scopeOptions.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
          ),
        ),
        h('div', { className: 'mt-askbody' },
          // 对话面板（占满全宽；.mt-msgs flex:1 → 消息区随对话框高度伸缩）
          h('div', { className: 'mt-askpanel' },
            h('div', { className: 'mt-msgs', ref: scrollRef },
              messages.length === 0 && !busy
                ? h('div', { className: 'mt-welcome' },
                    h('div', { style: { fontSize: 26 } }, '🤖'),
                    h('div', { style: { fontWeight: 750, marginTop: 6, fontSize: 15 } }, t.welcomeTitle),
                    h('div', { className: 'mt-muted', style: { marginTop: 4 } }, t.welcomeSub),
                    h('div', { style: { marginTop: 12, display: 'flex', flexWrap: 'wrap', justifyContent: 'center' } },
                      presets.map((q) => h('button', { key: q, className: 'q', onClick: () => send(q) }, q)),
                    ),
                  )
                : null,
              messages.map((msg, i) =>
                h('div', { className: `mt-bubble ${msg.role === 'user' ? 'user' : 'ai'}`, key: i },
                  msg.role === 'assistant'
                    ? h('div', null,
                        renderCitations(msg.content, msg.sources, setSource),
                        msg.error ? h('div', { className: 'mt-errmsg' }, '⚠️ ', msg.error) : null,
                        (msg.sources || []).length
                          ? h('div', { className: 'mt-msgsrc' },
                              h('span', { className: 'mt-muted' }, t.citations),
                              msg.sources.map((s) =>
                                h('button', { key: s.id || s.index, className: 'mt-linkchip', onClick: () => setSource(s) },
                                  `${t.quote} ${s.index}: ${s.meeting_title || s.label || s.id}`,
                                ),
                              ),
                            )
                          : msg.sources
                            ? h('div', { className: 'mt-msgsrc' }, h('span', { className: 'mt-muted' }, t.noCitations))
                            : null,
                        h('div', { className: 'mt-row', style: { marginTop: 6 } },
                          h('button', { className: 'mt-btn ghost small', onClick: () => navigator.clipboard.writeText(msg.content).catch(() => {}) }, t.copyAnswer),
                        ),
                      )
                    : [msg.content,
                        Array.isArray(msg.files) && msg.files.length
                          ? h('div', { className: 'mt-row', style: { marginTop: 6, justifyContent: 'flex-end' } },
                              msg.files.map((f, j) => h('span', { key: j, className: 'mt-attach' }, '📄 ', f.name)))
                          : null],
                ),
              ),
              // 流式接收中的 ai 气泡：状态行 / 思考 / 工具调用状态行 / 逐帧文本
              busy && stream
                ? h('div', { className: 'mt-bubble ai', key: 'streaming' },
                    stream.status ? h('div', { className: 'mt-streamstatus' }, h('span', { className: 'mt-spin', 'aria-hidden': true }), ' ', stream.status) : null,
                    stream.think ? h('div', { className: 'mt-streamthink' }, stream.think) : null,
                    stream.tool ? h('div', { className: 'mt-toolrow' }, '🔧 ', t.toolCalling(stream.tool)) : null,
                    stream.text ? h('div', null, renderCitations(stream.text, [], () => {})) : null,
                  )
                : null,
            ),
            // 附件 chips 区（输入栏上方：文件名 + 大小 + ✕ 移除；上传中显示进度态）
            files.length || uploading
              ? h('div', { className: 'mt-attachrow' },
                  files.map((f) =>
                    h('span', { key: f.key, className: 'mt-attach' + (f.pending ? ' uploading' : ''), title: f.path || f.name },
                      h('span', { className: 'nm' }, '📄 ', f.name),
                      h('span', { className: 'mt-muted' }, fmtBytes(f.size)),
                      f.pending ? h('span', { className: 'mt-spin', 'aria-hidden': true }) : null,
                      h('button', { className: 'rm', title: t.attRemove, 'aria-label': t.attRemove, onClick: () => removeFile(f.key) }, '✕'),
                    ),
                  ),
                  uploading ? h('span', { className: 'mt-muted' }, t.attUploading) : null,
                )
              : null,
            // 底部停靠区（sticky 吸底常驻）：输入框上侧一行 =「➕ 新建会议」提示标签 + 模型选择
            h('div', { className: 'mt-askdock' },
              h('div', { className: 'mt-asksub' },
                h('button', { className: 'mt-hintchip new', title: t.newMeeting, onClick: insertMeetingTemplate }, '➕ ', t.newMeeting),
                h('span', { style: { flex: 1 } }),
                renderModelSelector(),
              ),
              h('div', { className: 'mt-inputbar' },
              // 📎 附件按钮（隐藏 file input 多选 + accept 白名单）
              h('button', {
                className: 'mt-clipbtn', disabled: uploading > 0, title: t.attachTip, 'aria-label': t.attachBtn,
                onClick: () => fileRef.current && fileRef.current.click(),
              }, uploading > 0 ? h('span', { className: 'mt-spin', 'aria-hidden': true }) : '📎'),
              h('textarea', {
                ref: inputRef, value: input, disabled: busy, placeholder: t.inputPlaceholder,
                onChange: (e) => setInput(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } },
              }),
              busy
                ? h('button', { className: 'mt-btn stop', onClick: stopStream }, '■ ', t.stopBtn)
                : h('button', { className: 'mt-btn primary', disabled: !input.trim() || uploading > 0, onClick: () => send() }, '➤ ', t.sendBtn),
            ),
              // 拖拽把手并入停靠区：无论对话框多高都可见可拖（上下拖动 520~2200px，localStorage 记忆）
              h('div', {
                className: 'mt-resizer',
                role: 'separator',
                'aria-orientation': 'horizontal',
                'aria-label': t.resizeHint,
                title: t.resizeHint,
                onMouseDown: (e) => { if (startResizeRef.current) startResizeRef.current(e) },
              }, h('span', { className: 'grip', 'aria-hidden': true })),
            ),
            h('input', {
              ref: fileRef, type: 'file', multiple: true, accept: '.pdf,.docx,.xlsx,.txt,.md',
              style: { display: 'none' },
              onChange: (e) => { const fl = e.target.files; e.target.value = ''; if (fl && fl.length) void handleFiles(fl) },
            }),
            h('div', { className: 'mt-muted', style: { textAlign: 'center' } }, t.enterHint),
          ),
        ),
        source
          ? h(Modal, { title: t.srcTitle, narrow: true, onClose: () => setSource(null) },
              h('div', { className: 'mt-stack' },
                h('div', null, h('div', { className: 'mt-muted' }, t.srcSource), h('strong', null, source.meeting_title || source.label || source.id)),
                source.timestamp ? h('div', null, h('div', { className: 'mt-muted' }, t.srcStamp), h('span', { className: 'mt-chip' }, source.timestamp)) : null,
                h('div', null,
                  h('div', { className: 'mt-muted' }, t.srcText),
                  h('div', { style: { background: 'var(--dsw-alias-state-warn-tertiary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '9px 11px', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12, whiteSpace: 'pre-wrap' } }, source.text || t.none),
                ),
                h('div', { className: 'mt-row', style: { justifyContent: 'flex-end' } },
                  h('button', { className: 'mt-btn primary', onClick: () => setSource(null) }, t.close),
                ),
              ),
            )
          : null,
      )
    }

    /* ---------------------------------------------------------------- */
    /* 应用主体：插件自有导航 rail + 正文（DSH 左侧导航始终保持不变）          */
    /* ---------------------------------------------------------------- */

    function MeetingApp({ ctx }) {
      const [lang, setLang] = useState(() => (ctx.get('locale') && ctx.get('locale').getLocale && ctx.get('locale').getLocale() && ctx.get('locale').getLocale().id === 'en' ? 'en' : 'zh'))
      const t = dict[lang] || dict.zh
      const [tab, setTab] = useState('schedule')
      const [meetings, setMeetings] = useState([])
      const [loading, setLoading] = useState(true)
      const [toasts, setToasts] = useState([])
      const [detail, setDetail] = useState(null)
      const [minutesSeed, setMinutesSeed] = useState(null)
      const [askSeed, setAskSeed] = useState(null)
      // 会议问答父项展开/收起（默认收起；点击父项展开，箭头随时切换）
      const [askOpen, setAskOpen] = useState(false)
      // 问答会话列表：MeetingApp 持有（rail「历史对话」标签下平铺全部会话），AskView 经 props 共享
      const [qaSessions, setQaSessions] = useState([])
      const [qaActiveId, setQaActiveId] = useState('')
      const [docCount, setDocCount] = useState(null) // 已索引文档数（null = 加载失败显示 —）
      const toastSeq = useRef(0)

      const showToast = useCallback((message, type) => {
        const id = ++toastSeq.current
        setToasts((list) => [...list, { id, message, type: type || 'info' }])
        window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 3200)
      }, [])

      useEffect(() => {
        const locale = ctx.get('locale')
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => {
          const cur = locale.getLocale && locale.getLocale()
          setLang(cur && cur.id === 'en' ? 'en' : 'zh')
        })
      }, [ctx])

      const refreshMeetings = useCallback(async () => {
        setLoading(true)
        try {
          const data = await request('/meetings')
          setMeetings(data.meetings || [])
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        } finally {
          setLoading(false)
        }
      }, [t.requestFailed, showToast])
      useEffect(() => { refreshMeetings() }, [refreshMeetings])

      // 问答会话列表：GET /qa-sessions → rail「历史对话」标签下渲染；AskView turn_end 后经 props 刷新
      const refreshQaSessions = useCallback(async () => {
        try {
          const data = await request('/qa-sessions')
          setQaSessions(data.sessions || [])
        } catch {
          /* 列表加载失败静默：rail 显示「暂无」 */
        }
      }, [])
      useEffect(() => { refreshQaSessions() }, [refreshQaSessions])

      // rail 历史会话点击：载入该会话（seed.loadSession → AskView pickSession）
      const openQaSession = useCallback((s) => {
        setTab('ask')
        setAskSeed({ loadSession: s.session_id, nonce: Date.now() })
      }, [])

      // rail 历史会话删除：DELETE 后刷新列表；删的是当前会话则重置回全新对话
      const removeQaSession = useCallback(async (id) => {
        try {
          await request(`/qa-sessions/${encodeURIComponent(id)}`, del())
          setQaSessions((list) => list.filter((x) => x.session_id !== id))
          if (qaActiveId === id) {
            setQaActiveId('')
            setAskSeed({ reset: true, nonce: Date.now() })
          }
          showToast(t.deleteSessionFirst, 'info')
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        }
      }, [qaActiveId, t.deleteSessionFirst, t.requestFailed, showToast])

      // 统计卡：已索引文档数（request('/docs') 取 count，失败显示 —）
      useEffect(() => {
        let alive = true
        request('/docs')
          .then((d) => { if (alive) setDocCount(Array.isArray(d && d.docs) ? d.docs.length : null) })
          .catch(() => { if (alive) setDocCount(null) })
        return () => { alive = false }
      }, [])

      // 需求 2：面板挂载时若 DSH 侧栏处于展开态，则收起一次（仅此一次；
      // 卸载时不展开回去——展开时机收敛到「‹ 返回主页」按钮）
      useEffect(() => {
        try {
          if (typeof document === 'undefined') return
          // 该按钮存在 ⇔ DSH 侧栏当前展开（展开态 aria-label = 收起侧边栏 / Collapse sidebar）
          const expandedBtn = document.querySelector('button[aria-label="收起侧边栏"], button[aria-label="Collapse sidebar"]')
          if (!expandedBtn) return
          const layout = ctx.layout || (ctx.get && ctx.get('layout'))
          if (layout && typeof layout.toggleSidebar === 'function') layout.toggleSidebar()
        } catch {
          /* 收起失败静默，不影响面板渲染 */
        }
      }, [ctx])

      const gotoMinutes = useCallback((meetingId) => {
        setTab('minutes')
        setMinutesSeed({ meetingId, nonce: Date.now() })
      }, [])
      const gotoAsk = useCallback((meeting, autoQuestion) => {
        setTab('ask')
        setAskSeed({
          scope: meeting ? `meeting:${meeting.id}` : 'all',
          question: autoQuestion || (meeting ? t.detailJumpAsk(meeting.title) : ''),
          auto: Boolean(autoQuestion),
          nonce: Date.now(),
        })
      }, [t])

      // 「新建对话」二级项：清空当前会话进入全新对话（activeId=''、messages=[]、欢迎页）
      const startNewChat = useCallback(() => {
        setTab('ask')
        setAskSeed({ reset: true, nonce: Date.now() })
      }, [])

      // 模块级导航桥：cappacks:open-meeting → 'meetai:navigate'（含未挂载时的 pendingNav 补偿）
      const applyNav = useCallback((nav) => {
        const sectionTab = { 会议日程: 'schedule', 会议纪要: 'minutes', 会议问答: 'ask', schedule: 'schedule', minutes: 'minutes', ask: 'ask', create: 'create' }
        const target = sectionTab[nav.tab] || 'schedule'
        setTab(target)
        if (target === 'minutes' && nav.meetingId) setMinutesSeed({ meetingId: nav.meetingId, nonce: Date.now() })
        if (target === 'ask' && (nav.scope || nav.question)) setAskSeed({ scope: nav.scope || 'all', question: nav.question || '', auto: false, nonce: Date.now() })
      }, [])
      useEffect(() => {
        const onNav = (e) => applyNav((e && e.detail) || {})
        if (pendingNav) {
          const nav = pendingNav
          pendingNav = null
          applyNav(nav)
        }
        window.addEventListener(NAV_EV, onNav)
        return () => window.removeEventListener(NAV_EV, onNav)
      }, [applyNav])

      async function togglePin(m) {
        try {
          const data = await request(`/meetings/${encodeURIComponent(m.id)}`, patch({ is_pinned: !m.is_pinned }))
          setMeetings((list) => list.map((x) => (x.id === m.id ? { ...x, is_pinned: data.meeting.is_pinned } : x)).sort((a, b) => Number(b.is_pinned === true) - Number(a.is_pinned === true) || Date.parse(b.start_time || '') - Date.parse(a.start_time || '')))
          showToast(m.is_pinned ? t.starOff : t.starOn, 'success')
        } catch (e) {
          showToast(`${t.requestFailed}: ${e.message}`, 'error')
        }
      }

      const pendingArchive = meetings.filter((m) => m.minutes_status === 'ready').length

      // 统计卡：今日待开会议（今天开始且尚未结束）
      const todayMeetings = useMemo(() => {
        const today = new Date()
        const now = Date.now()
        return meetings.filter((m) => {
          const s = new Date(m.start_time || '')
          return Number.isFinite(s.getTime()) && sameDay(s, today) && deriveStatus(m, now) !== 'completed'
        }).length
      }, [meetings])

      const goBack = () => {
        try {
          const layout = ctx.layout || (ctx.get && ctx.get('layout'))
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null)
          // 需求：返回主页会话时重新展开 DSH 左侧导航栏（与挂载时的自动收起对称）。
          // 展开态 ⇔ 存在 aria-label「收起侧边栏 / Collapse sidebar」按钮；
          // 收起态标记 [data-sidebar-collapsed] 作辅助信号（两者按 OR 宽容判定，宁可多展开）。
          try {
            if (typeof document !== 'undefined') {
              const expandedBtn = document.querySelector('button[aria-label="收起侧边栏"], button[aria-label="Collapse sidebar"]')
              const isCollapsed = !expandedBtn || Boolean(document.querySelector('[data-sidebar-collapsed]'))
              if (isCollapsed && layout && typeof layout.toggleSidebar === 'function') layout.toggleSidebar()
            }
          } catch {
            /* 展开失败不阻塞返回 */
          }
        } catch {
          /* 打开会话区失败不阻塞 */
        }
      }

      // 插件自有导航 rail 项：图标 + 文案 + 徽标（参考 meetai.html 原型）
      const navItems = [
        ['schedule', '📅', t.navSchedule, meetings.length ? h('span', { className: 'mt-railbadge', key: 'b', title: String(meetings.length) }, String(meetings.length)) : null],
        ['create', '🗓️', t.navCreate, h('span', { className: 'mt-railtag', key: 't' }, t.aiAssistTag)],
        ['minutes', '📝', t.navMinutes, pendingArchive ? h('span', { className: 'mt-railbadge amber', key: 'b', title: `${pendingArchive} ${t.pendingArchiveBadge}` }, String(pendingArchive)) : null],
      ]

      return h('div', { className: 'mt-app' },
        h('style', null, CSS),
        // 插件自有导航 rail（配色随 DSH「通用设置 → 外观」主题令牌联动）
        h('aside', { className: 'mt-rail', 'aria-label': t.title },
          h('div', { className: 'mt-brand' },
            h('div', { className: 'mt-brandicon', 'aria-hidden': true }, '✦'),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'mt-brandname' }, 'MeetAI', h('span', { className: 'mt-brandtag' }, t.brandTag)),
              h('div', { className: 'mt-brandsub' }, t.brandSub),
            ),
          ),
          h('nav', { className: 'mt-railnav' },
            h('div', { className: 'mt-railsection' }, t.railSection),
            navItems.map(([id, icon, label, badge]) =>
              h('button', {
                key: id,
                className: 'mt-railitem' + (tab === id ? ' active' : ''),
                'aria-current': tab === id ? 'page' : undefined,
                title: label,
                onClick: () => setTab(id),
              },
                h('span', { className: 'ic' }, h('span', { 'aria-hidden': true }, icon), h('span', { className: 'txt' }, label)),
                badge,
              ),
            ),
            // 会议问答：可展开父项（点击 = 进入对话视图；箭头 = 展开/收起二级导航，默认展开）
            h('button', {
              key: 'ask',
              className: 'mt-railitem' + (tab === 'ask' && !askOpen ? ' active' : ''),
              'aria-current': tab === 'ask' && !askOpen ? 'page' : undefined,
              'aria-expanded': askOpen,
              title: t.navAsk,
              onClick: () => { setTab('ask'); setAskOpen(true) },
            },
              h('span', { className: 'ic' }, h('span', { 'aria-hidden': true }, '💬'), h('span', { className: 'txt' }, t.navAsk)),
              h('span', { className: 'mt-raildot', 'aria-hidden': true }),
              h('span', {
                className: 'mt-railarrow' + (askOpen ? ' open' : ''),
                'aria-hidden': true,
                onClick: (e) => { e.stopPropagation(); setAskOpen((o) => !o) },
              }, '▸'),
            ),
            // 二级子项：「✚ 新建对话」按钮 +「🕘 历史对话」标签（标签下平铺全部历史会话，点击载入 / 悬停删除）
            askOpen ? h('button', {
              key: 'ask-chat',
              className: 'mt-railsub' + (tab === 'ask' && !qaActiveId ? ' active' : ''),
              'aria-current': tab === 'ask' && !qaActiveId ? 'page' : undefined,
              title: t.newChat,
              onClick: startNewChat,
            },
              h('span', { className: 'ic' }, h('span', { 'aria-hidden': true }, '✚'), h('span', { className: 'txt' }, t.newChat)),
            ) : null,
            askOpen ? h('div', { key: 'ask-histlabel', className: 'mt-raillabel' },
              h('span', { 'aria-hidden': true }, '🕘'),
              h('span', null, t.sessions),
              h('span', { className: 'n' }, qaSessions.length ? String(qaSessions.length) : ''),
            ) : null,
            askOpen && qaSessions.length
              ? qaSessions.map((s) => h('div', { key: `qs-${s.session_id}`, className: 'mt-railsessrow' },
                  h('button', {
                    className: 'mt-railsub mt-railsession' + (tab === 'ask' && qaActiveId === s.session_id ? ' active' : ''),
                    'aria-current': tab === 'ask' && qaActiveId === s.session_id ? 'page' : undefined,
                    title: s.title || s.session_id,
                    onClick: () => openQaSession(s),
                  },
                    h('span', { className: 'txt' }, s.title || s.session_id),
                  ),
                  h('button', {
                    className: 'mt-railsessdel',
                    title: t.delSession,
                    'aria-label': `${t.delSession}: ${s.title || s.session_id}`,
                    onClick: (e) => { e.stopPropagation(); removeQaSession(s.session_id) },
                  }, '🗑'),
                ))
              : askOpen ? h('div', { key: 'ask-histempty', className: 'mt-railempty' }, t.noSessions) : null,
            // 统计卡：今日待开会议 / 待归档纪要 / 已索引文档
            h('div', { className: 'mt-railstats' },
              h('div', { className: 'cap' }, '✦ ', t.statTitle, h('span', { className: 'live' }, h('i', { 'aria-hidden': true }), t.statOnline)),
              h('div', { className: 'mt-statrow' }, h('span', null, t.statTodayMeetings), h('b', null, t.unitMeetings(todayMeetings))),
              h('div', { className: 'mt-statrow' }, h('span', null, t.statPendingMinutes), h('b', { className: 'indigo' }, t.unitFiles(pendingArchive))),
              h('div', { className: 'mt-statrow' }, h('span', null, t.statIndexedDocs), h('b', null, docCount === null ? t.none : t.unitDocs(docCount))),
            ),
          ),
          // 底部「‹ 返回主页」（goBack 逻辑保留：selectPanel(null)）
          h('button', { className: 'mt-railback', onClick: goBack, title: t.back }, '‹ ', h('span', { className: 'txt' }, t.back)),
        ),
        h('main', { className: 'mt-body' + (tab === 'ask' ? ' mt-body-ask' : '') },
          loading && !meetings.length && tab !== 'ask' ? h('div', { className: 'mt-muted' }, t.loading) : null,
          tab === 'schedule'
            ? h(ScheduleView, { t, lang, meetings, onDetail: setDetail, onNew: () => setTab('create'), gotoMinutes, gotoAsk: (m) => gotoAsk(m), togglePin })
            : null,
          tab === 'create'
            ? h(CreateView, { t, onCreated: () => setTab('schedule'), showToast, refreshMeetings })
            : null,
          tab === 'minutes'
            ? h(MinutesView, { t, lang, meetings, showToast, seed: minutesSeed, refreshMeetings, key: 'minutes-view' })
            : null,
          tab === 'ask'
            ? h(AskView, { t, meetings, showToast, seed: askSeed, refreshMeetings, sessions: qaSessions, refreshSessions: refreshQaSessions, onActiveSession: setQaActiveId, key: 'ask-view' })
            : null,
        ),
        detail ? h(DetailModal, { t, meeting: detail, onClose: () => setDetail(null), gotoMinutes, gotoAsk: (m) => gotoAsk(m, t.detailJumpAsk(m.title)) }) : null,
        h(Toasts, { toasts }),
      )
    }

    /* ---------------------------------------------------------------- */
    /* 侧栏图标与插件入口                                                   */
    /* ---------------------------------------------------------------- */

    function EntryIcon(props) {
      const p = props || {}
      return h(P.IconAlarmClockOutlineRegular, { size: p.size || 18, 'aria-hidden': true, style: { display: 'block' } })
    }

    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        const cleanups = []
        const locale = ctx.get('locale')
        const label = () => (locale && locale.getLocale && locale.getLocale() && locale.getLocale().id === 'en' ? 'Meeting Assistant' : '会议助手')

        // 主内容区完整应用（无业务 props，闭包传 ctx）
        cleanups.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'cap:meeting' }, () => h(MeetingApp, { ctx })),
          ),
        )
        // 侧栏能力包行（工作台分组下渲染；label 为函数以跟随语言切换）
        cleanups.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: 'cap:meeting', order: 10, label }, EntryIcon),
          ),
        )

        // cappacks:open-meeting 事件桥 → selectPanel('cap:meeting') + 页签切换
        function onOpenMeeting(ev) {
          const detail = (ev && ev.detail) || {}
          const nav = { tab: detail.section || 'schedule', meetingId: detail.meetingId || '' }
          pendingNav = nav
          try {
            window.dispatchEvent(new CustomEvent(NAV_EV, { detail: nav }))
          } catch {
            /* ignore */
          }
          try {
            const layout = ctx.layout || (ctx.get && ctx.get('layout'))
            if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('cap:meeting')
          } catch {
            /* ignore */
          }
        }
        window.addEventListener(OPEN_EV, onOpenMeeting)
        cleanups.push(() => window.removeEventListener(OPEN_EV, onOpenMeeting))

        return () => {
          for (const dispose of cleanups.reverse()) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch {
              /* ignore */
            }
          }
        }
      },
    }
  },
})
