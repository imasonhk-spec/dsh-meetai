import {mkdir,lstat,chmod,readFile,writeFile,rename,rm,realpath} from 'node:fs/promises'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {editorError} from './word-editor-security.mjs'
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
function id(value) {if(typeof value!=='string'||!UUID.test(value))throw editorError('WORD_EDITOR_SESSION_INVALID',400);return value}
async function privateDir(dir) {await mkdir(dir,{recursive:true,mode:0o700});const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())throw editorError('WORD_EDITOR_REGISTRY_UNSAFE',503);await chmod(dir,0o700)}
/** Shared only between trusted per-account Host routes and the local broker. Never accepts browser filesystem paths. */
export function createEditorRegistry(root,{now=()=>Date.now()}={}) {
 if(!path.isAbsolute(root))throw editorError('WORD_EDITOR_REGISTRY_UNSAFE',503)
 const pending=new Map()
 async function save(record) {
  await privateDir(root);id(record.id)
  const temp=path.join(root,record.id+'.'+randomUUID()+'.new')
  try {await writeFile(temp,JSON.stringify(record),{mode:0o600,flag:'wx'});await rename(temp,path.join(root,record.id+'.json'))}
  finally {await rm(temp,{force:true}).catch(()=>{})}
 }
 async function load(sessionId,{home,allowExpired=false}={}) {
  await privateDir(root);const file=path.join(root,id(sessionId)+'.json')
  let s,record
  try{s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw editorError('WORD_EDITOR_REGISTRY_UNSAFE',503);record=JSON.parse(await readFile(file,'utf8'))}
  catch(error){if(error.code==='ENOENT')throw editorError('WORD_EDITOR_SESSION_NOT_FOUND',404);throw error}
  if(record.id!==sessionId||record.schema!==1)throw editorError('WORD_EDITOR_REGISTRY_INVALID',503)
  if(home&&record.home!==await realpath(home))throw editorError('WORD_EDITOR_ACCOUNT_DENIED')
  if(!allowExpired&&(!Number.isSafeInteger(record.expiresAt)||record.expiresAt<=now()))throw editorError('WORD_EDITOR_SESSION_EXPIRED',410)
  return record
 }
 async function create({home,port,minutesId,artifactId,version}) {
  if(!path.isAbsolute(home)||!Number.isSafeInteger(port)||port<1024||port>65535||typeof minutesId!=='string'||!minutesId||minutesId.length>128||!Number.isSafeInteger(version)||version<1)throw editorError('WORD_EDITOR_SESSION_INPUT_INVALID',400)
  id(artifactId);const resolved=await realpath(home),sessionId=randomUUID()
  const record={schema:1,id:sessionId,home:resolved,port,minutesId,artifactId,version,actor:createHash('sha256').update(resolved).digest('hex'),key:'meet-'+sessionId,createdAt:now(),expiresAt:now()+12*3600000,export:null}
  await save(record);return record
 }
 async function serialize(sessionId,fn) {
  id(sessionId);const previous=pending.get(sessionId)||Promise.resolve();const work=previous.catch(()=>{}).then(fn)
  pending.set(sessionId,work);try{return await work}finally{if(pending.get(sessionId)===work)pending.delete(sessionId)}
 }
 return {create,load,save,serialize}
}
