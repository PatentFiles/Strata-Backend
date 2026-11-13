"""Nonproduction package consistency checks; never release authority."""
import pathlib,json,hashlib,unittest,tempfile,shutil
ROOT=pathlib.Path(__file__).resolve().parents[1]
def check(root):
 pins=json.loads((root/'docs/owner-machine-qualification/candidate-trust-pins.json').read_text())
 def hashed(path,digest):
  p=root/path
  if p.is_symlink() or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=digest:raise ValueError('hash mismatch')
 for name,path in [('producerManifestSha256','machine-qualification/producer-files.json'),('qualificationPolicySha256','machine-qualification/policy.json'),('behavioralSuiteSha256','machine-qualification/behavioral-suite/files.json'),('workflowSha256','.github/workflows/owner-machine-qualification.yml')]:hashed(path,pins[name])
 for prefix,file in [('',root/'machine-qualification/producer-files.json'),('machine-qualification/behavioral-suite/',root/'machine-qualification/behavioral-suite/files.json')]:
  for name,digest in json.loads(file.read_text())['files'].items():
   p=pathlib.PurePosixPath(name)
   if p.is_absolute() or '..' in p.parts:raise ValueError('unsafe path')
   hashed(prefix+name,digest)
 policy=json.loads((root/'machine-qualification/policy.json').read_text())
 if policy.get('completeOwnerRecoveryQualification') is not False or policy.get('candidateApplicationPublished') is not False or not policy.get('unqualified'):raise ValueError('draft must remain incomplete')
 if pins.get('productionEnabled') is not False or pins.get('remoteWorkflowId') is not None:raise ValueError('no adopted authority')
 workflow=(root/'.github/workflows/owner-machine-qualification.yml').read_text()
 if 'workflow_dispatch:' not in workflow or 'pull_request:' in workflow or 'secrets.' in workflow:raise ValueError('release workflow must remain manual/no secrets')
 for command in [policy['build']]+policy['checks']:
  if not command or any(not isinstance(x,str) or not x or '\0' in x for x in command):raise ValueError('invalid command')
 return sum(len(x['expectedPassLabels']) for x in json.loads((root/'machine-qualification/behavioral-suite/plan.json').read_text())['suites'])
class Package(unittest.TestCase):
 def test_exact_package(self):self.assertGreaterEqual(check(ROOT),145)
 def mutate(self,path,value):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)
   for folder in ['machine-qualification','docs/owner-machine-qualification','.github/workflows']:shutil.copytree(ROOT/folder,p/folder)
   (p/path).write_text(value)
   with self.assertRaises(ValueError):check(p)
 def test_modified_fixture(self):self.mutate('machine-qualification/behavioral-suite/fixtures/ownerAtomicRecovery.offline.ts','false proof')
 def test_modified_plan(self):self.mutate('machine-qualification/behavioral-suite/plan.json','{}')
 def test_modified_policy(self):self.mutate('machine-qualification/policy.json','{}')
 def test_modified_workflow(self):self.mutate('.github/workflows/owner-machine-qualification.yml','on: push')
if __name__=='__main__':unittest.main()
