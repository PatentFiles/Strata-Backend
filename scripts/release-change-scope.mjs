import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
// Only narrative documentation is exempt. SQL, fixtures, workflow changes,
// unknown paths, missing git history and an empty diff require full safety CI.
export function requiresRuntimeChecks(files){
 return files.length===0||files.some(file=>!(/^(?:docs|research)\/[^\0]+\.(?:md|txt)$/.test(file)||file==='README.md'));
}
export function runtimeScope(base,head,cwd=process.cwd()){
 if(!/^[a-f0-9]{40}$/.test(base??'')||! /^(?!0{40}$)[a-f0-9]{40}$/.test(head??''))return true;
 try{return requiresRuntimeChecks(execFileSync('git',['diff','--no-renames','--name-only','-z',base,head],{cwd,encoding:'utf8',stdio:['ignore','pipe','ignore']}).split('\0').filter(Boolean));}
 catch{return true;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const runtime=runtimeScope(process.env.RELEASE_BASE_SHA,process.env.RELEASE_HEAD_SHA);
 const output='runtime_changed='+runtime+'\n';
 if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,output);
 console.log(output.trim());
}
