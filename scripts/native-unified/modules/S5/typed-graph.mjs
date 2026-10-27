import { createHash } from 'node:crypto';
export const VERSION = 'S5-DELETE-1.1.0';
export const TYPES = Object.freeze({
  meeting: 'S1', artifact: 'S1', document: 'S1', word: 'S1', journal: 'S1',
  session: 'S2', upload: 'S2', recording: 'S2', transcript: 'S2', minutes: 'S2',
  media: 'S3', projection: 'S3', qa: 'S4', cache: 'S4', managedCopy: 'S4',
});
export function fail(code) { throw Object.assign(new Error(code), { code }); }
export function canonical(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && Object.getPrototypeOf(v) === Object.prototype) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  fail('DELETE_SCHEMA');
}
export const hash = v => createHash('sha256').update(canonical(v)).digest('hex');
export const copy = v => JSON.parse(canonical(v));
export const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
export const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const revision = v => Number.isSafeInteger(v) && v >= 0;
export function fields(v, allowed) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).some(k => !allowed.includes(k))) fail('DELETE_SCHEMA');
}
const sameOwner = (a, b) => a.account === b.account && a.meeting === b.meeting;

/** Storage is an explicit provider/schema fact, never inferred from null identity.
 * Physical includes shared retained bytes; detach still needs approved identity.
 * Metadata-only mutations require a versioned adapter that attests this kind. */
export function storageProofReasons(row, adapter) {
  const reasons = [];
  if (!['physical', 'metadata'].includes(row.storage) ||
      !Array.isArray(adapter?.storageKindsByType?.[row.type]) ||
      !adapter.storageKindsByType[row.type].includes(row.storage)) reasons.push('STORAGE_UNPROVEN');
  if (row.storage === 'physical' && (row.identity === null || row.identity === undefined)) reasons.push('PHYSICAL_IDENTITY_UNPROVEN');
  if (row.storage === 'metadata' && (row.identity !== null || row.mutation === null || row.mutation === undefined)) reasons.push('METADATA_MUTATION_UNPROVEN');
  return reasons;
}

/** Normalized DTO ONLY. Actual store/legacy schemas require provider adapters.
 * No path/title/body inference, no SDK API claimed, no lifecycle constructed. */
