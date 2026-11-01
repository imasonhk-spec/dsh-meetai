export const MAX_BYTES=500*1024*1024, MAX_MS=4*60*60*1000
export function requireValue(ok,code){if(!ok)throw Object.assign(new Error(code),{code})}
export function sourceKey(s){
  const fields=['accountId','meetingId','epoch','sourceId','originId','audioRevision','audioSha256']
  requireValue(s&&fields.every(k=>s[k]!==undefined&&s[k]!==null&&s[k]!=='')&&Number.isSafeInteger(s.epoch)&&s.epoch>=0&&/^[a-f0-9]{64}$/.test(s.audioSha256),'SOURCE_INVALID')
  return JSON.stringify(fields.map(k=>s[k]))
}
export function keepRanges(mode,intervals,durationMs){
  requireValue(Number.isFinite(durationMs)&&durationMs>0&&durationMs<=MAX_MS&&(mode==='keep'||mode==='delete')&&Array.isArray(intervals)&&intervals.length>0&&intervals.length<=256,'BAD_EDL')
  const ranges=intervals.map(r=>{requireValue(Array.isArray(r)&&r.length===2&&r.every(Number.isFinite)&&r[0]>=0&&r[0]<r[1]&&r[1]<=durationMs,'BAD_EDL');return [...r]}).sort((a,b)=>a[0]-b[0])
  for(let i=1;i<ranges.length;i++)requireValue(ranges[i][0]>=ranges[i-1][1],'BAD_EDL')
  if(mode==='keep')return ranges
  const keep=[];let cursor=0;for(const [a,b]of ranges){if(a>cursor)keep.push([cursor,a]);cursor=b}if(cursor<durationMs)keep.push([cursor,durationMs]);requireValue(keep.length,'BAD_EDL');return keep
}
export function validateMapping(m){
  requireValue(m?.version==='root-sample-map-1'&&Number.isSafeInteger(m.sampleRate)&&m.sampleRate>0&&m.sampleRate<=384000&&Number.isSafeInteger(m.rootDurationSamples)&&m.rootDurationSamples>0&&Number.isSafeInteger(m.durationSamples)&&m.durationSamples>0&&m.durationSamples*1000/m.sampleRate<=MAX_MS&&m.rootDurationSamples*1000/m.sampleRate<=MAX_MS&&Array.isArray(m.parts)&&m.parts.length>0&&m.parts.length<=256,'BAD_MAPPING')
  let cursor=0
  for(const p of m.parts){requireValue([p.outputStartSample,p.outputEndSample,p.rootStartSample,p.rootEndSample].every(Number.isSafeInteger)&&p.outputStartSample===cursor&&p.outputEndSample>cursor&&p.rootStartSample>=0&&p.rootEndSample<=m.rootDurationSamples&&p.rootEndSample-p.rootStartSample===p.outputEndSample-p.outputStartSample,'BAD_MAPPING');cursor=p.outputEndSample}
  requireValue(cursor===m.durationSamples,'BAD_MAPPING');return m
}
