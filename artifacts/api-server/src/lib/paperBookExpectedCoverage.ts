/** Reporting only: expected paper transitions are not capture attempts or fills. */
export type CoveragePosition = {id:string;status:string};
export type CoverageReceipt = {paperPositionId:string;phase:string;status:string};
export const EXPECTED_BOOK_POSITION_LIMIT=1000;
export function expectedPaperBookCoverage(
 positions:readonly CoveragePosition[],receipts:readonly CoverageReceipt[],truncated:boolean,
){
 if(positions.length>EXPECTED_BOOK_POSITION_LIMIT||receipts.length>EXPECTED_BOOK_POSITION_LIMIT*2)
  throw Error('paper_coverage_sample_limit');
 const expected=new Set<string>();
 for(const p of positions){
  if(!p.id||!['OPEN','CLOSED','SETTLED'].includes(p.status)||expected.has(p.id+'\0ENTRY'))
   throw Error('paper_coverage_position_invalid');
  expected.add(p.id+'\0ENTRY');
  if(p.status==='CLOSED')expected.add(p.id+'\0EXIT');
 }
 const seen=new Set<string>();let captured=0,unavailable=0;
 for(const r of receipts){
  const key=r.paperPositionId+'\0'+r.phase;
  if(!expected.has(key))continue;
  if(seen.has(key)||!['CAPTURED','UNAVAILABLE'].includes(r.status))throw Error('paper_coverage_receipt_invalid');
  seen.add(key);if(r.status==='CAPTURED')captured++;else unavailable++;
 }
 return {scope:'LATEST_PAPER_POSITIONS' as const,consistency:'POINT_IN_TIME_NON_ATOMIC' as const,absentMayBePending:true as const,sampledPositions:positions.length,
  positionReadLimit:EXPECTED_BOOK_POSITION_LIMIT,positionsTruncated:truncated,
  expectedEvents:expected.size,recordedReceipts:seen.size,capturedReceipts:captured,
  unavailableReceipts:unavailable,absentReceipts:expected.size-seen.size,
  missingOrUnavailable:expected.size-captured,
  proofOfActualExecution:false as const,
  interpretation:'Expected ENTRY for each sampled position and EXIT only for CLOSED; absence does not establish cause, failed attempt, zero liquidity, or applicability of historical capture instrumentation' as const};
}

/** Reader orchestration, injectable for offline tests; never reads live account data. */
export async function readExpectedPaperBookCoverage(engineId:string,positions:readonly CoveragePosition[],
 read:(engineId:string,positionIds:string[],limit:number)=>Promise<CoverageReceipt[]>) {
 const selected=positions.slice(0,EXPECTED_BOOK_POSITION_LIMIT);
 const receipts=selected.length ? await read(engineId,selected.map(p=>p.id),EXPECTED_BOOK_POSITION_LIMIT*2) : [];
 return expectedPaperBookCoverage(selected,receipts,positions.length>EXPECTED_BOOK_POSITION_LIMIT);
}
