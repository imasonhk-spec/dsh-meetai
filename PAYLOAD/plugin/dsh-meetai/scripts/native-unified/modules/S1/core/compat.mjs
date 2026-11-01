import { isDeepStrictEqual } from 'node:util';
import { requireCore, identifier, revision, copy, plain, assetKey, sourceIdentity, payloadHash } from './validation.mjs';
import { authorizeSourceRead } from './source-authorization.mjs';
const permissions = ['allowWriteAssets', 'allowManageAdapters', 'allowCoordinateReferences'];
export function compatMethods({ transaction, serialize, checked, getState, authorizeRead, version, wordMutations }) {
  const descriptor = { type: 'core_compat_index', ownerCapability: 'core', schemas: [1], contractVersion: version };
  const index = (next, captured) => next.assets[assetKey(captured.accountId, captured.meetingId, 'compat_index')];
  function upsert(next, captured, expected, upserts) {
    const prior = index(next, captured);
    requireCore((prior?.data.revision ?? 0) === expected, 'INDEX_REVISION_CONFLICT');
    const rows = new Map((prior?.data.rows ?? []).map(row => [row.key, row]));
    for (const row of upserts) rows.set(row.key, row);
    const ordered = [...rows.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    for (const row of ordered) {
      const source = row.source, current = next.assets[assetKey(source.accountId, source.meetingId, source.assetId)];
      requireCore(source.assetId !== 'compat_index' && source.accountId === captured.accountId &&
        source.meetingId === captured.meetingId && source.epoch === captured.epoch && current &&
        isDeepStrictEqual(current.source, source), 'SOURCE_INVALIDATED');
    }
    const oldAdapter = next.adapters.core_compat_index;
    requireCore(!oldAdapter || isDeepStrictEqual(oldAdapter, descriptor), 'ADAPTER_CONFLICT');
    next.adapters.core_compat_index = descriptor;
    const data = { schema: 1, revision: revision(expected + 1), cutover: true, rows: ordered };
    const references = ordered.map(row => ({ source: row.source, mode: 'whole' }));
    const source = { accountId: captured.accountId, meetingId: captured.meetingId, epoch: captured.epoch,
      assetId: 'compat_index', revision: data.revision, sha256: payloadHash(data) };
    next.assets[assetKey(captured.accountId, captured.meetingId, 'compat_index')] = {
      type: 'core_compat_index', schemaVersion: 1, source, referenceRevision: data.revision, references, data };
    return { indexRevision: data.revision, rows: ordered, cutover: true };
  }
  function parseRows(values) {
    requireCore(Array.isArray(values) && values.length <= 1000, 'INVALID_COMPAT_ROWS');
    const keys = new Set();
    return values.map(row => {
      requireCore(plain(row), 'INVALID_COMPAT_ROW');
      const key = identifier(row.key); requireCore(!keys.has(key), 'INVALID_COMPAT_ROW'); keys.add(key);
      return { key, kind: identifier(row.kind), source: sourceIdentity(row.source) };
    });
  }
  function details(next, captured, operation, word, requiredPermissions) {
    const references = copy(index(next, captured).references);
    if (word) {
      const asset = next.assets[assetKey(word.source.accountId, word.source.meetingId, word.source.assetId)];
      for (const ref of asset.references) if (!references.some(item => isDeepStrictEqual(item, ref))) references.push(copy(ref));
    }
    return { operation, requiredPermissions, references };
  }
  return {
    async readCompatIndex(context) {
      return serialize(async () => {
        const { captured } = await checked(context), row = index(getState(), captured);
        if (!row) return { revision: 0, rows: [], cutover: false };
        await authorizeSourceRead(authorizeRead, captured, { mode: 'whole', source: copy(row.source) });
        await checked(context); return copy({ revision: row.data.revision, rows: row.data.rows, cutover: true });
      });
    },
    async updateCompatIndex(context, expectedMeetingRevision, value) {
      requireCore(plain(value), 'INVALID_COMPAT_INDEX');
      const expected = revision(value.expectedIndexRevision), rows = parseRows(value.upserts);
      const mutate = (next, key, captured) => upsert(next, captured, expected, rows);
      return transaction(context, expectedMeetingRevision, mutate, 'allowWriteAssets', {}, {
        prepareDetails(next, key, captured) {
          mutate(next, key, captured); return details(next, captured, 'updateCompatIndex', null, permissions);
        }
      });
    },
    async commitCompatWord(context, expectedMeetingRevision, value) {
      requireCore(plain(value) && ['document', 'draft', 'promote'].includes(value.operation), 'INVALID_COMPAT_OPERATION');
      const input = copy(value), expected = revision(input.expectedIndexRevision), key = identifier(input.indexKey);
      if (input.operation === 'document' && input.kind === undefined) input.kind = 'document';
      identifier(input.documentId);
      const mutate = (next, meeting, captured) => {
        requireCore((index(next, captured)?.data.revision ?? 0) === expected, 'INDEX_REVISION_CONFLICT');
        const word = wordMutations[input.operation](next, captured, input);
        const kind = identifier(input.kind ?? word.kind ?? 'draft');
        const result = upsert(next, captured, expected, [{ key, kind, source: word.source }]);
        return { indexRevision: result.indexRevision, word };
      };
      return transaction(context, expectedMeetingRevision, mutate, 'allowWriteAssets', {}, {
        prepareDetails(next, meeting, captured) {
          const result = mutate(next, meeting, captured);
          return details(next, captured, 'commitCompatWord', result.word, [...permissions, 'allowWriteWord']);
        }
      });
    }
  };
}
