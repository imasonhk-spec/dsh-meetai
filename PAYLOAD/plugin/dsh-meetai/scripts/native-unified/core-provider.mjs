import { createNativeCoreRecovery } from './native-core-recovery.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { openCore, CONTRACT_VERSION } from './modules/S1/core/core.mjs';
import { validateWordContent } from './modules/S1/core/word-content.mjs';

export const PROVIDER_CONTRACT = 'unified-core-provider/1.0.0';
const owners = new WeakMap();
const fail = code => Object.assign(new Error(code), { code });
const demand = (condition, code) => { if (!condition) throw fail(code); };
const clone = value => structuredClone(value);
const id = value => {
  demand(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value), 'INVALID_ID');
  return value;
};
const revision = value => { demand(Number.isSafeInteger(value) && value >= 0, 'INVALID_REVISION'); return value; };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
function json(value) {
  demand(value === null || ['string', 'boolean'].includes(typeof value) ||
    typeof value === 'number' && Number.isFinite(value) || Array.isArray(value) || plain(value), 'INVALID_NAMESPACE_DATA');
  if (Array.isArray(value)) for (const row of value) json(row);
  else if (plain(value)) for (const [key, row] of Object.entries(value)) {
    demand(!['__proto__', 'prototype', 'constructor'].includes(key), 'INVALID_NAMESPACE_KEY'); json(row);
  }
}
function checkedImage(value) {
  demand(plain(value) && value.schema === 1 && plain(value.namespaces), 'INTEGRATION_STATE_INVALID');
  json(value);
  for (const [kind, row] of Object.entries(value.namespaces)) {
    id(kind); demand(plain(row) && plain(row.rows), 'INTEGRATION_STATE_INVALID');
    revision(row.revision); revision(row.compactionRevision ?? 0);
    for (const key of Object.keys(row.rows)) id(key);
  }
  return value;
}
function checkAuthority(authority) {
  demand(authority && ['authenticate', 'authorizeCommit', 'authorizeRead', 'resolveRequest']
    .every(key => typeof authority[key] === 'function'), 'TRUSTED_AUTHORITY_REQUIRED');
}
function checkedProvenance(value) {
  demand(plain(value) && typeof value.artifact === 'string' && value.artifact.length > 0 &&
    /^[a-f0-9]{64}$/.test(value.sha256) && value.contractVersion === CONTRACT_VERSION, 'CORE_PROVENANCE_REQUIRED');
  return Object.freeze(clone(value));
}

