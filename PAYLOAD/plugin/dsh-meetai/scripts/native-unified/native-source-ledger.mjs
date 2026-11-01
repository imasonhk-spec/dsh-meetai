import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { trustedSourceFields } from './native-source-contract.mjs';
import { MAX_BYTES } from './native-source-geometry.mjs';
const fail = code => Object.assign(new Error(code), { code });
const need = (ok, code) => { if (!ok) throw fail(code); };
const copy = value => structuredClone(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identifier = value => { need(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value), 'SOURCE_ID_INVALID'); return value; };
const scoped = context => ({ accountId: context.accountId, meetingId: context.meetingId, epoch: context.epoch });

/** Root identity is derived from the native durable origin AND persisted in the same native image. */
export function rootSourceRecord(tx, context, sourceRef, nativeOrigin) {
  identifier(sourceRef); need(typeof nativeOrigin === 'string' && nativeOrigin.length > 0, 'NATIVE_ORIGIN_REQUIRED');
  const rows = tx.list('recordings').filter(row => row.id === sourceRef || row.sourceId === sourceRef);
  need(rows.length === 1, 'SOURCE_NOT_FOUND');
  const recording = rows[0];
  need(recording.accountId === context.accountId && recording.meetingId === context.meetingId && recording.epoch === context.epoch &&
    /^rec_[a-f0-9]{16}$/.test(recording.id) && /^upl_[a-f0-9]{32}$/.test(recording.uploadId) &&
    Number.isSafeInteger(recording.sizeBytes) && recording.sizeBytes > 0 && recording.sizeBytes <= MAX_BYTES,
  'SOURCE_ATTACHMENT_INVALID');
  const session = tx.get('sessions', recording.sessionId), upload = tx.get('uploads', recording.uploadId);
  const scopeMatches = row => row && ['accountId', 'meetingId', 'epoch'].every(key => row[key] === context[key]);
  need(scopeMatches(session) && scopeMatches(upload) && session.state === 'attached' && upload.state === 'attached' &&
    session.uploadId === upload.id && upload.sessionId === session.id && upload.recordingId === recording.id &&
    session.operationId === upload.operationId && recording.operationId === upload.operationId &&
    isDeepStrictEqual(session.attachment, upload.receipt) && upload.receipt?.operationId === upload.operationId &&
    session.attachment?.recordingId === recording.id && session.attachment?.uploadId === upload.id &&
    session.attachment?.audioSha256 === recording.sha256 && session.attachment?.audioRevision === recording.audioRevision &&
    upload.receipt?.recordingId === recording.id && upload.receipt?.sessionId === session.id &&
    upload.receipt?.meetingId === context.meetingId && upload.receipt?.epoch === context.epoch &&
    upload.receipt?.audioSha256 === recording.sha256 && upload.receipt?.audioRevision === recording.audioRevision &&
    upload.audioSha256 === recording.sha256 && upload.totalBytes === recording.sizeBytes &&
    session.sealed?.audioSha256 === recording.sha256 && session.sealed?.totalBytes === recording.sizeBytes,
  'SOURCE_ATTACHMENT_INVALID');
  const originId = 'origin_' + digest(JSON.stringify([nativeOrigin, context.accountId, context.meetingId,
    context.epoch, recording.id, recording.sourceId, recording.sha256]));
  const transcript = tx.get('transcripts', recording.id);
  if (transcript) need(transcript.id === recording.id && transcript.audioSha256 === recording.sha256 &&
    typeof transcript.text === 'string' && transcript.text.length <= 200000 && digest(transcript.text) === transcript.sha256 &&
    Number.isSafeInteger(transcript.revision) && transcript.revision > 0, 'TRANSCRIPT_INTEGRITY');
  const source = trustedSourceFields({ ...scoped(context), sourceId: recording.sourceId, originId,
    audioRevision: recording.audioRevision, audioSha256: recording.sha256, transcriptRevision: transcript?.revision ?? 0 });
  const dto = { schema: 's2-source/1.0.0', meetingId: context.meetingId, epoch: context.epoch,
    recordingId: recording.id, sessionId: session.id, sourceId: recording.sourceId,
    audioRevision: recording.audioRevision, audioSha256: recording.sha256, sizeBytes: recording.sizeBytes,
    transcriptRevision: transcript?.revision ?? 0, transcriptSha256: transcript?.sha256 ?? null,
    transcriptState: transcript ? 'ready' : 'absent', timingQuality: transcript?.timingQuality ?? 'unknown',
    formalTranscript: Boolean(transcript), simulated: transcript?.simulated ?? null };
  return { source, dto, recording: copy(recording), transcript: copy(transcript), ledger: {
    id: source.sourceId, kind: 's2-root', nativeOrigin, source: { ...source, transcriptRevision: 0 },
    recordingId: recording.id, uploadId: recording.uploadId, size: recording.sizeBytes, operationId: recording.operationId,
    storage: { kind: 's2-upload' }, originalPreserved: true } };
}

