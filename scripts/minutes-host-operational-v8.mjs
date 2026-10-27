import { apply as mount, inject, handleGenerateText, getWordRuntime, ensureMinutesWord, readEditorMinutes, commitEditorMinutes } from '../index-minutes-operational-v8.js?operational-minutes-v6'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { prepareMinutesExecution } from './formal-minutes-models-v8/minutes-execution.mjs'
import { mountLocalCaptions } from './local-captions.mjs'
import { mountWordDocuments } from './word-documents.mjs'
import { mountWordEditor } from './word-editor.mjs'
export { inject }
// Fresh Host generation; the preserved legacy minute route is not a dev.6 acceptance claim.
export function apply(ctx) {
  const dispose = mount(ctx)
  const cleanup = [dispose]
  try {
    cleanup.push(ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      return config.provider === 'ollama' && config.model === 'occamy-1.0-q5:latest'
        ? Object.freeze({ ...config, model: 'huiwen-lm:latest' }) : config
    }))
    cleanup.push(mountLocalCaptions(ctx))
    cleanup.push(mountWordDocuments(ctx, getWordRuntime(ctx), { ensureForMinutes: (id, signal) => ensureMinutesWord(ctx, id, signal) }))
    cleanup.push(mountWordEditor(ctx, { getMinutes: (id, signal) => readEditorMinutes(ctx, id, signal), commitMinutes: (id, options) => commitEditorMinutes(ctx, id, options), getRuntime: () => getWordRuntime(ctx) }))
    cleanup.push(ctx.webServer.register({ kind: 'exact', path: '/api/meeting-assistant/generate-text', async handler(req,res) {
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
    cleanup.push(ctx.webServer.register({kind:'exact',path:'/api/meeting-assistant/local-minutes-status',async handler(req,res) {
      if(req.method!=='GET'){res.writeHead(405);res.end();return}
      const ac=new AbortController(),onClose=()=>ac.abort();res.once('close',onClose);let execution
      try{
        const model=new URL(req.url,'http://127.0.0.1').searchParams.get('model')
        if(!['huiwen-max:latest','huiwen-luna:latest'].includes(model))throw Object.assign(new Error('MODEL_SELECTION_INVALID'),{code:'MODEL_SELECTION_INVALID'})
        execution=await prepareMinutesExecution({provider:'ollama',model},ctx.get('llm'),{hostContext:ctx,admissionHome:process.env.DSH_HOME,signal:ac.signal,sourceSha256:createHash('sha256').update('').digest('hex')})
        await execution.assertCurrent(ac.signal)
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'})
        res.end(JSON.stringify({model,provider:'ollama',operationalReady:true,identity:execution.adapter.identity,policy:execution.plan.admissionPolicy,ownerKind:'native-loopback-service',sdkOwnershipClaimed:false,legacyReleaseAcceptanceClaimed:false,performanceImprovementClaimed:false}))
      }catch(error){if(!res.writableEnded){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:/^[A-Z_]+$/.test(error.code||'')?error.code:'LOCAL_MINUTES_STATUS_FAILED',operationalReady:false,hostCapabilities:{get:typeof ctx.get,effect:typeof ctx.effect,llmPresent:!!ctx.get('llm'),providers:typeof ctx.get('llm')?.listProviders,models:typeof ctx.get('llm')?.listModels}}))}}
      finally{res.removeListener('close',onClose);await execution?.close?.();ac.abort()}
    }}))
    cleanup.push(ctx.webServer.register({kind:'exact',path:'/api/meeting-assistant/release-info', handler(req,res) {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'})
      res.end(JSON.stringify({revision:'operational-minutes-models-v8',status:'operational_minutes_pending_review',formalAcceptanceClaimed:false,admissionPolicy:'local-minutes-operational/1',ownerKind:'native-loopback-service',sdkOwnershipClaimed:false,legacyReleaseAcceptanceClaimed:false,performanceImprovementClaimed:false,supportedLocalMinutesModels:['huiwen-max:latest','huiwen-luna:latest'],features:['word-editor','history-recovery','sentence-captions','restricted-meeting-qa','subtitle-seek','source-grounded-local-minutes'],deferred:['audio-trim','new-transcription-jobs'],preservedGroundedVersion:'grounded-minutes-engine-13-operational-local-3',modelDisplayName:'汇文纪要模型'}))
    }}))
  } catch(error) { for(const fn of cleanup.reverse()) fn?.(); throw error }
  ctx.effect(() => () => { for(const fn of cleanup.splice(0).reverse()) fn?.() })
}
