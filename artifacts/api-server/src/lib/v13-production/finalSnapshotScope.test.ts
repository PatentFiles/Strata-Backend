import assert from "node:assert/strict";
import test from "node:test";
import { ProductionLedger } from "./ledger";

const pool = {connect:async()=>({query:async(sql:string)=>({rows:sql.startsWith("SELECT")?[{id:"account"}]:[]}),release:()=>{}})};
test("final snapshot identity requires transaction and is cleared after success or failure",async()=>{
  const ledger = new ProductionLedger(pool as never,"account");
  await assert.rejects(ledger.withFinalAccountSnapshot("entry",async()=>{}),/transaction_required/);
  await ledger.transaction(async()=>{
    assert.equal(ledger.currentFinalSnapshotEntry(),null);
    await ledger.withFinalAccountSnapshot("entry",async()=>{
      await Promise.resolve();
      assert.equal(ledger.currentFinalSnapshotEntry(),"entry");
    });
    assert.equal(ledger.currentFinalSnapshotEntry(),null);
    await assert.rejects(ledger.withFinalAccountSnapshot("entry",async()=>{throw Error("read_failed");}),/read_failed/);
    assert.equal(ledger.currentFinalSnapshotEntry(),null);
  });
  assert.equal(ledger.currentFinalSnapshotEntry(),null);
});
test("concurrent final account snapshots never borrow another intent's exemption",async()=>{
  const ledger = new ProductionLedger(pool as never,"account");
  let release!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;});
  let ready!:()=>void;
  const entered=new Promise<void>(resolve=>{ready=resolve;});
  const first=ledger.transaction(async()=>ledger.withFinalAccountSnapshot("first",async()=>{
    ready();await paused;assert.equal(ledger.currentFinalSnapshotEntry(),"first");
  }));
  await entered;
  assert.equal(ledger.currentFinalSnapshotEntry(),null);
  await ledger.transaction(async()=>ledger.withFinalAccountSnapshot("second",async()=>{
    assert.equal(ledger.currentFinalSnapshotEntry(),"second");
  }));
  release();await first;
  assert.equal(ledger.currentFinalSnapshotEntry(),null);
});

test("detached async descendants cannot retain a completed final snapshot exemption",async()=>{
  const ledger = new ProductionLedger(pool as never,"account");
  let release!:()=>void;
  const paused=new Promise<void>(resolve=>{release=resolve;});
  let descendant!:Promise<void>;
  await ledger.transaction(async()=>{
    await ledger.withFinalAccountSnapshot("entry",async()=>{
      descendant=(async()=>{await paused;assert.equal(ledger.currentFinalSnapshotEntry(),null);})();
    });
    // Still in the transaction, but the narrower final-read scope has ended.
    release();await descendant;
  });
});
