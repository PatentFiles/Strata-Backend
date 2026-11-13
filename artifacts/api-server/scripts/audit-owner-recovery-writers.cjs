'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),ts=require('typescript');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const TARGETS=['v13_production_account','v13_production_intent','v13_production_position','v13_production_event','v13_production_observation','kalshi_account_worker_lease','strata_emergency_exit_reservations','kalshi_connection_credentials','provider_connections','financial_accounts','v13_live_money_policy','live_execution_config','strata_owner_control_heads','strata_owner_recovery_consent_challenge','strata_owner_recovery_consent_receipt','strata_owner_machine_authority','strata_owner_recovery_release_receipt','kalshi_account_operation_attempts','owner_recovery_barrier_scope','secrets','sessions','users'];
const word='(?:"[^"\\n]+"|[a-zA-Z_][a-zA-Z_0-9]*)';
const writePattern=new RegExp('\\b(INSERT\\s+INTO|MERGE\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+('+word+'(?:\\s*\\.\\s*'+word+')?)','gi');
function sqlWrites(sql){return [...sql.matchAll(writePattern)].map(m=>({operation:m[1].replace(/\s+/g,' ').toUpperCase(),target:m[2].replace(/["\s]/g,'').toLowerCase()})).filter(x=>TARGETS.includes(x.target.split('.').at(-1)));}
function audit(root){
 root=path.resolve(root);const names=[];
 function walk(dir){if(!fs.existsSync(dir))return;for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(['node_modules','dist','.git','.cache'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(ts|tsx|js|mjs|cjs|sql|json|yaml)$/.test(e.name))names.push(p);}}
 for(const p of ['artifacts/api-server','lib','docs/owner-only-recovery-candidate'])walk(path.join(root,p));
 for(const p of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])if(fs.existsSync(path.join(root,p)))names.push(path.join(root,p));names.sort();
 const program=ts.createProgram(names.filter(n=>/\.[cm]?[jt]sx?$/.test(n)),{allowJs:true,noResolve:true,target:ts.ScriptTarget.ESNext}),checker=program.getTypeChecker();
 const files=[],writers=[],unresolved=[],ddl=[];
 const string=(n,seen=new Set())=>{if(!n)return null;if(ts.isStringLiteralLike(n))return n.text;if(ts.isParenthesizedExpression(n))return string(n.expression,seen);if(ts.isTemplateExpression(n)){let s=n.head.text;for(const span of n.templateSpans)s+=(string(span.expression,seen)??'${DYNAMIC}')+span.literal.text;return s;}if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=string(n.left,seen),b=string(n.right,seen);return a!==null&&b!==null?a+b:null;}if(ts.isIdentifier(n)){const sym=checker.getSymbolAtLocation(n);if(!sym||seen.has(sym))return null;const d=sym.valueDeclaration;if(d&&ts.isVariableDeclaration(d)){const next=new Set(seen);next.add(sym);return string(d.initializer,next);}}if(ts.isObjectLiteralExpression(n)){const p=n.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText()==='text');return p?string(p.initializer,seen):null;}return null;};
 for(const full of names){const file=path.relative(root,full).replaceAll(path.sep,'/'),source=fs.readFileSync(full,'utf8'),kind=/\.(test|offline)\.[cm]?[jt]sx?$/.test(file)||/fixture/.test(file)?'test':file.endsWith('.sql')?'schema_or_migration':file.includes('/scripts/')?'operator_script':'runtime';files.push({file,sha256:hash(source),kind});
  const at=(node)=>({file,line:node?ts.getLineAndCharacterOfPosition(node.getSourceFile(),node.getStart()).line+1:1,kind});
  if(file.endsWith('.sql')){for(const w of sqlWrites(source))writers.push({...at(),...w,via:'sql_file'});if(/\b(ALTER|CREATE|DROP|GRANT|REVOKE)\b/i.test(source))ddl.push({...at(),sha256:hash(source)});continue;}
  if(!/\.[cm]?[jt]sx?$/.test(file))continue;
  const sf=program.getSourceFile(full);if(!sf)throw Error('source_parse_missing:'+file);
  function visit(n){
   if(ts.isCallExpression(n)){
    const callee=n.expression,name=ts.isPropertyAccessExpression(callee)?callee.name.text:ts.isIdentifier(callee)?callee.text:'';
    if(['query','execute','executeQuery','$executeRaw','$executeRawUnsafe','insert','update','delete','truncate'].includes(name)){
     const receiver=ts.isPropertyAccessExpression(callee)?checker.typeToString(checker.getTypeAtLocation(callee.expression)):'';
     if(name==='delete'&&/^(Map|Set|WeakMap|WeakSet|URLSearchParams|Headers)(<|$)/.test(receiver)){ts.forEachChild(n,visit);return;}
     const sql=string(n.arguments[0]);
     if(sql!==null){if(/(?:\bCALL\s|\bSELECT\s+(?:private|public)\.\w+\s*\()/i.test(sql))unresolved.push({...at(n),via:name,reason:'stored_routine_requires_catalog_qualification',expressionSha256:hash(n.getText())});for(const w of sqlWrites(sql))writers.push({...at(n),...w,via:'call:'+name});if(/\b(ALTER|CREATE|DROP|GRANT|REVOKE)\b/i.test(sql))ddl.push({...at(n),sha256:hash(sql)});if(sql.includes('${DYNAMIC}')&&(/\b(?:UPDATE|INTO|FROM|TABLE)\s+\$\{DYNAMIC\}/i.test(sql)||sqlWrites(sql).length===0&&!/^\s*(SELECT|BEGIN|COMMIT|ROLLBACK|SET|SHOW|SAVEPOINT|RELEASE)\b/i.test(sql)))unresolved.push({...at(n),via:name,reason:'dynamic_sql_target',expressionSha256:hash(n.getText())});}
     else unresolved.push({...at(n),via:name,reason:['insert','update','delete','truncate'].includes(name)?'orm_or_computed_target':'computed_or_external_query',expressionSha256:hash(n.getText())});
    }
   }
   ts.forEachChild(n,visit);
  }visit(sf);
 }
 const body={schema:'strata.writer-source-inventory.v1',files,writers,unresolved,ddl,protectedObjects:TARGETS};
 return {...body,sourceInventorySha256:hash(JSON.stringify(body)),completeWriterCoverage:false,productionQualified:false,limitations:['AST inventory is not runtime reachability or SQL parser proof','ORM/computed/external queries require explicit qualification','Live roles, grants, definers, external writers and deployed catalog are not measured']};
}
if(require.main===module){if(!process.argv[2])throw Error('repository root required');process.stdout.write(JSON.stringify(audit(process.argv[2]),null,2)+'\n');}
module.exports={audit,sqlWrites,TARGETS};
