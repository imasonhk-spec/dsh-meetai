import { createHash } from 'node:crypto';
import { requireCore } from './errors.mjs';
// Sole opaque Word-byte validator, independent of lifecycle/Word service modules.
export function validateWordContent(value) {
  requireCore(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && value.format === 'docx' && typeof value.base64 === 'string' &&
    value.base64.length > 0 && value.base64.length <= 12 * 1024 * 1024 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.base64) && value.base64.length % 4 === 0, 'INVALID_WORD_CONTENT');
  const bytes = Buffer.from(value.base64, 'base64');
  requireCore(bytes.toString('base64') === value.base64 &&
    createHash('sha256').update(bytes).digest('hex') === value.sha256, 'CONTENT_HASH_MISMATCH');
  return { format: 'docx', base64: value.base64, sha256: value.sha256 };
}
