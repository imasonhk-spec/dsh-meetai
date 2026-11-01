// Compiled into the existing classic meeting factory. No model or upload substitution.
async function generateWithProgress035(body, { signal, onProgress, resumeTaskId } = {}) {
  signal?.throwIfAborted()
  let taskId, cancelled = false, cancellation
  const report = task => {
    const p = task.progress || {}, phase = task.state === "completed" ? task.state : p.phase || task.state
    const labels = { committing: "正在提交纪要；提交阶段不再接受取消", queued: "等待纪要处理", extract: "正在逐段提取与回查原文", write: "正在按议题生成并核验", word: "正在生成Word并提交纪要", running: "纪要任务处理中", completed: "纪要任务完成" }
    const segments = Number.isSafeInteger(p.plannedSegments) ? ` · 已处理分段 ${p.processedSegments || 0}/${p.plannedSegments}` : ""
    onProgress?.({ ...task, label: (labels[phase] || "纪要任务处理中") + segments })
  }
  const cancel = () => {
    if (cancelled) return cancellation
    if (!taskId) return Promise.resolve({accepted:false})
    cancelled = true
    cancellation = fetch(API + "/generation-tasks/" + encodeURIComponent(taskId), { method: "DELETE", credentials: "same-origin", signal: AbortSignal.timeout(15000) })
      .then(async response=>({accepted:response.ok && (await response.json()).task?.state === "cancelled"})).catch(()=>({accepted:false}))
    return cancellation
  }
  const pause = () => new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", aborted); resolve() }
    const timer = setTimeout(done, 1200)
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(signal.reason || new DOMException("已取消", "AbortError")) }
    if (signal?.aborted) aborted(); else signal?.addEventListener("abort", aborted, { once: true })
  })
  try {
    // Learn the server task ID even if the operator cancels while admission is pending.
    const route = resumeTaskId ? "/generation-tasks/" + encodeURIComponent(resumeTaskId) + "/retry" : "/generation-tasks"
    const admitted = await request(route, { ...json(resumeTaskId ? {} : body), signal: AbortSignal.timeout(30000) })
    let task = admitted.task
    if (!task || !/^[a-f0-9-]{36}$/.test(task.task_id)) throw new Error("服务器未返回合法纪要任务，未显示生成成功。")
    taskId = task.task_id
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) { cancel(); signal.throwIfAborted() }
    for (;;) {
      signal?.throwIfAborted(); report(task)
      if (task.state === "completed") {
        if (!task.result?.minutes?.minutes_id) throw new Error("纪要提交回执缺失，未显示成功。")
        return task.result
      }
      if (["unresolved", "cancelled", "interrupted"].includes(task.state)) {
        const error = new Error(task.result?.reason || "纪要任务未通过或服务已中断；原文与缓存保留，请重试。")
        error.code = task.result?.error || "GENERATION_TASK_" + task.state.toUpperCase(); error.task_id = taskId; error.grounding = task.result?.grounding
        throw error
      }
      await pause()
      const options = { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) }
      task = (await request("/generation-tasks/" + encodeURIComponent(taskId), options)).task
      if (!task || task.task_id !== taskId) throw new Error("纪要任务身份发生变化，停止读取结果。")
    }
  } catch (error) {
    if (signal?.aborted && !(await cancel())?.accepted) error = Object.assign(new Error("取消未获服务器确认；任务可能正在提交，请恢复任务读取最新回执。"), {code:"TASK_CANCELLATION_UNCONFIRMED"})
    if (taskId) error.task_id = taskId
    throw error
  } finally { signal?.removeEventListener("abort", cancel) }
}
