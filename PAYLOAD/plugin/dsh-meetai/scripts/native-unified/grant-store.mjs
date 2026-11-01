import { open, lstat, realpath, unlink, rename } from 'node:fs/promises';
import { lstatSync, fstatSync } from 'node:fs';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const GRANT_STORE_CONTRACT = 'admin-private-grant-store/1.0.0';
export const GRANT_PERMISSIONS = Object.freeze(['allowMeeting', 'allowCreateMeeting', 'allowWriteAssets', 'allowManageAdapters',
  'allowCoordinateReferences', 'allowWriteWord', 'allowFence', 'allowDelete', 'allowRegisterHandlers', 'allowRunJobs', 'allowManageJobs']);
const fail = code => Object.assign(new Error(code), { code });
const demand = (condition, code) => { if (!condition) throw fail(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(JSON.stringify(value));
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, names) => plain(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const MAX_BYTES = 1024 * 1024;
const quarantined = new Set();
const startupRecoveryOwners = new WeakSet();
export function isGrantStartupRecovery(owner) { return startupRecoveryOwners.has(owner); }
function unattestedOwnerRecovery(owner, lockPath, closeRoot) {
  let phase = 'retained-unattested', ownerClosed = false, rootClosed = false, closing;
  function close() {
    if (closing) return closing;
    phase = 'closing';
    closing = Promise.resolve().then(async () => {
      if (!ownerClosed) { await owner.close(); ownerClosed = true; }
      if (!rootClosed) { await closeRoot(); rootClosed = true; }
      // FD closure is not permission to delete an inode that was never attested.
      throw fail('GRANT_OWNER_RECONCILIATION_REQUIRED');
    }).catch(error => {
      phase = 'close-failed'; closing = undefined; error.reconciliationRequired = true; throw error;
    });
    return closing;
  }
  const recovery = Object.freeze({ contract: 'admin-grant-startup-recovery/1', close, retryClose: close,
    status: () => Object.freeze({ phase, ownerClosed, rootClosed, lockIdentityKnown: false,
      reconciliationRequired: true, grantsAvailable: false, ownerBarrierHeld: true }) });
  startupRecoveryOwners.add(recovery);
  quarantined.add({ owner, lockPath, recovery, reason: 'GRANT_OWNER_STAT_FAILED' });
  return recovery;
}
const noFollow = constants.O_NOFOLLOW;
demand(typeof noFollow === 'number', 'NOFOLLOW_CAPABILITY_REQUIRED');

/** Explicit, side-effect-free admin initialization validator. Never invents permissions. */
export function validateGrantConfiguration(value) {
  demand(exact(value, ['schema', 'revision', 'meetings', 'permissions']) && value.schema === 1 &&
    Number.isSafeInteger(value.revision) && value.revision > 0, 'GRANT_SCHEMA_INVALID');
  demand(Array.isArray(value.meetings) && value.meetings.length <= 10000 && value.meetings.every(validId) &&
    new Set(value.meetings).size === value.meetings.length, 'GRANT_MEETINGS_INVALID');
  demand(exact(value.permissions, GRANT_PERMISSIONS) && GRANT_PERMISSIONS.every(key => typeof value.permissions[key] === 'boolean'), 'GRANT_PERMISSIONS_INVALID');
  return structuredClone(value);
}
export function validateGrantFile(bytes) {
  demand(Buffer.isBuffer(bytes) || typeof bytes === 'string', 'GRANT_FILE_INVALID');
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  demand(raw.length > 0 && raw.length <= MAX_BYTES && Buffer.from(raw.toString('utf8'), 'utf8').equals(raw), 'GRANT_FILE_INVALID');
  let parsed; try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw fail('GRANT_FILE_INVALID'); }
  const grants = validateGrantConfiguration(parsed);
  return Object.freeze({ grants, hash: digest(grants), fileHash: hash(raw) });
}
function privateStat(stat, directory = false) {
  demand(directory ? stat.isDirectory() : stat.isFile(), 'GRANT_PRIVATE_PATH_REQUIRED');
  demand((stat.mode & 0o077) === 0 && typeof process.getuid === 'function' && stat.uid === process.getuid(), 'GRANT_PRIVATE_OWNER_REQUIRED');
  if (!directory) demand(stat.nlink === 1, 'GRANT_HARDLINK_REJECTED');
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function readPrivate(file, handles) {
  const handle = await open(file, constants.O_RDONLY | noFollow); handles.add(handle);
  try {
    const before = await handle.stat(); privateStat(before);
    demand(Number.isSafeInteger(before.size) && before.size > 0 && before.size <= MAX_BYTES, 'GRANT_FILE_INVALID');
    const bytes = Buffer.alloc(before.size + 1); let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) break; position += bytesRead;
    }
    demand(position === before.size, 'GRANT_FILE_CHANGED');
    const after = await handle.stat(), named = await lstat(file); privateStat(after); privateStat(named);
    demand(['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key =>
      before[key] === after[key] && before[key] === named[key]), 'GRANT_FILE_CHANGED');
    return bytes.subarray(0, position);
  } finally { await handle.close(); handles.delete(handle); }
}

