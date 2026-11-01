import { isDeepStrictEqual } from 'node:util';
import { requireCore, copy } from './validation.mjs';
// One shared source-authority contract for assets and Word; no ancestor shortcuts.
export async function authorizeSourceRead(authorizeRead, captured, request) {
  requireCore(typeof authorizeRead === 'function', 'AUTH_READ_BACKEND_REQUIRED');
  const proof = await authorizeRead(captured.credential, copy(request));
  requireCore(proof?.allowed === true && proof.accountId === captured.accountId &&
    proof.subjectId === captured.subjectId && proof.mode === request.mode &&
    typeof proof.grantId === 'string' && proof.grantId.length > 0 &&
    Number.isSafeInteger(proof.grantRevision) && proof.grantRevision > 0 &&
    isDeepStrictEqual(proof.source, request.source) &&
    (request.mode === 'whole' ? proof.range === undefined : isDeepStrictEqual(proof.range, request.range)), 'SOURCE_AUTH_DENIED');
  return proof;
}
