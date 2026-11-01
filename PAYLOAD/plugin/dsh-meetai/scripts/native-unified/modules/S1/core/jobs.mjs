import { isDeepStrictEqual } from 'node:util';
import { requireCore, identifier, revision, positive, jsonData, copy, plain } from './validation.mjs';
import { executeWithLease } from './task-resource.mjs';
const jobKey = (captured, jobId) => JSON.stringify([captured.accountId, captured.meetingId, identifier(jobId)]);
const terminal = state => ['succeeded', 'cancelled', 'failed'].includes(state);
export function jobMethods(internal) {
  const { transaction, latest, serialize, checked, getState, version } = internal;
  const handlers = new Map(); let stopping = false, running = null;
  function descriptor(value) {
    requireCore(plain(value) && value.contractVersion === version, 'VERSION_UNSUPPORTED');
    requireCore(typeof value.handlerVersion === 'string' && /^\d+\.\d+\.\d+$/.test(value.handlerVersion), 'VERSION_UNSUPPORTED');
    return { handlerId: identifier(value.handlerId), ownerCapability: identifier(value.ownerCapability),
      handlerVersion: value.handlerVersion, contractVersion: version, inputSchemaVersion: positive(value.inputSchemaVersion),
      resource: identifier(value.resource) };
  }
  function owned(image, captured, id) {
    const job = image.jobs[jobKey(captured, id)]; requireCore(job, 'JOB_NOT_FOUND');
    requireCore(job.subjectId === captured.subjectId, 'JOB_NOT_OWNED'); requireCore(job.epoch === captured.epoch, 'EPOCH_STALE'); return job;
  }
  function usable(job) {
    const handler = handlers.get(job.handlerId); requireCore(handler && handler.active && !stopping, 'HANDLER_UNAVAILABLE');
    requireCore(handler.descriptor.handlerVersion === job.handlerVersion && handler.descriptor.inputSchemaVersion === job.inputSchemaVersion &&
      handler.descriptor.resource === job.resource, 'VERSION_UNSUPPORTED'); return handler;
  }
  function publicJob(job) {
    const { jobId, handlerId, handlerVersion, epoch, revision, state, attempts, result, errorCode } = job;
    const executing = running && running.jobId === jobId && running.accountId === job.accountId && running.meetingId === job.meetingId;
    return copy({ jobId, handlerId, handlerVersion, epoch, revision, state, attempts, recoveryRequired: state === 'running' && !executing,
      ...(result !== undefined ? { result } : {}), ...(errorCode ? { errorCode } : {}) });
  }
  const methods = {
    async registerHandler(context, expectedRevision, value, run) {
      const wanted = descriptor(value); requireCore(typeof run === 'function' && !stopping, 'INVALID_HANDLER');
      requireCore(!handlers.has(wanted.handlerId), 'HANDLER_CONFLICT');
      const entry = { descriptor: wanted, run, active: false }; handlers.set(wanted.handlerId, entry);
      try {
        await transaction(context, expectedRevision, next => {
          requireCore(!stopping, 'RUNNER_CLOSED'); const prior = next.handlers[wanted.handlerId];
          requireCore(!prior || isDeepStrictEqual(prior, wanted), 'HANDLER_CONFLICT'); next.handlers[wanted.handlerId] = wanted; return wanted;
        }, 'allowManageJobs', { operation: 'registerHandler', descriptor: wanted });
        requireCore(!stopping, 'RUNNER_CLOSED'); entry.active = true;
      } catch (error) { if (handlers.get(wanted.handlerId) === entry) handlers.delete(wanted.handlerId); throw error; }
      let disposed = false, disposal;
      return () => {
        if (disposed) return disposal; disposed = true; entry.active = false;
        if (handlers.get(wanted.handlerId) === entry) handlers.delete(wanted.handlerId);
        disposal = (async () => { if (running?.handler === entry) { running.controller.abort(); await running.promise.catch(() => {}); } })();
        return disposal;
      };
    },
    async enqueueJob(context, expectedRevision, value) {
      requireCore(plain(value) && !stopping, 'RUNNER_CLOSED'); jsonData(value.input);
      const input = { jobId: identifier(value.jobId), operationId: identifier(value.operationId), handlerId: identifier(value.handlerId),
        handlerVersion: value.handlerVersion, inputSchemaVersion: positive(value.inputSchemaVersion), input: copy(value.input) };
      return transaction(context, expectedRevision, (next, key, captured) => {
        requireCore(!stopping, 'RUNNER_CLOSED'); const record = next.handlers[input.handlerId];
        requireCore(record && record.handlerVersion === input.handlerVersion && record.inputSchemaVersion === input.inputSchemaVersion, 'VERSION_UNSUPPORTED');
        const draft = { ...input, accountId: captured.accountId, meetingId: captured.meetingId, subjectId: captured.subjectId,
          epoch: captured.epoch, resource: record.resource }; usable(draft);
        const existing = Object.values(next.jobs).find(job => job.accountId === captured.accountId &&
          job.meetingId === captured.meetingId && job.operationId === input.operationId);
        if (existing) {
          requireCore(existing.jobId === input.jobId && existing.epoch === captured.epoch && existing.subjectId === captured.subjectId &&
            existing.handlerId === draft.handlerId && existing.handlerVersion === draft.handlerVersion &&
            existing.inputSchemaVersion === draft.inputSchemaVersion && isDeepStrictEqual(existing.input, draft.input), 'OPERATION_CONFLICT');
          return publicJob(existing);
        }
        const keyForJob = jobKey(captured, input.jobId); requireCore(!next.jobs[keyForJob], 'JOB_EXISTS');
        next.jobs[keyForJob] = { ...draft, state: 'queued', revision: 0, attempts: 0 }; return publicJob(next.jobs[keyForJob]);
      }, 'allowRunJobs', { operation: 'enqueueJob', handlerId: input.handlerId });
    },
    async getJob(context, jobId) {
      return serialize(async () => { const { captured } = await checked(context); return publicJob(owned(getState(), captured, jobId)); });
    },
    async cancelJob(context, expectedRevision, jobId, expectedJobRevision) {
      revision(expectedJobRevision);
      const outcome = await transaction(context, expectedRevision, (next, key, captured) => {
        const job = owned(next, captured, jobId); requireCore(job.revision === expectedJobRevision, 'JOB_REVISION_CONFLICT');
        requireCore(!terminal(job.state) || job.state === 'cancelled', 'JOB_STATE_CONFLICT');
        if (job.state !== 'cancelled') { job.state = 'cancelled'; job.revision++; } return publicJob(job);
      }, 'allowRunJobs', { operation: 'cancelJob', jobId });
      if (running && running.accountId === context.accountId && running.meetingId === context.meetingId && running.jobId === jobId)
        running.controller.abort(); return outcome;
    },
    async recoverJob(context, expectedRevision, jobId, expectedJobRevision) {
      revision(expectedJobRevision);
      return transaction(context, expectedRevision, (next, key, captured) => {
        const job = owned(next, captured, jobId); requireCore(job.revision === expectedJobRevision, 'JOB_REVISION_CONFLICT');
        requireCore(job.state === 'running' && !running, 'JOB_STATE_CONFLICT'); usable(job);
        job.state = 'queued'; job.revision++; return publicJob(job);
      }, 'allowRunJobs', { operation: 'recoverJob', jobId });
    },
    runNext(context) {
      requireCore(!stopping, 'RUNNER_CLOSED'); requireCore(!running, 'RUNNER_BUSY');
      const slot = { controller: new AbortController(), context, jobId: null, accountId: null, meetingId: null, handler: null, promise: null };
      running = slot;
      slot.promise = (async () => {
        let selected;
        try {
          const started = await latest(context, (next, key, captured) => {
            const job = Object.values(next.jobs).find(row => row.accountId === captured.accountId && row.meetingId === captured.meetingId &&
              row.subjectId === captured.subjectId && row.state === 'queued'); if (!job) return null;
            requireCore(!stopping && !slot.controller.signal.aborted, 'RUNNER_CLOSED'); requireCore(job.epoch === captured.epoch, 'EPOCH_STALE');
            slot.handler = usable(job); slot.jobId = job.jobId; slot.accountId = job.accountId; slot.meetingId = job.meetingId;
            job.state = 'running'; job.revision++; job.attempts++; selected = copy(job); return publicJob(job);
          }, 'allowRunJobs', { operation: 'startJob' });
          if (!started.value) return null;
          requireCore(!stopping && slot.handler.active && !slot.controller.signal.aborted, 'JOB_INTERRUPTED');
          return await executeWithLease(internal, context, selected.resource, slot.controller, async (verifyLease, lease) => {
            const result = await slot.handler.run(Object.freeze({ input: copy(selected.input), signal: slot.controller.signal,
              jobId: selected.jobId, epoch: selected.epoch, resource: selected.resource })); jsonData(result);
            requireCore(!stopping && slot.handler.active && !slot.controller.signal.aborted, 'JOB_INTERRUPTED');
            await verifyLease();
            requireCore(!stopping && slot.handler.active && !slot.controller.signal.aborted, 'JOB_INTERRUPTED');
            const done = await latest(context, (next, key, captured) => {
              const job = owned(next, captured, selected.jobId);
              requireCore(job.state === 'running' && job.revision === selected.revision, 'JOB_STATE_CONFLICT');
              requireCore(slot.handler.active && !slot.controller.signal.aborted && !stopping, 'JOB_INTERRUPTED');
              job.state = 'succeeded'; job.revision++; job.result = copy(result); return publicJob(job);
            }, 'allowRunJobs', { operation: 'publishJob', jobId: selected.jobId }, { lease }); return done.value;
          });
        } catch (error) {
          if (selected && !stopping) {
            try {
              await latest(context, (next, key, captured) => {
                const job = owned(next, captured, selected.jobId);
                if (job.state === 'running') { job.state = slot.controller.signal.aborted ? 'cancelled' : 'failed'; job.revision++; job.errorCode = 'HANDLER_FAILED'; }
                return publicJob(job);
              }, 'allowRunJobs', { operation: 'finishInterruptedJob', jobId: selected.jobId });
            } catch { /* Fence/revocation/close preserves original running intent. */ }
          } throw error;
        } finally { if (running === slot) running = null; }
      })(); return slot.promise;
    }
  };
  async function stop() {
    stopping = true; for (const entry of handlers.values()) entry.active = false; handlers.clear();
    if (running) { running.controller.abort(); await running.promise.catch(() => {}); }
  }
  async function interruptMeeting(accountId, meetingId, epoch) {
    identifier(accountId); identifier(meetingId); revision(epoch);
    const slot = running;
    if (!slot || slot.context.accountId !== accountId || slot.context.meetingId !== meetingId || slot.context.epoch !== epoch) return;
    slot.controller.abort(); await slot.promise.catch(() => {});
  }
  function inspectRunning() {
    return running ? { accountId: running.context.accountId, meetingId: running.context.meetingId,
      epoch: running.context.epoch, jobId: running.jobId, phase: running.jobId === null ? 'preparing' : 'executing' } : null;
  }
  return { methods, stop, interruptMeeting, inspectRunning };
}
