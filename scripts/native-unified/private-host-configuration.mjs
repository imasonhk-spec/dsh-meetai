// Native private configuration owner. Explicit open only; no IO on import.
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validateGrantFile } from './grant-store.mjs'
export const PRIVATE_CONFIGURATION_CONTRACT='admin-unified-private-configuration/1.0.0'
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code})}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const plain=value=>value!==null&&Object.getPrototypeOf(value)===Object.prototype
const child=(base,value)=>value.startsWith(base+path.sep)
const canonical=value=>typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value
const same=(a,b)=>['dev','ino','uid','mode','nlink','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key])
const sameInode=(a,b)=>a.dev===b.dev&&a.ino===b.ino
const ROOTS=['stateRoot','grantDirectory','uploadRoot','wordStageRoot','mediaStageRoot','captionStageRoot','groundingRoot']
function jsonShape(value,depth=0){
  need(depth<=32,'HOST_PRIVATE_JSON_DEPTH')
  if(value===null||['string','boolean'].includes(typeof value))return
  if(typeof value==='number'){need(Number.isFinite(value),'HOST_PRIVATE_JSON_INVALID');return}
  if(Array.isArray(value)){need(value.length<=10000,'HOST_PRIVATE_JSON_INVALID');for(const item of value)jsonShape(item,depth+1);return}
  need(plain(value),'HOST_PRIVATE_JSON_INVALID')
  for(const key of Object.keys(value)){need(!['__proto__','prototype','constructor'].includes(key),'HOST_PRIVATE_JSON_INVALID');jsonShape(value[key],depth+1)}
}
function privateStat(stat,directory=false){
  need((directory?stat.isDirectory():stat.isFile())&&stat.uid===BigInt(process.getuid())&&(stat.mode&0o077n)===0n&&
    (directory||stat.nlink===1n),'HOST_PRIVATE_FILE_UNSAFE')
}
function profileStat(stat){need(stat.isDirectory()&&stat.uid===BigInt(process.getuid())&&(stat.mode&0o022n)===0n,'HOST_PROFILE_DIRECTORY_UNSAFE')}
export async function openPrivateHostConfiguration({file,profileDirectory,home,operator,signal}={}){
  need(canonical(home)&&canonical(profileDirectory)&&child(home,profileDirectory)&&
    file===path.join(profileDirectory,'meeting-unified.json')&&typeof operator?.id==='string'&&operator.id.length>0,'HOST_PRIVATE_IDENTITY_REQUIRED')
  let phase='opening',current,currentHash,currentStat,lock,lockStat,lockClosed=false,root,rootStat,
    tail=Promise.resolve(),closing,unknownLockIdentity=false,pendingIntent=null,publicationUncertain=false,lockUnlinked=false
  const transientHandles=new Set()
  async function closeTransient(handle){if(handle){await handle.close();transientHandles.delete(handle)}}
  const lockName='meeting-unified.json.writer.lock',lockPath=file+'.writer.lock'
  const anchored=name=>`/proc/self/fd/${root.fd}/${name}`
  function owned(){need(root&&['opening','ready','closing','uncertain'].includes(phase),'HOST_CONFIGURATION_CLOSED')}
  function active(){need(phase==='ready','HOST_CONFIGURATION_NOT_READY')}
  function validate(cfg){
    jsonShape(cfg)
    need(plain(cfg)&&cfg.schema===1&&cfg.accountId==='admin'&&cfg.adminHome===home&&cfg.adminProfileDirectory===profileDirectory&&
      typeof cfg.subjectId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(cfg.subjectId)&&!['__proto__','prototype','constructor'].includes(cfg.subjectId),'HOST_ADMIN_PROVISIONING_INVALID')
    need(plain(cfg.runtime)&&cfg.runtime.accountId==='admin'&&cfg.runtime.subjectId===cfg.subjectId&&cfg.runtime.adminProfileDirectory===profileDirectory,'HOST_RUNTIME_IDENTITY_CONFLICT')
    const roots=ROOTS.map(key=>cfg.runtime[key])
    need(roots.every(value=>canonical(value)&&child(home,value)&&value!==profileDirectory&&!child(profileDirectory,value)&&!child(value,profileDirectory)), 'HOST_RUNTIME_ROOT_OUTSIDE_ADMIN')
    need(roots.every((value,index)=>roots.every((other,j)=>index===j||value!==other&&!child(value,other)&&!child(other,value))),'HOST_RUNTIME_ROOT_OVERLAP')
    need(/^[a-f0-9]{64}$/.test(cfg.runtime.initialGrantFileHash??'')&&plain(cfg.runtime.executors)&&plain(cfg.runtime.localModel)&&plain(cfg.runtime.word),'HOST_RUNTIME_PINS_REQUIRED')
    need(Array.isArray(cfg.runtime.writerIds)&&cfg.runtime.writerIds.length>0&&cfg.runtime.writerIds.every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value))&&new Set(cfg.runtime.writerIds).size===cfg.runtime.writerIds.length,'HOST_WRITER_SET_REQUIRED')
    need(plain(cfg.sourceHashPins)&&/^[a-f0-9]{64}$/.test(cfg.sourceHashPins.core??''),'HOST_SOURCE_PINS_REQUIRED')
  }
  async function checkRoot(){
    owned()
    const named=await fs.lstat(profileDirectory,{bigint:true}),actual=await root.stat({bigint:true})
    profileStat(named);profileStat(actual)
    need(!named.isSymbolicLink()&&sameInode(named,rootStat)&&sameInode(actual,rootStat)&&await fs.realpath(profileDirectory)===profileDirectory,'HOST_CONFIGURATION_ROOT_CHANGED')
  }
  async function checkLock(){
    await checkRoot();need(lock&&lockStat&&!unknownLockIdentity,'HOST_CONFIGURATION_LOCK_UNPROVEN')
    const named=await fs.lstat(anchored(lockName),{bigint:true});privateStat(named)
    need(sameInode(named,lockStat),'HOST_CONFIGURATION_OWNER_CHANGED')
    if(!lockClosed)need(sameInode(await lock.stat({bigint:true}),lockStat),'HOST_CONFIGURATION_OWNER_CHANGED')
  }
  async function read(){
    await checkRoot()
    const fd=await fs.open(anchored(path.basename(file)),constants.O_RDONLY|constants.O_NOFOLLOW)
    transientHandles.add(fd)
    try{
      const before=await fd.stat({bigint:true});privateStat(before)
      need(before.size>0n&&before.size<=1048576n,'HOST_PRIVATE_FILE_SIZE')
      const bytes=await fd.readFile()
      need(Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes),'HOST_PRIVATE_UTF8_INVALID')
      const after=await fd.stat({bigint:true}),named=await fs.lstat(anchored(path.basename(file)),{bigint:true})
      need(same(before,after)&&same(before,named),'HOST_PRIVATE_FILE_CHANGED')
      let cfg;try{cfg=JSON.parse(bytes.toString('utf8'))}catch{need(false,'HOST_PRIVATE_JSON_INVALID')}
      validate(cfg);await checkRoot();return {cfg,stat:before,hash:sha(bytes)}
    }finally{await closeTransient(fd)}
  }
  async function verifyCurrent(){
    await checkLock();const got=await read()
    need(got.hash===currentHash&&same(got.stat,currentStat),'HOST_CONFIGURATION_EXTERNAL_MUTATION')
  }
  async function assertCurrent(){active();return verifyCurrent()}
  function snapshot(){active();return structuredClone(current)}
  function runtimeConfiguration(){const cfg=snapshot();return {...cfg.runtime,expectedOperatorId:operator.id,coreArtifact:'controlled native S1 integrated source',coreSha256:cfg.sourceHashPins.core}}
  function publishGrantSnapshot(value){
    active()
    const supplied=structuredClone(value)
    const operation=tail.then(async()=>{
      // Already-admitted publication drains before configuration close.
      await verifyCurrent()
      need(/^[a-f0-9]{64}$/.test(supplied?.fileHash??''),'HOST_GRANT_PUBLICATION_INVALID')
      const grantDirectory=current.runtime.grantDirectory
      need(await fs.realpath(grantDirectory)===grantDirectory,'HOST_GRANT_DIRECTORY_UNSAFE')
      const gd=await fs.open(grantDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
      transientHandles.add(gd)
      let fd,out
      try{
        const directoryStat=await gd.stat({bigint:true});privateStat(directoryStat,true)
        fd=await fs.open(`/proc/self/fd/${gd.fd}/grants.json`,constants.O_RDONLY|constants.O_NOFOLLOW)
        transientHandles.add(fd)
        const before=await fd.stat({bigint:true});privateStat(before);need(before.size>0n&&before.size<=1048576n,'HOST_GRANT_FILE_SIZE')
        const bytes=await fd.readFile(),parsed=validateGrantFile(bytes)
        need(same(before,await fd.stat({bigint:true}))&&same(before,await fs.lstat(`/proc/self/fd/${gd.fd}/grants.json`,{bigint:true}))&&
          parsed.fileHash===supplied.fileHash&&parsed.hash===supplied.hash&&JSON.stringify(parsed.grants)===JSON.stringify(supplied.grants),'HOST_GRANT_PUBLICATION_CONFLICT')
        need(sameInode(directoryStat,await fs.lstat(grantDirectory,{bigint:true}))&&await fs.realpath(grantDirectory)===grantDirectory,'HOST_GRANT_DIRECTORY_CHANGED')
        await closeTransient(fd);fd=null
        const next=structuredClone(current);next.runtime.initialGrantFileHash=parsed.fileHash
        const configBytes=Buffer.from(JSON.stringify(next,null,2)+'\n');need(configBytes.length<=1048576,'HOST_PRIVATE_FILE_SIZE')
        const temp='.unified-config-'+randomUUID()+'.pending'
        // Retain the exact intent name for reconciliation on every uncertain write.
        pendingIntent=temp
        out=await fs.open(anchored(temp),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
        transientHandles.add(out)
        await out.writeFile(configBytes);await out.sync();await closeTransient(out);out=null;await root.sync()
        await verifyCurrent();await fs.rename(anchored(temp),anchored(path.basename(file)));await root.sync()
        const observed=await read();need(observed.hash===sha(configBytes),'HOST_GRANT_PUBLICATION_UNCONFIRMED')
        current=observed.cfg;currentHash=observed.hash;currentStat=observed.stat;pendingIntent=null
      }catch(error){publicationUncertain=true;phase='uncertain';error.reconciliationRequired=true;error.retainedConfigurationIntent=pendingIntent;throw error}
      finally{
        const settled=await Promise.allSettled([closeTransient(out),closeTransient(fd),closeTransient(gd)])
        if(settled.some(item=>item.status==='rejected')){publicationUncertain=true;phase='uncertain';throw Object.assign(new Error('HOST_GRANT_HANDLES_CLOSE_INCOMPLETE'),{code:'HOST_GRANT_HANDLES_CLOSE_INCOMPLETE',reconciliationRequired:true})}
      }
    }).catch(error=>{publicationUncertain=true;phase='uncertain';error.reconciliationRequired=true;throw error})
    tail=operation.catch(()=>{});return operation
  }
  function close(){
    if(phase==='closed')return Promise.resolve()
    if(closing)return closing
    const uncertain=phase==='uncertain'
    phase='closing'
    closing=Promise.resolve().then(async()=>{
      await tail
      const drained=await Promise.allSettled([...transientHandles].map(closeTransient))
      need(drained.every(item=>item.status==='fulfilled'),'HOST_CONFIGURATION_HANDLES_CLOSE_INCOMPLETE')
      need(!unknownLockIdentity,'HOST_CONFIGURATION_LOCK_RECONCILIATION_REQUIRED')
      // An uncertain publication must be reconciled before its owner barrier is removed.
      need(!uncertain&&!publicationUncertain&&phase!=='uncertain'&&!pendingIntent,'HOST_CONFIGURATION_PUBLICATION_RECONCILIATION_REQUIRED')
      if(lock&&!lockUnlinked){
        await checkLock()
        if(!lockClosed){await lock.close();lockClosed=true}
        await checkLock();await fs.unlink(anchored(lockName));lockUnlinked=true
      }
      if(lockUnlinked&&root){await checkRoot();await root.sync();lock=null}
      if(root){await root.close();root=null}
      phase='closed'
    }).catch(error=>{phase='close-failed';closing=undefined;throw error})
    return closing
  }
  const api=Object.freeze({contract:PRIVATE_CONFIGURATION_CONTRACT,snapshot,runtimeConfiguration,assertCurrent,publishGrantSnapshot,
    status:()=>Object.freeze({phase,configurationHash:currentHash??null,accountId:'admin',profileDirectory,pendingIntent,unknownLockIdentity,publicationUncertain,retainedHandleCount:transientHandles.size}),close,retryClose:close})
  try{
    signal?.throwIfAborted()
    need(await fs.realpath(home)===home&&await fs.realpath(profileDirectory)===profileDirectory,'HOST_PRIVATE_SYMLINK_REJECTED')
    privateStat(await fs.lstat(home,{bigint:true}),true)
    root=await fs.open(profileDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    rootStat=await root.stat({bigint:true});profileStat(rootStat)
    const first=await read();current=first.cfg;currentHash=first.hash;currentStat=first.stat
    signal?.throwIfAborted()
    try{lock=await fs.open(anchored(lockName),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)}
    catch(error){if(error.code==='EEXIST')error.code='HOST_CONFIGURATION_ALREADY_OWNED';throw error}
    try{lockStat=await lock.stat({bigint:true});privateStat(lockStat)}catch(error){unknownLockIdentity=true;throw error}
    await lock.writeFile(JSON.stringify({contract:PRIVATE_CONFIGURATION_CONTRACT,pid:process.pid,ownerId:randomUUID(),configurationHash:currentHash})+'\n')
    await lock.sync();await root.sync();await verifyCurrent();signal?.throwIfAborted()
    phase='ready';return api
  }catch(error){
    // Even a missing provisioning file returns its acquired root-FD owner for cleanup.
    phase='open-failed';error.ownedRuntime=api;error.reconciliationRequired=!!lock||unknownLockIdentity
    throw error
  }
}
