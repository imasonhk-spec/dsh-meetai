// Server-only admin reference transaction. Definitions only; no migration at import.
// Native maintenance and release capabilities are mandatory and currently NOT bootstrapped.
import path from 'node:path'
import { constants } from 'node:fs'
import { open, lstat, realpath, mkdir, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
const HOME = '/home/lgsj/.dsh/multi-user/users/admin/home'
const hash = raw => createHash('sha256').update(raw).digest('hex')
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const stamp = info => [info.dev, info.ino, info.uid, info.nlink, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':')
const FILES = Object.freeze({
  rag: Object.freeze({ relative: 'raganything/config.json', paths: Object.freeze([['llm','model'],['lightrag','index_llm_model'],['custom_models','llm',0,'model']]), old: Object.freeze(['huiwen-lm:latest','huiwen-lm:latest','qwen3.6:35b']), model: 'huiwen-luna:latest' }),
  minutes: Object.freeze({ relative: 'meeting-assistant/settings.json', paths: Object.freeze([['minutesModel','model']]), old: Object.freeze(['huiwen-lm:latest']), model: 'huiwen-max:latest' })
})
function valueAt(value, parts) { for (const key of parts) { need(value !== null && typeof value === 'object' && Object.hasOwn(value,key), 'ADMIN_MIGRATION_FIELD_MISSING'); value=value[key] } return value }
function replaceAt(value, parts, replacement) { const parent=valueAt(value,parts.slice(0,-1)); parent[parts.at(-1)]=replacement }
async function privateRoot(root) {
  const info=await lstat(root)
  need(info.isDirectory() && !info.isSymbolicLink() && info.uid===process.getuid() && (info.mode&0o077)===0 && await realpath(root)===root,'ADMIN_MIGRATION_PRIVATE_ROOT_UNSAFE')
}
async function readStable(file) {
  need(await realpath(file)===file,'ADMIN_MIGRATION_SYMLINK')
  const descriptor=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
    const before=await descriptor.stat({bigint:true})
    need(before.isFile() && before.nlink===1n && before.uid===BigInt(process.getuid()) && (before.mode&0o022n)===0n && before.size<=1048576n,'ADMIN_MIGRATION_FILE_UNSAFE')
    const raw=Buffer.alloc(Number(before.size)+1)
    let size=0
    for(;;){const item=await descriptor.read(raw,size,raw.length-size,size);size+=item.bytesRead;need(size<=Number(before.size),'ADMIN_MIGRATION_FILE_CHANGED');if(!item.bytesRead)break}
    const after=await descriptor.stat({bigint:true}),named=await lstat(file,{bigint:true})
    need(stamp(before)===stamp(after) && stamp(after)===stamp(named) && !named.isSymbolicLink() && await realpath(file)===file,'ADMIN_MIGRATION_FILE_CHANGED')
    return {raw:raw.subarray(0,size),sha256:hash(raw.subarray(0,size)),stamp:stamp(after),mode:Number(after.mode&0o777n)}
  } finally { await descriptor.close() }
}
async function writeNew(file,raw,mode=0o600) {
  const descriptor=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,mode)
  try { await descriptor.writeFile(raw);await descriptor.sync() } finally { await descriptor.close() }
}
async function syncDirectory(directory) { const descriptor=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await descriptor.sync()}finally{await descriptor.close()} }
function changes(snapshot,name) {
  const spec=FILES[name],before=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(snapshot.raw)),after=structuredClone(before)
  for(let index=0;index<spec.paths.length;index++){
    need(valueAt(before,spec.paths[index])===spec.old[index],'ADMIN_MIGRATION_OLD_VALUE_CHANGED')
    replaceAt(after,spec.paths[index],spec.model)
  }
  if(name==='minutes')need(valueAt(before,['minutesModel','provider'])==='ollama','ADMIN_MIGRATION_REMOTE_SELECTION_PRESERVED')
  if(name==='rag'){
    need(valueAt(before,['llm','base_url'])==='http://127.0.0.1:11435/v1' && valueAt(before,['custom_models','llm',0,'base_url'])==='http://127.0.0.1:11435/v1','ADMIN_MIGRATION_REMOTE_SELECTION_PRESERVED')
  }
  // Restore the four permitted fields in a clone and prove every other field identical,
  // including embedding, remote catalogue, credentials and historical settings.
  const restored=structuredClone(after)
  for(let index=0;index<spec.paths.length;index++)replaceAt(restored,spec.paths[index],spec.old[index])
  need(isDeepStrictEqual(before,restored),'ADMIN_MIGRATION_UNRELATED_FIELD_CHANGED')
  return Buffer.from(JSON.stringify(after,null,2)+'\n')
}
/** Native port is a proposed integration dependency, not an existing old-Host service.
 * withFrozenWriters must hold the actual complete config writer set, including inherited-sync writers.
 * assertRelease must attest genuine Luna AND Max release identities/evidence, never request flags.
 * No HTTP route is registered by this module.
 */
