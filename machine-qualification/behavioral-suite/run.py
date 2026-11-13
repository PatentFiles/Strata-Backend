#!/usr/bin/env python3
"""Inactive protected expectations against candidate source; local proof only.
Invoke only after independently pinning this runner's bytes. The required manifest
hash must come from protected configuration, never from candidate request data.
"""
import argparse, pathlib, hashlib, json, subprocess, tempfile, os, getpass, re
BASE=pathlib.Path(__file__).resolve().parent
sha=lambda b:hashlib.sha256(b).hexdigest()
def verify_package(expected):
 raw=(BASE/'files.json').read_bytes()
 if len(expected)!=64 or sha(raw)!=expected:raise ValueError('protected_manifest_mismatch')
 m=json.loads(raw)
 if m.get('schema')!='strata.protected-behavioral-files.v1':raise ValueError('manifest_schema')
 for name,digest in m['files'].items():
  p=pathlib.PurePosixPath(name)
  if p.is_absolute() or '..' in p.parts:raise ValueError('unsafe_path')
  at=BASE
  for part in p.parts:
   at=at/part
   if at.is_symlink():raise ValueError('protected_symlink')
  if not at.is_file() or at.stat().st_size>1048576 or sha(at.read_bytes())!=digest:raise ValueError('protected_bytes_mismatch')
 return m

def main():
 ap=argparse.ArgumentParser();ap.add_argument('--source',required=True);ap.add_argument('--pg-bin',required=True);ap.add_argument('--manifest-sha256',required=True);ap.add_argument('--artifact');a=ap.parse_args()
 package=verify_package(a.manifest_sha256);plan=json.loads((BASE/'plan.json').read_text());source=pathlib.Path(a.source).resolve();pg=pathlib.Path(a.pg_bin).resolve();api=source/'artifacts/api-server'
 if plan.get('productionEnabled') is not False or plan.get('completeOwnerRecoveryQualification') is not False:raise ValueError('not_authority')
 user=getpass.getuser()
 if os.geteuid()==0 or not re.fullmatch(r'[a-z_][a-z0-9_-]{0,62}',user):raise ValueError('disposable_nonroot_identity_only')
 def run(argv,**kw):
  try:return subprocess.run([str(x) for x in argv],check=True,timeout=180,**kw)
  except subprocess.CalledProcessError as e:
   if e.stdout:print(e.stdout)
   if e.stderr:print(e.stderr)
   raise
 results=[]
 with tempfile.TemporaryDirectory(prefix='owner-protected-behavior-') as tmp:
  d=pathlib.Path(tmp)
  for i,suite in enumerate(plan['suites']):
   port=suite['port']
   if port not in (55459,55460,55461):raise ValueError('disposable_port_only')
   db=d/f'pg{i}';started=False;output=d/f'suite{i}.cjs';meta=d/f'meta{i}.json'
   env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'LANG':'C.UTF-8','NODE_ENV':'test','NODE_PATH':str(api/'node_modules'),'DATABASE_URL':f'postgresql://{user}@127.0.0.1:{port}/compatible_disposable'}
   run([pg/'initdb','-D',db,'--auth=trust','--no-locale'],stdout=subprocess.DEVNULL)
   try:
    run([pg/'pg_ctl','-D',db,'-l',d/f'pg{i}.log','-o',f"-h 127.0.0.1 -p {port} -k ''",'start'],stdout=subprocess.DEVNULL);started=True
    run([pg/'createdb','-h127.0.0.1',f'-p{port}','compatible_disposable'])
    original=(BASE/'fixtures'/suite['fixture']).read_text()
    contents=original.replace('postgresql://agent@127.0.0.1:',f'postgresql://{user}@127.0.0.1:').replace('__STRATA_PROTECTED_FIXTURES__/',str(BASE/'fixtures')+'/').replace('__STRATA_CANDIDATE_SOURCE__/',str(source)+'/')
    script="const e=require('esbuild'),fs=require('fs');let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{let r=e.buildSync({metafile:true,stdin:{contents:s,resolveDir:process.argv[1],sourcefile:'protected-fixture.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:process.argv[2],external:['pg-native','pdfjs-dist','pdfjs-dist/*','pino','pino-pretty']});fs.writeFileSync(process.argv[3],JSON.stringify(r.metafile));});"
    run(['node','-e',script,source/suite['resolveDir'],output,meta],cwd=api,input=contents,text=True,env=env)
    paths={(api/x).resolve() for x in json.loads(meta.read_text())['inputs'] if not x.endswith('protected-fixture.ts')}
    # Runtime-read actual schema and executor text are also part of the evidence.
    paths.update([source/'lib/db/drizzle/0000_reviewed_release_schema.sql',api/'src/lib/v13-production/executor.ts',source/'lib/db/drizzle/0013_kalshi_account_worker_lease.sql'])
    def inventory():return [{'path':str(p.relative_to(source)),'sha256':sha(p.read_bytes())} for p in sorted(paths)]
    before=inventory();compiled=sha(output.read_bytes());r=run(['node',output],cwd=api,capture_output=True,text=True,env=env)
    labels=[x[5:] for x in r.stdout.splitlines() if x.startswith('PASS ')]
    if labels!=suite['expectedPassLabels']:raise ValueError('required_behavioral_scenarios_missing_or_changed')
    if before!=inventory() or compiled!=sha(output.read_bytes()):raise ValueError('candidate_changed_during_tests')
    verify_package(a.manifest_sha256)
    print(r.stdout,end='')
    results.append({'fixture':suite['fixture'],'passedScenarios':len(labels),'inputFiles':before,'compiledSha256':compiled,'stdoutSha256':sha(r.stdout.encode()),'protectedFixtureSha256':sha(original.encode())})
   finally:
    if started:run([pg/'pg_ctl','-D',db,'stop','-m','fast'],stdout=subprocess.DEVNULL)
 artifact={'schema':plan['schema'],'kind':'LOCAL_PROTECTED_BEHAVIORAL_CANDIDATE','protectedManifestSha256':a.manifest_sha256,'suites':results,'completeOwnerRecoveryQualification':False,'unqualified':plan['unqualified'],'genuineRemoteQualification':False,'evidenceIssued':False,'recoveryAuthorized':False,'tradingAuthorized':False}
 if a.artifact:pathlib.Path(a.artifact).write_text(json.dumps(artifact,indent=2)+'\n')
 print(json.dumps(artifact,sort_keys=True))
if __name__=='__main__':main()