/** Pure construction over the ONE core opened by the integrator. No runtime install. */
export function createCoreProvider({ core, authority, provenance, wordRenderer, deletion, controlContext } = {}) {
  checkAuthority(authority);
  const source = checkedProvenance(provenance);
  demand(core?.version === CONTRACT_VERSION && ['readIntegrationState', 'commitIntegrationState',
    'capture', 'guardContext', 'composeContext', 'assertContextActive', 'read', 'close', 'closeStatus', 'retryClose']
    .every(key => typeof core[key] === 'function'), 'NATIVE_INTEGRATION_CORE_REQUIRED');
  demand(!owners.has(core), 'PROVIDER_OWNER_CONFLICT');
  let phase = 'open', tail = Promise.resolve(), closing;
  const scopes = new WeakMap();
  const execution = new AsyncLocalStorage();
  const live = () => demand(phase === 'open', 'PROVIDER_CLOSED');
  const active = context => { live(); core.assertContextActive(context); };
  function scopeFor(context, { unbound = false } = {}) {
    active(context);
    const scope = Object.freeze({ accountId: id(context.accountId),
      meetingId: unbound ? null : id(context.meetingId), epoch: unbound ? null : context.epoch });
    if (!unbound) demand(Number.isSafeInteger(scope.epoch) && scope.epoch > 0, 'ORIGINAL_EPOCH_REQUIRED');
    scopes.set(scope, context); return scope;
  }
  function verifyScope(context, scope, unbound = false) {
    active(context); demand(plain(scope), 'SCOPE_REQUIRED');
    demand(scope.accountId === context.accountId && (unbound
      ? scope.meetingId == null && scope.epoch == null
      : scope.meetingId === context.meetingId && scope.epoch === context.epoch), 'ORIGINAL_CONTEXT_MISMATCH');
  }
  // This is a staging gate, NOT a replacement for S1's durable queue or authority lock.
  // Native publication repeats original epoch/auth/CAS; no automatic rebase/retry.
  function serialize(operation) {
    live(); const pending = tail.then(() => { live(); return operation(); });
    tail = pending.catch(() => {}); return pending;
  }
  async function withNamespaces(context, scope, locks, callback, { unbound = false } = {}) {
    demand(typeof callback === 'function' && plain(locks), 'NAMESPACE_CALLBACK_REQUIRED');
    const bound = execution.getStore();
    if (bound) context = core.composeContext(context, bound.context);
    verifyScope(context, scope, unbound);
    return serialize(async () => {
      verifyScope(context, scope, unbound);
      const before = await core.readIntegrationState(context); active(context);
      revision(before.meetingRevision); revision(before.namespaceRevision);
      const image = checkedImage(clone(before.image));
      let admitted = true, word, allocation;
      const dependencyMeetings = new Map();
      const touch = () => { demand(admitted, 'NAMESPACE_TRANSACTION_SETTLED'); active(context); };
      const namespace = (kind, create = false) => {
        touch(); id(kind);
        if (!Object.hasOwn(image.namespaces, kind) && create)
          image.namespaces[kind] = { revision: 0, compactionRevision: 0, rows: {} };
        return image.namespaces[kind];
      };
      const tx = Object.freeze({
        pinMeeting(value) {
          touch(); demand(plain(value), 'INVALID_MEETING_DEPENDENCY'); id(value.meetingId);
          demand(Number.isSafeInteger(value.epoch) && value.epoch > 0, 'INVALID_MEETING_DEPENDENCY'); revision(value.revision);
          const pinned = Object.freeze({ meetingId: value.meetingId, epoch: value.epoch, revision: value.revision });
          const prior = dependencyMeetings.get(pinned.meetingId);
          demand(!prior || isDeepStrictEqual(prior, pinned), 'MEETING_DEPENDENCY_CONFLICT');
          dependencyMeetings.set(pinned.meetingId, pinned); return clone(pinned);
        },
        get(kind, key) { id(key); const row = namespace(kind); return clone(row && Object.hasOwn(row.rows, key) ? row.rows[key] : undefined); },
        list(kind) { return clone(Object.values(namespace(kind)?.rows ?? {})); },
        revision(kind) { return namespace(kind)?.revision ?? 0; },
        set(kind, key, value) { id(key); json(value); const row = namespace(kind, true); row.rows[key] = clone(value); row.revision = revision(row.revision + 1); },
        delete(kind, key) { id(key); const row = namespace(kind); if (row && Object.hasOwn(row.rows, key)) { delete row.rows[key]; row.revision = revision(row.revision + 1); } },
        compact(kind) { const row = namespace(kind, true); row.compactionRevision = revision(row.compactionRevision + 1); row.revision = revision(row.revision + 1); }
      });
      const stage = {
        async word(input) {
          touch(); verifyScope(context, input.scope, unbound); demand(!word, 'MULTIPLE_WORD_PUBLICATIONS_FORBIDDEN');
          demand(!unbound, 'WORD_BOUND_CONTEXT_REQUIRED');
          demand(typeof wordRenderer?.render === 'function', 'TRUSTED_WORD_RENDERER_REQUIRED');
          revision(input.expectedRevision); id(input.operationId);
          demand(typeof input.markdown === 'string' && input.markdown.length > 0, 'WORD_MARKDOWN_REQUIRED');
          if (input.source !== undefined) demand(input.source?.meetingId === scope.meetingId && input.source?.epoch === scope.epoch, 'WORD_SOURCE_IDENTITY_CONFLICT');
          const kind = input.kind ?? 'document'; demand(['document', 'template'].includes(kind), 'WORD_KIND_INVALID');
          input.signal?.throwIfAborted();
          // Supplied bytes originate in trusted native editor/template staging;
          // validate actual DOCX structure/hash, never a success flag or file path.
          const content = validateWordContent(input.content ?? await wordRenderer.render({ ...clone(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'signal'))), signal: input.signal })); touch();
          input.signal?.throwIfAborted(); demand(!word, 'MULTIPLE_WORD_PUBLICATIONS_FORBIDDEN');
          const documentId = input.documentId ?? 'minutes_' + createHash('sha256').update(input.operationId).digest('hex');
          id(documentId); demand(documentId.length <= 100, 'WORD_DOCUMENT_ID_TOO_LONG');
          const dto = { documentId, documentRevision: input.expectedRevision + 1,
            source: { accountId: context.accountId, meetingId: context.meetingId, epoch: context.epoch,
              assetId: 'word_' + documentId, revision: input.expectedRevision + 1, sha256: content.sha256 }, kind };
          word = { operation: 'document', value: { kind, documentId,
            expectedDocumentRevision: input.expectedRevision, content,
            ...(input.templateSource ? { templateSource: clone(input.templateSource) } : {}) }, expectedReceipt: dto };
          tx.set('wordBodies', documentId, { id: documentId, scope: clone(scope), operationId: input.operationId,
            documentId, documentRevision: dto.documentRevision, kind, content: input.markdown,
            contentSha256: createHash('sha256').update(input.markdown).digest('hex'), docxSha256: content.sha256,
            source: input.source ? clone(input.source) : null, ...(input.grounding ? { grounding: clone(input.grounding) } : {}) });
          return clone(dto);
        },
        allocate(inputScope, operationId) {
          touch(); demand(unbound, 'CREATE_SCOPE_MUST_BE_UNBOUND'); verifyScope(context, inputScope, true);
          id(operationId); demand(!allocation, 'MULTIPLE_ALLOCATIONS_FORBIDDEN');
          allocation = { meetingId: 'meeting_' + randomUUID(), operationId, epoch: 1 };
          return clone({ meetingId: allocation.meetingId, epoch: 1 });
        }
      };
      drafts.set(tx, stage);
      try {
        const value = await callback(tx); touch(); json(value); checkedImage(image);
        if (isDeepStrictEqual(before.image, image) && !word && !allocation) {
          if (dependencyMeetings.size) {
            demand(typeof core.checkIntegrationDependencies === 'function', 'NATIVE_DEPENDENCY_CHECK_REQUIRED');
            await core.checkIntegrationDependencies(context, [...dependencyMeetings.values()]);
          }
          await core.read(context); touch(); return clone(value);
        }
        const input = {
          expectedNamespaceRevision: before.namespaceRevision, image,
          ...(dependencyMeetings.size ? { dependencyMeetings: [...dependencyMeetings.values()] } : {}),
          // Omission means native retention. Ordinary writes never clear the graph.
          ...(word ? { word } : {}), ...(allocation ? { allocation } : {})
        };
        let result;
        if (allocation) {
          demand(typeof authority.grantAllocatedMeeting === 'function' && typeof core.inspectPrivateContextCredential === 'function', 'NATIVE_ALLOCATION_ACK_REQUIRED');
          const credential = core.inspectPrivateContextCredential(context);
          try {
            const ack = await authority.grantAllocatedMeeting(credential, allocation.meetingId, async () => {
              result = await core.commitIntegrationState(context, before.meetingRevision, input);
              demand(isDeepStrictEqual(result?.value?.allocation, allocation), 'NATIVE_ALLOCATION_ACK_INVALID');
              return clone(result.value.allocation);
            });
            demand(isDeepStrictEqual(ack, result?.value?.allocation), 'NATIVE_ALLOCATION_ACK_INVALID');
          } catch (error) {
            // The lifecycle may have published before grant persistence failed. Never replay/false-ACK.
            phase = 'uncertain'; error.reconciliationRequired = true; throw error;
          }
        } else result = await core.commitIntegrationState(context, before.meetingRevision, input);
        // Publication has settled. Never replace the epoch/context or replay callback.
        if (result?.value?.namespaceRevision !== before.namespaceRevision + 1 ||
          word && !isDeepStrictEqual(result.value.word, word.expectedReceipt)) {
          phase = 'uncertain'; throw fail('NATIVE_SETTLEMENT_UNCERTAIN');
        }
        return clone(value);
      } finally { admitted = false; drafts.delete(tx); }
    });
  }
  const drafts = new WeakMap();
  const api = Object.freeze({
    contract: PROVIDER_CONTRACT, core, provenance: source,
    stageWord(tx, input) { const stage = drafts.get(tx); demand(stage, 'UNTRUSTED_NAMESPACE_TRANSACTION'); return stage.word(input); },
    scopeFor, withNamespaces,
    executionContext() {
      const stored = execution.getStore();
      if (!stored?.jobId) return null;
      active(stored.context);
      demand(controlContext && typeof core.inspectIntegrationRunnerState === 'function' && typeof core.inspectPrivateIntegrationState === 'function', 'NATIVE_EXECUTION_INSPECTOR_REQUIRED');
      const observed = core.inspectIntegrationRunnerState(controlContext).running;
      const native = Object.values(core.inspectPrivateIntegrationState(controlContext).jobs).find(job =>
        job.jobId === stored.jobId && job.accountId === stored.context.accountId && job.subjectId === stored.context.subjectId &&
        job.meetingId === stored.context.meetingId && job.epoch === stored.context.epoch);
      demand(native?.state === 'running' && observed?.jobId === stored.jobId &&
        ['accountId', 'meetingId', 'epoch'].every(field => observed[field] === stored.context[field]), 'NATIVE_EXECUTION_UNPROVEN');
      return Object.freeze({ context: stored.context, nativeJobId: stored.jobId });
    },
    runInContext(context, { signal, jobId } = {}, operation) {
      demand(typeof operation === 'function', 'EXECUTION_CALLBACK_REQUIRED');
      active(context); signal?.throwIfAborted();
      const guarded = core.guardContext(context, () => { live(); signal?.throwIfAborted(); });
      return execution.run({ context: guarded, jobId }, operation);
    },
    async captureRequest(request, { signal, mutation = false } = {}) {
      live(); signal?.throwIfAborted();
      // Only trusted resolver sees Host transport. No body identity is parsed here.
      const resolved = await authority.resolveRequest(request, { mutation, signal });
      live(); signal?.throwIfAborted();
      demand(resolved && Object.hasOwn(resolved, 'credential') && typeof resolved.meetingId === 'string', 'TRUSTED_REQUEST_IDENTITY_REQUIRED');
      const context = await core.capture(resolved.credential, resolved.meetingId);
      signal?.throwIfAborted();
      demand(Number.isSafeInteger(resolved.epoch) && resolved.epoch === context.epoch, 'ORIGINAL_EPOCH_REQUIRED');
      if (resolved.accountId !== undefined) demand(resolved.accountId === context.accountId, 'TRUSTED_REQUEST_IDENTITY_CONFLICT');
      if (resolved.subjectId !== undefined) demand(resolved.subjectId === context.subjectId, 'TRUSTED_REQUEST_IDENTITY_CONFLICT');
      return core.guardContext(context, () => { live(); signal?.throwIfAborted(); resolved.assertActive?.(); });
    },
    peerFor(context, { runner, unbound = false } = {}) {
      active(context);
      demand(runner && ['register', 'submit', 'cancel', 'drain'].every(key => typeof runner[key] === 'function'), 'SINGLE_RUNNER_ADAPTER_REQUIRED');
      return Object.freeze({
        contract: 's2-peer/1.0.0', core, runner,
        withWrite: (scope, locks, fn) => withNamespaces(context, scope, locks, fn, { unbound }),
        withDelete(deleting, locks, fn) {
          // A fenced ordinary context CANNOT synthesize a deletion capability.
          demand(typeof deletion?.withDelete === 'function', 'TRUSTED_DELETION_CAPABILITY_REQUIRED');
          return deletion.withDelete({ core, originalContext: context, deleting, locks, callback: fn });
        },
        allocateMeeting(tx, scope, operationId) {
          const stage = drafts.get(tx); demand(stage, 'UNTRUSTED_NAMESPACE_TRANSACTION');
          return stage.allocate(scope, operationId);
        },
        word: Object.freeze({ commit(tx, input) {
          const stage = drafts.get(tx); demand(stage, 'UNTRUSTED_NAMESPACE_TRANSACTION'); return stage.word(input);
        } })
      });
    },
    closeStatus() { return { phase, native: core.closeStatus() }; },
    close() {
      if (closing) return closing;
      phase = 'closing'; let yes, no;
      closing = new Promise((resolve, reject) => { yes = resolve; no = reject; }); closing.catch(() => {});
      (async () => {
        try { await tail; await core.close(); phase = 'closed'; owners.delete(core); }
        catch (error) { phase = 'failed'; throw error; }
      })().then(yes, no); return closing;
    },
    retryClose() {
      demand(phase === 'failed', 'CLOSE_RETRY_NOT_ALLOWED');
      phase = 'closing'; closing = core.retryClose().then(() => { phase = 'closed'; owners.delete(core); }, error => { phase = 'failed'; throw error; });
      closing.catch(() => {}); return closing;
    }
  });
  owners.set(core, api); return api;
}

/** Opening is an explicit developer capability; not called while authoring/checking. */
export async function openCoreProvider(options = {}) {
  checkAuthority(options.authority); checkedProvenance(options.provenance);
  let core;
  try {
    core = await openCore({ directory: options.directory,
      authenticate: options.authority.authenticate, authorizeCommit: options.authority.authorizeCommit,
      authorizeRead: options.authority.authorizeRead });
  } catch (error) {
    if (error.startupRecovery) error.ownedCoreRecovery = createNativeCoreRecovery({ startupRecovery: error.startupRecovery });
    throw error;
  }
  try { return createCoreProvider({ ...options, core }); }
  catch (error) {
    try { await core.close(); } catch (cleanupError) {
      error.cleanupError = cleanupError; error.core = core;
      error.ownedCoreRecovery = createNativeCoreRecovery({ core });
    }
    throw error;
  }
}