export function createAdminModelMigration({home,context,native}={}) {
  need(home===HOME && context?.accountId==='admin' && native?.contract==='admin-model-migration-native/1' && ['assertContext','withFrozenWriters','assertRelease'].every(key=>typeof native[key]==='function'),'ADMIN_MIGRATION_NATIVE_CONTEXT_REQUIRED')
  return Object.freeze({async commit({expectedSha256,signal}={}){
    need(expectedSha256 && Object.keys(expectedSha256).sort().join('|')==='minutes|rag' && ['rag','minutes'].every(key=>/^[a-f0-9]{64}$/.test(expectedSha256[key])),'ADMIN_MIGRATION_BASELINE_REQUIRED')
    signal?.throwIfAborted()
    await native.assertContext(context,{signal})
    // Maintenance failures remain failures, not a fallback into direct unowned file IO.
    return native.withFrozenWriters(context,{domains:['admin-rag-config','admin-minutes-settings','admin-profile-inheritance'],signal},async()=>{
      await native.assertContext(context,{signal})
      need(await native.assertRelease(context,{roles:['luna-text','max-minutes'],phase:'release',signal})===true,'ADMIN_MIGRATION_RELEASE_REQUIRED')
      await privateRoot(HOME)
      for(const name of ['raganything','meeting-assistant'])await privateRoot(path.join(HOME,name))
      const root=path.join(HOME,'meeting-assistant/model-migrations')
      await mkdir(root,{mode:0o700}); // Existing journals require explicit recovery first, never silently reuse.
      await privateRoot(root)
      const transaction=path.join(root,randomUUID())
      await mkdir(transaction,{mode:0o700})
      const state={version:1,transactionId:path.basename(transaction),accountId:'admin',status:'preparing',files:[]}
      const journal=path.join(transaction,'journal.json')
      async function record(){const temp=path.join(transaction,'journal-'+randomUUID()+'.tmp');await writeNew(temp,Buffer.from(JSON.stringify(state,null,2)+'\n'));await rename(temp,journal);await syncDirectory(transaction)}
      const work=[]
      const committed=[]
      let complete=false
      try {
        for(const name of ['rag','minutes']){
          signal?.throwIfAborted()
          const file=path.join(HOME,FILES[name].relative),snapshot=await readStable(file)
          need(snapshot.sha256===expectedSha256[name],'ADMIN_MIGRATION_BASELINE_CHANGED')
          const raw=changes(snapshot,name),backup=path.join(transaction,name+'.before.json'),temp=path.join(path.dirname(file),'.model-migration-'+state.transactionId+'-'+name+'.tmp')
          await writeNew(backup,snapshot.raw)
          work.push({name,file,snapshot,raw,temp})
          state.files.push({name,relativePath:FILES[name].relative,beforeSha256:snapshot.sha256,afterSha256:hash(raw),backupName:path.basename(backup),committed:false})
        }
        state.status='prepared';await record()
        for(const item of work)await writeNew(item.temp,item.raw,item.snapshot.mode)
        for(const item of work){
          signal?.throwIfAborted()
          await native.assertContext(context,{signal})
          need(await native.assertRelease(context,{roles:['luna-text','max-minutes'],phase:'release',signal})===true,'ADMIN_MIGRATION_RELEASE_REQUIRED')
          const current=await readStable(item.file)
          need(current.sha256===item.snapshot.sha256 && current.stamp===item.snapshot.stamp,'ADMIN_MIGRATION_CONCURRENT_WRITE')
          await rename(item.temp,item.file);committed.push(item);await syncDirectory(path.dirname(item.file))
          need((await readStable(item.file)).sha256===hash(item.raw),'ADMIN_MIGRATION_COMMIT_INTEGRITY')
          state.files.find(row=>row.name===item.name).committed=true;state.status='committing';await record()
        }
        state.status='committed_restart_not_performed';await record();complete=true
        // No private values, backups, credentials, original file bodies or runtime readiness claim.
        return Object.freeze({transactionId:state.transactionId,status:state.status,accountId:'admin',files:state.files.map(({name,beforeSha256,afterSha256})=>({name,beforeSha256,afterSha256})),restartPerformed:false})
      } catch(error) {
        state.status='rollback_required';state.errorCode=/^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code||'')?error.code:'ADMIN_MIGRATION_FAILED';state.rollback=[]
        // Restore only bytes this transaction wrote while the real writer freeze still holds.
        for(const item of committed.reverse()){
          try{
            const current=await readStable(item.file)
            need(current.sha256===hash(item.raw),'ADMIN_MIGRATION_ROLLBACK_DRIFT')
            const temp=path.join(path.dirname(item.file),'.model-rollback-'+randomUUID()+'.tmp')
            await writeNew(temp,item.snapshot.raw,item.snapshot.mode);await rename(temp,item.file);await syncDirectory(path.dirname(item.file))
            need((await readStable(item.file)).sha256===item.snapshot.sha256,'ADMIN_MIGRATION_ROLLBACK_INTEGRITY')
            state.rollback.push({name:item.name,status:'restored'})
          }catch{state.rollback.push({name:item.name,status:'refused_or_failed'})}
        }
        state.status=state.rollback.every(row=>row.status==='restored')?'rolled_back':'manual_recovery_required';await record()
        throw Object.assign(new Error(state.status==='manual_recovery_required'?'ADMIN_MIGRATION_RECOVERY_REQUIRED':state.errorCode),{code:state.status==='manual_recovery_required'?'ADMIN_MIGRATION_RECOVERY_REQUIRED':state.errorCode})
      } finally {
        for(const item of work){try{const current=await readStable(item.temp);if(current.sha256===hash(item.raw))await unlink(item.temp)}catch(error){if(error?.code!=='ENOENT')state.cleanupUnproven=true}}
        if(state.cleanupUnproven){await record();if(complete)throw Object.assign(new Error('ADMIN_MIGRATION_CLEANUP_UNPROVEN'),{code:'ADMIN_MIGRATION_CLEANUP_UNPROVEN'})}
      }
    })
  }})
}
