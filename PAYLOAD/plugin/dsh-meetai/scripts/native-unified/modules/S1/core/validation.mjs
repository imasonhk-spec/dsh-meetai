import { CONTRACT_VERSION } from './contract-version.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateWordContent } from './word-content.mjs';
import { requireCore } from './errors.mjs';
import { validateCompatState } from './compat-state.mjs';
export { CoreError, requireCore } from './errors.mjs';
export function identifier(value) {
  requireCore(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value), 'INVALID_ID'); return value;
}
export function revision(value) { requireCore(Number.isSafeInteger(value) && value >= 0, 'INVALID_REVISION'); return value; }
export const copy = value => structuredClone(value);
export const meetingKey = (accountId, meetingId) => JSON.stringify([identifier(accountId), identifier(meetingId)]);
export const assetKey = (accountId, meetingId, assetId) => JSON.stringify([identifier(accountId), identifier(meetingId), identifier(assetId)]);
export function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function jsonData(value) {
  const seen = new Set(); let nodes = 0;
  function visit(item, depth) {
    requireCore(depth <= 64 && ++nodes <= 100000, 'DATA_LIMIT'); requireCore(item !== undefined, 'INVALID_DATA');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { requireCore(Number.isFinite(item), 'INVALID_DATA'); return; }
    requireCore(typeof item === 'object' && !seen.has(item), 'INVALID_DATA'); seen.add(item);
    if (Array.isArray(item)) {
      requireCore(Reflect.ownKeys(item).length === item.length + 1, 'INVALID_DATA');
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        requireCore(descriptor && Object.hasOwn(descriptor, 'value'), 'INVALID_DATA'); visit(descriptor.value, depth + 1);
      }
    } else {
      requireCore(plain(item), 'INVALID_DATA');
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        requireCore(typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key) &&
          descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'INVALID_DATA'); visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(item);
  }
  visit(value, 0);
}
export function sha256(value) { requireCore(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_HASH'); return value; }
export function positive(value) { revision(value); requireCore(value > 0, 'INVALID_REVISION'); return value; }
export function range(value) {
  requireCore(plain(value) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 &&
    value.end > value.start && ['samples', 'characters'].includes(value.unit), 'INVALID_RANGE');
  return { start: value.start, end: value.end, unit: value.unit };
}
export function sourceIdentity(value) {
  requireCore(plain(value), 'INVALID_SOURCE');
  return { accountId: identifier(value.accountId), meetingId: identifier(value.meetingId), assetId: identifier(value.assetId),
    epoch: positive(value.epoch), revision: positive(value.revision), sha256: sha256(value.sha256) };
}
export const payloadHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function storedEpoch(epoch, meeting) {
  positive(epoch);
  requireCore(meeting && (meeting.fenced ? epoch < meeting.epoch : epoch === meeting.epoch), 'JOURNAL_INVALID');
}
export function validateState(state) {
  requireCore(plain(state) && state.schema === 1, 'SCHEMA_UNSUPPORTED'); revision(state.sequence);
  for (const name of ['meetings', 'assets', 'jobs', 'documents', 'adapters', 'handlers']) requireCore(plain(state[name]), 'JOURNAL_INVALID');
  for (const [key, row] of Object.entries(state.meetings)) {
    requireCore(plain(row) && key === meetingKey(row.accountId, row.meetingId), 'JOURNAL_INVALID');
    positive(row.epoch); revision(row.revision); requireCore(typeof row.fenced === 'boolean', 'JOURNAL_INVALID');
  }
  for (const [key, row] of Object.entries(state.adapters)) {
    requireCore(plain(row) && key === identifier(row.type) && row.contractVersion === CONTRACT_VERSION &&
      typeof row.ownerCapability === 'string' && Array.isArray(row.schemas) && row.schemas.length > 0 &&
      row.schemas.every(value => Number.isSafeInteger(value) && value > 0), 'JOURNAL_INVALID');
  }
  for (const [key, row] of Object.entries(state.assets)) {
    requireCore(plain(row), 'JOURNAL_INVALID'); const source = sourceIdentity(row.source);
    requireCore(key === assetKey(source.accountId, source.meetingId, source.assetId), 'JOURNAL_INVALID');
    storedEpoch(source.epoch, state.meetings[meetingKey(source.accountId, source.meetingId)]);
    const adapter = state.adapters[identifier(row.type)]; requireCore(adapter && adapter.schemas.includes(row.schemaVersion), 'SCHEMA_UNSUPPORTED');
    requireCore(Array.isArray(row.references) && Number.isSafeInteger(row.referenceRevision) && row.referenceRevision >= 0, 'JOURNAL_INVALID');
    for (const reference of row.references) {
      requireCore(plain(reference) && ['whole', 'projection'].includes(reference.mode), 'JOURNAL_INVALID');
      const source = sourceIdentity(reference.source); storedEpoch(source.epoch, state.meetings[meetingKey(source.accountId, source.meetingId)]);
      if (reference.mode === 'projection') range(reference.range); else requireCore(reference.range === undefined, 'JOURNAL_INVALID');
    }
    jsonData(row.data);
    const hash = row.type === 'core_word' ? validateWordContent(row.data).sha256 : payloadHash(row.data);
    requireCore(hash === source.sha256, 'CONTENT_HASH_MISMATCH');
  }
  for (const [id, handler] of Object.entries(state.handlers)) {
    requireCore(plain(handler) && id === identifier(handler.handlerId) && handler.contractVersion === CONTRACT_VERSION &&
      typeof handler.handlerVersion === 'string' && /^\d+\.\d+\.\d+$/.test(handler.handlerVersion), 'JOURNAL_INVALID');
    identifier(handler.ownerCapability); identifier(handler.resource); positive(handler.inputSchemaVersion);
  }
  const operations = new Set();
  for (const [key, job] of Object.entries(state.jobs)) {
    requireCore(plain(job) && key === assetKey(job.accountId, job.meetingId, job.jobId), 'JOURNAL_INVALID');
    identifier(job.operationId); identifier(job.subjectId); identifier(job.resource);
    storedEpoch(job.epoch, state.meetings[meetingKey(job.accountId, job.meetingId)]);
    const operation = JSON.stringify([job.accountId, job.meetingId, job.operationId]);
    requireCore(!operations.has(operation), 'JOURNAL_INVALID'); operations.add(operation);
    revision(job.revision); revision(job.attempts); jsonData(job.input);
    const handler = state.handlers[identifier(job.handlerId)];
    requireCore(handler && handler.handlerVersion === job.handlerVersion && handler.resource === job.resource &&
      handler.inputSchemaVersion === job.inputSchemaVersion, 'VERSION_UNSUPPORTED');
    requireCore(['queued', 'running', 'succeeded', 'cancelled', 'failed'].includes(job.state), 'JOURNAL_INVALID');
    const twice = 2 * job.attempts; requireCore(Number.isSafeInteger(twice), 'JOURNAL_INVALID');
    if (job.state === 'queued') requireCore(job.revision === twice, 'JOURNAL_INVALID');
    if (job.state === 'running') requireCore(job.attempts > 0 && job.revision === twice - 1, 'JOURNAL_INVALID');
    if (['succeeded', 'failed'].includes(job.state)) requireCore(job.attempts > 0 && job.revision === twice, 'JOURNAL_INVALID');
    if (job.state === 'cancelled') requireCore((job.attempts > 0 && job.revision === twice) || job.revision === twice + 1, 'JOURNAL_INVALID');
    if (job.state === 'succeeded') { requireCore(job.result !== undefined, 'JOURNAL_INVALID'); jsonData(job.result); }
    else requireCore(job.result === undefined, 'JOURNAL_INVALID');
    if (job.state === 'failed') requireCore(job.errorCode === 'HANDLER_FAILED', 'JOURNAL_INVALID');
    else if (job.state === 'cancelled') {
      requireCore(job.errorCode === undefined || (job.errorCode === 'HANDLER_FAILED' && job.attempts > 0 && job.revision === twice), 'JOURNAL_INVALID');
    } else requireCore(job.errorCode === undefined, 'JOURNAL_INVALID');
  }
  for (const [key, document] of Object.entries(state.documents)) {
    requireCore(plain(document) && key === assetKey(document.accountId, document.meetingId, document.documentId) &&
      ['document', 'template'].includes(document.kind) && plain(document.drafts) && Array.isArray(document.versions), 'JOURNAL_INVALID');
    storedEpoch(document.epoch, state.meetings[meetingKey(document.accountId, document.meetingId)]); positive(document.revision);
    requireCore(document.versions.length === document.revision, 'JOURNAL_INVALID');
    for (const [index, saved] of document.versions.entries()) {
      requireCore(saved.revision === index + 1, 'JOURNAL_INVALID'); identifier(saved.subjectId);
      const content = validateWordContent(saved.content), source = sourceIdentity(saved.source);
      requireCore(source.accountId === document.accountId && source.meetingId === document.meetingId &&
        source.epoch === document.epoch && source.assetId === 'word_' + document.documentId &&
        source.revision === saved.revision && source.sha256 === content.sha256, 'JOURNAL_INVALID');
      if (saved.templateSource) {
        const source = sourceIdentity(saved.templateSource); storedEpoch(source.epoch, state.meetings[meetingKey(source.accountId, source.meetingId)]);
      }
    }
    const asset = state.assets[assetKey(document.accountId, document.meetingId, 'word_' + document.documentId)];
    requireCore(asset?.type === 'core_word' && isDeepStrictEqual(asset.source, document.versions.at(-1).source), 'JOURNAL_INVALID');
    for (const [subject, draft] of Object.entries(document.drafts)) {
      identifier(subject); positive(draft.revision); positive(draft.baseDocumentRevision);
      requireCore(draft.baseDocumentRevision <= document.revision, 'JOURNAL_INVALID');
      const content = validateWordContent(draft.content), source = sourceIdentity(draft.source);
      const expectedId = 'draft_' + createHash('sha256').update(JSON.stringify([document.documentId, subject])).digest('hex');
      requireCore(source.assetId === expectedId && source.accountId === document.accountId && source.meetingId === document.meetingId &&
        source.epoch === document.epoch && source.revision === draft.revision && source.sha256 === content.sha256, 'JOURNAL_INVALID');
      requireCore(isDeepStrictEqual(state.assets[assetKey(source.accountId, source.meetingId, source.assetId)]?.source, source), 'JOURNAL_INVALID');
      if (draft.promotedToRevision !== undefined) requireCore(Number.isSafeInteger(draft.promotedToRevision) &&
        draft.promotedToRevision <= document.revision && draft.promotedToRevision > 0, 'JOURNAL_INVALID');
    }
  }
  validateCompatState(state);
  jsonData(state);
}
