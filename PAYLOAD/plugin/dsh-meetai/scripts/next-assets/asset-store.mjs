import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { openJournal, assetError, clone, canonical, syncDir } from './journal.mjs';

export const ASSET_TYPES = Object.freeze(['meetings','recordings','audioRevisions','transcripts','minutes','documents','artifacts','jobs','jobEvents','viewStates','workspaces','templates','qaTurns','legacyImports']);
const IDS = { meetings:'meetingId', recordings:'recordingId', audioRevisions:'audioRevisionId', transcripts:'transcriptVersionId', minutes:'minutesId', documents:'documentRevisionId', artifacts:'artifactId', jobs:'jobId', templates:'templateVersionId' };
const IMMUTABLE = new Set(['audioRevisions','transcripts','minutes','documents','artifacts','templates']);
const REFS = { recordingId:'recordings', sourceAudioRevisionId:'audioRevisions', activeAudioRevisionId:'audioRevisions', audioRevisionId:'audioRevisions', rootAudioRevisionId:'audioRevisions', parentAudioRevisionId:'audioRevisions', transcriptVersionId:'transcripts', parentMinutesId:'minutes', minutesId:'minutes', documentRevisionId:'documents', parentDocumentRevisionId:'documents', templateVersionId:'templates', artifactId:'artifacts', mappingArtifactId:'artifacts', rawTranscriptArtifactId:'artifacts', sentenceManifestId:'artifacts', wordManifestId:'artifacts', coverageArtifactId:'artifacts', contentArtifactId:'artifacts', reviewArtifactId:'artifacts', docxArtifactId:'artifacts', extractedTextArtifactId:'artifacts', transcriptArtifactId:'artifacts', asrPlanArtifactId:'artifacts', legacyRecordArtifactId:'artifacts', projectionArtifactId:'artifacts' };
export function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value); }
function checkType(type) { if (!ASSET_TYPES.includes(type)) throw assetError('ASSET_TYPE_INVALID', '不支持的资产类别。', 400); }
function checkId(id) { if (!validId(id)) throw assetError('ASSET_ID_INVALID', '资产标识无效。', 400); }
function jsonValue(value) {
  let text;
  try { text = JSON.stringify(value); } catch { throw assetError('ASSET_METADATA_INVALID', '资产元数据无法序列化。', 400); }
  if (!text || Buffer.byteLength(text) > 1024 * 1024) throw assetError('ASSET_METADATA_LIMIT', '资产元数据超限，请将大文本保存为artifact。', 413);
  return JSON.parse(text);
}
function cas(actual, expected) {
  if (!Number.isSafeInteger(expected) || expected < 0) throw assetError('ASSET_CAS_REQUIRED', '资产写入必须携带版本。', 428);
  if (actual !== expected) throw assetError('ASSET_VERSION_CONFLICT', '资产版本已变化，请保留待保存内容并加载最新版本。', 409, { currentRevision: actual });
}
function page(items, { cursor, limit = 30, meetingId, type, revision }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw assetError('ASSET_PAGE_LIMIT', '分页大小必须为1至100。', 400);
  items.sort((a,b) => String(a.id).localeCompare(String(b.id), 'en'));
  let after = '';
  if (cursor) {
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw assetError('ASSET_CURSOR_INVALID', '分页游标无效。', 400); }
    if (decoded.type !== type || decoded.meetingId !== (meetingId || null) || decoded.revision !== revision || !validId(decoded.after)) throw assetError('ASSET_CURSOR_STALE', '资产列表已变化，请从第一页重新加载。', 409);
    after = decoded.after;
  }
  const remaining = items.filter(item => !after || String(item.id).localeCompare(after, 'en') > 0);
  const selected = remaining.slice(0, limit);
  const nextCursor = remaining.length > limit ? Buffer.from(JSON.stringify({ type, meetingId: meetingId || null, revision, after: selected.at(-1).id })).toString('base64url') : null;
  return { items: selected, nextCursor, revision };
}
function summary(record) {
  // Relation metadata must not become an accidental path/large-text API.
  const allowed = new Set(['id','meetingId','recordingId','audioRevisionId','transcriptVersionId','minutesId','documentRevisionId','artifactId','templateVersionId','rootAudioRevisionId','parentAudioRevisionId','parentMinutesId','parentDocumentRevisionId','sourceAudioRevisionId','activeAudioRevisionId','audioSha256','sourceSha256','docxSha256','sha256','bytes','durationMs','durationSamples','sampleRate','channels','kind','status','state','title','originalName','displayTitle','createdAt','savedAt','updatedAt','revision','timingLevel','timingProvenance','lengthUtf16','bytesUtf8','source','jobId','stage','attempt','progress','error','cancelRequested','checkpointRef','planVersion']);
  return Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)));
}

