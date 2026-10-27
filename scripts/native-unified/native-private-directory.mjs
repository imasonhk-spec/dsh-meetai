// Existing admin-private directory acquisition only; never mkdir or remove a lock.
// This root owner does not establish safety of downstream state-file IO by itself.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
const HOME='${DSH_HOME}/.dsh/multi-user/users/admin/home';
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code})};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function privateDirectory(info){need(info.isDirectory()&&info.uid===BigInt(process.getuid())&&
  (info.mode&0o077n)===0n,'NATIVE_PRIVATE_DIRECTORY_UNSAFE');}
export async function openNativePrivateDirectory({directory,home=HOME,signal}={}){
  need(home===HOME&&typeof directory==='string'&&path.isAbsolute(directory)&&
    path.normalize(directory)===directory&&directory.startsWith(HOME+'/')&&
    !directory.startsWith(HOME+'/profiles/'),'NATIVE_ADMIN_STORE_DIRECTORY_REQUIRED');
  const parts=directory.slice(HOME.length+1).split('/');
  need(parts.length<=32&&parts.every(part=>part&&part!=='.'&&part!=='..'&&!part.includes('\\')&&!part.includes('\0')),
    'NATIVE_PRIVATE_DIRECTORY_COMPONENT_INVALID');
  need(process.platform==='linux'&&Number.isInteger(constants.O_NOFOLLOW)&&Number.isInteger(constants.O_DIRECTORY),
    'NATIVE_DIRECTORY_FD_UNSUPPORTED');
  const handles=[],pins=[],dependents=new Set();
  let phase='opening',closing;
  const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
  async function assertCurrent(){
    need(phase==='ready','NATIVE_DIRECTORY_OWNER_NOT_READY');signal?.throwIfAborted();
    for(const row of pins){
      const named=await fs.lstat(row.path,{bigint:true}),actual=await row.handle.stat({bigint:true});
      privateDirectory(named);privateDirectory(actual);
      need(!named.isSymbolicLink()&&same(named,row.info)&&same(actual,row.info)&&
        await fs.realpath(row.path)===row.path,'NATIVE_PRIVATE_DIRECTORY_REPLACED');
    }
    signal?.throwIfAborted();
  }
  function status(){return Object.freeze({contract:'native-private-directory-owner/1',phase,
    retainedHandles:handles.length,dependentOwners:dependents.size,createsDirectories:false,stateFileIOAttested:false});}
  function retainDependent(owner){
    need(phase==='ready'&&owner&&typeof owner.close==='function'&&
      (typeof owner.status==='function'||typeof owner.closeStatus==='function'),'NATIVE_DIRECTORY_DEPENDENT_OWNER_REQUIRED');
    dependents.add(owner);
  }
  function close(){
    if(phase==='closed')return Promise.resolve();if(closing)return closing;
    phase='closing';
    closing=Promise.resolve().then(async()=>{
      for(const owner of dependents){
        const observed=typeof owner.status==='function'?owner.status():owner.closeStatus();
        need(observed?.phase==='closed','NATIVE_DIRECTORY_DEPENDENT_STILL_OWNED');
      }
      while(handles.length){await handles[handles.length-1].close();handles.pop();}
      phase='closed';
    }).catch(error=>{phase='close-failed';closing=undefined;throw error;});
    return closing;
  }
  const api=Object.freeze({contract:'native-private-directory-owner/1',status,assertCurrent,retainDependent,
    async anchoredDirectory(){await assertCurrent();return '/proc/self/fd/'+handles[handles.length-1].fd;},
    close,retryClose:close});
  try{
    signal?.throwIfAborted();
    const namedHome=await fs.lstat(HOME,{bigint:true});privateDirectory(namedHome);
    need(!namedHome.isSymbolicLink()&&await fs.realpath(HOME)===HOME,'NATIVE_ADMIN_HOME_UNSAFE');
    let parent=await fs.open(HOME,flags);handles.push(parent);
    const actualHome=await parent.stat({bigint:true});privateDirectory(actualHome);
    need(same(namedHome,actualHome),'NATIVE_ADMIN_HOME_CHANGED');
    pins.push({path:HOME,handle:parent,info:actualHome});
    let current=HOME;
    for(const part of parts){
      signal?.throwIfAborted();current=path.join(current,part);
      const child=await fs.open('/proc/self/fd/'+parent.fd+'/'+part,flags);handles.push(child);
      const info=await child.stat({bigint:true});privateDirectory(info);
      pins.push({path:current,handle:child,info});parent=child;
    }
    phase='ready';await assertCurrent();return api;
  }catch(error){
    phase='open-failed';
    // The retained object owns every acquired handle, including partial startup.
    if(handles.length){error.ownedStorageRecovery=api;error.reconciliationRequired=true;}
    throw error;
  }
}
