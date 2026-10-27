// Trusted server bootstrap adapters only. No call at module load, no permissions inferred.
import { openGrantStore, GRANT_STORE_CONTRACT, isGrantStartupRecovery } from './grant-store.mjs';
import { createAdminAuthority } from './admin-authority.mjs';
const authoritySlots=new WeakMap();
const need=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code})};
function actualGrant(owner){
  need(owner?.contract===GRANT_STORE_CONTRACT&&['close','retryClose','status','snapshot','assertCurrent','assertOwned']
    .every(key=>typeof owner[key]==='function'),'NATIVE_ACTUAL_GRANT_OWNER_REQUIRED');
  return owner;
}
export async function openOwnedNativeGrantStore(directory,options){
  let acquired;
  try{acquired=await openGrantStore(directory,options);return actualGrant(acquired);}
  catch(error){
    // Retain first; even an unexpected successful output may still own resources.
    const retained=acquired??error.recovery;
    if(retained){
      error.ownedGrantRecovery=retained;
      if(isGrantStartupRecovery(retained)){
        // Module-private provenance, not a client flag or a fake normal grant-store API.
        error.reconciliationRequired=true;
      }else{
        try{actualGrant(retained);}catch(validationError){
          error.grantRecoveryValidationError=validationError;error.reconciliationRequired=true;
        }
      }
    }
    throw error;
  }
}
export function createOwnedNativeAuthority(options={}){
  const grants=actualGrant(options.grantStore);
  need(!authoritySlots.has(grants),'NATIVE_AUTHORITY_GRANT_OWNER_CONFLICT');
  const authority=createAdminAuthority(options);
  let phase='retained',closing;
  function status(){return Object.freeze({contract:'native-authority-owner/1',phase,
    nativePhase:authority.status().phase,wholeRuntimeOwner:false});}
  function close(){
    if(phase==='closed')return Promise.resolve();
    if(closing)return closing;
    phase='closing';
    closing=Promise.resolve().then(async()=>{
      await authority.close();
      need(authority.status().phase==='closed','NATIVE_AUTHORITY_CLOSE_UNPROVEN');
      phase='closed';
      // Keep this grant-store identity bound. A new startup requires a new actual owner,
      // not silently recreating authority while provider/other consumers may retain it.
    }).catch(error=>{phase='close-failed';closing=undefined;throw error;});
    return closing;
  }
  const owner=Object.freeze({contract:'native-authority-owner/1',status,close,retryClose:close});
  const result=Object.freeze({authority,owner});
  authoritySlots.set(grants,result);
  return result;
}
