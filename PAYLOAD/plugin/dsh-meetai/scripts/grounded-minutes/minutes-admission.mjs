// Admin-only private publication gate. No file creation, model calls or runtime bootstrap.
// The native authority bridge is NOT present in the old Host. Default requests fail closed.
import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, realpath, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
const ADMIN_HOME = process.env.DSH_ADMIN_HOME || '/home/lgsj/.dsh/multi-user/users/admin/home'
const SHA = /^[a-f0-9]{64}$/
const issued = new WeakMap()
const fail = code => Object.assign(new Error(code), { code })
const need = (ok, code) => { if (!ok) throw fail(code) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
const keys = (value, names) => plain(value) && Object.keys(value).sort().join('|') === names.slice().sort().join('|')
const stamp = info => [info.dev, info.ino, info.uid, info.nlink, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':')
const GATES = ['developmentComplete', 'rocm', 'quality', 'protocol', 'performance', 'recovery']
export const MINUTES_ADMISSION_CONTRACT = 'admin-minutes-admission/1'
export function assertIssuedMinutesAdmission(value) {
  need(value && issued.has(value), 'MAX_ADMISSION_UNTRUSTED')
  return issued.get(value)
}
async function privateDirectory(directory) {
  const info = await lstat(directory)
  need(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0 && await realpath(directory) === directory, 'MAX_ADMISSION_PRIVATE_ROOT_UNSAFE')
}
async function readPublication(home) {
  need(home === ADMIN_HOME, 'MAX_ADMISSION_ACCOUNT_REQUIRED')
  // Existing profile may be 0755 inside a 0700 home. Do not chmod or initialize it here.
  await privateDirectory(home)
  const profile = path.join(home, 'profiles/web')
  need(await realpath(profile) === profile, 'MAX_ADMISSION_PRIVATE_ROOT_UNSAFE')
  const directory = path.join(profile, 'meeting-admission')
  await privateDirectory(directory)
  const file = path.join(directory, 'minutes-max.json')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    need(before.isFile() && before.nlink === 1n && before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o600n && before.size > 0n && before.size <= 65536n, 'MAX_ADMISSION_PUBLICATION_UNSAFE')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    for (;;) {
      const item = await handle.read(bytes, length, bytes.length - length, length)
      length += item.bytesRead
      need(length <= Number(before.size), 'MAX_ADMISSION_PUBLICATION_CHANGED')
      if (!item.bytesRead) break
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(file, { bigint: true })
    need(length === Number(before.size) && stamp(before) === stamp(after) && !named.isSymbolicLink() && stamp(named) === stamp(after) && await realpath(file) === file, 'MAX_ADMISSION_PUBLICATION_CHANGED')
    const raw = bytes.subarray(0, length)
    let value
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) } catch { throw fail('MAX_ADMISSION_PUBLICATION_INVALID') }
    return { value, sha256: digest(raw), fingerprint: stamp(after) }
  } finally { await handle.close() }
}
function validatePublication(value, now) {
  need(keys(value, ['schemaVersion', 'accountId', 'role', 'provider', 'model', 'phase', 'revision', 'hostBootId', 'issuedAt', 'expiresAt', 'identity', 'evidence']), 'MAX_ADMISSION_PUBLICATION_INVALID')
  need(value.schemaVersion === 1 && value.accountId === 'admin' && value.role === 'minutes' && value.provider === 'ollama' && value.model === 'huiwen-max:latest' && value.phase === 'release', 'MAX_ADMISSION_SCOPE_MISMATCH')
  need(Number.isSafeInteger(value.revision) && value.revision > 0 && typeof value.hostBootId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value.hostBootId), 'MAX_ADMISSION_PUBLICATION_INVALID')
  need(Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) && value.issuedAt <= now && value.expiresAt > now && value.expiresAt - value.issuedAt <= 3600000, 'MAX_ADMISSION_EXPIRED')
  const identity = value.identity
  need(keys(identity, ['baseModel', 'quantization', 'weightsSha256', 'manifestSha256', 'executableSha256', 'workerSha256', 'configurationSha256', 'ownerId', 'adapterFingerprint']), 'MAX_ADMISSION_IDENTITY_INVALID')
  need(identity.baseModel === 'qwen3.5:122b' && typeof identity.quantization === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(identity.quantization), 'MAX_ADMISSION_IDENTITY_INVALID')
  for (const key of ['weightsSha256', 'manifestSha256', 'executableSha256', 'workerSha256', 'configurationSha256']) need(typeof identity[key] === 'string' && SHA.test(identity[key]), 'MAX_ADMISSION_IDENTITY_INVALID')
  for (const key of ['ownerId', 'adapterFingerprint']) need(typeof identity[key] === 'string' && /^[A-Za-z0-9_.:|/-]{1,256}$/.test(identity[key]), 'MAX_ADMISSION_IDENTITY_INVALID')
  need(keys(value.evidence, GATES), 'MAX_ADMISSION_EVIDENCE_INVALID')
  for (const gate of GATES) need(typeof value.evidence[gate] === 'string' && SHA.test(value.evidence[gate]), 'MAX_ADMISSION_EVIDENCE_INVALID')
  // JSON contains only references, never ready/allowed/passed flags, endpoints, secrets or a request-supplied authorizer.
  return value
}
/** authority is a future server-owned native bridge, not the frozen Occamy owner.
 * No current SDK service is invented or looked up here. Missing bridge always rejects.
 * Required bridge methods attest scope/publication/evidence and the actual SDK-owner binding.
 */
