import {fiveTerminalNoSendFixture} from './acceptance.test';
import assert from 'node:assert/strict';import test,{before} from 'node:test';import {readFileSync} from 'node:fs';import {pool} from '@workspace/db';
before(async()=>{
 const sql=readFileSync('../../lib/db/drizzle/0044_v13_signal_decision_trace.sql','utf8');
 const table=sql.match(/CREATE TABLE private\.strata_v13_execution_trace \([\s\S]*?\n\);/)![0];
 const fn=sql.match(/CREATE FUNCTION private\.strata_v13_capture_intent\(\)[\s\S]*?END \$\$;/)![0];
 const trigger=sql.match(/CREATE TRIGGER strata_v13_capture_intent[\s\S]*?\(\);/)![0];
 await pool.query('CREATE SCHEMA IF NOT EXISTS private');await pool.query(table);await pool.query(fn);await pool.query(trigger);
});
test('actual intent trigger ignores unchanged persisted fields but records real changes',async()=>{
 await fiveTerminalNoSendFixture();
 await pool.query('TRUNCATE private.strata_v13_execution_trace');
 const ids=(await pool.query("SELECT id FROM v13_production_intent WHERE account_id='test-account' ORDER BY id")).rows;assert.equal(ids.length,5);
 await pool.query("UPDATE v13_production_intent SET state=state,exchange_order_id=exchange_order_id,filled_hundredths=filled_hundredths,reserved_micros=reserved_micros,terminal=terminal WHERE account_id='test-account'");
 assert.equal((await pool.query('SELECT count(*) FROM private.strata_v13_execution_trace')).rows[0].count,'0');
 await pool.query('UPDATE v13_production_intent SET cancel_attempted=true WHERE id=$1',[ids[0].id]);
 assert.equal((await pool.query('SELECT count(*) FROM private.strata_v13_execution_trace')).rows[0].count,'1');
});

test('trigger-enabled reconciliation preserves changed-state trace and omits unchanged noise',async()=>{
 await fiveTerminalNoSendFixture();
 const {ProductionLedger,identity}=await import('./ledger');const ledger=new ProductionLedger(pool,'test-account');
 const i=(await pool.query("SELECT id,created_at,decision FROM v13_production_intent WHERE account_id='test-account' ORDER BY created_at DESC LIMIT 1")).rows[0];
 // Fixture-only setup: simulate one never-dispatched aged PREPARED row.
 await pool.query("UPDATE v13_production_intent SET state='PREPARED',terminal=false,cancel_attempted=false WHERE id=$1",[i.id]);
 await pool.query('TRUNCATE private.strata_v13_execution_trace');
 let a=await ledger.readAccount();let now=Math.max(i.created_at.getTime(),Date.parse(i.decision.source.evaluated_at))+60000;
 const snapshot={identity:identity(a),observedAtMs:now,complete:true,authenticated:true,historyFromMs:0,cashMicros:a.cash_micros,cashExact:true,orders:[],fills:[],settlements:[],positions:[],unexplainedCashActivity:false};
 await ledger.reconcile(snapshot,a.revision,now);
 const traces=(await pool.query('SELECT intent_id,details FROM private.strata_v13_execution_trace')).rows;
 assert.equal(traces.length,1);assert.equal(traces[0].intent_id,i.id);assert.equal(traces[0].details.state,'BLOCKED');assert.equal(traces[0].details.terminal,true);
 a=await ledger.readAccount();await ledger.reconcile({...snapshot,observedAtMs:++now},a.revision,now);
 assert.equal((await pool.query('SELECT count(*) FROM private.strata_v13_execution_trace')).rows[0].count,'1');
});
