/** A short initialization wait is not trading permission. All independent
 * market identity and feed clocks must pass before this classifier is called. */
export const TARGET_INITIALIZATION_MS=15000;
export function directTargetReadiness(input:{target:unknown;status:unknown;openMs:number;nowMs:number;previouslyReady:boolean}):'ready'|'waiting'|'invalid'|'unavailable'{
 const {target,status,openMs,nowMs,previouslyReady}=input;
 if(typeof target==='number'&&Number.isFinite(target)&&target>0)return 'ready';
 if(target!==null||status!=='pending'||previouslyReady||!Number.isSafeInteger(openMs)||!Number.isSafeInteger(nowMs)||nowMs<openMs)return 'invalid';
 return nowMs-openMs<=TARGET_INITIALIZATION_MS?'waiting':'unavailable';
}