export function createMinutesAdmission({ home, llm, authority } = {}) {
  async function authorize(request, { signal } = {}) {
    signal?.throwIfAborted()
    need(keys(request, ['role', 'provider', 'model']) && request.role === 'minutes' && request.provider === 'ollama' && request.model === 'huiwen-max:latest', 'MAX_ADMISSION_SCOPE_MISMATCH')
    need(home === ADMIN_HOME, 'MAX_ADMISSION_ACCOUNT_REQUIRED')
    // No private body access before a genuine native authority is bound.
    need(authority?.contract === 'native-minutes-admission-authority/1' && ['assertScope', 'assertPublication', 'verifyEvidence', 'assertCurrent', 'assertSdkBinding'].every(key => typeof authority[key] === 'function'), 'MAX_ADMISSION_OWNER_UNAVAILABLE')
    need(await authority.assertScope({ accountId: 'admin', home, role: 'minutes', signal }) === true, 'MAX_ADMISSION_SCOPE_MISMATCH')
    signal?.throwIfAborted()
    const publication = await readPublication(home), value = validatePublication(publication.value, Date.now())
    const context = Object.freeze({ accountId: 'admin', role: 'minutes', provider: 'ollama', model: 'huiwen-max:latest', phase: 'release', revision: value.revision, hostBootId: value.hostBootId, publicationSha256: publication.sha256, identity: Object.freeze({ ...value.identity }) })
    need(await authority.assertPublication(context, { signal }) === true, 'MAX_ADMISSION_PUBLICATION_UNTRUSTED')
    need(await authority.assertSdkBinding(llm, context, { signal }) === true, 'MAX_ADMISSION_SDK_OWNER_UNBOUND')
    for (const gate of GATES) {
      signal?.throwIfAborted()
      // Runtime authority verifies original local evidence provenance and gate-specific acceptance,
      // including actual completed ROCm work and equivalent full-task >=20% improvement.
      need(await authority.verifyEvidence(gate, value.evidence[gate], context, { signal }) === true, 'MAX_ADMISSION_EVIDENCE_UNVERIFIED')
    }
    async function assertCurrent(activeSignal = signal) {
      activeSignal?.throwIfAborted()
      need(value.expiresAt > Date.now(), 'MAX_ADMISSION_EXPIRED')
      const current = await readPublication(home)
      need(current.sha256 === publication.sha256 && current.fingerprint === publication.fingerprint && isDeepStrictEqual(current.value, value), 'MAX_ADMISSION_PUBLICATION_CHANGED')
      need(await authority.assertCurrent(context, { signal: activeSignal }) === true && await authority.assertSdkBinding(llm, context, { signal: activeSignal }) === true, 'MAX_ADMISSION_OWNER_CHANGED')
      need(value.expiresAt > Date.now(), 'MAX_ADMISSION_EXPIRED')
      activeSignal?.throwIfAborted()
      return true
    }
    await assertCurrent(signal)
    const token = Object.freeze({ allowed: true, role: 'minutes', provider: 'ollama', model: 'huiwen-max:latest', assertCurrent })
    issued.set(token, Object.freeze({ context, assertCurrent }))
    return token
  }
  return Object.freeze({ contract: MINUTES_ADMISSION_CONTRACT, authorize })
}
