/** Arithmetic only, NOT proof of membership, fee authority, or permission to trade.
 * Conditional on reviewed quadratic .07 multiplier-one terms, hundredth-contract
 * minimum fragments and DIRECT $0.0001 balance alignment. No rebates credited.
 */
export type DirectPrecisionBounds={cash:number;trade:number;exit:number};
const ceil=(n:bigint,d:bigint)=>(n+d-1n)/d;
export function prepareDirectPrecisionBounds(ticks:readonly number[],side:'YES'|'NO'):
 ((limit:number)=>DirectPrecisionBounds|null)|null{
 if(!Array.isArray(ticks)||!ticks.length||ticks.length>9999||!['YES','NO'].includes(side)||
  Array.from(ticks).some(t=>!Number.isInteger(t)||t<1||t>9999)||new Set(ticks).size!==ticks.length)return null;
 const prices=ticks.map(t=>side==='YES'?t:10000-t).sort((a,b)=>a-b);
 let cash=0n,trade=0n,exit=0n;
 const prefix=new Map<number,{cash:number;trade:number}>();
 for(const tick of prices){
  // Minimum fragment .01 contracts: p*units in microdollars = tick.
  const p=BigInt(tick),fee=ceil(7n*p*(10000n-p),1000000n);
  const entry=ceil(p+fee,100n)*100n;
  // For valid p, .07*p*(1-p) < p; floor is nonnegative.
  const proceeds=(p-fee)/100n*100n,loss=p-proceeds;
  cash=cash>entry?cash:entry;trade=trade>fee?trade:fee;exit=exit>loss?exit:loss;
  prefix.set(tick,{cash:Number(cash*100n),trade:Number(trade*100n)});
 }
 const exitPerContract=Number(exit*100n);
 return limit=>{
  if(!Number.isFinite(limit)||limit<=0||limit>=1||Math.abs(limit*10000-Math.round(limit*10000))>1e-8)return null;
  const b=prefix.get(Math.round(limit*10000));return b?{...b,exit:exitPerContract}:null;
 };
}