/** Explicit startup only; not invoked during development/syntax checking. Existing grants required. */
export async function openGrantStore(directory, { initialFileHash } = {}) {
  demand(typeof directory === 'string' && directory.length > 0 && /^[a-f0-9]{64}$/.test(initialFileHash), 'GRANT_INITIAL_HASH_REQUIRED');
  const root = resolve(directory);
  demand(await realpath(root) === root, 'GRANT_SYMLINK_REJECTED');
  const rootStat = await lstat(root); privateStat(rootStat, true);
  demand(process.platform === 'linux' && Number.isInteger(constants.O_DIRECTORY), 'GRANT_DIRECTORY_FD_REQUIRED');
  let rootHandle, rootClosed = false, owner, ownerStat, lockPath, dataPath, intentPath,
    phase = 'opening', ownerClosed = false, lockRemoved = false, lockRemovalSynced = false,
    closePromise, tail = Promise.resolve(), current;
  const handles = new Set();
  function anchored(name) { demand(rootHandle && !rootClosed, 'GRANT_ROOT_CLOSED'); return join('/proc/self/fd/' + rootHandle.fd, name); }
  function checkRoot() {
    demand(rootHandle && !rootClosed, 'GRANT_ROOT_CLOSED');
    const named = lstatSync(root), actual = fstatSync(rootHandle.fd);
    privateStat(named, true); privateStat(actual, true);
    demand(sameFile(rootStat, named) && sameFile(rootStat, actual), 'GRANT_ROOT_REPLACED');
  }
  async function closeRoot() { if (rootHandle && !rootClosed) { await rootHandle.close(); rootClosed = true; } }
  async function closeTracked(handle) { if (handle) { await handle.close(); handles.delete(handle); } }
  async function closeTransient() { for (const handle of handles) await closeTracked(handle); }
  function checkLock() {
    checkRoot(); demand(owner && ownerStat, 'GRANT_OWNER_IDENTITY_UNPROVEN');
    const lock = lstatSync(lockPath); privateStat(lock);
    demand(sameFile(ownerStat, lock), 'GRANT_OWNER_REPLACED');
    if (!ownerClosed) { const actual = fstatSync(owner.fd); privateStat(actual); demand(sameFile(ownerStat, actual), 'GRANT_OWNER_FD_REPLACED'); }
  }
  function owned() {
    demand(phase === 'open', phase === 'uncertain' ? 'GRANT_STATE_UNCERTAIN' : 'GRANT_STORE_CLOSED');
    try { checkLock(); } catch (error) { phase = 'uncertain'; quarantined.add(api); throw error; } return true;
  }
  function serialized(fn) {
    owned(); const pending = tail.then(() => { owned(); return fn(); }); tail = pending.catch(() => {}); return pending;
  }
  async function syncRoot() {
    await closeTransient(); checkRoot(); await rootHandle.sync(); checkRoot();
  }
  async function checkCurrent(expected) {
    owned();
    demand(expected?.revision === current.grants.revision && expected.hash === current.hash, 'GRANT_REVISION_CONFLICT');
    let observed;
    try { observed = validateGrantFile(await readPrivate(dataPath, handles)); }
    catch (error) { phase = 'uncertain'; quarantined.add(api); throw error; }
    owned();
    if (observed.fileHash !== current.fileHash || observed.hash !== current.hash) {
      phase = 'uncertain'; quarantined.add(api); throw fail('GRANT_EXTERNAL_MUTATION');
    }
    return true;
  }
  function close() {
    if (closePromise) return closePromise;
    phase = 'closing'; let yes, no;
    closePromise = new Promise((resolve, reject) => { yes = resolve; no = reject; }); closePromise.catch(() => {});
    (async () => {
      try {
        await tail; await closeTransient();
        if (owner) {
          if (!ownerClosed) { checkLock(); await owner.close(); ownerClosed = true; }
          if (!lockRemoved) { checkLock(); await unlink(lockPath); lockRemoved = true; }
          if (!lockRemovalSynced) { await syncRoot(); lockRemovalSynced = true; }
        }
        await closeTransient(); await closeRoot(); phase = 'closed'; quarantined.delete(api);
      } catch (error) { phase = 'close-failed'; quarantined.add(api); throw error; }
    })().then(yes, no); return closePromise;
  }
  const api = Object.freeze({
    contract: GRANT_STORE_CONTRACT,
    assertOwned: owned,
    snapshot() { owned(); return structuredClone(current); },
    assertCurrent(expected) { return serialized(() => checkCurrent(expected)); },
    persist({ expectedRevision, currentHash, next } = {}) {
      return serialized(async () => {
        await checkCurrent({ revision: expectedRevision, hash: currentHash });
        const grants = validateGrantConfiguration(next);
        demand(grants.revision === expectedRevision + 1, 'GRANT_REVISION_CONFLICT');
        const bytes = Buffer.from(JSON.stringify(grants), 'utf8'); demand(bytes.length <= MAX_BYTES, 'GRANT_FILE_INVALID');
        const nextHash = digest(grants), nextFileHash = hash(bytes), pendingName = 'grants-' + randomUUID() + '.pending';
        const intentData = { schema: 1, expectedRevision, currentHash, oldFileHash: current.fileHash,
          nextRevision: grants.revision, nextHash, nextFileHash, pendingName };
        let intent, pending, admitted = false;
        try {
          intent = await open(intentPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
          handles.add(intent); admitted = true;
          await intent.writeFile(JSON.stringify(intentData));
          await intent.sync(); await closeTracked(intent); intent = undefined; await syncRoot();
          pending = await open(anchored(pendingName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
          handles.add(pending); await pending.writeFile(bytes); await pending.sync(); await closeTracked(pending); pending = undefined;
          await checkCurrent({ revision: expectedRevision, hash: currentHash }); owned();
          // Publication still belongs to the authority gate; no grant gate is released here.
          owned(); await rename(anchored(pendingName), dataPath); await syncRoot();
          owned();
          const published = validateGrantFile(await readPrivate(dataPath, handles));
          demand(published.fileHash === nextFileHash, 'GRANT_EXTERNAL_MUTATION');
          owned(); await unlink(intentPath); await syncRoot(); owned();
          current = { grants, hash: nextHash, fileHash: nextFileHash };
          return { revision: grants.revision, hash: nextHash, fileHash: nextFileHash };
        } catch (error) {
          if (admitted || error.code === 'EEXIST') { phase = 'uncertain'; quarantined.add(api); error.reconciliationRequired = true; }
          if (pending) await closeTracked(pending).catch(() => {});
          if (intent) await closeTracked(intent).catch(() => {});
          if (admitted) {
            // If cleanup's fsync failed after intent unlink, retain/recreate evidence.
            let evidence;
            try {
              evidence = await open(intentPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
              handles.add(evidence); await evidence.writeFile(JSON.stringify(intentData)); await evidence.sync(); await closeTracked(evidence); evidence = undefined; await syncRoot();
            } catch (evidenceError) {
              if (evidenceError.code !== 'EEXIST') error.intentRetentionError = evidenceError;
              if (evidence) await closeTracked(evidence).catch(() => {});
            }
          }
          throw error;
        }
      });
    },
    close,
    retryClose() { demand(phase === 'close-failed', 'GRANT_CLOSE_RETRY_NOT_ALLOWED'); closePromise = undefined; return close(); },
    status() { return Object.freeze({ phase, ownerBarrierHeld: phase !== 'closed', reconciliationRequired: phase === 'uncertain',
      rootClosed, lockOwned: Boolean(owner), lockRemoved, lockRemovalSynced, retainedTransientHandles: handles.size }); }
  });
  try {
    rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | noFollow); checkRoot();
    demand(await realpath(root) === root, 'GRANT_SYMLINK_REJECTED');
    lockPath = anchored('grants.writer.lock'); dataPath = anchored('grants.json'); intentPath = anchored('grant.intent');
    try { owner = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw fail('GRANT_STORE_ALREADY_OWNED'); throw error; }
    try { ownerStat = await owner.stat(); }
    catch (error) {
      error.recovery = unattestedOwnerRecovery(owner, lockPath, closeRoot);
      error.reconciliationRequired = true; throw error;
    }
    privateStat(ownerStat); checkLock();
    await owner.writeFile(JSON.stringify({ schema: 1, ownerId: randomUUID(), contract: GRANT_STORE_CONTRACT })); await owner.sync(); await syncRoot();
    try { await lstat(intentPath); throw fail('GRANT_RECONCILIATION_REQUIRED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = validateGrantFile(await readPrivate(dataPath, handles));
    demand(current.fileHash === initialFileHash, 'GRANT_INITIAL_HASH_MISMATCH');
    phase = 'open'; checkLock(); return api;
  } catch (error) {
    if (isGrantStartupRecovery(error.recovery)) throw error;
    try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError; error.recovery = api; }
    throw error;
  }
}
