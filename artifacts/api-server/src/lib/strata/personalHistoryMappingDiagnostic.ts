/** Internal, bounded explanation for a refused signed-history mapping.
 * The public failure contract remains unchanged. Diagnostics contain fixed
 * categories and counts only: never exchange bodies, IDs, keys or signatures.
 * WeakMap custody prevents caller-supplied JSON from masquerading as a trace.
 */
export type HistoryMappingStage =
 | 'history_coverage' | 'order_record' | 'order_request' | 'order_status'
 | 'order_market' | 'order_book_side' | 'order_limit' | 'order_quantity'
 | 'order_reduce_only' | 'order_identity' | 'order_conflict'
 | 'fill_record' | 'fill_order' | 'fill_identity' | 'fill_quantity'
 | 'fill_price' | 'fill_fee' | 'fill_time' | 'fill_market' | 'fill_gross'
 | 'settlement_record' | 'settlement_contract' | 'settlement_payout'
 | 'position_record' | 'snapshot_shape';
export type HistoryMappingDiagnostic = Readonly<{
 version:1; stage:HistoryMappingStage;
 orderRows:number; fillRows:number; positionRows:number; settlementRows:number;
}>;
const diagnostics = new WeakMap<object,HistoryMappingDiagnostic>();
const count = (value:unknown):number => Array.isArray(value) ? Math.min(value.length,100_000) : 0;
export function rememberHistoryMappingFailure<T extends {ok:false;reason:string}>(
 result:T,stage:HistoryMappingStage,read:unknown,
):T {
 const r=read&&typeof read==='object'?read as Record<string,unknown>:{};
 diagnostics.set(result,Object.freeze({version:1,stage,orderRows:count(r.orders),fillRows:count(r.fills),
  positionRows:count(r.positions),settlementRows:count(r.settlements)}));
 return result;
}
export function historyMappingDiagnostic(result:unknown):HistoryMappingDiagnostic|null {
 return result&&typeof result==='object'?diagnostics.get(result)??null:null;
}
