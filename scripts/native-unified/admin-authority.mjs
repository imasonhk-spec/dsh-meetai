import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ACCOUNT_CONTROL_MEETING } from './modules/S1/core/integration-state.mjs';
import { validateGrantConfiguration } from './grant-store.mjs';
import { rootSourceRecord } from './native-source-ledger.mjs';
import { trustedSourceFields } from './native-source-contract.mjs';
import { sourceKey } from './native-source-geometry.mjs';
import { validateMapping } from './native-source-geometry.mjs';

export const AUTHORITY_CONTRACT = 'admin-connection-authority/1.0.0';
const fail = code => Object.assign(new Error(code), { code });
const demand = (ok, code) => { if (!ok) throw fail(code); };
const copy = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => { demand(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value), 'AUTHORITY_ID_INVALID'); return value; };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const reader = image => ({
  get(kind, key) { const rows = image.namespaces?.[kind]?.rows; return rows && Object.hasOwn(rows, key) ? copy(rows[key]) : undefined; },
  list(kind) { return copy(Object.values(image.namespaces?.[kind]?.rows ?? {})); }
});

/** Actual Connection operator + explicit private grants + synchronous native source image. */
export function createAdminAuthority({ connection, accountId, subjectId, grants, grantStore, lifecycle } = {}) {
  demand(connection && typeof connection.admit === 'function', 'CONNECTION_ADMISSION_REQUIRED'); id(accountId); id(subjectId);
  let current = validateGrantConfiguration(grants);
  demand(grantStore && ['assertOwned', 'persist', 'assertCurrent'].every(key => typeof grantStore[key] === 'function'), 'DURABLE_GRANT_OWNER_REQUIRED');
  demand(typeof lifecycle?.assertActive === 'function', 'LIFECYCLE_AUTHORITY_REQUIRED');
  const operator = connection.operator;
  demand(operator && typeof operator.id === 'string', 'OPERATOR_PRINCIPAL_REQUIRED');
  let phase = 'active', tail = Promise.resolve(), binding, closePromise;
  const credentials = new WeakMap(), routes = new WeakMap();
  function serialized(fn) { const result = tail.then(fn); tail = result.catch(() => {}); return result; }
  function active() { demand(phase === 'active', 'AUTHORITY_REVOKED'); lifecycle.assertActive(); grantStore.assertOwned(); }
  function admission(request) { const result = connection.admit(request); demand(result?.peer === operator && result.peer.id === operator.id, 'AUTH_DENIED'); return result.peer; }
  function allowed(meetingId) { return current.permissions.allowMeeting === true && (meetingId === ACCOUNT_CONTROL_MEETING || current.meetings.includes(meetingId)); }
  function native() { active(); demand(binding, 'NATIVE_AUTHORITY_NOT_BOUND'); binding.core.assertContextActive(binding.controlContext); return binding; }
  function assertContext(context) {
    const b = native(); b.core.assertContextActive(context);
    demand(context.accountId === accountId && context.subjectId === subjectId, 'AUTH_CONTEXT_IDENTITY_CONFLICT'); return b;
  }
  async function auth(credential) {
    active(); const saved = credential && credentials.get(credential);
    demand(saved?.peer === operator, 'UNTRUSTED_CREDENTIAL'); saved.assertActive?.(); admission(saved.request);
    await grantStore.assertCurrent({ revision: current.revision, hash: digest(current) }); active(); saved.assertActive?.();
    demand(allowed(saved.meetingId), 'AUTH_DENIED');
    return { accountId, subjectId, meetingId: saved.meetingId, ...copy(current.permissions) };
  }
  function issue(request, meetingId, assertActive) {
    active(); id(meetingId); admission(request); demand(allowed(meetingId), 'AUTH_DENIED');
    const credential = Object.freeze({}); credentials.set(credential, { request, meetingId, peer: operator, assertActive }); return credential;
  }
  function inspectMeeting(context, meetingId) {
    const b = assertContext(context); id(meetingId);
    const rows = b.core.inspectIntegrationAccount(context);
    const row = rows.find(item => item.accountId === accountId && item.meetingId === meetingId);
    demand(row, 'MEETING_NOT_FOUND');
    return copy({ accountId, meetingId, epoch: row.epoch, revision: row.revision, fenced: row.fenced,
      allowed: allowed(meetingId), grantRevision: current.revision });
  }
  function assertDeleteDetails(details = {}) {
    if (details.deleteTarget) {
      const t = details.deleteTarget;
      demand(plain(t) && t.account === accountId && allowed(t.meeting) && current.permissions.allowDelete === true, 'DELETE_AUTH_DENIED');
    }
    if (details.deleteLane) {
      const lane = details.deleteLane, b = native();
      demand(plain(lane) && lane.target?.account === accountId && allowed(lane.target.meeting) && current.permissions.allowDelete === true &&
        typeof b.core.inspectIntegrationDeleteOperation === 'function', 'DELETE_AUTH_DENIED');
      const op = b.core.inspectIntegrationDeleteOperation(b.controlContext, lane.operationId);
      demand(op.subjectId === subjectId && op.intentHash === lane.intentHash && isDeepStrictEqual(op.target, lane.target) &&
        op.intent.originalEpoch === lane.originalEpoch, 'DELETE_AUTH_DENIED');
    }
  }
  function targetWritable(meetingId, epoch) {
    if (meetingId !== ACCOUNT_CONTROL_MEETING && typeof lifecycle.assertTargetWritable === 'function')
      lifecycle.assertTargetWritable({ accountId, meetingId, epoch });
  }
  function checkDependencies(values = []) {
    const b = native(); demand(Array.isArray(values), 'AUTH_DEPENDENCIES_INVALID');
    const rows = b.core.inspectIntegrationAccount(b.controlContext), seen = new Set();
    for (const value of values) {
      demand(plain(value) && !seen.has(id(value.meetingId)) && Number.isSafeInteger(value.epoch) && value.epoch > 0 &&
        Number.isSafeInteger(value.revision) && value.revision >= 0, 'AUTH_DEPENDENCIES_INVALID'); seen.add(value.meetingId);
      const row = rows.find(item => item.meetingId === value.meetingId && item.accountId === accountId);
      demand(allowed(value.meetingId) && row && !row.fenced && row.epoch === value.epoch && row.revision === value.revision, 'AUTH_DEPENDENCY_DENIED');
    }
  }
  function inspectAsset(source, request) {
    const b = native(); demand(source?.accountId === accountId && allowed(source.meetingId), 'SOURCE_AUTH_DENIED');
    try { return b.core.inspectIntegrationSource(b.controlContext, source); }
    catch (error) {
      // Only an opaque, native-staged ticket can authorize a source not yet published.
      if (!request?.details?.preparedSourceTicket || typeof b.core.inspectIntegrationPreparedSource !== 'function') throw error;
      demand(error.code === 'SOURCE_INVALIDATED', 'PREPARED_SOURCE_FALLBACK_DENIED');
      return b.core.inspectIntegrationPreparedSource(b.controlContext, {
        ticket: request.details.preparedSourceTicket, source,
        request: { accountId: request.accountId, subjectId: request.subjectId, meetingId: request.meetingId, epoch: request.epoch }
      });
    }
  }
  function referenceProof(references, request) {
    const b = native(); demand(Array.isArray(references), 'REFERENCE_COVERAGE_UNKNOWN');
    for (const ref of references) {
      demand(ref?.mode === 'whole' && ref.range === undefined, 'REFERENCE_PROJECTION_UNPROVEN');
      const result = inspectAsset(ref.source, request); demand(isDeepStrictEqual(result.source, ref.source), 'SOURCE_AUTH_DENIED');
    }
    const image = b.core.inspectIntegrationImage(b.controlContext);
    // Authority gate + native queue protect this exact source/target/reference set until settlement.
    return { coverage: 'verified', revision: Math.max(1, image.namespaceRevision + 1), references: copy(references) };
  }
  function sourceRecord(context, input) {
    const b = assertContext(context), source = trustedSourceFields(input);
    demand(isDeepStrictEqual(source, input), 'SOURCE_FIELDS_INVALID');
    const target = inspectMeeting(context, source.meetingId);
    demand(target.allowed && !target.fenced && target.epoch === source.epoch && source.accountId === accountId, 'SOURCE_AUTH_DENIED');
    demand(context.meetingId === source.meetingId && context.epoch === source.epoch, 'ORIGINAL_CONTEXT_REQUIRED');
    const saved = b.core.inspectIntegrationImage(context), tx = reader(saved.image), ledger = tx.get('audioSources', source.sourceId);
    demand(ledger && ledger.nativeOrigin === saved.originId, 'SOURCE_LEDGER_REQUIRED');
    let resolved;
    if (ledger.kind === 's2-root') {
      resolved = rootSourceRecord(tx, context, ledger.recordingId, saved.originId);
      demand(ledger.recordingId === resolved.recording.id && ledger.uploadId === resolved.recording.uploadId &&
        sourceKey(ledger.source) === sourceKey(resolved.source), 'SOURCE_LEDGER_CONFLICT');
    } else {
      demand(ledger.kind === 's3-derived' && ledger.originalPreserved === true, 'SOURCE_LEDGER_INVALID');
      const root = rootSourceRecord(tx, context, ledger.rootRecordingId, saved.originId);
      demand(sourceKey(root.source) === sourceKey(ledger.rootSource) && ledger.source.originId === root.source.originId,
        'SOURCE_STALE');
      resolved = { source: trustedSourceFields({ ...ledger.source, transcriptRevision: root.source.transcriptRevision }), ledger };
    }
    demand(sourceKey(resolved.source) === sourceKey(source), 'SOURCE_STALE');
    if (Object.hasOwn(input, 'transcriptRevision')) demand(input.transcriptRevision === resolved.source.transcriptRevision, 'TRANSCRIPT_STALE');
    const fenced = tx.get('mediaSourceFences', source.sourceId);
    demand(!fenced || sourceKey(fenced.source) !== sourceKey(source), 'SOURCE_FENCED');
    demand(Number.isSafeInteger(ledger.size) && ledger.size > 0, 'SOURCE_SIZE_UNPROVEN');
    return { source, ledger: copy(ledger), size: ledger.size, target, namespaceRevision: saved.namespaceRevision };
  }
  const api = Object.freeze({
    contract: AUTHORITY_CONTRACT, accountId, subjectId, issue, inspectMeeting,
    bindNative(core, controlContext) {
      active(); demand(!binding, 'NATIVE_AUTHORITY_ALREADY_BOUND');
      demand(core && ['assertContextActive', 'inspectIntegrationAccount', 'inspectIntegrationImage', 'inspectIntegrationSource'].every(key => typeof core[key] === 'function'), 'NATIVE_AUTHORITY_REQUIRED');
      core.assertContextActive(controlContext);
      demand(controlContext.accountId === accountId && controlContext.subjectId === subjectId && controlContext.meetingId === ACCOUNT_CONTROL_MEETING, 'NATIVE_CONTROL_IDENTITY_INVALID');
      core.inspectIntegrationAccount(controlContext); core.inspectIntegrationImage(controlContext);
      binding = Object.freeze({ core, controlContext }); return true;
    },
    routeRequest(request, value) {
      active(); admission(request); demand(request && typeof request === 'object' && plain(value), 'TRUSTED_ROUTE_REQUIRED');
      id(value.meetingId); demand(Number.isSafeInteger(value.epoch) && value.epoch > 0, 'ORIGINAL_EPOCH_REQUIRED');
      const route = Object.freeze({ meetingId: value.meetingId, epoch: value.epoch });
      const previous = routes.get(request); demand(!previous || isDeepStrictEqual(previous, route), 'ORIGINAL_ROUTE_CONFLICT');
      routes.set(request, route); return route;
    },
    async resolveRequest(request, { mutation = false, signal } = {}) {
      active(); signal?.throwIfAborted(); const route = routes.get(request); demand(route, 'TRUSTED_ROUTE_REQUIRED');
      if (mutation) {
        const headers = request.headers, get = name => headers instanceof Headers ? headers.get(name) : headers?.[name];
        demand(typeof get('origin') === 'string' && !Array.isArray(get('origin')), 'MUTATION_ORIGIN_REQUIRED');
      }
      const credential = issue(request, route.meetingId, () => signal?.throwIfAborted()); await auth(credential);
      return { credential, ...route, accountId, subjectId, assertActive: () => { active(); signal?.throwIfAborted(); admission(request);
        if (mutation) targetWritable(route.meetingId, route.epoch); } };
    },
    authenticate: auth,
    async authorizeRead(credential, request) {
      return serialized(async () => {
        const identity = await auth(credential); demand(['whole', 'projection'].includes(request.mode), 'AUTH_DENIED');
        checkDependencies(request.dependencyMeetings ?? []);
        const inspected = inspectAsset(request.source);
        if (request.mode === 'projection') throw fail('SOURCE_PROJECTION_UNPROVEN');
        demand(request.range === undefined && isDeepStrictEqual(inspected.source, request.source), 'SOURCE_AUTH_DENIED');
        await auth(credential); checkDependencies(request.dependencyMeetings ?? []); inspectAsset(request.source);
        return { allowed: true, accountId, subjectId, source: copy(request.source), mode: request.mode,
          grantId: 'grant_' + digest([accountId, subjectId, current.revision]), grantRevision: current.revision };
      });
    },
    async authorizeProjection(context, { source, kind, range, signal } = {}) {
      return serialized(async () => {
        active(); signal?.throwIfAborted(); await auth(assertContext(context).core.inspectPrivateContextCredential(context));
        await grantStore.assertCurrent({ revision: current.revision, hash: digest(current) }); active(); signal?.throwIfAborted();
        const record = sourceRecord(context, source);
        demand(['whole', 'bytes', 'samples', 'characters'].includes(kind), 'SOURCE_PROJECTION_INVALID');
        if (kind === 'characters') throw fail('SOURCE_PROJECTION_UNPROVEN');
        if (kind === 'whole') demand(range === undefined, 'SOURCE_PROJECTION_INVALID');
        else if (kind === 'bytes') demand(plain(range) && Object.keys(range).length === 2 && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) &&
          range.start >= 0 && range.end >= range.start && range.end < record.size, 'SOURCE_RANGE_INVALID');
        else {
          const mapping = validateMapping(record.ledger.mapping);
          const image = native().core.inspectIntegrationImage(context).image;
          const root = record.ledger.kind === 's2-root' ? record.ledger : image.namespaces?.audioSources?.rows?.[record.ledger.rootSource?.sourceId];
          const metadata = root?.sampleMetadata;
          demand(metadata && metadata.synthetic === false && metadata.audioSha256 === root.source.audioSha256 &&
            sourceKey(metadata.source) === sourceKey(root.source) && metadata.provenance?.startsWith('decoded-pcm-count:') &&
            metadata.sampleRate === mapping.sampleRate && metadata.rootDurationSamples === mapping.rootDurationSamples, 'SOURCE_SAMPLE_PROOF_REQUIRED');
          demand(plain(range) && Object.keys(range).length === 2 && range.sampleRate === mapping.sampleRate && Array.isArray(range.ranges) &&
            range.ranges.length > 0 && range.ranges.length <= 10000 && range.ranges.every(pair => Array.isArray(pair) && pair.length === 2 &&
              pair.every(Number.isSafeInteger) && pair[0] >= 0 && pair[0] < pair[1] && pair[1] <= mapping.rootDurationSamples &&
              mapping.parts.some(part => part.rootStartSample <= pair[0] && part.rootEndSample >= pair[1])), 'SOURCE_SAMPLE_RANGE_INVALID');
        }
        signal?.throwIfAborted(); sourceRecord(context, source);
        return { allowed: true, accountId, meetingId: source.meetingId, epoch: source.epoch, source: copy(source), kind,
          ...(range !== undefined ? { range: copy(range) } : {}), grantRevision: current.revision };
      });
    },
    async authorizeCommit(credential, request, commit) {
      demand(typeof commit === 'function', 'AUTH_COMMIT_REQUIRED');
      return serialized(async () => {
        let identity = await auth(credential);
        demand(request.accountId === accountId && request.subjectId === subjectId && request.meetingId === identity.meetingId &&
          identity[request.permission] === true && (request.details?.requiredPermissions ?? []).every(key => identity[key] === true), 'AUTH_DENIED');
        if (!binding) demand(request.details?.operation === 'createMeeting' && request.meetingId === ACCOUNT_CONTROL_MEETING, 'NATIVE_AUTHORITY_NOT_BOUND');
        else {
          checkDependencies(request.details?.dependencyMeetings ?? []); assertDeleteDetails(request.details);
          if (!request.details?.deleteLane && !request.details?.deleteTarget) targetWritable(request.meetingId, request.epoch);
          if ((request.details?.references ?? []).length || request.details?.operation === 'setReferences')
            identity = { ...identity, referenceCoordination: referenceProof(request.details.references, request) };
        }
        await auth(credential);
        if (binding) { checkDependencies(request.details?.dependencyMeetings ?? []); assertDeleteDetails(request.details);
          if (!request.details?.deleteLane && !request.details?.deleteTarget) targetWritable(request.meetingId, request.epoch); }
        // The sole grant/reference gate remains held until native commit promise settles.
        return await commit(identity);
      });
    },
    async updateGrants(expectedRevision, next) {
      return serialized(async () => {
        active(); const validated = validateGrantConfiguration(next);
        demand(expectedRevision === current.revision && validated.revision === current.revision + 1, 'GRANT_REVISION_CONFLICT');
        await grantStore.persist({ expectedRevision, currentHash: digest(current), next: validated }); current = validated;
        return { revision: current.revision };
      });
    },
    async grantAllocatedMeeting(credential, meetingId, durableAllocation) {
      id(meetingId); demand(typeof durableAllocation === 'function', 'ALLOCATION_SETTLEMENT_REQUIRED');
      const identity = await auth(credential); demand(identity.meetingId === ACCOUNT_CONTROL_MEETING && identity.allowCreateMeeting, 'AUTH_DENIED');
      let outcome;
      // Never hold authority mutex while native allocation reenters authorizeCommit.
      try { outcome = await durableAllocation(); }
      catch (error) { error.reconciliationRequired = true; throw error; }
      demand(outcome?.meetingId === meetingId && outcome.epoch === 1, 'ALLOCATION_IDENTITY_INVALID');
      return serialized(async () => {
        try {
          await auth(credential);
          const next = { ...copy(current), revision: current.revision + 1, meetings: [...new Set([...current.meetings, meetingId])] };
          await grantStore.persist({ expectedRevision: current.revision, currentHash: digest(current), next }); current = next;
        } catch (error) { error.allocationOutcome = copy(outcome); error.reconciliationRequired = true; throw error; }
        return copy(outcome);
      });
    },
    status() { return { phase, accountId, subjectId, grantRevision: current.revision, nativeBound: Boolean(binding), identity: AUTHORITY_CONTRACT }; },
    close() { if (!closePromise) { phase = 'closing'; closePromise = tail.then(() => { phase = 'closed'; }); } return closePromise; }
  });
  return api;
}
