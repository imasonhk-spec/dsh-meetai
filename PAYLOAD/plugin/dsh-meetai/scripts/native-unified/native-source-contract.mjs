import { sourceKey } from './native-source-geometry.mjs';
export const SOURCE_FIELDS = Object.freeze(['accountId', 'meetingId', 'epoch', 'sourceId', 'originId', 'audioRevision', 'audioSha256']);
const fail = code => Object.assign(new Error(code), { code });
const requireValue = (ok, code) => { if (!ok) throw fail(code); };

/** Mapping only: this function neither authenticates callers nor grants source permissions. */
export function trustedSourceFields(value) {
  sourceKey(value);
  for (const field of ['accountId', 'meetingId', 'sourceId', 'originId'])
    requireValue(typeof value[field] === 'string' && value[field].length > 0, 'SOURCE_INVALID');
  requireValue(Number.isSafeInteger(value.audioRevision) && value.audioRevision > 0 ||
    typeof value.audioRevision === 'string' && value.audioRevision.length > 0, 'SOURCE_INVALID');
  const result = Object.fromEntries(SOURCE_FIELDS.map(field => [field, value[field]]));
  if (value.transcriptRevision !== undefined) {
    requireValue(Number.isSafeInteger(value.transcriptRevision) && value.transcriptRevision >= 0, 'TRANSCRIPT_REVISION_INVALID');
    result.transcriptRevision = value.transcriptRevision;
  }
  return Object.freeze(result);
}

