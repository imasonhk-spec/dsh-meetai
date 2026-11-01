import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { hash } from './source-store.mjs'
import { buildAnalysisView, validateSourceLedger, canonicalJSON, VIEW_VERSION, EVIDENCE_VERSION } from './analysis-view.mjs'
import { renderGroundingReport, assembleGroundedMinutes } from './assembly-final.mjs'
const fail=()=>Object.assign(new Error('原文核验资料不可用或完整性检查失败。'),{code:'GROUNDING_REPORT_UNAVAILABLE',status:422})
async function text(file,limit){
 const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0))
 try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>limit)throw fail();const buffer=Buffer.alloc(stat.size+1);let length=0;for(;;){const result=await handle.read(buffer,length,buffer.length-length,null);length+=result.bytesRead;if(!result.bytesRead)break;if(length>stat.size)throw fail()}return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length))}finally{await handle.close()}
}
export async function loadGroundingBundle({dataRoot,grounding}){
 try{
  if(!path.isAbsolute(dataRoot)||![grounding?.sourceId,grounding?.runId].every(id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)))throw fail()
  const root=path.join(dataRoot,'grounded-minutes'),sourceDir=path.join(root,'sources',grounding.sourceId),runDir=path.join(sourceDir,'runs',grounding.runId)
  for(const directory of [dataRoot,root,path.join(root,'sources'),sourceDir,path.join(sourceDir,'runs'),runDir]){const stat=await lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw fail()}
  const [source,manifestRaw,resultRaw]=await Promise.all([text(path.join(sourceDir,'source.txt'),800000),text(path.join(sourceDir,'manifest.json'),200000),text(path.join(runDir,'result.json'),16*1024*1024)])
  const manifest=JSON.parse(manifestRaw),result=JSON.parse(resultRaw)
  if(hash(JSON.stringify(manifest))!==grounding.sourceId||hash(source)!==manifest.sourceSha256||source.length!==manifest.lengthUtf16||source.length>200000||result.sourceId!==grounding.sourceId||result.runId!==grounding.runId||result.sourceLengthUtf16!==source.length||!Array.isArray(result.coverage))throw fail()
  const validSpan=span=>Number.isSafeInteger(span?.start)&&Number.isSafeInteger(span?.end)&&span.start>=0&&span.end>span.start&&span.end<=source.length&&source.slice(span.start,span.end)===span.quote
  if(result.evidenceVersion===EVIDENCE_VERSION){
   // Rebuild roles/IDs/ranges from immutable source, not the caller's result ledger.
   const view=buildAnalysisView(source,manifest.maxChars),units=new Map(view.units.map(unit=>[unit.id,unit]))
   if(result.viewVersion!==VIEW_VERSION||grounding.viewVersion!==VIEW_VERSION||view.sha256!==result.viewSha256||grounding.viewSha256!==view.sha256||canonicalJSON(result.analysisDefinition)!==canonicalJSON(view.definition))throw fail()
   validateSourceLedger(view,result,source)
   assembleGroundedMinutes(result)
   for(const item of result.coverage){
    const evidence=item.source
    if(evidence.protocol!==EVIDENCE_VERSION||!Array.isArray(evidence.spans)||!evidence.spans.length)throw fail()
    for(const span of evidence.spans){const unit=units.get(span.utteranceId);if(!unit||!validSpan(span)||span.start!==unit.start||span.end!==unit.end)throw fail()}
    if(evidence.quote!==evidence.spans.map(span=>span.quote).join('\n'))throw fail()
   }
   for(const item of result.unresolved)if(!validSpan(item))throw fail()
  }else{
   // Historic contiguous-quote reports remain on the original source-hash path.
   if(result.evidenceVersion!==undefined)throw fail()
   for(const item of result.coverage)if(!validSpan(item.source))throw fail()
  }
  return {sourceId:result.sourceId,runId:result.runId,source,coverage:result.coverage,segmentLedger:result.segmentLedger,unresolved:result.unresolved||[],unresolvedCount:result.unresolvedCount||0,needsReview:true,allUnitsAccountedFor:result.allUnitsAccountedFor===true,includedEvidenceValidated:result.includedEvidenceValidated===true,report:renderGroundingReport(result),sourceProcessingComplete:result.sourceProcessingComplete===true,extractedFactCoverageComplete:result.extractedFactCoverageComplete===true,allImportantFactsProvenExtracted:false,semanticAccuracyVerified:false,crossSegmentContradictionAuditVerified:false}
 }catch{throw fail()}
}
