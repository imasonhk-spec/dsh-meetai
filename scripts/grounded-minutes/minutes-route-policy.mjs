// Admin development policy: no I/O, registry mutation or real release authorizer.
// authorizeMax MUST be a server-owned operation, never a request-supplied flag.
export const LEGACY_MINUTES_MODEL = 'huiwen-lm:latest';
export const MAX_MINUTES_MODEL = 'huiwen-max:latest';
const fail = code => Object.assign(new Error(code), {code});
function selection(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(k => !['provider','model'].includes(k))) throw fail('MODEL_SELECTION_INVALID');
  const {provider,model} = value;
  if (typeof provider !== 'string' || typeof model !== 'string' ||
      !provider.trim() || !model.trim() || provider.length > 256 || model.length > 256 ||
      /[\s\x00-\x1f]/.test(provider.trim()) || /[\x00-\x1f]/.test(model) ||
      provider.includes('://') || model.includes('://')) throw fail('MODEL_SELECTION_INVALID');
  return Object.freeze({provider:provider.trim(),model:model.trim()});
}
export function classifyMinutesRoute(value) {
  let route = selection(value);
  // Same-weight compatibility only; do NOT rewrite Occamy directly into Max.
  if (route.provider === 'ollama' && route.model === 'occamy-1.0-q5:latest')
    route = Object.freeze({...route,model:LEGACY_MINUTES_MODEL});
  const lower = route.model.toLowerCase();
  if ((lower.startsWith('huiwen-max') && route.model !== MAX_MINUTES_MODEL) ||
      (lower.startsWith('huiwen-luna') && route.model !== 'huiwen-luna:latest'))
    throw fail('MODEL_ID_NOT_CANONICAL');
  if (route.model === 'huiwen-luna:latest') throw fail('MINUTES_ROLE_MODEL_MISMATCH');
  if (route.model === MAX_MINUTES_MODEL) {
    if (route.provider !== 'ollama') throw fail('MAX_LOCAL_PROVIDER_REQUIRED');
    return Object.freeze({role:'minutes',execution:'grounded',route,maxAdmissionRequired:true});
  }
  if (route.model === LEGACY_MINUTES_MODEL)
    return Object.freeze({role:'minutes',execution:'grounded',route,maxAdmissionRequired:false});
  // Preserve existing explicit non-reserved choices; no local/cloud substitution.
  return Object.freeze({role:'minutes',execution:'existing-explicit',route,maxAdmissionRequired:false});
}
async function boundedAdmission(authorizeMax,request,signal,timeoutMs) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer,onAbort;
  const gate = new Promise((_,reject) => {
    onAbort = () => { controller.abort(signal.reason); reject(signal.reason); };
    signal?.addEventListener('abort',onAbort,{once:true});
    timer = setTimeout(() => {
      const error = fail('MAX_ADMISSION_TIMEOUT'); controller.abort(error); reject(error);
    },timeoutMs);
  });
  try {
    return await Promise.race([gate,Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return authorizeMax(request,{signal:controller.signal});
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',onAbort); }
}
export function createMinutesRoutingPolicy({authorizeMax,admissionTimeoutMs=10000} = {}) {
  if (authorizeMax !== undefined && typeof authorizeMax !== 'function') throw fail('MAX_AUTHORIZER_INVALID');
  if (!Number.isSafeInteger(admissionTimeoutMs) || admissionTimeoutMs<=0 || admissionTimeoutMs>180000)
    throw fail('MAX_ADMISSION_TIMEOUT_INVALID');
  return Object.freeze({async resolve(value,{signal} = {}) {
    signal?.throwIfAborted();
    const plan = classifyMinutesRoute(value);
    if (!plan.maxAdmissionRequired) return plan;
    if (!authorizeMax) throw fail('MAX_NOT_ADMITTED');
    let admission;
    try {
      admission = await boundedAdmission(authorizeMax,Object.freeze({role:plan.role,...plan.route}),signal,admissionTimeoutMs);
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code==='MAX_ADMISSION_TIMEOUT') throw fail('MAX_ADMISSION_TIMEOUT');
      // No raw exception/endpoints/secrets from a future registry/owner.
      throw fail('MAX_ADMISSION_UNAVAILABLE');
    }
    signal?.throwIfAborted();
    if (!admission || admission.allowed !== true || admission.role !== plan.role ||
        admission.provider !== plan.route.provider || admission.model !== plan.route.model)
      throw fail('MAX_NOT_ADMITTED');
    // This callback binding is NOT proof of quality/ROCm/performance acceptance.
    return plan;
  }});
}
