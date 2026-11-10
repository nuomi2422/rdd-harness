'use strict';
/** Poll through a complete monotonic interval; missing reads remain explicit gaps. */
async function observeStopWindow({clock,sleep,collect,cutoffMono,durationMs=60000,intervalMs=5000}) {
  if(typeof clock!=='function'||typeof sleep!=='function'||typeof collect!=='function'||!Number.isFinite(cutoffMono)||durationMs<=0||intervalMs<=0) throw new TypeError('invalid observation');
  const start=clock(); let previous=start; let lastSuccessful=null; let invalidClock=start<cutoffMono; let gaps=false;
  if (invalidClock) return {observedMs:null,complete:false,invalidClock:true,gaps:false};
  for (;;) {
    const before=clock();
    if(before<previous){invalidClock=true;break;}
    previous=before;
    const result=await collect();
    const after=clock();
    if(after<before){invalidClock=true;break;}
    previous=after;
    if(result && result.ok===true) lastSuccessful=after; else gaps=true;
    if(after-start>=durationMs) break;
    await sleep(Math.min(intervalMs,durationMs-(after-start)));
  }
  // Both durations are diagnostic. A delayed first poll cannot borrow elapsed
  // save/stop time to satisfy the required complete polling interval.
  const observedMs=lastSuccessful===null||invalidClock ? null : lastSuccessful-cutoffMono;
  const pollingMs=lastSuccessful===null||invalidClock ? null : lastSuccessful-start;
  return {observedMs,pollingMs,complete:pollingMs!==null&&pollingMs>=durationMs&&!gaps,invalidClock,gaps};
}
module.exports={observeStopWindow};
