import { isDeepStrictEqual } from 'node:util';
import { requireCore, identifier, revision, copy, plain, assetKey, meetingKey, payloadHash } from './validation.mjs';
import { hash, canonical, fields, sha, id } from '../../S5/typed-graph.mjs';
import { ACCOUNT_CONTROL_MEETING } from './integration-state.mjs';

export const NATIVE_DELETE_CONTRACT = 'S5-DELETE-REAL-1.0.0';
const TYPE = 'core_integration_deletions', ASSET = 'integration_deletions';
const empty = () => ({ schema: 1, revision: 0, lastClock: 0, plans: {}, operations: {}, targets: {}, reservations: {} });
const targetKey = target => meetingKey(target.account, target.meeting);
const opItem = (op, key) => { const item = op.intent.items.find(value => value.key === key); requireCore(item, 'DELETE_ITEM_UNAPPROVED'); return item; };
const stepHash = (op, item) => hash({ intentHash: op.intentHash, item });
const postHash = item => item.mutation?.postHash ?? hash({ absent: item.key, originalIdentity: item.identity });
const receipt = (op, item, state) => ({ operationId: op.id, stepHash: stepHash(op, item), state,
  ...(state === 'done' ? { postHash: postHash(item) } : {}) });

/** The only deletion ledger is an asset in the native S1 journal, under the same
 * owner, queue and durable transaction. Storage IO belongs to a registered actual
 * inventory implementation, never to a browser manifest or a synthetic flag.
 */