export function buildTypedGraph(snapshot, target, adapters) {
  fields(snapshot, ['epoch', 'revision', 'registryRevision', 'items', 'coverage', 'blockers']);
  if (!revision(snapshot.epoch) || !revision(snapshot.revision) || !revision(snapshot.registryRevision) ||
      !Array.isArray(snapshot.items) || !Array.isArray(snapshot.blockers) || snapshot.items.length > 10000) fail('DELETE_SCHEMA');
  const reasons = [], items = [], keys = new Set();
  for (const row of snapshot.items) {
    fields(row, ['key', 'type', 'schema', 'storage', 'revision', 'referenceVersion', 'owners', 'dependencies', 'adapter', 'identity', 'mutation']);
    if (!id(row.key) || keys.has(row.key)) fail('DELETE_DUPLICATE_ID');
    keys.add(row.key);
    if (!Object.hasOwn(TYPES, row.type) || row.schema !== 's5-typed-v2') reasons.push('UNKNOWN_SCHEMA');
    if (!revision(row.revision) || !revision(row.referenceVersion) || !id(row.adapter) || !Array.isArray(row.owners) || !row.owners.length || !Array.isArray(row.dependencies)) fail('DELETE_SCHEMA');
    const refs = new Set();
    for (const owner of row.owners) {
      fields(owner, ['account', 'meeting']);
      if (!id(owner.account) || !id(owner.meeting) || refs.has(canonical(owner))) fail('DELETE_REFERENCE_UNPROVEN');
      refs.add(canonical(owner));
    }
    if (row.dependencies.some(d => !id(d)) || new Set(row.dependencies).size !== row.dependencies.length) fail('DELETE_SCHEMA');
    const adapter = adapters[row.adapter];
    if (!adapter || adapter.version !== VERSION || adapter.mode !== 'synthetic' || !Array.isArray(adapter.types) || !adapter.types.includes(row.type) || typeof adapter.inspect !== 'function' || typeof adapter.apply !== 'function') reasons.push('ADAPTER_UNAVAILABLE');
    reasons.push(...storageProofReasons(row, adapter));
    if (row.identity !== null) {
      fields(row.identity, ['dev', 'ino', 'uid', 'size', 'sha256']);
      if (!['dev', 'ino', 'uid', 'size'].every(k => revision(row.identity[k])) || !sha(row.identity.sha256)) fail('DELETE_IDENTITY_UNPROVEN');
    }
    if (row.mutation !== null) {
      fields(row.mutation, ['revision', 'preHash', 'postHash', 'policy']);
      if (!revision(row.mutation.revision) || !sha(row.mutation.preHash) || !sha(row.mutation.postHash) || !['purge', 'compact'].includes(row.mutation.policy)) fail('DELETE_MUTATION_UNPROVEN');
    }
    if (row.identity === null && row.mutation === null) reasons.push('MUTATION_UNPROVEN');
    if (row.owners.some(o => sameOwner(o, target))) {
      const action = row.mutation?.policy === 'compact' ? 'compact' : row.owners.length > 1 ? 'detach' : 'remove';
      if (action === 'compact' && row.owners.length > 1) reasons.push('SHARED_COMPACTION_UNPROVEN');
      if (action === 'detach' && row.mutation === null) reasons.push('DETACH_CAS_UNPROVEN');
      items.push({ ...copy(row), owners: copy(row.owners).sort((a, b) => canonical(a).localeCompare(canonical(b))), action });
    }
  }
  for (const row of snapshot.items) {
    if (row.dependencies.some(d => !keys.has(d))) reasons.push('DANGLING_REFERENCE');
    // Provider resolves global aliases; normalized retaining edges must agree
    // with every declared surviving owner. QA/cache dependencies invalidate,
    // they do not confer physical retention or whole-source authorization.
    if (!['qa', 'cache'].includes(row.type)) for (const dep of row.dependencies) {
      const destination = snapshot.items.find(r => r.key === dep);
      if (destination && row.owners.some(owner => !destination.owners.some(o => sameOwner(o, owner)))) reasons.push('REFERENCE_CLOSURE_UNPROVEN');
    }
  }
  const c = snapshot.coverage;
  if (!c || !Array.isArray(c.domains) || !Array.isArray(c.writers) || !Array.isArray(c.externalCopies)) reasons.push('COVERAGE_UNPROVEN');
  else {
    fields(c, ['domains', 'writers', 'externalCopies', 'inventoryHash']);
    if (!sha(c.inventoryHash)) reasons.push('INVENTORY_UNPROVEN');
    for (const name of ['S1', 'S2', 'S3', 'S4']) {
      const ds = c.domains.filter(d => d.provider === name);
      if (ds.length !== 1) { reasons.push('DOMAIN_UNPROVEN'); continue; }
      const d = ds[0]; fields(d, ['provider', 'contract', 'mode', 'historyInventoried', 'state']);
      if (d.contract !== VERSION || d.mode !== 'synthetic' || d.historyInventoried !== true || !['present', 'verifiedAbsent'].includes(d.state)) reasons.push('DOMAIN_UNPROVEN');
      if (d.state === 'verifiedAbsent' && snapshot.items.some(r => TYPES[r.type] === name)) reasons.push('ABSENCE_CONFLICT');
    }
    if (c.domains.length !== 4 || !c.writers.length) reasons.push('COVERAGE_UNPROVEN');
    const writerIds = new Set();
    for (const w of c.writers) {
      fields(w, ['id', 'version', 'fenced']);
      if (!id(w.id) || writerIds.has(w.id) || w.version !== VERSION || w.fenced !== true) reasons.push('WRITER_UNPROVEN');
      writerIds.add(w.id);
    }
    for (const e of c.externalCopies) {
      fields(e, ['id', 'state', 'contract']);
      if (!id(e.id) || !['verifiedAbsent', 'managed'].includes(e.state) || e.contract !== VERSION ||
          e.state === 'managed' && !snapshot.items.some(r => r.type === 'managedCopy' && r.key === e.id)) reasons.push('EXTERNAL_COPY_UNPROVEN');
    }
    if (!c.externalCopies.length) reasons.push('EXTERNAL_COPY_UNPROVEN');
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
  // Inventory evidence is supplied by a trusted peer under admission, not a
  // browser assertion. This stage can establish only synthetic completeness.
  const uniqueReasons = [...new Set(reasons)].sort();
  return { contract: VERSION, mode: 'synthetic', complete: uniqueReasons.length === 0, realComplete: false,
    reasons: uniqueReasons, target: copy(target), epoch: snapshot.epoch, revision: snapshot.revision,
    registryRevision: snapshot.registryRevision, blockers: copy(snapshot.blockers), items,
    snapshotHash: hash(snapshot), manifestHash: hash({ snapshot, target, contract: VERSION }) };
}

export function publicPreview(plan) {
  return { planId: plan.id, manifestHash: plan.graph.manifestHash, expiresAt: plan.expiresAt,
    complete: plan.graph.complete, realComplete: false, mode: 'synthetic', reasons: plan.graph.reasons,
    blockers: plan.graph.blockers.map(b => id(b) ? b : 'UNPROVEN_ACTIVITY'),
    items: plan.graph.items.map(i => ({ key: i.key, type: i.type, storage: i.storage, action: i.action, bytes: i.identity?.size ?? 0 })),
    defaultAction: 'cancel', irreversible: true };
}
