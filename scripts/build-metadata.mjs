import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readdirSync,readFileSync,lstatSync} from 'node:fs';
import {resolve,relative,join,isAbsolute} from 'node:path';
const skipped=new Set(['node_modules','dist','.git','.local','browser-evidence']);
const text=/\.(?:[cm]?[jt]sx?|json|ya?ml|html|css|sql|svg|md)$/i;
/** Build-time content identity, independent of an ephemeral deployment label.
 * LF normalization makes the same checkout comparable on Windows and Linux.
 * No environment values, source contents, credentials or filesystem paths are
 * published. This digest is provenance only and grants no execution authority. */
export function captureBuildMetadata(root,roots,env=process.env){
 root=resolve(root);const files=[];
 function walk(p){
  const stat=lstatSync(p);if(stat.isSymbolicLink())throw Error('build_source_symlink_not_supported');
  if(stat.isDirectory()){
   for(const name of readdirSync(p).sort())if(!skipped.has(name))walk(join(p,name));
  }else if(stat.isFile()&&(text.test(p)||p.endsWith('.pdf')))files.push(p);
 }
 for(const name of roots){const p=resolve(root,name),r=relative(root,p);if(r.startsWith('..')||isAbsolute(r))throw Error('build_source_outside_root');walk(p);}
 const hash=createHash('sha256');
 for(const p of [...new Set(files)].sort((a,b)=>{const x=relative(root,a).replaceAll('\\','/'),y=relative(root,b).replaceAll('\\','/');return x<y?-1:x>y?1:0;})){
  const name=relative(root,p).replaceAll('\\','/');
  const raw=readFileSync(p),bytes=text.test(p)?Buffer.from(raw.toString('utf8').replace(/\r\n/g,'\n')):raw;
  hash.update(name+'\0'+bytes.length+'\0');hash.update(bytes);
 }
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 let revision=null,tree=null,dirty=null,provenance='source-digest-only';
 try{revision=git('rev-parse','HEAD');tree=git('rev-parse','HEAD^{tree}');dirty=git('status','--porcelain','--untracked-files=normal')!=='';provenance='git-at-build';}
 catch{const supplied=env.RAILWAY_GIT_COMMIT_SHA||env.GITHUB_SHA;if(typeof supplied==='string'&&/^[a-f0-9]{40}$/i.test(supplied)){revision=supplied.toLowerCase();provenance='provider-commit-at-build';}}
 return Object.freeze({version:'STRATA_BUILD_V1',revision,tree,dirty,provenance,
  sourceSha256:hash.digest('hex'),sourceFiles:new Set(files).size,digestPolicy:'sha256-path-length-lf-v1',executionAuthority:'NONE'});
}
