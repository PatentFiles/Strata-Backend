/** Observability only. Never use this helper as order admission authority.
 * pg Date.toString() drops milliseconds; getTime() retains the exact source.
 * Unknown/invalid/future timestamps return null, not an invented zero age.
 */
export function signalTraceSourceAgeMs(value:unknown,nowMs:number):number|null {
  try {
    if(!Number.isSafeInteger(nowMs) || nowMs<0)return null;
    let sourceMs:number;
    if(value instanceof Date)sourceMs=Date.prototype.getTime.call(value);
    else if(typeof value==="string"){
      // Explicit timezone only. Reject locale-dependent dates and Date.parse's
      // normalization of impossible calendar dates (e.g. February 30).
      const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
      if(!m)return null;
      sourceMs=Date.parse(value);
      const zone=m[8]!;
      const hours=zone==="Z"?0:Number(zone.slice(1,3));
      const minutes=zone==="Z"?0:Number(zone.slice(4,6));
      if(hours>23 || minutes>59)return null;
      const offset=(hours*60+minutes)*(zone.startsWith("-")?-1:1);
      const local=new Date(sourceMs+offset*60_000);
      if(local.getUTCFullYear()!==Number(m[1]) || local.getUTCMonth()+1!==Number(m[2]) ||
        local.getUTCDate()!==Number(m[3]) || local.getUTCHours()!==Number(m[4]) ||
        local.getUTCMinutes()!==Number(m[5]) || local.getUTCSeconds()!==Number(m[6]))return null;
    }else return null;
    const age=nowMs-sourceMs;
    return Number.isSafeInteger(sourceMs) && sourceMs>=0 && Number.isSafeInteger(age) && age>=0?age:null;
  }catch{return null;}
}
