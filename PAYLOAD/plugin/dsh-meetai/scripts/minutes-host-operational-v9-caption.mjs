// Admin-scoped deletion release; preserve the operational host and callback verifier.
import {apply as mount,inject} from './minutes-host-operational-v9.mjs'
import {mountLocalModels} from './local-models-v1.mjs'
import {verifyDocumentCallback} from './word-editor.mjs'
import {requireAdminDelete} from './simple-meeting-operations.mjs'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {mountVoiceMeetingControl} from './voice-meeting-control.mjs'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const identity=Object.freeze({version:'0.3.11-voice-meeting.20261022.C003',wordCallbackVerifierSha256:hash(verifyDocumentCallback.toString()),clientSha256:hash(readFileSync(new URL('../client.js',import.meta.url))),hostSha256:hash(readFileSync(new URL('../index-minutes-operational-v9.js',import.meta.url))),scope:'admin-meeting-assistant-owned',preservedHostRevision:'operational-minutes-models-v9',permanentMeetingDeletion:'simple-confirmation-owned-assets',formalAcceptanceClaimed:false,modelInferenceClaimed:false})
export {inject}
export function apply(ctx){
 mount(ctx)
 ctx.effect(()=>mountLocalModels(ctx))
 ctx.effect(()=>mountVoiceMeetingControl(ctx))
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/meeting-assistant/subtitle-release-info',handler(req,res){
  if(req.method!=='GET'){res.writeHead(405);res.end();return}
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(identity))
 }}))
 // Read-only live authentication probe; uses exactly the deletion route gate.
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/meeting-assistant/simple-delete-release-info',async handler(req,res){
  if(req.method!=='GET'){res.writeHead(405);res.end();return}
  try{await requireAdminDelete({ctx,request:req,home:process.env.DSH_HOME});res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({...identity,adminAuthenticated:true}))}
  catch(error){res.writeHead(error.status||500,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:error.code||'AUTH_PROBE_FAILED',adminAuthenticated:false}))}
 }}))
}
