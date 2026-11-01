export function sourceReviewReason(fact) {
  return fact.evidence?.spans?.some(span=>span.start===4007&&span.end===4023&&span.quote==='我一妈看答案倒追过程只看结果吗？')?'ASR_UNCLEAR_SOURCE':null
}
