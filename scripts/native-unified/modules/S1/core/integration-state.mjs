import { randomUUID, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { requireCore, identifier, revision, copy, plain, jsonData, assetKey, meetingKey, payloadHash, sourceIdentity } from './validation.mjs';
import { authorizeSourceRead } from './source-authorization.mjs';
export const INTEGRATION_STATE_CONTRACT = 's1-unified-namespace/1.0.0';
export const ACCOUNT_CONTROL_MEETING = 'integration_account_control';
const ASSET = 'integration_namespace', TYPE = 'core_integration_namespace';
const EMPTY = () => ({ schema: 1, namespaces: {} });
function validateImage(image) {
  requireCore(plain(image) && image.schema === 1 && plain(image.namespaces), 'INTEGRATION_IMAGE_INVALID'); jsonData(image);
  for (const [kind, namespace] of Object.entries(image.namespaces)) {
    identifier(kind); requireCore(plain(namespace) && plain(namespace.rows), 'INTEGRATION_NAMESPACE_INVALID');
    revision(namespace.revision); revision(namespace.compactionRevision);
    for (const [id, row] of Object.entries(namespace.rows))
      requireCore(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id) && plain(row), 'INTEGRATION_ROW_INVALID');
  }
  return image;
}
/** Same native state/queue/publication barrier; private inspection is NOT an HTTP read API. */
export function integrationMethods(internal) {
  const { transaction, serialize, checked, getState, authorizeRead, version, wordMutations } = internal;
  const descriptor = { type: TYPE, ownerCapability: 'core', schemas: [1], contractVersion: version };
  // Opaque native-only proof expires with its one held transaction's settlement.
  const preparedSources = new Map();
  function control(next, captured) {
    const row = next.meetings[meetingKey(captured.accountId, ACCOUNT_CONTROL_MEETING)];
    requireCore(row && !row.fenced, 'INTEGRATION_ACCOUNT_NOT_INITIALIZED'); return row;
  }
  const key = captured => assetKey(captured.accountId, ACCOUNT_CONTROL_MEETING, ASSET);
  function current(next, captured) { control(next, captured); return next.assets[key(captured)]; }
  function dependencies(next, captured, values = []) {
    requireCore(Array.isArray(values) && values.length <= 4096, 'INTEGRATION_DEPENDENCIES_INVALID'); const seen = new Set();
    for (const value of values) {
      requireCore(plain(value), 'INTEGRATION_DEPENDENCIES_INVALID'); identifier(value.meetingId);
      revision(value.revision); revision(value.epoch);
      requireCore(value.epoch > 0 && !seen.has(value.meetingId), 'INTEGRATION_DEPENDENCIES_INVALID'); seen.add(value.meetingId);
      const target = next.meetings[meetingKey(captured.accountId, value.meetingId)];
      requireCore(target && !target.fenced && target.epoch === value.epoch && target.revision === value.revision, 'QA_DEPENDENCY_STALE');
    }
  }
  function mutate(next, captured, input) {
    dependencies(next, captured, input.dependencyMeetings);
    const owner = control(next, captured), prior = current(next, captured);
    requireCore((prior?.data.namespaceRevision ?? 0) === input.expectedNamespaceRevision, 'INTEGRATION_REVISION_CONFLICT');
    const image = validateImage(copy(input.image)); let allocation;
    if (input.allocation) {
      const { meetingId, operationId } = input.allocation; identifier(meetingId);
      requireCore(typeof operationId === 'string' && operationId.length <= 160, 'ALLOCATION_INVALID');
      requireCore(captured.meetingId === ACCOUNT_CONTROL_MEETING, 'ALLOCATION_REQUIRES_CONTROL_CONTEXT');
      const target = meetingKey(captured.accountId, meetingId); requireCore(!next.meetings[target], 'MEETING_EXISTS');
      next.meetings[target] = { accountId: captured.accountId, meetingId, epoch: 1, revision: 0, fenced: false };
      allocation = { meetingId, epoch: 1, operationId };
    }
    let word;
    if (input.word) {
      requireCore(['document', 'draft', 'promote'].includes(input.word.operation), 'INTEGRATION_WORD_INVALID');
      word = wordMutations[input.word.operation](next, captured, copy(input.word.value));
      if (input.word.expectedReceipt) requireCore(isDeepStrictEqual(word, input.word.expectedReceipt), 'WORD_SETTLEMENT_IDENTITY_INVALID');
    }
    const originId = prior?.data.originId ?? owner.integrationOrigin;
    requireCore(typeof originId === 'string' && originId.length > 0, 'INTEGRATION_ORIGIN_MISSING');
    const data = { contract: INTEGRATION_STATE_CONTRACT, namespaceRevision: revision(input.expectedNamespaceRevision + 1), originId, image };
    requireCore(input.references === undefined || Array.isArray(input.references), 'INTEGRATION_REFERENCES_INVALID');
    const references = copy((prior?.references ?? []).filter(ref => !word || ref.source.accountId !== word.source.accountId ||
      ref.source.meetingId !== word.source.meetingId || ref.source.assetId !== word.source.assetId));
    for (const ref of input.references ?? []) if (!references.some(saved => isDeepStrictEqual(saved, ref))) references.push(copy(ref));
    for (const ref of references) {
      requireCore(plain(ref) && ref.mode === 'whole' && ref.range === undefined, 'INTEGRATION_REFERENCES_INVALID');
      const source = sourceIdentity(ref.source), target = next.assets[assetKey(source.accountId, source.meetingId, source.assetId)],
        sourceMeeting = next.meetings[meetingKey(source.accountId, source.meetingId)];
      requireCore(source.accountId === captured.accountId && target && sourceMeeting && !sourceMeeting.fenced &&
        sourceMeeting.epoch === source.epoch && isDeepStrictEqual(source, target.source), 'SOURCE_INVALIDATED');
    }
    if (word) references.push({ mode: 'whole', source: copy(word.source) });
    const oldDescriptor = next.adapters[TYPE]; requireCore(!oldDescriptor || isDeepStrictEqual(oldDescriptor, descriptor), 'ADAPTER_CONFLICT');
    next.adapters[TYPE] = descriptor;
    next.assets[key(captured)] = { type: TYPE, schemaVersion: 1,
      source: { accountId: captured.accountId, meetingId: ACCOUNT_CONTROL_MEETING, assetId: ASSET,
        epoch: owner.epoch, revision: data.namespaceRevision, sha256: payloadHash(data) },
      referenceRevision: (prior?.referenceRevision ?? 0) + 1, references: copy(references), data };
    return { namespaceRevision: data.namespaceRevision, ...(word ? { word } : {}), ...(allocation ? { allocation } : {}) };
  }
  return {
    integrationStateContract: INTEGRATION_STATE_CONTRACT,
    inspectIntegrationAccount(context) {
      internal.assertContext(context); const captured = internal.capturedContext(context);
      return copy(Object.values(getState().meetings).filter(row => row.accountId === captured.accountId));
    },
    inspectIntegrationImage(context) {
      internal.assertContext(context); const captured = internal.capturedContext(context), owner = control(getState(), captured), saved = current(getState(), captured);
      return { originId: saved?.data.originId ?? owner.integrationOrigin, namespaceRevision: saved?.data.namespaceRevision ?? 0,
        image: copy(saved?.data.image ?? EMPTY()) };
    },
    inspectIntegrationSource(context, source) {
      internal.assertContext(context); const captured = internal.capturedContext(context), identity = sourceIdentity(source);
      requireCore(identity.accountId === captured.accountId, 'SOURCE_AUTH_DENIED');
      const state = getState(), owner = state.meetings[meetingKey(identity.accountId, identity.meetingId)],
        asset = state.assets[assetKey(identity.accountId, identity.meetingId, identity.assetId)];
      requireCore(owner && !owner.fenced && owner.epoch === identity.epoch && asset && isDeepStrictEqual(asset.source, identity), 'SOURCE_INVALIDATED');
      return copy({ source: asset.source, type: asset.type, referenceRevision: asset.referenceRevision, references: asset.references });
    },
    inspectIntegrationPreparedSource(context, { ticket, source, request } = {}) {
      internal.assertContext(context); const caller = internal.capturedContext(context), record = preparedSources.get(ticket);
      requireCore(typeof ticket === 'string' && /^[a-f0-9]{64}$/.test(ticket) && record && plain(request), 'PREPARED_SOURCE_TICKET_INVALID');
      requireCore(caller.accountId === record.accountId && caller.subjectId === record.subjectId &&
        ['accountId', 'subjectId', 'meetingId', 'epoch'].every(field => request[field] === record[field]), 'PREPARED_SOURCE_IDENTITY_INVALID');
      const identity = sourceIdentity(source);
      requireCore(isDeepStrictEqual(identity, source), 'PREPARED_SOURCE_IDENTITY_INVALID');
      const selected = record.assets.find(asset => isDeepStrictEqual(asset.source, identity));
      requireCore(selected && record.references.some(ref => ref.mode === 'whole' && isDeepStrictEqual(ref.source, identity)), 'PREPARED_SOURCE_UNPROVEN');
      return copy(selected);
    },
    async checkIntegrationDependencies(context, values) {
      const snapshot = copy(values);
      return serialize(async () => {
        const { captured } = await checked(context); dependencies(getState(), captured, snapshot);
        const saved = current(getState(), captured);
        if (snapshot.length) {
          requireCore(saved, 'INTEGRATION_ACCOUNT_NOT_INITIALIZED');
          await authorizeSourceRead(authorizeRead, captured, { mode: 'whole', source: copy(saved.source), dependencyMeetings: snapshot });
          await checked(context); dependencies(getState(), captured, snapshot);
        }
        return true;
      });
    },
    async readIntegrationState(context) {
      return serialize(async () => {
        const { captured, row } = await checked(context), owner = control(getState(), captured), saved = current(getState(), captured);
        if (saved) await authorizeSourceRead(authorizeRead, captured, { mode: 'whole', source: copy(saved.source) }); await checked(context);
        return { meetingRevision: row.revision, namespaceRevision: saved?.data.namespaceRevision ?? 0,
          originId: saved?.data.originId ?? owner.integrationOrigin, image: copy(saved?.data.image ?? EMPTY()), references: copy(saved?.references ?? []) };
      });
    },
    async commitIntegrationState(context, expectedMeetingRevision, value) {
      requireCore(plain(value), 'INTEGRATION_INPUT_INVALID'); const input = copy(value); revision(input.expectedNamespaceRevision); validateImage(input.image);
      let ticket;
      try {
        return await transaction(context, expectedMeetingRevision, (next, _key, captured) => mutate(next, captured, copy(input)),
          'allowWriteAssets', {}, { prepareDetails(next, _key, captured) {
            const result = mutate(next, captured, copy(input)), references = copy(next.assets[key(captured)].references);
            requireCore(!ticket, 'PREPARED_SOURCE_TICKET_REENTRY'); ticket = randomBytes(32).toString('hex');
            const assets = references.map(ref => {
              const asset = next.assets[assetKey(ref.source.accountId, ref.source.meetingId, ref.source.assetId)];
              requireCore(asset && isDeepStrictEqual(asset.source, ref.source), 'SOURCE_INVALIDATED');
              return copy({ source: asset.source, type: asset.type, referenceRevision: asset.referenceRevision, references: asset.references });
            });
            preparedSources.set(ticket, { accountId: captured.accountId, subjectId: captured.subjectId,
              meetingId: captured.meetingId, epoch: captured.epoch, references, assets });
            return { operation: 'commitIntegrationState', namespaceRevision: result.namespaceRevision, references, preparedSourceTicket: ticket,
              dependencyMeetings: copy(input.dependencyMeetings ?? []), requiredPermissions: ['allowWriteAssets', 'allowManageAdapters', 'allowCoordinateReferences',
                ...(input.word ? ['allowWriteWord'] : []), ...(input.allocation ? ['allowCreateMeeting'] : [])] };
          } });
      } finally { if (ticket) preparedSources.delete(ticket); }
    },
    async readIntegrationJob(context, jobId) {
      identifier(jobId);
      return serialize(async () => { const { captured } = await checked(context), job = getState().jobs[assetKey(captured.accountId, captured.meetingId, jobId)];
        requireCore(job && job.epoch === captured.epoch && job.subjectId === captured.subjectId, 'JOB_NOT_FOUND'); return copy(job); });
    }
  };
}
export function newIntegrationOrigin() { return 'origin_' + randomUUID().replaceAll('-', ''); }
