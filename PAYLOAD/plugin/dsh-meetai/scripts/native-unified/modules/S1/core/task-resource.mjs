// One core lease authority. Preflight is not the publication admission check.
export async function executeWithLease({ claimResource, heartbeatResource, releaseResource }, context, resource, controller, run) {
  const lease = await claimResource(context, resource);
  let pending = Promise.resolve(), heartbeatBusy = false, failure;
  const heartbeat = async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try { await heartbeatResource(context, lease); }
    catch (error) { failure = error; controller.abort(); }
    finally { heartbeatBusy = false; }
  };
  const timer = setInterval(() => { if (!heartbeatBusy) pending = heartbeat(); }, 10000); timer.unref();
  const verify = async () => { await pending; if (failure) throw failure; await heartbeatResource(context, lease); };
  try {
    if (controller.signal.aborted) throw Object.assign(new Error('JOB_INTERRUPTED'), { code: 'JOB_INTERRUPTED' });
    return await run(verify, lease); // Token is checked and pinned inside the guarded core commit.
  } finally {
    clearInterval(timer); await pending.catch(() => {});
    await releaseResource(context, lease).catch(() => {}); // Never removes a replacement holder's token.
  }
}
