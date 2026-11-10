import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export function assetError(code, message, status = 409, details = {}) {
  return Object.assign(new Error(message), { code, stage: 'asset_store', status, retryable: false, recoveryAction: 'reload_current_version', details });
}
export const clone = value => value == null ? value : structuredClone(value);
export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
const JOURNAL_TYPES=new Set(['meetings','recordings','audioRevisions','transcripts','minutes','documents','artifacts','jobs','jobEvents','viewStates','workspaces','templates','qaTurns','legacyImports']);
function validOperation(op){return !!op&&typeof op==='object'&&JOURNAL_TYPES.has(op.type)&&typeof op.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(op.id)&&(op.delete===true||(op.value&&typeof op.value==='object'&&!Array.isArray(op.value)&&op.value.id===op.id&&Number.isSafeInteger(op.value.revision)&&op.value.revision>0));}
export async function syncDir(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// One process per account root. Never steal a live or unknown writer lock.
export async function openJournal(root) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  root = await fs.realpath(root);
  const lockPath = path.join(root, '.next-assets-writer');
  const token = randomUUID();
  async function acquire() {
    try { await fs.mkdir(lockPath, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const reclaimPath = lockPath + '.reclaim';
      try { await fs.mkdir(reclaimPath, { mode: 0o700 }); }
      catch { throw assetError('ASSET_WRITER_BUSY', '写入锁正在恢复或需要人工核对。', 503); }
      try {
        // Re-read ownership under the exclusive reclaim guard. A reclaimer
        // never moves/deletes a new live owner's directory after a stale read.
        let owner;
        try { owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')); }
        catch { throw assetError('ASSET_WRITER_BUSY', '账号资产写入锁需要人工核对。', 503); }
        if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw assetError('ASSET_WRITER_BUSY', '账号资产写入锁归属未知。', 503);
        let dead = false;
        try { process.kill(owner.pid, 0); } catch (probe) { dead = probe.code === 'ESRCH'; }
        if (!dead) throw assetError('ASSET_WRITER_BUSY', '账号资产由另一写入者持有。', 503);
        const stale = lockPath + '.stale-' + token;
        try { await fs.rename(lockPath, stale); } catch { throw assetError('ASSET_WRITER_BUSY', '写入锁归属正在变更。', 503); }
        await fs.rm(stale, { recursive: true });
        try { await fs.mkdir(lockPath, { mode: 0o700 }); }
        catch { throw assetError('ASSET_WRITER_BUSY', '账号资产已被另一写入者接管。', 503); }
      } finally { await fs.rm(reclaimPath, { recursive: true }); }
    }
    await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), token }), { flag: 'wx', mode: 0o600 });
    await syncDir(lockPath); await syncDir(root);
  }
  await acquire();
  const journalPath = path.join(root, 'relations.journal.jsonl');
  let handle;
  try { handle = await fs.open(journalPath, 'a+', 0o600); await syncDir(root); }
  catch (error) { await handle?.close().catch(() => {}); await fs.rm(lockPath, { recursive: true }); throw error; }
  let revision = 0, previousHash = '0'.repeat(64);
  const tables = new Map();
  // Torn final lines may be truncated, complete corrupt entries never skipped.
  try {
    const reader = (await import('node:fs')).createReadStream(journalPath);
    let pending = Buffer.alloc(0), validBytes = 0;
    for await (const chunk of reader) {
      pending = Buffer.concat([pending, chunk]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        if (line.length > 8 * 1024 * 1024) throw assetError('ASSET_JOURNAL_CORRUPT', '关系journal记录超限。', 503);
        let entry;
        try { entry = JSON.parse(line.toString('utf8')); } catch { throw assetError('ASSET_JOURNAL_CORRUPT', '关系journal记录损坏。', 503); }
        const { hash, ...body } = entry;
        if (entry.revision !== revision + 1 || entry.previousHash !== previousHash || hash !== digest(canonical(body)) || !Array.isArray(entry.ops)) throw assetError('ASSET_JOURNAL_CORRUPT', '关系journal校验失败。', 503);
        for (const op of entry.ops) {
          if(!validOperation(op))throw assetError('ASSET_JOURNAL_CORRUPT','关系journal事务操作结构损坏。',503);
          if (!tables.has(op.type)) tables.set(op.type, new Map());
          if (op.delete) tables.get(op.type).delete(op.id); else tables.get(op.type).set(op.id, op.value);
        }
        revision = entry.revision; previousHash = hash; validBytes += line.length + 1;
      }
      if (pending.length > 8 * 1024 * 1024) throw assetError('ASSET_JOURNAL_CORRUPT', '关系journal未完成记录超限。', 503);
    }
    if (pending.length) { await handle.truncate(validBytes); await handle.sync(); }
  } catch (error) { await handle.close(); await fs.rm(lockPath, { recursive: true }); throw error; }
  let tail = Promise.resolve(), closed = false, closing = false, poisoned = false;
  function serial(fn) {
    if (closing) return Promise.reject(assetError('ASSET_STORE_UNAVAILABLE', '资产存储正在关闭。', 503));
    const result = tail.then(async () => {
      if (closed || poisoned) throw assetError('ASSET_STORE_UNAVAILABLE', '资产存储已关闭或需恢复。', 503);
      return fn();
    });
    tail = result.catch(() => {}); return result;
  }
  return {
    root,
    get revision() { return revision; },
    get availability() { return {closed:closed || closing,uncertain:poisoned,writable:!closed && !closing && !poisoned}; },
    reconcileUncertain() {
      if(closing) return Promise.reject(assetError('ASSET_STORE_UNAVAILABLE','资产存储正在关闭。',503));
      const result = tail.then(async () => {
        if(closed) throw assetError('ASSET_STORE_UNAVAILABLE','资产存储已关闭。',503);
        if(!poisoned) return {revision,reconciled:false};
        // Own writer lock is retained throughout this explicit serial barrier.
        // Reconstruct physical complete transactions, not the stale RAM tables.
        const rebuilt = new Map(); let recoveredRevision=0,recoveredHash='0'.repeat(64),validBytes=0,pending=Buffer.alloc(0);
        const reader=(await import('node:fs')).createReadStream(journalPath);
        for await(const chunk of reader) {
          pending=Buffer.concat([pending,chunk]); let newline;
          while((newline=pending.indexOf(10))>=0) {
            const line=pending.subarray(0,newline);pending=pending.subarray(newline+1);
            if(line.length>8*1024*1024) throw assetError('ASSET_JOURNAL_CORRUPT','关系journal记录超限。',503);
            let entry;try{entry=JSON.parse(line.toString('utf8'))}catch{throw assetError('ASSET_JOURNAL_CORRUPT','完整关系journal记录损坏，未删除。',503)}
            const {hash,...body}=entry;
            if(entry.schemaVersion!==1 || entry.revision!==recoveredRevision+1 || entry.previousHash!==recoveredHash || hash!==digest(canonical(body)) || !Array.isArray(entry.ops) || typeof entry.transactionId!=='string') throw assetError('ASSET_JOURNAL_CORRUPT','关系journal完整事务校验失败。',503);
            for(const op of entry.ops) {
              if(!validOperation(op)) throw assetError('ASSET_JOURNAL_CORRUPT','关系journal事务操作结构损坏。',503);
              if(!rebuilt.has(op.type)) rebuilt.set(op.type,new Map());
              if(op.delete===true) rebuilt.get(op.type).delete(op.id);else rebuilt.get(op.type).set(op.id,op.value);
            }
            recoveredRevision=entry.revision;recoveredHash=hash;validBytes+=line.length+1;
          }
          if(pending.length>8*1024*1024) throw assetError('ASSET_JOURNAL_CORRUPT','关系journal尾记录超限。',503);
        }
        // Only an incomplete final line is torn. Complete corrupt entries above
        // refuse reconciliation and remain byte-for-byte intact.
        if(pending.length) await handle.truncate(validBytes);
        await handle.sync();
        tables.clear();for(const [type,rows]of rebuilt)tables.set(type,rows);
        revision=recoveredRevision;previousHash=recoveredHash;poisoned=false;
        return {revision,reconciled:true};
      });
      tail=result.catch(()=>{});return result;
    },
    get(type, id) { return clone(tables.get(type)?.get(id)); },
    values(type) { return [...(tables.get(type)?.values() || [])].map(clone); },
    serial,
    async append(ops) {
      if (!ops.length) return revision;
      const body = { schemaVersion: 1, revision: revision + 1, previousHash, transactionId: randomUUID(), committedAt: new Date().toISOString(), ops };
      const hash = digest(canonical(body)); const line = Buffer.from(JSON.stringify({ ...body, hash }) + '\n');
      if (line.length > 8 * 1024 * 1024) throw assetError('ASSET_TRANSACTION_LIMIT', '关系事务超限，请分页提交元数据。', 413);
      try {
        let offset = 0;
        while (offset < line.length) { const result = await handle.write(line, offset, line.length - offset, null); if (!result.bytesWritten) throw new Error('journal write stalled'); offset += result.bytesWritten; }
        await handle.sync();
      } catch (error) { poisoned = true; throw Object.assign(assetError('ASSET_COMMIT_UNCERTAIN', '关系提交状态不确定，请重新打开并恢复journal。', 503), { cause: error }); }
      for (const op of ops) {
        if (!tables.has(op.type)) tables.set(op.type, new Map());
        if (op.delete) tables.get(op.type).delete(op.id); else tables.get(op.type).set(op.id, clone(op.value));
      }
      revision = body.revision; previousHash = hash; return revision;
    },
    async close() {
      closing = true; await tail; if (closed) return; closed = true; await handle.close();
      const owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
      if (owner.token === token) { await fs.rm(lockPath, { recursive: true }); await syncDir(root); }
    },
  };
}
 