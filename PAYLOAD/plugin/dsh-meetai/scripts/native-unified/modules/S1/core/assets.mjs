import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { authorizeSourceRead } from './source-authorization.mjs';
import { requireCore, identifier, revision, positive, copy, assetKey, meetingKey,
  jsonData, sourceIdentity, range, plain, sha256 } from './validation.mjs';

export function assetMethods({ transaction, serialize, checked, getState, authorizeRead, authenticate, version }) {
  const cleanupHandlers = new Map();
  function ownedAsset(image, captured, id) {
    const key = assetKey(captured.accountId, captured.meetingId, id), row = image.assets[key];
    requireCore(row, 'ASSET_NOT_FOUND');
    requireCore(row.source.epoch === captured.epoch, 'EPOCH_STALE');
    return { key, row };
  }
  function descriptor(value) {
    requireCore(plain(value) && value.contractVersion === version, 'VERSION_UNSUPPORTED');
    const schemas = value.schemas;
    requireCore(Array.isArray(schemas) && schemas.length > 0 && new Set(schemas).size === schemas.length,
      'SCHEMA_UNSUPPORTED');
    schemas.forEach(positive);
    return { type: identifier(value.type), ownerCapability: identifier(value.ownerCapability),
      schemas: [...schemas].sort((a, b) => a - b), contractVersion: version };
  }
  const access = (captured, request) => authorizeSourceRead(authorizeRead, captured, request);
  return {
    async registerAssetAdapter(context, expectedRevision, value) {
      const wanted = descriptor(value);
      requireCore(wanted.type !== 'core_compat_index', 'COMPAT_RESERVED');
      return transaction(context, expectedRevision, next => {
        const old = next.adapters[wanted.type];
        requireCore(!old || isDeepStrictEqual(old, wanted), 'ADAPTER_CONFLICT');
        next.adapters[wanted.type] = wanted;
        return wanted;
      }, 'allowManageAdapters', { operation: 'registerAssetAdapter', descriptor: wanted });
    },
    // Runtime cleanup registration never removes the durable recognition catalogue.
    async attachCleanup(context, value, cleanup) {
      const wanted = descriptor(value);
      requireCore(typeof cleanup === 'function', 'INVALID_HANDLER');
      return serialize(async () => {
        const { captured } = await checked(context);
        const auth = await authenticate(captured.credential);
        requireCore(auth?.allowManageAdapters === true && auth.accountId === captured.accountId &&
          auth.subjectId === captured.subjectId && auth.meetingId === captured.meetingId, 'AUTH_DENIED');
        requireCore(isDeepStrictEqual(getState().adapters[wanted.type], wanted), 'ADAPTER_UNKNOWN');
        requireCore(!cleanupHandlers.has(wanted.type), 'ADAPTER_CONFLICT');
        const entry = { cleanup, wanted }; cleanupHandlers.set(wanted.type, entry);
        let disposed = false;
        return () => {
          if (disposed) return; disposed = true;
          if (cleanupHandlers.get(wanted.type) === entry) cleanupHandlers.delete(wanted.type);
        };
      });
    },
    async assetRecognition(context, type) {
      identifier(type);
      return serialize(async () => {
        await checked(context);
        const record = getState().adapters[type];
        return record ? { descriptor: copy(record), cleanupAvailable: cleanupHandlers.has(type),
          coverage: 'unknown', complete: false } : { descriptor: null, cleanupAvailable: false,
          coverage: 'unknown', complete: false };
      });
    },
    async putAsset(context, expectedRevision, value) {
      requireCore(plain(value), 'INVALID_ASSET');
      jsonData(value.data);
      const input = { assetId: identifier(value.assetId), type: identifier(value.type),
        schemaVersion: positive(value.schemaVersion), expectedAssetRevision: revision(value.expectedAssetRevision),
        sha256: sha256(value.sha256), data: copy(value.data) };
      jsonData(value.data);
      requireCore(input.assetId !== 'compat_index' && input.type !== 'core_compat_index', 'COMPAT_RESERVED');
      return transaction(context, expectedRevision, (next, key, captured) => {
        const adapter = next.adapters[input.type];
        requireCore(adapter?.schemas.includes(input.schemaVersion), 'SCHEMA_UNSUPPORTED');
        requireCore(createHash('sha256').update(JSON.stringify(input.data)).digest('hex') === input.sha256,
          'CONTENT_HASH_MISMATCH');
        const ownKey = assetKey(captured.accountId, captured.meetingId, input.assetId), old = next.assets[ownKey];
        requireCore((old?.source.revision ?? 0) === input.expectedAssetRevision, 'ASSET_REVISION_CONFLICT');
        requireCore(!old || old.source.epoch === captured.epoch, 'EPOCH_STALE');
        requireCore(!old || old.type === input.type, 'ASSET_TYPE_CONFLICT');
        const row = { type: input.type, schemaVersion: input.schemaVersion,
          source: { accountId: captured.accountId, meetingId: captured.meetingId,
            assetId: input.assetId, epoch: captured.epoch, revision: positive(input.expectedAssetRevision + 1), sha256: input.sha256 },
          referenceRevision: old?.referenceRevision ?? 0, references: old?.references ?? [], data: input.data };
        next.assets[ownKey] = row;
        return { source: row.source, referenceRevision: row.referenceRevision };
      }, 'allowWriteAssets', { operation: 'putAsset', assetId: input.assetId });
    },
    async readAsset(context, requestedSource, mode, requestedRange) {
      const source = sourceIdentity(requestedSource);
      requireCore(['whole', 'projection'].includes(mode), 'INVALID_AUTH_MODE');
      const projection = mode === 'projection' ? range(requestedRange) : undefined;
      requireCore(mode !== 'whole' || requestedRange === undefined, 'INVALID_RANGE');
      return serialize(async () => {
        const { captured } = await checked(context);
        const image = getState(), targetMeeting = image.meetings[meetingKey(source.accountId, source.meetingId)];
        requireCore(targetMeeting && !targetMeeting.fenced && targetMeeting.epoch === source.epoch, 'SOURCE_INVALIDATED');
        const row = image.assets[assetKey(source.accountId, source.meetingId, source.assetId)];
        requireCore(row && isDeepStrictEqual(row.source, source), 'SOURCE_INVALIDATED');
        await access(captured, { mode, source, ...(projection ? { range: projection } : {}) });
        await checked(context);
        if (mode === 'whole') return { source: copy(source), data: copy(row.data), mode };
        // No ancestry shortcut; projection never returns the source payload.
        requireCore(projection.unit === 'characters' && typeof row.data === 'string' &&
          projection.end <= row.data.length, 'PROJECTION_UNSUPPORTED');
        return { source: copy(source), range: projection, data: row.data.slice(projection.start, projection.end), mode };
      });
    },
    async setReferences(context, expectedRevision, assetId, expectedReferenceRevision, values) {
      identifier(assetId); revision(expectedReferenceRevision);
      requireCore(assetId !== 'compat_index', 'COMPAT_RESERVED');
      requireCore(Array.isArray(values) && values.length <= 1000, 'INVALID_REFERENCE');
      const references = values.map(value => {
        requireCore(plain(value) && ['whole', 'projection'].includes(value.mode), 'INVALID_REFERENCE');
        return { source: sourceIdentity(value.source), mode: value.mode,
          ...(value.mode === 'projection' ? { range: range(value.range) } : {}) };
      });
      // Guard must coordinate every account/source/reference under one backend
      // barrier. Unknown/partial coverage MUST be denied by the trusted backend.
      return transaction(context, expectedRevision, (next, key, captured) => {
        const { row } = ownedAsset(next, captured, assetId);
        requireCore(row.referenceRevision === expectedReferenceRevision, 'REFERENCE_REVISION_CONFLICT');
        for (const reference of references) {
          const source = reference.source, target = next.assets[assetKey(source.accountId, source.meetingId, source.assetId)];
          const lifecycle = next.meetings[meetingKey(source.accountId, source.meetingId)];
          requireCore(target && isDeepStrictEqual(target.source, source) && lifecycle &&
            !lifecycle.fenced && lifecycle.epoch === source.epoch, 'SOURCE_INVALIDATED');
        }
        row.references = references; row.referenceRevision = revision(expectedReferenceRevision + 1);
        return { source: row.source, referenceRevision: row.referenceRevision };
      }, 'allowCoordinateReferences', { operation: 'setReferences', references });
    }
  };
}
