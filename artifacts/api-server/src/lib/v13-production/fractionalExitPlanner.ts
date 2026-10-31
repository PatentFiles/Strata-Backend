import type {V13DepthLevel} from '../v13ExecutionPlanner';
const fixed=(raw:unknown,scale:number):bigint|null=>{
 if(typeof raw!=='string'||!new RegExp(`^(0|[1-9][0-9]{0,9})(?:\\.[0-9]{1,${scale}})?$`).test(raw))return null;
 const [w,f='']=raw.split('.');return BigInt(w!)*10n**BigInt(scale)+BigInt(f.padEnd(scale,'0'));
};
/** EXIT-only exact quantum planner; no float accumulation or upward rounding. */
export function planFractionalIocExit(input:{ownedHundredths:string;bestBidDollars:string|null;bidLevels:V13DepthLevel[];minimumExitMicros:number}) {
 const deny=(reason:string)=>({ok:false as const,reason});
 if(!/^[1-9][0-9]{0,10}$/.test(input.ownedHundredths)||!Number.isSafeInteger(input.minimumExitMicros)||input.minimumExitMicros<=0||input.minimumExitMicros>=1000000)return deny('invalid_input');
 const owned=BigInt(input.ownedHundredths),requested=owned<100000n?owned:100000n,best=fixed(input.bestBidDollars,4);
 if(best===null||best<=0n||best>=10000n||best*100n<BigInt(input.minimumExitMicros))return deny('invalid_input');
 if(!Array.isArray(input.bidLevels)||input.bidLevels.length===0||input.bidLevels.length>1000)return deny('depth_unavailable_or_invalid');
 const levels:Array<{ticks:bigint;quantity:bigint}>=[],seen=new Set<string>();
 for(const l of input.bidLevels){const ticks=fixed(l.priceDollars,4),quantity=fixed(l.availableContracts,2);
  if(ticks===null||ticks<=0n||ticks>=10000n||quantity===null||quantity<=0n||seen.has(String(ticks)))return deny('depth_unavailable_or_invalid');
  seen.add(String(ticks));levels.push({ticks,quantity});}
 levels.sort((a,b)=>a.ticks>b.ticks?-1:a.ticks<b.ticks?1:0);
 if(levels[0]!.ticks!==best)return deny('depth_unavailable_or_invalid');
 let remaining=requested,gross=0n,limit=best,visible=0n;
 for(const l of levels){if(l.ticks*100n<BigInt(input.minimumExitMicros))break;visible+=l.quantity;
  const take=remaining<l.quantity?remaining:l.quantity;if(take>0n){gross+=take*l.ticks;remaining-=take;limit=l.ticks;}if(remaining===0n)break;}
 const planned=requested-remaining;if(planned<=0n)return deny('no_contract_quantum_executable');
 return {ok:true as const,plan:{quantityVersion:'EXIT_HUNDREDTHS_V1' as const,requestedHundredths:requested.toString(),plannedHundredths:planned.toString(),residualHundredths:(owned-planned).toString(),limitMicros:Number(limit*100n),grossProceedsMicros:gross.toString(),visibleHundredths:visible.toString(),minimumExitMicros:input.minimumExitMicros}};
}
