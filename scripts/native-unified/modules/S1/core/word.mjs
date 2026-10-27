import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { requireCore, identifier, revision, positive, copy, plain, assetKey, sourceIdentity } from './validation.mjs';
import { authorizeSourceRead } from './source-authorization.mjs';
import { validateWordContent } from './word-content.mjs';
export { validateWordContent } from './word-content.mjs';
const documentId = value => { identifier(value); requireCore(value.length <= 100, 'INVALID_ID'); return value; };
const draftId = (id, subject) => 'draft_' + createHash('sha256').update(JSON.stringify([id, subject])).digest('hex');
export function wordMethods(internal) {
  const { transaction, serialize, checked, getState, authorizeRead, version } = internal;
  const adapter = { type: 'core_word', ownerCapability: 'core', schemas: [1], contractVersion: version };
  function own(next, captured, id) {
    const row = next.documents[assetKey(captured.accountId, captured.meetingId, documentId(id))];
    requireCore(row && row.epoch === captured.epoch, 'DOCUMENT_NOT_FOUND'); return row;
  }
  function publishAsset(next, captured, id, content, assetRevision) {
    const priorAdapter = next.adapters.core_word;
    requireCore(!priorAdapter || isDeepStrictEqual(priorAdapter, adapter), 'ADAPTER_CONFLICT');
    next.adapters.core_word = adapter;
    const source = { accountId: captured.accountId, meetingId: captured.meetingId, assetId: id,
      epoch: captured.epoch, revision: positive(assetRevision), sha256: content.sha256 };
    const key = assetKey(captured.accountId, captured.meetingId, id), prior = next.assets[key];
    requireCore(!prior || prior.type === 'core_word', 'ASSET_TYPE_CONFLICT');
    next.assets[key] = { type: 'core_word', schemaVersion: 1, source, referenceRevision: prior?.referenceRevision ?? 0,
      references: prior?.references ?? [], data: content }; return source;
  }
  function append(next, captured, id, expected, content, kind, templateSource) {
    const key = assetKey(captured.accountId, captured.meetingId, id), prior = next.documents[key];
    requireCore((prior?.revision ?? 0) === expected, 'DOCUMENT_REVISION_CONFLICT');
    requireCore(!prior || prior.kind === kind, 'DOCUMENT_KIND_CONFLICT');
    requireCore(!prior || prior.epoch === captured.epoch, 'EPOCH_STALE');
    if (templateSource) {
      const target = next.assets[assetKey(templateSource.accountId, templateSource.meetingId, templateSource.assetId)];
      const template = Object.values(next.documents).find(row => row.kind === 'template' &&
        isDeepStrictEqual(row.versions.at(-1)?.source, templateSource));
      requireCore(target && template && isDeepStrictEqual(target.source, templateSource) &&
        template.accountId === captured.accountId && template.meetingId === captured.meetingId &&
        template.epoch === captured.epoch, 'TEMPLATE_INVALIDATED');
    }
    const source = publishAsset(next, captured, 'word_' + id, content, expected + 1);
    const row = prior ?? { documentId: id, accountId: captured.accountId, meetingId: captured.meetingId,
      epoch: captured.epoch, kind, revision: 0, versions: [], drafts: {} };
    row.revision++;
    row.versions.push({ revision: row.revision, subjectId: captured.subjectId, content,
      source, ...(templateSource ? { templateSource } : {}) });
    next.documents[key] = row;
    if (templateSource) {
      const asset = next.assets[assetKey(captured.accountId, captured.meetingId, source.assetId)];
      asset.references = [{ source: templateSource, mode: 'whole' }]; asset.referenceRevision++;
    }
    return { documentId: id, documentRevision: row.revision, source, kind };
  }
  const mutations = {
    document(next, captured, value) {
      requireCore(plain(value) && ['document', 'template'].includes(value.kind), 'INVALID_DOCUMENT');
      return append(next, captured, documentId(value.documentId), revision(value.expectedDocumentRevision),
        validateWordContent(value.content), value.kind, value.templateSource ? sourceIdentity(value.templateSource) : undefined);
    },
    draft(next, captured, value) {
      const id = documentId(value.documentId), expectedDraft = revision(value.expectedDraftRevision),
        base = revision(value.baseDocumentRevision), content = validateWordContent(value.content);
      const row = own(next, captured, id), draft = row.drafts[captured.subjectId];
      requireCore(base > 0 && base <= row.revision, 'DOCUMENT_REVISION_CONFLICT');
      requireCore((draft?.revision ?? 0) === expectedDraft, 'DRAFT_REVISION_CONFLICT');
      const source = publishAsset(next, captured, draftId(id, captured.subjectId), content, expectedDraft + 1);
      row.drafts[captured.subjectId] = { revision: expectedDraft + 1, baseDocumentRevision: base, content, source };
      return { documentId: id, draftRevision: expectedDraft + 1, baseDocumentRevision: base, source };
    },
    promote(next, captured, value) {
      const id = documentId(value.documentId); revision(value.expectedDocumentRevision); positive(value.expectedDraftRevision);
      const row = own(next, captured, id), draft = row.drafts[captured.subjectId];
      requireCore(draft?.revision === value.expectedDraftRevision, 'DRAFT_REVISION_CONFLICT');
      requireCore(row.revision === value.expectedDocumentRevision && draft.baseDocumentRevision === row.revision,
        'DOCUMENT_REVISION_CONFLICT');
      const result = append(next, captured, id, row.revision, copy(draft.content), row.kind);
      draft.promotedToRevision = result.documentRevision; return result;
    }
  };
  internal.wordMutations = Object.freeze(mutations);
  function direct(context, expectedRevision, operation, value, details) {
    return transaction(context, expectedRevision, (next, key, captured) => {
      requireCore(!next.assets[assetKey(captured.accountId, captured.meetingId, 'compat_index')]?.data.cutover,
        'COMPAT_WRITER_REQUIRED');
      return mutations[operation](next, captured, value);
    }, 'allowWriteWord', details);
  }
  return {
    async putWordDocument(context, expectedRevision, value) {
      // Snapshot before transaction's first await: proof and mutation share one input.
      const snapshot = copy(value);
      const templateSource = snapshot.templateSource ? sourceIdentity(snapshot.templateSource) : undefined;
      if (templateSource) snapshot.templateSource = templateSource;
      return direct(context, expectedRevision, 'document', snapshot, { operation: 'putWordDocument', documentId: snapshot.documentId,
        ...(templateSource ? { references: [{ mode: 'whole', source: templateSource }] } : {}) });
    },
    async saveWordDraft(context, expectedRevision, value) {
      const snapshot = copy(value);
      return direct(context, expectedRevision, 'draft', snapshot, { operation: 'saveWordDraft', documentId: snapshot.documentId });
    },
    async promoteWordDraft(context, expectedRevision, document, expectedDocumentRevision, expectedDraftRevision) {
      return direct(context, expectedRevision, 'promote', { documentId: document, expectedDocumentRevision, expectedDraftRevision },
        { operation: 'promoteWordDraft', documentId: document });
    },
    async readWordDocument(context, document, wantedRevision) {
      const id = documentId(document); if (wantedRevision !== undefined) positive(wantedRevision);
      return serialize(async () => {
        const { captured } = await checked(context), row = own(getState(), captured, id);
        const saved = wantedRevision === undefined ? row.versions.at(-1) : row.versions.find(item => item.revision === wantedRevision);
        requireCore(saved, 'DOCUMENT_REVISION_NOT_FOUND');
        await authorizeSourceRead(authorizeRead, captured, { mode: 'whole', source: saved.source });
        await checked(context); return copy({ documentId: id, kind: row.kind, documentRevision: saved.revision, ...saved });
      });
    },
    async readWordDraft(context, document) {
      const id = documentId(document);
      return serialize(async () => {
        const { captured } = await checked(context), row = own(getState(), captured, id), draft = row.drafts[captured.subjectId];
        requireCore(draft, 'DRAFT_NOT_FOUND');
        await authorizeSourceRead(authorizeRead, captured, { mode: 'whole', source: draft.source });
        await checked(context); return copy({ documentId: id, currentDocumentRevision: row.revision, ...draft });
      });
    }
  };
}
