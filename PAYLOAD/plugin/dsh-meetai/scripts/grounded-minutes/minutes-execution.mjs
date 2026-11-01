// Admin development execution. Native authority is not bootstrapped here; Max fails closed.
import {createMinutesRoutingPolicy} from './minutes-route-policy.mjs';
import {createHostAdapter} from './llm-adapter-huiwen.mjs';
import {createMinutesAdmission,assertIssuedMinutesAdmission} from './minutes-admission.mjs';
const issued = new WeakMap();
const fail = code => Object.assign(new Error(code),{code});
export async function assertMinutesExecution(binding,adapter,signal) {
  const record = binding && issued.get(binding);
  if (!record || record.adapter!==adapter) throw fail('MINUTES_BINDING_REQUIRED');
  if (adapter.complete!==record.complete || adapter.identity?.provider!==record.route.provider ||
      adapter.identity?.model!==record.route.model || adapter.fingerprint!==record.fingerprint)
    throw fail('MINUTES_BINDING_CHANGED');
  if(record.admission) await assertIssuedMinutesAdmission(record.admission).assertCurrent(signal);
  signal?.throwIfAborted();
  return record.route;
}
export function createMinutesExecution({authorizeMax}={}) {
  // Validate constructor options without invoking an authorizer or doing IO.
  createMinutesRoutingPolicy({authorizeMax});
  return Object.freeze({async prepare(selection,llm,{signal}={}) {
    // Admission state is per-operation, not shared between concurrent calls.
    let admission;
    const policy=createMinutesRoutingPolicy({authorizeMax:authorizeMax?async(request,options)=>{
      admission=await authorizeMax(request,options);
      assertIssuedMinutesAdmission(admission); // A request JSON or allowed:true callback cannot issue this token.
      return admission;
    }:undefined});
    const plan=await policy.resolve(selection,{signal});
    signal?.throwIfAborted();
    if (plan.execution!=='grounded') return Object.freeze({plan,adapter:null,binding:null});
    const admitted=plan.maxAdmissionRequired?assertIssuedMinutesAdmission(admission):null;
    if(admitted) await admitted.assertCurrent(signal);
    const adapter=await createHostAdapter(llm,plan.route,{signal,expectedModel:plan.route.model});
    signal?.throwIfAborted();
    if (adapter.identity?.provider!==plan.route.provider || adapter.identity?.model!==plan.route.model)
      throw fail('MINUTES_BINDING_CHANGED');
    if(admitted) {
      if(adapter.fingerprint!==admitted.context.identity.adapterFingerprint)throw fail('MINUTES_BINDING_CHANGED');
      const complete=adapter.complete;
      adapter.fingerprint+='|admission:'+admitted.context.publicationSha256;
      adapter.complete=async options=>{
        await admitted.assertCurrent(options?.signal);
        const response=await complete(options);
        await admitted.assertCurrent(options?.signal);
        return response;
      };
      await admitted.assertCurrent(signal);
    }
    const binding=Object.freeze({role:'minutes',provider:plan.route.provider,model:plan.route.model});
    issued.set(binding,{adapter,route:plan.route,complete:adapter.complete,fingerprint:adapter.fingerprint,admission});
    return Object.freeze({plan,adapter,binding});
  }});
}
// The old Host has no genuine Max owner/authority. Never invent ctx.get services or initialize the Occamy candidate.
export async function prepareMinutesExecution(selection,llm,{signal,admissionHome}={}) {
  const gate=createMinutesAdmission({home:admissionHome,llm});
  return createMinutesExecution({authorizeMax:gate.authorize}).prepare(selection,llm,{signal});
}
