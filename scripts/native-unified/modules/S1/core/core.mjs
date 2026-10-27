import { open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { constants, lstatSync, fstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreError, requireCore, identifier, revision, copy, meetingKey, validateState } from './validation.mjs';
import { assetMethods } from './assets.mjs';
import { jobMethods } from './jobs.mjs';
import { wordMethods } from './word.mjs';
import { compatMethods } from './compat.mjs';
import { integrationMethods, ACCOUNT_CONTROL_MEETING, newIntegrationOrigin } from './integration-state.mjs';
import { deletionMethods } from './delete-state.mjs';
export { CoreError, requireCore, identifier, revision } from './validation.mjs';
// Controlled fork: original p2.3 evidence remains bound to frozen inputs, not this extension.
import { CONTRACT_VERSION } from './contract-version.mjs';
export { CONTRACT_VERSION } from './contract-version.mjs';
const contexts = new WeakMap();
// Failed shutdown is quarantined, not delegated to FileHandle garbage collection.
const quarantinedCores = new Set();
const quarantinedStartups = new Set();
function startupRecovery(owner, lockPath, originalError, cleanup) {
  let ownerClosed = !owner, lockRemoved = !owner, lockRemovalSynced = !owner, rootClosed = false, phase = 'pending', closePromise;
  const record = { owner, originalError, recovery: null };
  quarantinedStartups.add(record);
  const recovery = Object.freeze({
    status: () => Object.freeze({ phase, ownerClosed, lockRemoved, lockRemovalSynced, rootClosed,
      retainedTransientHandles: cleanup.retainedTransientHandles(), ownerBarrierHeld: phase !== 'closed' }),
    retryClose() {
      if (phase === 'closing' || phase === 'closed') return closePromise;
      requireCore(phase === 'pending' || phase === 'failed', 'CLOSE_RETRY_NOT_ALLOWED');
      phase = 'closing';
      let succeed, fail;
      closePromise = new Promise((resolve, reject) => { succeed = resolve; fail = reject; });
      closePromise.catch(() => {}); // A reentrant observer need not attach before a sync failure.
      // Publish the gate before invoking either trusted cleanup function.
      const pipeline = async () => {
        try {
          if (!ownerClosed) { await cleanup.closeOwner(owner); ownerClosed = true; }
          if (!lockRemoved) { await cleanup.unlinkLock(lockPath); lockRemoved = true; }
           if (!lockRemovalSynced) { await cleanup.syncRoot(); lockRemovalSynced = true; }
           await cleanup.closeTransient();
           if (!rootClosed) { await cleanup.closeRoot(); rootClosed = true; }
           phase = 'closed'; quarantinedStartups.delete(record);
        } catch (error) {
          phase = 'failed'; originalError.startupCleanupError = error;
          originalError.startupCleanupErrors = Object.freeze([...(originalError.startupCleanupErrors ?? []), error]);
          throw error;
        }
      };
      pipeline().then(succeed, fail); return closePromise;
    }
  });
  record.recovery = recovery; return recovery;
}
export async function openCore({ directory, authenticate, authorizeCommit, authorizeRead, clock = Date.now, startupCleanup }) {
  requireCore(typeof authenticate === 'function', 'AUTH_BACKEND_REQUIRED');
  requireCore(typeof directory === 'string' && directory.length > 0, 'INVALID_DIRECTORY');
  requireCore(typeof clock === 'function', 'INVALID_CLOCK');
  const startupHooks = startupCleanup ?? { closeOwner: handle => handle.close(), unlinkLock: path => unlink(path) };
  requireCore(typeof startupHooks.closeOwner === 'function' && typeof startupHooks.unlinkLock === 'function',
    'INVALID_STARTUP_CLEANUP');
  requireCore(process.platform === 'linux' && [constants.O_DIRECTORY, constants.O_NOFOLLOW].every(Number.isInteger), 'NATIVE_ROOT_IO_UNSUPPORTED');
  const root = resolve(directory);
  requireCore(await realpath(root) === root, 'CORE_CANONICAL_ROOT_REQUIRED');
  const rootIdentity = await lstat(root, { bigint: true });
  requireCore(rootIdentity.isDirectory() && rootIdentity.uid === BigInt(process.getuid()) &&
    (rootIdentity.mode & 0o077n) === 0n, 'CORE_PRIVATE_ROOT_REQUIRED');
  let rootHandle, rootHandleClosed = false, lockPath, owner, ownerIdentity, ownerHandleClosed = false,
    ownerLockRemoved = false, ownerLockRemovalSynced = false;
  function rootAnchor() {
    requireCore(rootHandle && !rootHandleClosed, 'CORE_ROOT_FD_CLOSED');
    return '/proc/self/fd/' + rootHandle.fd;
  }
  async function closeRootHandle() {
    if (rootHandle && !rootHandleClosed) { await rootHandle.close(); rootHandleClosed = true; }
  }
  const transientHandles = new Set();
  function assertRootIdentity() {
    const named = lstatSync(root, { bigint: true });
    requireCore(named.isDirectory() && ['dev', 'ino', 'uid', 'mode'].every(key =>
      named[key] === rootIdentity[key]), 'CORE_ROOT_IDENTITY_CHANGED');
    if (rootHandle && !rootHandleClosed) {
      const actual = fstatSync(rootHandle.fd, { bigint: true });
      requireCore(actual.isDirectory() && ['dev', 'ino', 'uid', 'mode'].every(key =>
        actual[key] === rootIdentity[key]), 'CORE_ROOT_FD_CHANGED');
    }
  }
  async function closeTransientHandles() {
    for (const handle of transientHandles) { await handle.close(); transientHandles.delete(handle); }
  }
  async function syncRootDirectory() {
    await closeTransientHandles(); assertRootIdentity();
    requireCore(rootHandle && !rootHandleClosed, 'CORE_ROOT_FD_CLOSED');
    await rootHandle.sync(); assertRootIdentity();
  }
  function assertOwnerIdentity() {
    requireCore(ownerIdentity, 'CORE_OWNER_IDENTITY_UNPROVEN');
    assertRootIdentity(); const named = lstatSync(lockPath, { bigint: true });
    requireCore(named.isFile() && named.nlink === 1n && ['dev', 'ino', 'uid', 'mode'].every(key =>
      named[key] === ownerIdentity[key]), 'CORE_OWNER_IDENTITY_CHANGED');
    if (!ownerHandleClosed) {
      const actual = fstatSync(owner.fd, { bigint: true });
      requireCore(actual.isFile() && actual.nlink === 1n && ['dev', 'ino', 'uid', 'mode'].every(key =>
        actual[key] === ownerIdentity[key]), 'CORE_OWNER_FD_CHANGED');
    }
  }
  let state, stateReadHandle;
  try {
    rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    assertRootIdentity();
    requireCore(await realpath(root) === root, 'CORE_CANONICAL_ROOT_REQUIRED');
    lockPath = join(rootAnchor(), 'owner.lock');
    try { owner = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new CoreError('CORE_ALREADY_OWNED'); throw error; }
    ownerIdentity = await owner.stat({ bigint: true });
    requireCore(ownerIdentity.isFile() && ownerIdentity.uid === BigInt(process.getuid()) &&
      ownerIdentity.nlink === 1n && (ownerIdentity.mode & 0o077n) === 0n, 'CORE_PRIVATE_OWNER_REQUIRED');
    assertOwnerIdentity();
    await owner.writeFile(randomUUID()); await owner.sync(); assertOwnerIdentity();
    await syncRootDirectory(); assertOwnerIdentity();
    try {
      requireCore(process.platform === 'linux' && Number.isInteger(constants.O_NOFOLLOW), 'NATIVE_STATE_IO_UNSUPPORTED');
      const statePath = join(rootAnchor(), 'state.json');
      stateReadHandle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW); transientHandles.add(stateReadHandle);
      const before = await stateReadHandle.stat({ bigint: true });
      requireCore(before.isFile() && before.uid === BigInt(process.getuid()) && before.nlink === 1n &&
        (before.mode & 0o077n) === 0n && before.size > 0n && before.size <= 67108864n, 'JOURNAL_INVALID');
      // Read at most the observed size plus one byte, even if another writer grows it.
      const buffer = Buffer.alloc(Number(before.size) + 1); let position = 0;
      while (position < buffer.length) {
        const { bytesRead } = await stateReadHandle.read(buffer, position, buffer.length - position, position);
        if (bytesRead === 0) break; position += bytesRead;
      }
      requireCore(position === Number(before.size), 'JOURNAL_INVALID');
      const after = await stateReadHandle.stat({ bigint: true });
      const named = await lstat(statePath, { bigint: true });
      requireCore(named.isFile() && ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
        .every(key => before[key] === after[key] && before[key] === named[key]), 'JOURNAL_INVALID');
      const bytes = buffer.subarray(0, position), utf8 = bytes.toString('utf8');
      requireCore(Buffer.from(utf8, 'utf8').equals(bytes), 'JOURNAL_INVALID');
      await stateReadHandle.close(); transientHandles.delete(stateReadHandle); stateReadHandle = undefined;
      state = JSON.parse(utf8);
    }
    catch (error) {
      // ENOENT after a handle was acquired is disappearance, not an empty new store.
      if (error.code !== 'ENOENT' || stateReadHandle) throw new CoreError('JOURNAL_INVALID');
      state = { schema: 1, sequence: 0, meetings: {}, assets: {}, jobs: {}, documents: {}, adapters: {}, handlers: {} };
    }
    validateState(state); assertOwnerIdentity();
  } catch (error) {
    if (!owner && !rootHandle) throw error;
    const recovery = startupRecovery(owner, lockPath, error, {
      ...startupHooks,
      async closeOwner(handle) {
        if (stateReadHandle) { await stateReadHandle.close(); transientHandles.delete(stateReadHandle); stateReadHandle = undefined; }
        await closeTransientHandles();
        await startupHooks.closeOwner(handle); ownerHandleClosed = true;
      },
      async unlinkLock(ownedPath) { assertOwnerIdentity(); await startupHooks.unlinkLock(ownedPath); ownerLockRemoved = true; },
      syncRoot: syncRootDirectory, closeTransient: closeTransientHandles, closeRoot: closeRootHandle,
      retainedTransientHandles: () => transientHandles.size
    });
    // Preserve startup's original failure even if its cleanup also fails.
    try { await recovery.retryClose(); }
    catch { error.startupRecovery = recovery; }
    throw error;
  }
  let closed = false, closing = false, closePromise, closeFailed = false,
    poisoned = false, tail = Promise.resolve();
  const secret = {}, leases = new Map(), closeHooks = new Set();
  function active() { requireCore(!closed && !closing, 'CORE_CLOSED'); requireCore(!poisoned, 'JOURNAL_UNCERTAIN'); assertOwnerIdentity(); }
  function serialize(fn) {
    const pending = tail.then(() => { active(); return fn(); }); tail = pending.catch(() => {}); return pending;
  }
  async function persist(next, publicationGuard) {
    active(); validateState(next);
    const encodedState = Buffer.from(JSON.stringify(next), 'utf8');
    requireCore(encodedState.length > 0 && encodedState.length <= 67108864, 'JOURNAL_SIZE_LIMIT');
    const temporary = join(rootAnchor(), 'state-' + randomUUID() + '.pending');
    let file, guardRejected = false, renameStarted = false;
    try {
      file = await open(temporary, 'wx', 0o600); transientHandles.add(file);
      await file.writeFile(encodedState); await file.sync(); await file.close(); transientHandles.delete(file); file = null;
      // Consume the original composed lifecycle after every preparation I/O await.
      // No await separates this synchronous check from invoking publication.
      try { assertOwnerIdentity(); publicationGuard(); } catch (error) { guardRejected = true; throw error; }
      renameStarted = true;
      await rename(temporary, join(rootAnchor(), 'state.json'));
      await syncRootDirectory();
      state = next;
    } catch (error) {
      // A rejected guard before rename is known non-publication, not uncertain I/O.
      // Keep the closed pending image as evidence; never import it automatically.
      if (guardRejected && !renameStarted) throw error;
      poisoned = true;
      if (file) { try { await file.close(); transientHandles.delete(file); } catch { /* Retain actual FD for close/retry. */ } }
      throw new CoreError('JOURNAL_UNCERTAIN');
    }
  }
  function checkAuth(auth, captured, permission = 'allowMeeting') {
    requireCore(auth?.accountId === captured.accountId && auth?.subjectId === captured.subjectId, 'AUTH_REVOKED');
    requireCore(auth.meetingId === captured.meetingId && auth.allowMeeting === true && auth[permission] === true, 'AUTH_DENIED');
  }
  async function identity(context) {
    const captured = context && contexts.get(context); requireCore(captured?.owner === secret, 'UNTRUSTED_CONTEXT');
    checkAuth(await authenticate(captured.credential), captured); captured.assertActive?.(); return captured;
  }
  async function checked(context) {
    const captured = await identity(context), key = meetingKey(captured.accountId, captured.meetingId), row = state.meetings[key];
    requireCore(row, 'MEETING_NOT_FOUND'); requireCore(row.epoch === captured.epoch, 'EPOCH_STALE');
    requireCore(!row.fenced, 'MEETING_FENCED'); return { captured, key, row };
  }
  async function guardedCommit(captured, permission, details, commit) {
    requireCore(typeof authorizeCommit === 'function', 'AUTH_WRITE_BACKEND_REQUIRED');
    let calls = 0, operation, accepting = true, committed = false;
    const guarded = async auth => {
      requireCore(accepting && ++calls === 1, 'AUTH_GUARD_INVALID');
      operation = (async () => {
        checkAuth(auth, captured, permission);
        for (const required of details.requiredPermissions ?? []) checkAuth(auth, captured, required);
        if (details.operation === 'setReferences' || details.references?.length > 0) {
          requireCore(auth.referenceCoordination?.coverage === 'verified' &&
            Number.isSafeInteger(auth.referenceCoordination?.revision) && auth.referenceCoordination.revision > 0 &&
            JSON.stringify(auth.referenceCoordination.references) === JSON.stringify(details.references), 'REFERENCE_COVERAGE_UNKNOWN');
        }
        active(); const value = await commit(); committed = true; return value;
      })(); return operation;
    };
    try {
      await authorizeCommit(captured.credential, Object.freeze({ accountId: captured.accountId, subjectId: captured.subjectId,
        meetingId: captured.meetingId, epoch: captured.epoch, contractVersion: captured.contractVersion,
        permission, details: copy(details) }), guarded);
      requireCore(calls === 1, 'AUTH_GUARD_INVALID'); return await operation;
    } catch (error) {
      if (operation) await operation.catch(() => {});
      if (committed) { poisoned = true; throw new CoreError('JOURNAL_UNCERTAIN'); } throw error;
    } finally { accepting = false; }
  }
  // Synchronous commit-domain check. No serialize reentry while the core queue is held.
  function pinLease(context, token) {
    const captured = contexts.get(context);
    requireCore(captured?.owner === secret, 'UNTRUSTED_CONTEXT');
    const key = meetingKey(captured.accountId, captured.meetingId) + ':' + token?.resource, lease = leases.get(key);
    requireCore(lease?.token === token && lease.context === context && token.epoch === captured.epoch &&
      lease.expiresAt > clock(), 'LEASE_EXPIRED');
    lease.commitPins++;
    return () => { lease.commitPins--; };
  }
  const LATEST = Symbol('internal-current-revision');
  async function transaction(context, expectedRevision, mutate, permission = 'allowMeeting', details = {}, requirements = {}) {
    if (expectedRevision !== LATEST) revision(expectedRevision);
    return serialize(async () => {
      const { captured, key, row } = await checked(context);
      const expected = expectedRevision === LATEST ? row.revision : expectedRevision;
      requireCore(row.revision === expected, 'REVISION_CONFLICT');
      const commitDetails = requirements.prepareDetails ? requirements.prepareDetails(copy(state), key, captured) : details;
      requireCore(!commitDetails || typeof commitDetails.then !== 'function', 'ASYNC_MUTATION_FORBIDDEN');
      return guardedCommit(captured, permission, commitDetails, async () => {
        await checked(context);
        let unpin;
        try {
          if (requirements.lease) unpin = pinLease(context, requirements.lease);
          captured.assertActive?.();
          const next = copy(state), result = mutate(next, key, captured);
          requireCore(!result || typeof result.then !== 'function', 'ASYNC_MUTATION_FORBIDDEN');
          if (JSON.stringify(next) === JSON.stringify(state)) return { revision: expected, value: copy(result) };
          next.meetings[key].revision = revision(expected + 1); next.sequence = revision(next.sequence + 1);
          // Lease admission linearizes above; reservation survives I/O until durable outcome.
          // Competing acquire/release/fence transactions cannot enter this held queue.
          await persist(next, () => {
            active(); captured.assertActive?.();
            const assertion = requirements.assertPublication?.();
            requireCore(!assertion || typeof assertion.then !== 'function', 'ASYNC_PUBLICATION_GUARD_FORBIDDEN');
          });
          return { revision: next.meetings[key].revision, value: copy(result) };
        } finally { unpin?.(); }
      });
    });
  }
  const internal = { transaction, serialize, checked, identity, getState: () => state,
    latest: (context, mutate, permission, details, requirements) => transaction(context, LATEST, mutate, permission, details, requirements),
    claimResource: (context, resource) => api.acquireLease(context, { resource }),
    heartbeatResource: (context, token) => api.heartbeatLease(context, token),
    releaseResource: (context, token) => api.releaseLease(context, token),
    onClosing: callback => api.onClosing(callback), authorizeRead, authenticate, copy, clock, version: CONTRACT_VERSION,
    assertContext: context => api.assertContextActive(context), capturedContext: context => contexts.get(context),
    interruptMeetingJobs: (...args) => runner.interruptMeeting(...args),
    guardedExternal: (context, permission, details, operation) => serialize(async () => {
      const { captured } = await checked(context);
      return guardedCommit(captured, permission, details, async () => { await checked(context); return operation(); });
    }) };
  const runner = jobMethods(internal);
  const words = wordMethods(internal);
  const compat = compatMethods(internal);
  const api = {
    version: CONTRACT_VERSION,
    async createMeeting(credential, meetingId) {
      identifier(meetingId);
      return serialize(async () => {
        const auth = await authenticate(credential);
        requireCore(auth?.allowMeeting === true && auth.meetingId === meetingId, 'AUTH_DENIED'); identifier(auth.subjectId);
        const key = meetingKey(auth.accountId, meetingId); requireCore(!state.meetings[key], 'MEETING_EXISTS');
        const captured = { accountId: auth.accountId, subjectId: auth.subjectId, meetingId, credential };
        return guardedCommit(captured,
          'allowMeeting', { operation: 'createMeeting' }, async () => {
            const next = copy(state); next.meetings[key] = { accountId: auth.accountId, meetingId, epoch: 1, revision: 0, fenced: false,
              ...(meetingId === ACCOUNT_CONTROL_MEETING ? { integrationOrigin: newIntegrationOrigin() } : {}) };
            next.sequence = revision(next.sequence + 1);
            await persist(next, () => { active(); captured.assertActive?.(); }); return copy(next.meetings[key]);
          });
      });
    },
    async capture(credential, meetingId) {
      return serialize(async () => {
        const auth = await authenticate(credential);
        requireCore(auth?.allowMeeting === true && auth.meetingId === meetingId, 'AUTH_DENIED'); identifier(auth.subjectId);
        const key = meetingKey(auth.accountId, meetingId), row = state.meetings[key];
        requireCore(row, 'MEETING_NOT_FOUND'); requireCore(!row.fenced, 'MEETING_FENCED');
        const token = Object.freeze({ accountId: auth.accountId, meetingId, subjectId: auth.subjectId,
          epoch: row.epoch, contractVersion: CONTRACT_VERSION });
        contexts.set(token, { ...token, credential, owner: secret }); return token;
      });
    },
    // Trusted feature adapter binds cancellation to the same captured identity/epoch.
    guardContext(context, assertActive) {
      active(); const captured = contexts.get(context);
      requireCore(captured?.owner === secret && typeof assertActive === 'function', 'UNTRUSTED_CONTEXT');
      captured.assertActive?.(); assertActive();
      const token = Object.freeze({ ...context });
      contexts.set(token, { ...captured, assertActive: () => { captured.assertActive?.(); assertActive(); } }); return token;
    },
    assertContextActive(context) {
      active(); const captured = context && contexts.get(context);
      requireCore(captured?.owner === secret, 'UNTRUSTED_CONTEXT');
      const row = state.meetings[meetingKey(captured.accountId, captured.meetingId)];
      requireCore(row, 'MEETING_NOT_FOUND'); requireCore(row.epoch === captured.epoch, 'EPOCH_STALE');
      requireCore(!row.fenced, 'MEETING_FENCED'); captured.assertActive?.(); return true;
    },
    guardIntegrationPhysicalIO(context, { operationId } = {}, operation) {
      identifier(operationId); requireCore(typeof operation === 'function', 'PHYSICAL_IO_CALLBACK_REQUIRED');
      // Trusted Host-only bytes IO, not a second semantic publisher. This callback
      // MUST NOT reenter native APIs/authority queues. Native/authorization locks
      // remain held until actual IO settlement; namespace publication follows
      // separately and repeats original-context/CAS checks.
      return internal.guardedExternal(context, 'allowWriteAssets', { operation: 'integrationPhysicalIO', operationId }, operation);
    },
    inspectPrivateContextCredential(context) {
      api.assertContextActive(context); return contexts.get(context).credential;
    },
    inspectIntegrationRunnerState(controlContext) {
      api.assertContextActive(controlContext);
      requireCore(controlContext.meetingId === ACCOUNT_CONTROL_MEETING, 'DELETE_CONTROL_CONTEXT_REQUIRED');
      return { running: runner.inspectRunning(), leases: [...leases.values()]
        .filter(lease => lease.context.accountId === controlContext.accountId)
        .map(lease => ({ accountId: lease.context.accountId, meetingId: lease.context.meetingId, epoch: lease.context.epoch,
          resource: lease.token.resource, expiresAt: lease.expiresAt, commitPins: lease.commitPins })) };
    },
    composeContext(original, requestContext) {
      api.assertContextActive(original); api.assertContextActive(requestContext);
      const captured = contexts.get(original), requestCaptured = contexts.get(requestContext);
      requireCore(['accountId', 'subjectId', 'meetingId', 'epoch'].every(field =>
        captured[field] === requestCaptured[field]), 'CONTEXT_IDENTITY_MISMATCH');
      // guardContext preserves original credential/epoch and its complete guard chain.
      return api.guardContext(original, () => { api.assertContextActive(requestContext); });
    },
    async read(context) { return serialize(async () => copy((await checked(context)).row)); },
    async fence(context, expectedRevision) {
      return transaction(context, expectedRevision, (next, key) => {
        next.meetings[key].fenced = true; next.meetings[key].epoch = revision(next.meetings[key].epoch + 1);
        return { epoch: next.meetings[key].epoch, fenced: true };
      }, 'allowFence', { operation: 'fence' });
    },
    async acquireLease(context, { resource, ttlMs = 30000 }) {
      identifier(resource); requireCore(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 300000, 'INVALID_TTL');
      return serialize(async () => {
        const { key, captured } = await checked(context), leaseKey = key + ':' + resource, existing = leases.get(leaseKey);
        requireCore(!existing || (existing.commitPins === 0 && existing.expiresAt <= clock()), 'LEASE_CONFLICT');
        const token = Object.freeze({ id: randomUUID(), resource, epoch: captured.epoch });
        leases.set(leaseKey, { token, context, expiresAt: clock() + ttlMs, commitPins: 0 }); return token;
      });
    },
    async heartbeatLease(context, token, ttlMs = 30000) {
      requireCore(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 300000, 'INVALID_TTL');
      return serialize(async () => {
        const { key } = await checked(context), lease = leases.get(key + ':' + token?.resource);
        requireCore(lease?.token === token && lease.context === context && lease.expiresAt > clock(), 'LEASE_EXPIRED');
        lease.expiresAt = clock() + ttlMs; return { expiresAt: lease.expiresAt };
      });
    },
    async releaseLease(context, token) {
      return serialize(async () => {
        const captured = await identity(context), key = meetingKey(captured.accountId, captured.meetingId) + ':' + token?.resource;
        const lease = leases.get(key); requireCore(lease?.token === token && lease.context === context && lease.commitPins === 0,
          'LEASE_NOT_OWNED'); leases.delete(key);
      });
    },
    onClosing(callback) {
      active(); requireCore(typeof callback === 'function', 'INVALID_HANDLER'); closeHooks.add(callback);
      return () => { if (!closing) closeHooks.delete(callback); };
    },
    closeStatus() {
      return Object.freeze({ phase: closed ? 'closed' : closeFailed ? 'failed' : closing ? 'closing' : 'open',
        ownerBarrierHeld: !closed, failedHooks: closeFailed ? closeHooks.size : 0,
        lockRemoved: ownerLockRemoved, lockRemovalSynced: ownerLockRemovalSynced, rootHandleClosed, retainedTransientHandles: transientHandles.size });
    },
    retryClose() {
      requireCore(closeFailed && !closed, 'CLOSE_RETRY_NOT_ALLOWED'); closeFailed = false; closePromise = undefined; return api.close();
    },
    ...assetMethods(internal), ...words, ...compat, ...runner.methods, ...integrationMethods(internal), ...deletionMethods(internal),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      let succeed, fail;
      closePromise = new Promise((resolve, reject) => { succeed = resolve; fail = reject; });
      closePromise.catch(() => {});
      // Start synchronously, but only AFTER publishing the unique reentry gate.
      const pipeline = async () => {
        // Attach rejection consumers immediately, even while cooperative runner shutdown waits.
        const cleanup = Promise.allSettled([...closeHooks].map(async callback => { await callback(); closeHooks.delete(callback); }));
        try {
          await runner.stop(); const outcomes = await cleanup; await tail;
          requireCore(outcomes.every(row => row.status === 'fulfilled'), 'RESOURCE_CLOSE_FAILED');
          await closeTransientHandles();
          if (!ownerHandleClosed) { assertOwnerIdentity(); await owner.close(); ownerHandleClosed = true; }
          if (!ownerLockRemoved) { assertOwnerIdentity(); await unlink(lockPath); ownerLockRemoved = true; }
          if (!ownerLockRemovalSynced) { await syncRootDirectory(); ownerLockRemovalSynced = true; }
          await closeTransientHandles(); await closeRootHandle(); closed = true; leases.clear(); quarantinedCores.delete(api);
        } catch {
          closeFailed = true; quarantinedCores.add(api);
          if (!ownerHandleClosed) {
            try { assertOwnerIdentity(); await owner.writeFile('\n' + JSON.stringify({ status: 'RESOURCE_CLOSE_FAILED',
              failedHooks: closeHooks.size, contractVersion: CONTRACT_VERSION })); await owner.sync(); } catch { /* Lock remains the barrier. */ }
          }
          throw new CoreError('RESOURCE_CLOSE_FAILED');
        }
      };
      pipeline().then(succeed, fail); return closePromise;
    }
  }; return Object.freeze(api);
}
