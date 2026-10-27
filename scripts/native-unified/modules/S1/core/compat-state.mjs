import { CONTRACT_VERSION } from './contract-version.mjs';
import { requireCore } from './errors.mjs';
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sourceKeys = ['accountId', 'meetingId', 'assetId', 'epoch', 'revision', 'sha256'];
const sameSource = (a, b) => a && b && sourceKeys.every(key => a[key] === b[key]);
// Pure stored-state validation: deliberately imports only errors to avoid a validation cycle.
export function validateCompatState(state) {
  const descriptor = state.adapters.core_compat_index;
  if (descriptor) requireCore(descriptor.ownerCapability === 'core' && descriptor.schemas.length === 1 &&
    descriptor.schemas[0] === 1 && descriptor.contractVersion === CONTRACT_VERSION, 'JOURNAL_INVALID');
  for (const asset of Object.values(state.assets)) {
    if (asset.source.assetId !== 'compat_index' && asset.type !== 'core_compat_index') continue;
    requireCore(asset.source.assetId === 'compat_index' && asset.type === 'core_compat_index' &&
      asset.schemaVersion === 1 && descriptor, 'SCHEMA_UNSUPPORTED');
    requireCore(exactKeys(asset.source, sourceKeys), 'JOURNAL_INVALID');
    const data = asset.data;
    requireCore(exactKeys(data, ['schema', 'revision', 'cutover', 'rows']) && data.schema === 1,
      'SCHEMA_UNSUPPORTED');
    requireCore(positive(data.revision) && data.revision === asset.source.revision && data.cutover === true &&
      asset.referenceRevision === data.revision && Array.isArray(data.rows) &&
      asset.references.length === data.rows.length, 'JOURNAL_INVALID');
    let previous;
    for (let n = 0; n < data.rows.length; n++) {
      const row = data.rows[n], source = row?.source;
      requireCore(exactKeys(row, ['key', 'kind', 'source']) && id(row.key) && id(row.kind) &&
        (previous === undefined || previous < row.key), 'JOURNAL_INVALID'); previous = row.key;
      requireCore(exactKeys(source, sourceKeys) && id(source.accountId) && id(source.meetingId) &&
        id(source.assetId) && source.assetId !== 'compat_index' && positive(source.epoch) && positive(source.revision) &&
        typeof source.sha256 === 'string' && /^[a-f0-9]{64}$/.test(source.sha256) &&
        source.accountId === asset.source.accountId && source.meetingId === asset.source.meetingId &&
        source.epoch === asset.source.epoch, 'JOURNAL_INVALID');
      const target = state.assets[JSON.stringify([source.accountId, source.meetingId, source.assetId])];
      const ref = asset.references[n];
      requireCore(target && sameSource(target.source, source) && exactKeys(ref, ['source', 'mode']) &&
        ref.mode === 'whole' && exactKeys(ref.source, sourceKeys) && sameSource(ref.source, source), 'JOURNAL_INVALID');
    }
  }
}