export function deletionMethods(internal) {
  const { getState, serialize, checked, latest, clock, version } = internal;
  let inventory;
  const preparedReservations = new Map();
  function assertReserved(input) {
    const result = provider().assertReserved(input);
    requireCore(!result || typeof result.then !== 'function', 'ASYNC_PUBLICATION_GUARD_FORBIDDEN');
    return result;
  }
  function context(context) {
    internal.assertContext(context); const captured = internal.capturedContext(context);
    requireCore(captured.meetingId === ACCOUNT_CONTROL_MEETING, 'DELETE_CONTROL_CONTEXT_REQUIRED'); return captured;
  }
  function target(captured, value) {
    fields(value, ['account', 'meeting']); requireCore(id(value.account) && id(value.meeting) && value.account === captured.accountId &&
      value.meeting !== ACCOUNT_CONTROL_MEETING, 'DELETE_AUTH_UNPROVEN'); return copy(value);
  }
  const ledgerKey = captured => assetKey(captured.accountId, ACCOUNT_CONTROL_MEETING, ASSET);
  function ledger(state, captured) {
    const saved = state.assets[ledgerKey(captured)]; const data = saved?.data ?? empty();
    requireCore(data.schema === 1 && plain(data.plans) && plain(data.operations) && plain(data.targets) && plain(data.reservations), 'DELETE_LEDGER_INVALID');
    return data;
  }
  function time(data) { const now = clock(); revision(now); requireCore(now >= data.lastClock, 'DELETE_CLOCK_INVALID'); return now; }
  function save(state, captured, data) {
    const old = state.assets[ledgerKey(captured)], owner = state.meetings[meetingKey(captured.accountId, ACCOUNT_CONTROL_MEETING)];
    requireCore(owner && !owner.fenced, 'DELETE_CONTROL_CONTEXT_REQUIRED');
    const descriptor = { type: TYPE, ownerCapability: 'core', schemas: [1], contractVersion: version };
    requireCore(!state.adapters[TYPE] || isDeepStrictEqual(state.adapters[TYPE], descriptor), 'ADAPTER_CONFLICT');
    state.adapters[TYPE] = descriptor; data.revision = revision((old?.data.revision ?? 0) + 1); data.lastClock = time(data);
    state.assets[ledgerKey(captured)] = { type: TYPE, schemaVersion: 1,
      source: { accountId: captured.accountId, meetingId: ACCOUNT_CONTROL_MEETING, assetId: ASSET,
        epoch: owner.epoch, revision: data.revision, sha256: payloadHash(data) }, referenceRevision: 0, references: [], data: copy(data) };
  }
  function provider() { requireCore(inventory, 'DELETE_REAL_INVENTORY_REQUIRED'); return inventory; }
  function operation(state, captured, operationId) {
    identifier(operationId); const data = ledger(state, captured), op = data.operations[operationId];
    requireCore(op && op.id === operationId && op.target.account === captured.accountId && op.intentHash === hash(op.intent) &&
      op.intent.contract === NATIVE_DELETE_CONTRACT && op.subjectId === captured.subjectId &&
      Array.isArray(op.inventoryDescriptors) && op.inventoryDescriptorsHash === hash(op.inventoryDescriptors) &&
      isDeepStrictEqual(op.target, op.intent.target) &&
      ['deleting', 'deleting_failed', 'deleted'].includes(op.state), 'DELETE_INTENT_CONFLICT');
    return op;
  }
  function fenced(state, captured, op) {
    const data = ledger(state, captured), owner = state.meetings[targetKey(op.target)];
    requireCore(owner?.fenced && owner.epoch === op.intent.originalEpoch + 1 && owner.deletionOperationId === op.id &&
      data.targets[targetKey(op.target)] === op.id, 'DELETE_FENCE_CONFLICT');
    for (const item of op.intent.items) requireCore(data.reservations[item.key] === op.id, 'DELETE_RESERVATION_LOST');
  }
  function lane(op, operation) {
    return { operation, deleteLane: { operationId: op.id, intentHash: op.intentHash, target: copy(op.target), originalEpoch: op.intent.originalEpoch },
      requiredPermissions: ['allowDelete'] };
  }
  async function snapshot(state, captured, expected) {
    const owner = state.meetings[targetKey(expected)]; requireCore(owner && !owner.fenced, 'DELETE_TARGET_UNAVAILABLE');
    const actual = await provider().snapshot({ state: copy(state), target: copy(expected) });
    requireCore(actual && Array.isArray(actual.items) && plain(actual.coverage) && Array.isArray(actual.blockers) &&
      Array.isArray(actual.unknowns) && Number.isSafeInteger(actual.writerRevision), 'DELETE_INVENTORY_UNPROVEN');
    revision(actual.registryRevision); revision(actual.writerRevision);
    const value = { epoch: owner.epoch, revision: owner.revision, registryRevision: actual.registryRevision,
      items: copy(actual.items), coverage: copy(actual.coverage), blockers: copy(actual.blockers) };
    return { value, writerRevision: actual.writerRevision, unknowns: copy(actual.unknowns) };
  }
  function strictIntent(input, plan, actual) {
    const expectedItems = actual.value.items.filter(row => row.owners.some(owner =>
      owner.account === input.target.account && owner.meeting === input.target.meeting)).map(row => ({ ...copy(row),
        owners: copy(row.owners).sort((a, b) => canonical(a).localeCompare(canonical(b))),
        action: row.mutation?.policy === 'compact' ? 'compact' : row.owners.length > 1 ? 'detach' : 'remove' }));
    expectedItems.sort((a, b) => a.key.localeCompare(b.key));
    requireCore(isDeepStrictEqual(expectedItems, input.intent.items) && input.intent.manifestHash ===
      hash({ snapshot: actual.value, target: input.target, contract: NATIVE_DELETE_CONTRACT, writerRevision: actual.writerRevision }), 'DELETE_ITEM_SET_CHANGED');
    requireCore(input.intentHash === hash(input.intent) && input.intent.contract === NATIVE_DELETE_CONTRACT &&
      isDeepStrictEqual(input.intent.target, input.target) && plan?.id === input.intent.planId &&
      plan.graph.complete === true && plan.graph.realComplete === true && input.intent.manifestHash === plan.graph.manifestHash &&
      input.intent.originalEpoch === actual.value.epoch && input.intent.revision === actual.value.revision &&
      input.intent.registryRevision === actual.value.registryRevision && input.intent.writerRevision === actual.writerRevision &&
      input.intent.snapshotHash === hash(actual.value) && input.intent.inventoryHash === actual.value.coverage.inventoryHash &&
      isDeepStrictEqual(input.intent.coverage, actual.value.coverage) && isDeepStrictEqual(input.intent.items, plan.graph.items) &&
      input.intent.snapshotHash === plan.graph.snapshotHash && input.intent.writerRevision === plan.graph.writerRevision &&
      actual.unknowns.length === 0, 'DELETE_PLAN_STALE');
  }
  return {
    integrationCoreVersion: '1.0.0-unified-core.1',
    assertIntegrationDeletionReservationAuthority(controlContext, supplied, phase) {
      const captured = context(controlContext);
      if (phase === 'preview') {
        const t = supplied?.target;
        requireCore(plain(t) && t.accountId === captured.accountId && Number.isSafeInteger(t.originalEpoch), 'DELETE_PREVIEW_UNPROVEN');
        identifier(t.meetingId); const owner = getState().meetings[meetingKey(t.accountId, t.meetingId)];
        const now = time(ledger(getState(), captured));
        requireCore(owner && !owner.fenced && owner.epoch === t.originalEpoch && t.meetingId !== ACCOUNT_CONTROL_MEETING &&
          Number.isSafeInteger(supplied.expiresAt) && supplied.expiresAt > now && supplied.expiresAt - now <= 300000, 'DELETE_PREVIEW_UNPROVEN');
        return true;
      }
      if (phase === 'restore-set') {
        identifier(supplied?.bootId);
        requireCore(Array.isArray(supplied.operations), 'DELETE_RESTORE_UNPROVEN');
        const actual = Object.values(ledger(getState(), captured).operations).map(op => copy(operation(getState(), captured, op.id)));
        const order = values => copy(values).sort((a, b) => a.id.localeCompare(b.id));
        requireCore(isDeepStrictEqual(order(actual), order(supplied.operations)), 'DELETE_RESTORE_SET_CHANGED');
        return true;
      }
      if (phase === 'assert' && !ledger(getState(), captured).operations[supplied.id]) {
         requireCore(supplied?.intentHash === hash(supplied.intent) && supplied.subjectId === captured.subjectId &&
           supplied.target?.account === captured.accountId, 'DELETE_RESERVATION_UNPROVEN');
        const pending = preparedReservations.get(supplied.id), owner = getState().meetings[targetKey(supplied.target)];
        requireCore(pending?.phase === 'prepare' && pending.intentHash === supplied.intentHash &&
          isDeepStrictEqual(pending.target, supplied.target) && owner && !owner.fenced &&
          owner.epoch === supplied.intent.originalEpoch && owner.revision === supplied.intent.revision, 'DELETE_RESERVATION_UNPROVEN');
        return true;
      }
      const phases = ['prepare', 'assert', 'published', 'nonpublished', 'restore'];
      requireCore(phases.includes(phase) && supplied?.intentHash === hash(supplied.intent) &&
        supplied.target.account === captured.accountId, 'DELETE_RESERVATION_UNPROVEN');
      if (phase === 'prepare' || phase === 'nonpublished') {
        const pending = preparedReservations.get(supplied.id);
        requireCore(pending && pending.phase === phase && pending.intentHash === supplied.intentHash &&
          isDeepStrictEqual(pending.target, supplied.target), 'DELETE_RESERVATION_UNPROVEN');
        requireCore(!ledger(getState(), captured).operations[supplied.id], 'DELETE_ALREADY_PUBLISHED');
      } else {
        const actual = operation(getState(), captured, supplied.id);
        requireCore(actual.intentHash === supplied.intentHash && isDeepStrictEqual(actual.intent, supplied.intent), 'DELETE_RESERVATION_UNPROVEN');
        fenced(getState(), captured, actual);
      }
      return true;
    },
    installIntegrationDeleteInventory(controlContext, candidate) {
      context(controlContext); requireCore(!inventory && candidate?.contract === NATIVE_DELETE_CONTRACT &&
        ['snapshot', 'reserve', 'assertReserved', 'verifyPosts', 'inspectPost', 'applyMetadata', 'performPhysical', 'finalize', 'confirmPublished', 'abortKnownReservation']
          .every(method => typeof candidate[method] === 'function'), 'DELETE_REAL_INVENTORY_REQUIRED');
      inventory = candidate;
    },
    inspectPrivateIntegrationState(controlContext) { context(controlContext); return copy(getState()); },
    inspectIntegrationDeleteOperation(controlContext, operationId) {
      const captured = context(controlContext); return copy(operation(getState(), captured, operationId));
    },
    async snapshotIntegrationDeletion(controlContext, expectedTarget) {
      return serialize(async () => { const { captured } = await checked(controlContext); context(controlContext);
        const expected = target(captured, expectedTarget); return copy((await snapshot(getState(), captured, expected)).value); });
    },
    async verifyIntegrationDeleteSnapshot(controlContext, input) {
      return serialize(async () => { const { captured } = await checked(controlContext); context(controlContext);
        const actual = await snapshot(getState(), captured, target(captured, input.target));
        requireCore(isDeepStrictEqual(actual.value, input.snapshot), 'DELETE_INVENTORY_CHANGED');
        return { snapshotHash: hash(actual.value), inventoryHash: actual.value.coverage.inventoryHash,
          writerRevision: actual.writerRevision, unknowns: actual.unknowns }; });
    },
    async putIntegrationDeletePlan(controlContext, plan) {
      const captured = context(controlContext); target(captured, plan.target); identifier(plan.id);
      requireCore(plan.graph?.contract === NATIVE_DELETE_CONTRACT && isDeepStrictEqual(plan.graph.target, plan.target) &&
        sha(plan.graph.snapshotHash) && sha(plan.graph.manifestHash), 'DELETE_PLAN_INVALID');
      const result = await latest(controlContext, next => {
        const data = copy(ledger(next, captured)), now = time(data); requireCore(plan.createdAt <= now && plan.expiresAt > now &&
          plan.expiresAt - plan.createdAt <= 300000 && !data.plans[plan.id], 'DELETE_PLAN_INVALID');
        data.plans[plan.id] = copy(plan); save(next, captured, data); return copy(plan);
      }, 'allowDelete', { operation: 'putIntegrationDeletePlan', deleteTarget: copy(plan.target), requiredPermissions: ['allowDelete'] });
      return result.value;
    },
    async getIntegrationDeletePlan(controlContext, planId) {
      identifier(planId); return serialize(async () => { const { captured } = await checked(controlContext); context(controlContext);
        return copy(ledger(getState(), captured).plans[planId] ?? null); });
    },
    async getIntegrationDeleteOperation(controlContext, operationId) {
      identifier(operationId); return serialize(async () => { const { captured } = await checked(controlContext); context(controlContext);
        const value = ledger(getState(), captured).operations[operationId]; return value ? copy(operation(getState(), captured, operationId)) : null; });
    },
    async beginIntegrationDeletion(controlContext, inputValue) {
      const captured = context(controlContext), input = copy(inputValue); identifier(input.id); target(captured, input.target);
      let reserveToken, approved, published = false;
      // latest prepare must be synchronous; asynchronous physical enumeration happens
      // first under serialize. Its native sequence is then pinned in the transaction.
      const preflight = await serialize(async () => {
        await checked(controlContext); const existing = ledger(getState(), captured).operations[input.id];
        if (existing) { requireCore(existing.intentHash === input.intentHash && isDeepStrictEqual(existing.target, input.target), 'DELETE_OPERATION_CONFLICT'); return { existing: copy(existing) }; }
        const state = getState(), data = ledger(state, captured), plan = data.plans[input.intent.planId];
        const actual = await snapshot(state, captured, input.target); strictIntent(input, plan, actual);
        requireCore(time(data) < plan.expiresAt && time(data) < input.intent.expiresAt, 'DELETE_PLAN_EXPIRED');
        return { sequence: state.sequence, actual, plan: copy(plan) };
      });
      if (preflight.existing) return preflight.existing;
      try {
        const result = await latest(controlContext, next => {
          requireCore(next.sequence === preflight.sequence, 'DELETE_INVENTORY_CHANGED');
          const data = copy(ledger(next, captured)); strictIntent(input, data.plans[input.intent.planId], preflight.actual);
          requireCore(time(data) < input.intent.expiresAt && !data.targets[targetKey(input.target)], 'DELETE_PLAN_STALE');
          const op = { id: input.id, subjectId: captured.subjectId, target: copy(input.target), intent: copy(input.intent), intentHash: input.intentHash,
            state: 'deleting', progress: {} };
          for (const item of op.intent.items) { requireCore(!data.reservations[item.key], 'DELETE_ASSET_RESERVED'); data.reservations[item.key] = op.id; }
          preparedReservations.set(op.id, { phase: 'prepare', intentHash: op.intentHash, target: copy(op.target) });
          approved = op;
          reserveToken = provider().reserve({ state: copy(next), operation: copy(op), snapshot: copy(preflight.actual.value) });
          requireCore(reserveToken && typeof reserveToken.then !== 'function' && Array.isArray(reserveToken.descriptors) &&
            reserveToken.inventoryHash === preflight.actual.value.coverage.inventoryHash &&
            reserveToken.descriptorsHash === hash(reserveToken.descriptors), 'DELETE_RESERVATION_UNPROVEN');
          op.inventoryDescriptors = copy(reserveToken.descriptors); op.inventoryDescriptorsHash = reserveToken.descriptorsHash; approved = op;
          data.operations[op.id] = op; data.targets[targetKey(op.target)] = op.id;
          const owner = next.meetings[targetKey(op.target)];
          requireCore(owner && !owner.fenced && owner.epoch === op.intent.originalEpoch && owner.revision === op.intent.revision, 'DELETE_PLAN_STALE');
          owner.fenced = true; owner.epoch = revision(owner.epoch + 1); owner.revision = revision(owner.revision + 1);
          owner.deletionOperationId = op.id; owner.deletionState = 'deleting'; save(next, captured, data); return copy(op);
        }, 'allowDelete', { operation: 'beginIntegrationDeletion', deleteTarget: input.target,
          dependencyMeetings: [{ meetingId: input.target.meeting, epoch: input.intent.originalEpoch, revision: input.intent.revision }],
          requiredPermissions: ['allowDelete', 'allowFence', 'allowCoordinateReferences'] },
          { assertPublication: () => assertReserved({ operation: copy(approved), token: reserveToken }) });
        published = true;
        const confirmation = provider().confirmPublished({ operation: copy(result.value), token: reserveToken });
        requireCore(!confirmation || typeof confirmation.then !== 'function', 'ASYNC_PUBLICATION_GUARD_FORBIDDEN');
        return result.value;
      } catch (error) {
        // An uncertain durable outcome cannot release admission or reservations.
        if (reserveToken && !published && error.code !== 'JOURNAL_UNCERTAIN' && !ledger(getState(), captured).operations[input.id]) {
          preparedReservations.set(input.id, { phase: 'nonpublished', intentHash: input.intentHash, target: copy(input.target) });
          provider().abortKnownReservation({ operation: copy(approved), token: reserveToken });
        }
        throw error;
      } finally {
        if (published || !reserveToken) preparedReservations.delete(input.id);
        else if (preparedReservations.get(input.id)?.phase === 'nonpublished') preparedReservations.delete(input.id);
      }
    },
    async assertIntegrationDeleteIntent(controlContext, supplied) {
      return serialize(async () => { const { captured } = await checked(controlContext); context(controlContext);
        const op = operation(getState(), captured, supplied.id); requireCore(op.intentHash === supplied.intentHash &&
          isDeepStrictEqual(op.intent, supplied.intent), 'DELETE_INTENT_CONFLICT'); fenced(getState(), captured, op);
        assertReserved({ state: copy(getState()), operation: copy(op) }); return true; });
    },
    async inspectIntegrationDeleteItem(controlContext, step) {
      return serialize(async () => { const { captured } = await checked(controlContext); context(controlContext);
        const op = operation(getState(), captured, step.operationId), item = opItem(op, step.item.key); fenced(getState(), captured, op);
        requireCore(op.intentHash === step.intentHash && isDeepStrictEqual(item, step.item) && step.stepHash === stepHash(op, item), 'DELETE_ITEM_UNAPPROVED');
        assertReserved({ state: copy(getState()), operation: copy(op) });
        const observed = await provider().inspectPost({ state: copy(getState()), operation: copy(op), item: copy(item) });
        requireCore(['done', 'notStarted', 'unknown'].includes(observed?.state), 'DELETE_POST_UNPROVEN');
        if (observed.state === 'done') requireCore(observed.postHash === postHash(item), 'DELETE_POST_CONFLICT');
        return receipt(op, item, observed.state); });
    },
    async applyIntegrationDeleteItem(controlContext, step) {
      const captured = context(controlContext);
      const original = await serialize(async () => { await checked(controlContext); const op = operation(getState(), captured, step.operationId);
        const item = opItem(op, step.item.key); fenced(getState(), captured, op);
        requireCore(op.intentHash === step.intentHash && step.stepHash === stepHash(op, item) && isDeepStrictEqual(item, step.item) &&
          ['intent', 'done'].includes(op.progress[item.key]?.phase), 'DELETE_ITEM_UNAPPROVED'); return { op: copy(op), item: copy(item) }; });
      if (original.item.storage === 'physical') {
        assertReserved({ operation: copy(original.op) });
        await internal.guardedExternal(controlContext, 'allowDelete', lane(original.op, 'applyIntegrationDeletePhysical'),
          () => provider().performPhysical({ operation: copy(original.op), item: copy(original.item), stepHash: step.stepHash }));
        return; // Apply is NEVER proof; runtime must inspect exact post.
      }
      const result = await latest(controlContext, next => {
        const op = operation(next, captured, original.op.id), item = opItem(op, original.item.key); fenced(next, captured, op);
        requireCore(op.intentHash === original.op.intentHash && op.progress[item.key]?.stepHash === step.stepHash, 'DELETE_ITEM_UNAPPROVED');
        assertReserved({ state: copy(next), operation: copy(op) });
        const observed = provider().applyMetadata({ state: next, operation: copy(op), item: copy(item) });
        requireCore(observed && typeof observed.then !== 'function' && observed.postHash === postHash(item), 'DELETE_POST_CONFLICT'); return observed;
      }, 'allowDelete', lane(original.op, 'applyIntegrationDeleteItem'),
        { assertPublication: () => assertReserved({ operation: copy(original.op) }) });
      return result.value;
    },
    async saveIntegrationDeleteProgress(controlContext, input) {
      const captured = context(controlContext); identifier(input.operationId); identifier(input.key);
      const existing = operation(getState(), captured, input.operationId);
      const result = await latest(controlContext, next => {
        const op = operation(next, captured, input.operationId); fenced(next, captured, op); const item = opItem(op, input.key);
        requireCore(input.value?.stepHash === stepHash(op, item) && ['intent', 'done'].includes(input.value.phase) &&
          (input.value.phase !== 'done' || input.value.postHash === postHash(item)), 'DELETE_PROGRESS_INVALID');
        const old = op.progress[item.key]; requireCore(!old || old.phase !== 'done' || isDeepStrictEqual(old, input.value), 'DELETE_PROGRESS_REGRESSION');
        requireCore(op.state !== 'deleted', 'DELETE_ALREADY_FINAL'); op.progress[item.key] = copy(input.value);
        save(next, captured, ledger(next, captured)); return copy(op);
      }, 'allowDelete', lane(existing, 'saveIntegrationDeleteProgress')); return result.value;
    },
    async failIntegrationDeletion(controlContext, input) {
      const captured = context(controlContext); identifier(input.code); const existing = operation(getState(), captured, input.operationId);
      const result = await latest(controlContext, next => { const op = operation(next, captured, input.operationId);
        if (op.state === 'deleted') return copy(op); fenced(next, captured, op); op.state = 'deleting_failed'; op.errorCode = input.code;
        next.meetings[targetKey(op.target)].deletionState = 'deleting_failed'; save(next, captured, ledger(next, captured)); return copy(op);
      }, 'allowDelete', lane(existing, 'failIntegrationDeletion')); return result.value;
    },
    async finishIntegrationDeletion(controlContext, input) {
      const captured = context(controlContext);
      const preflight = await serialize(async () => {
        await checked(controlContext); const op = operation(getState(), captured, input.operationId);
        if (op.state === 'deleted') { requireCore(op.intentHash === input.intentHash, 'DELETE_INTENT_CONFLICT'); return { existing: copy(op) }; }
        fenced(getState(), captured, op); requireCore(op.intentHash === input.intentHash && Array.isArray(input.proofs) &&
          input.proofs.length === op.intent.items.length && new Set(input.proofs.map(proof => proof.key)).size === input.proofs.length, 'DELETE_FINALIZATION_UNPROVEN');
        for (const item of op.intent.items) {
          const proof = input.proofs.find(value => value.key === item.key); requireCore(proof && proof.operationId === op.id &&
            proof.stepHash === stepHash(op, item) && proof.state === 'done' && proof.postHash === postHash(item) &&
            op.progress[item.key]?.phase === 'done' && op.progress[item.key].postHash === proof.postHash, 'DELETE_POST_UNPROVEN');
        }
        await provider().verifyPosts({ state: copy(getState()), operation: copy(op), proofs: copy(input.proofs) });
        return { sequence: getState().sequence, op: copy(op) };
      });
      if (preflight.existing) return preflight.existing;
      const result = await latest(controlContext, next => {
        requireCore(next.sequence === preflight.sequence, 'DELETE_FINALIZATION_CHANGED'); const op = operation(next, captured, input.operationId); fenced(next, captured, op);
        assertReserved({ state: copy(next), operation: copy(op) });
        const finalized = provider().finalize({ state: next, operation: copy(op) });
        requireCore(finalized && typeof finalized.then !== 'function' && finalized.remainingSensitive === 0 && finalized.liveResources === 0, 'DELETE_FINALIZATION_UNPROVEN');
        op.state = 'deleted'; delete op.errorCode; next.meetings[targetKey(op.target)].deletionState = 'deleted';
        save(next, captured, ledger(next, captured)); return copy(op);
      }, 'allowDelete', lane(preflight.op, 'finishIntegrationDeletion'),
        { assertPublication: () => assertReserved({ operation: copy(preflight.op) }) }); return result.value;
    },
    async drainIntegrationDeleteJobs(controlContext, operationId) {
      const op = await serialize(async () => { const { captured } = await checked(controlContext); const value = operation(getState(), captured, operationId);
        fenced(getState(), captured, value); return copy(value); });
      // Never hold native queue while waiting on a task that releases a native lease.
      await internal.interruptMeetingJobs(op.target.account, op.target.meeting, op.intent.originalEpoch);
    }
  };
}
