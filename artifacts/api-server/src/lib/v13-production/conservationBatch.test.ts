import test from 'node:test';import assert from 'node:assert/strict';import {ProductionLedger,type Account} from './ledger';
const account={id:'test-account',initial_cash_micros:'100',cash_micros:'100',reserved_micros:'0'} as Account;
const zero={cash:'0',pnl:'0',basis:'0',position_pnl:'0',amount:'0'};
async function check(totals:typeof zero,a=account){
 let calls=0;const tx={query:async(sql:string,args:unknown[])=>{calls++;assert.deepEqual(args,['test-account']);
  assert.equal((sql.match(/WHERE account_id=\$1/g)||[]).length,3);assert.equal((sql.match(/CROSS JOIN \(SELECT/g)||[]).length,2);
  assert.equal((sql.match(/coalesce\(sum\(/g)||[]).length,5);assert.doesNotMatch(sql,/LIMIT|GROUP BY|\bUPDATE\b|\bINSERT\b/);return {rows:[totals]};}};
 try{await new ProductionLedger({} as never,'test-account').assertConservation(tx as never,a);}finally{assert.equal(calls,1);}
}
test('empty and signed PnL/basis/reservation totals retain exact BigInt equations in one request',async()=>{
 await check(zero);await check({cash:'-15',pnl:'-2',basis:'13',position_pnl:'-2',amount:'7'}, {...account,cash_micros:'85',reserved_micros:'7'});
});
test('each cash/PnL/basis/position/reservation corruption still fails unchanged',async()=>{
 for(const field of Object.keys(zero))await assert.rejects(check({...zero,[field]:'1'}),/production_money_conservation_failed/);
});
