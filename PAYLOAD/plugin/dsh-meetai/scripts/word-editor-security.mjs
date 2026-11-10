import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

export const editorError = (code, status = 403) => Object.assign(new Error(code), {code, status})
const b64 = bytes => Buffer.from(bytes).toString('base64url')
export function checkSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw editorError('WORD_EDITOR_SECRET_UNAVAILABLE', 503)
  return secret
}
export function signEditorToken(payload, secret) {
  checkSecret(secret)
  const header = b64(JSON.stringify({alg:'HS256',typ:'JWT'}))
  const body = b64(JSON.stringify(payload))
  const data = header + '.' + body
  return data + '.' + createHmac('sha256',secret).update(data).digest('base64url')
}
export function verifyEditorToken(token, secret, {scope, now = Date.now(), requireExpiry = true} = {}) {
  checkSecret(secret)
  if (typeof token !== 'string' || token.length > 32768) throw editorError('WORD_EDITOR_TOKEN_INVALID')
  const pieces = token.split('.')
  if (pieces.length !== 3 || pieces.some(x => !/^[A-Za-z0-9_-]+$/.test(x))) throw editorError('WORD_EDITOR_TOKEN_INVALID')
  const expected = createHmac('sha256',secret).update(pieces[0]+'.'+pieces[1]).digest()
  const actual = Buffer.from(pieces[2],'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw editorError('WORD_EDITOR_SIGNATURE_INVALID')
  let header,payload
  try { header=JSON.parse(Buffer.from(pieces[0],'base64url'));payload=JSON.parse(Buffer.from(pieces[1],'base64url')) }
  catch { throw editorError('WORD_EDITOR_TOKEN_INVALID') }
  if (header.alg !== 'HS256' || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw editorError('WORD_EDITOR_TOKEN_INVALID')
  if (scope && payload.scope !== scope) throw editorError('WORD_EDITOR_TOKEN_SCOPE')
  if ((requireExpiry || payload.exp !== undefined) && (!Number.isSafeInteger(payload.exp) || payload.exp*1000 <= now)) throw editorError('WORD_EDITOR_TOKEN_EXPIRED')
  if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf*1000 > now)) throw editorError('WORD_EDITOR_TOKEN_NOT_ACTIVE')
  return payload
}
export function requestNonce() { return randomBytes(24).toString('base64url') }
export function safeEditorDownloadURL(value, base) {
  let url,allowed
  try {url=new URL(value);allowed=new URL(base)} catch {throw editorError('WORD_EDITOR_DOWNLOAD_DENIED')}
  if (url.protocol !== allowed.protocol || url.origin !== allowed.origin || !['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash || !url.pathname.startsWith('/cache/')) throw editorError('WORD_EDITOR_DOWNLOAD_DENIED')
  return url.href
}
export async function downloadEditorDocument(url, {base, signal, maxBytes = 10*1024*1024, fetcher = fetch} = {}) {
  const safe = safeEditorDownloadURL(url,base)
  const timeout = AbortSignal.timeout(30000)
  const combined = signal ? AbortSignal.any([signal,timeout]) : timeout
  const response = await fetcher(safe,{redirect:'error',signal:combined})
  if (!response.ok || response.status >= 300) throw editorError('WORD_EDITOR_DOWNLOAD_FAILED',502)
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw editorError('WORD_EDITOR_DOCUMENT_LIMIT',413)
  if (!response.body) throw editorError('WORD_EDITOR_DOWNLOAD_EMPTY',502)
  const chunks=[];let total=0
  try {for await (const chunk of response.body) { total+=chunk.length;if(total>maxBytes) throw editorError('WORD_EDITOR_DOCUMENT_LIMIT',413);chunks.push(Buffer.from(chunk)) }}
  catch(error) {await response.body.cancel?.().catch(()=>{});throw error}
  const bytes=Buffer.concat(chunks)
  if (bytes.length < 4 || bytes[0]!==0x50 || bytes[1]!==0x4b) throw editorError('WORD_EDITOR_NOT_DOCX',422)
  return bytes
}