/** root MUST come from authenticated Host data root, never an HTTP body. */
export async function createAssetStore({ root } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw assetError('ASSET_ROOT_INVALID', '宿主未提供账号私有数据根。', 500);
  const journal = await openJournal(root);
  const artifactRoot = path.join(journal.root, 'artifacts');
  try {
    await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(artifactRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw assetError('ASSET_ROOT_INVALID', 'artifact目录不安全。', 500);
  } catch (error) { await journal.close(); throw error; }
  const store = {
    get revision() { return journal.revision; },
    get availability() { return journal.availability; },
    reconcileUncertain: () => journal.reconcileUncertain(),
    get(type, id, { meetingId } = {}) {
      checkType(type); checkId(id); const record = journal.get(type, id);
      if (!record || (meetingId && record.meetingId !== meetingId)) throw assetError('ASSET_NOT_FOUND', '未找到可访问的资产。', 404);
      return record;
    },
    list(type, options = {}) {
      checkType(type);
      const items = journal.values(type).filter(record => !options.meetingId || record.meetingId === options.meetingId);
      return page(items, { ...options, type, revision: journal.revision });
    },
    async transaction(callback, { expectedRevision } = {}) {
      return journal.serial(async () => {
        if (expectedRevision !== undefined) cas(journal.revision, expectedRevision);
        const pending = new Map();
        const key = (type,id) => `${type}/${id}`;
        function read(type,id) { checkType(type); checkId(id); const op = pending.get(key(type,id)); return op ? (op.delete ? undefined : clone(op.value)) : journal.get(type,id); }
        const tx = {
          revision: journal.revision,
          get(type,id, { meetingId } = {}) { const record = read(type,id); if (record && meetingId && record.meetingId !== meetingId) return undefined; return record; },
          list(type, { meetingId } = {}) {
            checkType(type); const map = new Map(journal.values(type).map(record => [record.id,record]));
            for (const op of pending.values()) if (op.type === type) { if (op.delete) map.delete(op.id); else map.set(op.id, clone(op.value)); }
            return [...map.values()].filter(record => !meetingId || record.meetingId === meetingId);
          },
          put(type, input, { expectedRevision = 0, metadataOnly = false } = {}) {
            checkType(type); const value = jsonValue(input); const alias = IDS[type]; const id = value.id || (alias && value[alias]); checkId(id);
            if (alias && value[alias] && value[alias] !== id) throw assetError('ASSET_ID_MISMATCH', '资产标识不一致。', 400);
            value.id = id; if (alias) value[alias] = id;
            if (type === 'meetings') value.meetingId = id;
            else if (type !== 'legacyImports' && type !== 'templates') checkId(value.meetingId);
            const previous = read(type,id); cas(previous?.revision || 0, expectedRevision);
            if (previous && previous.meetingId !== value.meetingId) throw assetError('ASSET_SCOPE_IMMUTABLE', '已提交资产不能改绑会议。', 409);
            if (previous && IMMUTABLE.has(type) && !metadataOnly) throw assetError('ASSET_IMMUTABLE', '已提交内容版本不可覆盖，请创建新版本。', 409);
            if (previous && metadataOnly) {
              const keys = ['status','state','reviewState','updatedAt'];
              for (const name of new Set([...Object.keys(previous),...Object.keys(value)])) if (!keys.includes(name) && name !== 'revision' && canonical(previous[name]) !== canonical(value[name])) throw assetError('ASSET_IMMUTABLE', '元数据更新不得更改资产内容或关联。', 409);
            }
            value.revision = (previous?.revision || 0) + 1;
            value.createdAt ||= previous?.createdAt || new Date().toISOString(); value.updatedAt = new Date().toISOString();
            pending.set(key(type,id), { type,id,value }); return clone(value);
          },
          delete(type,id, { expectedRevision } = {}) {
            const previous = read(type,id); cas(previous?.revision || 0, expectedRevision);
            if (IMMUTABLE.has(type)) throw assetError('ASSET_IMMUTABLE', '内容版本不能直接删除。', 409);
            pending.set(key(type,id), { type,id,delete:true });
          },
        };
        const result = await callback(tx);
        // Validate final staged graph (supports root recording/audio cycles).
        for (const op of pending.values()) {
          if (op.delete) continue;
          for (const [field,targetType] of Object.entries(REFS)) {
            if (!op.value[field] || (IDS[op.type] === field && op.value[field] === op.id)) continue;
            const target = read(targetType, op.value[field]);
            if (!target || (target.meetingId && target.meetingId !== op.value.meetingId)) throw assetError('ASSET_REFERENCE_INVALID', '资产引用缺失或不属于此会议。', 422, { field });
          }
        }
        for (const op of pending.values()) {
          if (op.delete) continue;
          const value = op.value;
          const audio = value.audioRevisionId && op.type !== 'audioRevisions' ? read('audioRevisions',value.audioRevisionId) : null;
          if (audio && value.recordingId && audio.recordingId !== value.recordingId) throw assetError('ASSET_REFERENCE_INVALID','音频与录音资产关联不匹配。',422);
          if (op.type === 'audioRevisions') for (const field of ['parentAudioRevisionId','rootAudioRevisionId']) if (value[field]) {
            const related = read('audioRevisions',value[field]);
            if (related.recordingId !== value.recordingId) throw assetError('ASSET_REFERENCE_INVALID','派生音频不属于同一录音。',422);
          }
          if (op.type === 'minutes' && value.transcriptVersionId && value.sourceAudioRevisionId && read('transcripts',value.transcriptVersionId).audioRevisionId !== value.sourceAudioRevisionId) throw assetError('ASSET_REFERENCE_INVALID','纪要源音频与转写版本不匹配。',422);
          for (const field of ['sha256','audioSha256','sourceSha256','docxSha256']) if (value[field] !== undefined && !/^[a-f0-9]{64}$/.test(value[field])) throw assetError('ASSET_HASH_INVALID','资产哈希字段无效。',422,{field});
          // Counts/bytes remain integers; milliseconds are an exact sample-derived quotient.
          for (const field of ['bytes','bytesUtf8','lengthUtf16','durationSamples']) if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] < 0)) throw assetError('ASSET_MEASUREMENT_INVALID','资产计量值无效。',422,{field});
          if (value.durationMs !== undefined && (!Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > Number.MAX_SAFE_INTEGER)) throw assetError('ASSET_MEASUREMENT_INVALID','资产时长无效。',422,{field:'durationMs'});
          if (op.type === 'audioRevisions') {
            for (const field of ['sampleRate','channels']) if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field] <= 0)) throw assetError('ASSET_MEASUREMENT_INVALID','音频时基无效。',422,{field});
            if (value.durationSamples !== undefined && (!Number.isSafeInteger(value.sampleRate) || value.sampleRate <= 0 || value.durationMs !== value.durationSamples * 1000 / value.sampleRate)) throw assetError('ASSET_MEASUREMENT_INVALID','音频时长与精确样本时基不一致。',422,{field:'durationMs'});
          }
          if (op.type === 'transcripts' && ((value.lengthUtf16 || 0) > 2000000 || (value.bytesUtf8 || 0) > 16 * 1024 * 1024)) throw assetError('TRANSCRIPT_LIMIT','原文产物已保留，但不能登记为超规格的转写版本。',413);
          const artifactField = op.type === 'audioRevisions' ? 'artifactId' : op.type === 'documents' ? 'docxArtifactId' : null;
          if (artifactField && value[artifactField]) {
            const artifact = read('artifacts',value[artifactField]);
            const declaredHash = op.type === 'documents' ? value.docxSha256 : value.sha256;
            if ((declaredHash && declaredHash !== artifact.sha256) || (value.bytes !== undefined && value.bytes !== artifact.bytes)) throw assetError('ASSET_CONTENT_MISMATCH','资产内容引用与哈希或字节数不一致。',422);
          }
        }
        // Deletes cannot strand references; immutable history stays intact.
        for (const op of pending.values()) if (op.delete) for (const type of ASSET_TYPES) for (const record of tx.list(type)) for (const [field,target] of Object.entries(REFS)) if (target === op.type && record[field] === op.id && !(record.id === op.id && type === op.type)) throw assetError('ASSET_REFERENCED', '资产仍被引用，不能删除。', 409);
        const revision = await journal.append([...pending.values()]);
        return { result: clone(result), revision };
      });
    },
    async put(type, record, options = {}) { return (await store.transaction(tx => tx.put(type,record,options))).result; },
    async register(type, record, options = {}) { return store.put(type,record,options); },
    async patchMetadata(type,id,patch,{expectedRevision} = {}) {
      return (await store.transaction(tx => { const previous = tx.get(type,id); if (!previous) throw assetError('ASSET_NOT_FOUND','未找到可访问的资产。',404); return tx.put(type,{...previous,...patch},{expectedRevision,metadataOnly:true}); })).result;
    },
    workspace(meetingId, { limit = 30, cursors = {} } = {}) {
      checkId(meetingId);
      const result = { schemaVersion:1,meetingId,revision:journal.revision,viewState:journal.get('viewStates',meetingId)?.value || {},pages:{} };
      for (const type of ['recordings','audioRevisions','transcripts','minutes','documents']) {
        const paged = store.list(type,{meetingId,limit,cursor:cursors[type]}); result[type] = paged.items.map(summary); result.pages[type] = {nextCursor:paged.nextCursor};
      }
      const activeJobs = page(journal.values('jobs').filter(job => job.meetingId === meetingId && ['queued','running','paused_resource','waiting_user','interrupted'].includes(job.state)),{type:'activeJobs',meetingId,limit,cursor:cursors.activeJobs,revision:journal.revision});
      result.activeJobs = activeJobs.items.map(summary); result.pages.activeJobs = {nextCursor:activeJobs.nextCursor};
      return result;
    },
    getWorkspace(meetingId, options) { return store.workspace(meetingId,options); },
    async updateViewState(meetingId, patch, { expectedRevision } = {}) {
      checkId(meetingId); cas(journal.revision, expectedRevision); const permitted = ['audioRevisionId','transcriptVersionId','minutesId','documentRevisionId','playbackMs','captionMode','followPlayback','sourceMode','collapsedPanels'];
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !permitted.includes(key))) throw assetError('VIEW_STATE_INVALID','查看状态包含不允许的字段。',400);
      if (patch.playbackMs !== undefined && (!Number.isSafeInteger(patch.playbackMs) || patch.playbackMs < 0 || patch.playbackMs > 14400000)) throw assetError('VIEW_STATE_INVALID','播放位置无效。',400);
      if (patch.captionMode !== undefined && !['sentence','word'].includes(patch.captionMode)) throw assetError('VIEW_STATE_INVALID','字幕模式无效。',400);
      if (patch.followPlayback !== undefined && typeof patch.followPlayback !== 'boolean') throw assetError('VIEW_STATE_INVALID','跟随状态无效。',400);
      if (patch.sourceMode !== undefined && !['uploaded','recorded','history'].includes(patch.sourceMode)) throw assetError('VIEW_STATE_INVALID','来源模式无效。',400);
      if (patch.collapsedPanels !== undefined && (!Array.isArray(patch.collapsedPanels) || patch.collapsedPanels.length > 20 || patch.collapsedPanels.some(item => typeof item !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(item)))) throw assetError('VIEW_STATE_INVALID','面板状态无效。',400);
      return store.transaction(tx => {
        const previous = tx.get('viewStates',meetingId);
        const value = {...(previous?.value || {}),...patch};
        for (const field of ['audioRevisionId','transcriptVersionId','minutesId','documentRevisionId']) if (value[field] != null) {
          const entity = tx.get(REFS[field],value[field],{meetingId}); if (!entity) throw assetError('VIEW_STATE_REFERENCE_INVALID','所选版本不属于此会议。',422);
        }
        const audio = value.audioRevisionId && tx.get('audioRevisions',value.audioRevisionId);
        const transcript = value.transcriptVersionId && tx.get('transcripts',value.transcriptVersionId);
        const minutes = value.minutesId && tx.get('minutes',value.minutesId);
        const document = value.documentRevisionId && tx.get('documents',value.documentRevisionId);
        if ((transcript && audio && transcript.audioRevisionId !== audio.id) || (document && minutes && document.minutesId !== minutes.id)) throw assetError('VIEW_STATE_REFERENCE_INVALID','所选版本之间不匹配。',422);
        return tx.put('viewStates',{id:meetingId,meetingId,value},{expectedRevision:previous?.revision || 0});
      },{expectedRevision});
    },
    async putArtifact({ data, filePath, kind = 'binary', expectedSha256, meetingId, maxBytes = 4 * 1024 ** 3 } = {}) {
      checkId(meetingId);
      if ((data === undefined) === (filePath === undefined)) throw assetError('ARTIFACT_INPUT_INVALID','artifact必须提供一种数据来源。',400);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw assetError('ARTIFACT_INPUT_INVALID','artifact限额无效。',400);
      if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw assetError('ARTIFACT_INPUT_INVALID','artifact哈希无效。',400);
      const id = 'art_' + randomUUID().replaceAll('-',''); const temp = path.join(artifactRoot,id + '.pending'); const destination = path.join(artifactRoot,id + '.data');
      const hash = createHash('sha256'); let bytes = 0;
      const meter = new Transform({ transform(chunk,encoding,callback) { bytes += chunk.length; if (bytes > maxBytes) return callback(assetError('ARTIFACT_LIMIT','产物超过容量边界。',413)); hash.update(chunk); callback(null,chunk); } });
      try {
        const source = filePath !== undefined ? createReadStream(filePath) : (await import('node:stream')).Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))]);
        await pipeline(source,meter,createWriteStream(temp,{flags:'wx',mode:0o600}));
        const sha256 = hash.digest('hex'); if (expectedSha256 && sha256 !== expectedSha256) throw assetError('ARTIFACT_INTEGRITY','产物完整性校验失败。',422);
        const handle = await fs.open(temp,'r+'); try { await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temp,destination); await syncDir(artifactRoot);
        // A crash before this commit leaves an orphan, never a broken reference.
        return await store.put('artifacts',{id,meetingId,kind,sha256,bytes,status:'ready'},{expectedRevision:0});
      } catch (error) { await fs.rm(temp,{force:true}).catch(()=>{}); throw error; }
    },
    async resolveArtifact(id,{meetingId} = {}) {
      const record = store.get('artifacts',id,{meetingId}); const filePath = path.join(artifactRoot,id + '.data');
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.bytes) throw assetError('ARTIFACT_INTEGRITY','产物文件无法通过完整性检查。',422);
      return {...record,filePath,absolutePath:filePath};
    },
    async verifyArtifact(id,options) {
      const record = await store.resolveArtifact(id,options); const hash = createHash('sha256'); for await (const chunk of createReadStream(record.filePath)) hash.update(chunk);
      if (hash.digest('hex') !== record.sha256) throw assetError('ARTIFACT_INTEGRITY','产物哈希校验失败。',422);
      return record;
    },
    close: () => journal.close(),
  };
  return store;
}
 