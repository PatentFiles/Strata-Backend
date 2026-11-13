const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {audit,sqlWrites}=require('./audit-owner-recovery-writers.cjs');
test('quoted targets and MERGE are accounted, unrelated objects not promoted',()=>{assert.deepEqual(sqlWrites('UPDATE "public"."v13_production_account" SET x=1'),[{operation:'UPDATE',target:'public.v13_production_account'}]);assert.equal(sqlWrites('MERGE INTO private.kalshi_account_worker_lease USING x ON true').length,1);assert.equal(sqlWrites('UPDATE random_table SET x=1').length,0);});
test('actual call AST resolves local SQL constants, preserves dynamic/ORM/routine uncertainty, hashes every source',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'writer-audit-')),dir=path.join(d,'artifacts/api-server/src');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'sample.ts'),`// db.query('UPDATE v13_production_account SET x=0');
 const q='UPDATE public.v13_production_account SET x=$1';db.query(q,[1]);
 db.query(\`UPDATE \${table} SET x=$1\`,[1]);db.update(accounts).set({x:1});
 db.query('SELECT private.change_control($1)',[1]);
 const cache=new Map<string,string>();cache.delete('x');`);
 try{const a=audit(d),b=audit(d);assert.equal(a.sourceInventorySha256,b.sourceInventorySha256);assert.equal(a.files.length,1);assert.equal(a.writers.length,1);assert.equal(a.unresolved.length,3);assert.equal(a.completeWriterCoverage,false);assert.equal(a.productionQualified,false);fs.appendFileSync(path.join(dir,'sample.ts'),'\n// drift');assert.notEqual(a.sourceInventorySha256,audit(d).sourceInventorySha256);}finally{fs.rmSync(d,{recursive:true,force:true});}
});
