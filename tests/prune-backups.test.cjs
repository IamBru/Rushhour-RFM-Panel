const {test}=require('node:test');
const assert=require('node:assert/strict');
const prune=require('../scripts/prune-backups.cjs');
function fixture(){
 const current={id:100,name:'rfm-owner-backup-20-1',size_in_bytes:100,expired:false,created_at:'2026-11-24T06:00:00Z',workflow_run:{id:20,head_branch:'main'}};
 const artifact=(id,run,name,branch='main',time='2026-11-24T00:00:00Z')=>({id,name,created_at:time,workflow_run:{id:run,head_branch:branch}});
 const old=[current,artifact(1,10,'rfm-owner-backup-10-1'),artifact(2,11,'other-artifact'),artifact(3,12,'rfm-owner-backup-12-1','feature'),artifact(4,13,'rfm-owner-backup-13-1'),artifact(5,21,'rfm-owner-backup-21-1','main','2026-11-24T12:00:00Z')];
 const deleted=[];
 const api={getArtifact:async()=>({data:current}),getWorkflowRun:async({run_id})=>({data:{workflow_id:run_id===13?999:123,head_branch:'main'}}),listArtifactsForRepo(){},deleteArtifact:async({artifact_id})=>deleted.push(artifact_id)};
 const args={github:{rest:{actions:api},paginate:async()=>old},context:{repo:{owner:'test',repo:'test'},runId:20},core:{info(){}},artifactId:'100'};
 return {args,current,deleted,api};
}
test('cleanup deletes only older backups belonging to the same workflow on main',async()=>{
 const f=fixture();await prune(f.args);assert.deepEqual(f.deleted,[1]);
});
test('missing upload ID or missing artifact never deletes backups',async()=>{
 const f=fixture();f.args.artifactId='';await assert.rejects(prune(f.args));assert.deepEqual(f.deleted,[]);
 f.args.artifactId='100';f.api.getArtifact=async()=>{throw Error('not found')};await assert.rejects(prune(f.args));assert.deepEqual(f.deleted,[]);
});
test('expired, empty or wrong-run replacement preserves previous backups',async()=>{
 for(const changes of [{expired:true},{size_in_bytes:0},{name:'unrelated'},{workflow_run:{id:21,head_branch:'main'}},{created_at:'invalid'}]){
  const f=fixture();Object.assign(f.current,changes);await assert.rejects(prune(f.args));assert.deepEqual(f.deleted,[]);
 }
});
test('cleanup API failure is visible and never deletes the new artifact',async()=>{
 const f=fixture();f.api.deleteArtifact=async({artifact_id})=>{assert.notEqual(artifact_id,100);throw Error('denied')};await assert.rejects(prune(f.args),/denied/);
});
