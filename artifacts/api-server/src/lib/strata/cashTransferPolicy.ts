import {money,requireProof} from '../v13-production/types';

/** All policy arithmetic uses integer cents/microdollars. This is a withdrawal
 * floor, not permission to increase the selected stake or the approved limits. */
export function requiredTradingCapitalCents(stake:unknown):number {
 const n=typeof stake==='number'?stake:typeof stake==='string'&&/^[1-9]\d*$/.test(stake)?Number(stake):NaN;
 requireProof(Number.isSafeInteger(n)&&n>=500&&n<=2_500_000,'transfer_saved_stake_unverified');
 return n*5;
}
export function protectedTransferCash(input:{stakeCents:unknown;ownerRetainCents:unknown;cashMicros:string;reservedMicros:string}){
 const required=requiredTradingCapitalCents(input.stakeCents),keep=input.ownerRetainCents;
 requireProof(typeof keep==='number'&&Number.isSafeInteger(keep)&&keep>=0&&keep<=100_000_000_000,'transfer_retained_cash_invalid');
 const cash=money(input.cashMicros),reserved=money(input.reservedMicros);
 requireProof(cash>=0n&&reserved>=0n&&cash>=reserved,'transfer_cash_or_reserve_unverified');
 // Preserve BOTH the trading floor and any already committed cash; do not count
 // open exposure or fractional cents as a transferable whole cent.
 const floor=Math.max(required,keep),excess=cash-reserved-BigInt(floor)*10_000n;
 return {requiredCapitalCents:required,minimumRetainedCents:floor,
  maximumCents:Number(excess>0n?excess/10_000n:0n)};
}
export function automaticTransferTrigger(mode:'fixed_amount'|'excess',trigger:number,fixed:number,floor:number):number{
 requireProof([trigger,fixed,floor].every(n=>Number.isSafeInteger(n)&&n>=0),'transfer_auto_trigger_invalid');
 return Math.max(trigger,floor+(mode==='excess'?1:fixed));
}
export function automaticTransferAmount(mode:'fixed_amount'|'excess',fixed:number,maximum:number):number{
 requireProof(Number.isSafeInteger(fixed)&&fixed>0&&Number.isSafeInteger(maximum)&&maximum>=0,'transfer_auto_amount_invalid');
 return mode==='excess'?maximum:fixed<=maximum?fixed:0;
}
/** Original opening funding stays immutable. Later verified movements have
 * their own receipt ledger and signed net projection; they are never trade P&L. */
export function fundedCapitalBasis(a:{initial_cash_micros:string;net_funding_micros?:string}):bigint{
 return money(a.initial_cash_micros)+money(a.net_funding_micros??'0');
}
export function exactCashMicros(payload:unknown,subaccount:0|1,exchangeIndex:0|2):bigint|null{
 if(!payload||typeof payload!=='object'||Array.isArray(payload))return null;
 const outer=payload as Record<string,unknown>;
 const r=outer.balance&&typeof outer.balance==='object'&&!Array.isArray(outer.balance)?outer.balance as Record<string,unknown>:outer;
 const agrees=(v:unknown,n:number)=>v===undefined||v===n||v===String(n);
 if([outer,r].some(x=>!agrees(x.subaccount,subaccount)||!agrees(x.subaccount_number,subaccount)||!agrees(x.exchange_index,exchangeIndex)))return null;
 const d=r.balance_dollars??r.available_balance_dollars;
 if(d!==undefined){
  if(typeof d!=='string'||!/^(0|[1-9]\d{0,12})(?:\.\d{1,6})?$/.test(d))return null;
  const [whole,fraction='']=d.split('.');return BigInt(whole!)*1_000_000n+BigInt(fraction.padEnd(6,'0'));
 }
 const n=r.balance??r.available_balance;
 return typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?BigInt(n)*10_000n:null;
}
