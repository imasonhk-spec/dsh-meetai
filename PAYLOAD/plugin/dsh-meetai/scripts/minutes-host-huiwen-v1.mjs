import { apply as mount, inject, handleGenerateText, getWordRuntime, ensureMinutesWord, readEditorMinutes, commitEditorMinutes } from '../index-huiwen.js?huiwen-model-name-v1'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { mountLocalCaptions } from './local-captions.mjs'
import { mountWordDocuments } from './word-documents.mjs'
import { mountWordEditor } from './word-editor.mjs'
export { inject }
// Exact generation route is authoritative even if an older prefix route survived reload.
// Cold startup still mounts the original full meeting API; there is only one generation implementation.
export function apply(ctx) {
  const dispose = mount(ctx)
  const cleanup = [dispose]
  try {
    // Registered Host waterfall: replace only the same-weight model ID before
    // prepare/admission. The LOOP records the new call header; old events are
    // never rewritten, and no frozen messages/config are mutated.
    cleanup.push(ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      return config.provider === 'ollama' && config.model === 'occamy-1.0-q5:latest'
        ? Object.freeze({ ...config, model: 'huiwen-lm:latest' }) : config
    }))
    cleanup.push(mountLocalCaptions(ctx))
    cleanup.push(mountWordDocuments(ctx, getWordRuntime(ctx), { ensureForMinutes: (id, signal) => ensureMinutesWord(ctx, id, signal) }))
    cleanup.push(mountWordEditor(ctx, { getMinutes: (id, signal) => readEditorMinutes(ctx, id, signal), commitMinutes: (id, options) => commitEditorMinutes(ctx, id, options), getRuntime: () => getWordRuntime(ctx) }))
    cleanup.push(ctx.webServer.register({ kind:'exact', path:'/api/meeting-assistant/generate-text', async handler(req,res) {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const ac = new AbortController()
      const close = () => ac.abort()
      res.once('close', close)
      try { await handleGenerateText(ctx,req,res,ac.signal) }
      catch (error) {
        if (!res.writableEnded) {
          res.writeHead(500, {'Content-Type':'application/json'})
          res.end(JSON.stringify({error:'INTERNAL',reason:String(error?.message || error)}))
        }
      } finally { res.removeListener('close',close); ac.abort() }
    }}))
    cleanup.push(ctx.webServer.register({kind:'exact',path:'/api/meeting-assistant/minutes-model', async handler(req,res) {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      let config
      try { config=JSON.parse(await readFile(path.join(process.env.DSH_HOME,'meeting-assistant/settings.json'),'utf8')) }
      catch { res.writeHead(503); res.end(JSON.stringify({error:'SETTINGS_UNAVAILABLE'})); return }
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'})
      res.end(JSON.stringify({revision:'huiwen-model-name-v1',modelDisplayName:'Huiwen-LM',modelChineseName:'汇文大模型',underlyingWeightsUnchanged:true,minutesModel:config.minutesModel || null,cloudFallback:!config.minutesModel,generationRoute:'exact'}))
    }}))
  } catch(error) { for(const fn of cleanup.reverse()) fn?.(); throw error }
  ctx.effect(() => () => { for(const fn of cleanup.splice(0).reverse()) fn?.() })
}
