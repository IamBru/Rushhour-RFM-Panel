const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(/boot\(\);\s*$/,'');
function fixture(){
 const nodes={},events={};let confirmed=true;
 const ctx=vm.createContext({localStorage:{getItem:()=>null,setItem(){}},location:{hostname:'localhost'},
  document:{querySelector:s=>nodes[s]??=( {innerHTML:''}),querySelectorAll:()=>[],addEventListener:(n,f)=>events[n]=f},
  setTimeout(){},clearTimeout(){},window:{},File:class{},confirm:()=>confirmed});
 const run=s=>vm.runInContext(s,ctx);
 run(script);run('state.data=seedData();bind();');
 return {run,ctx,nodes,events,confirm:v=>confirmed=v};
}
test('admin controls only appear in their entity headers; members retain Add items',()=>{
 const f=fixture();let c=f.run('renderCatalog()');
 assert(c.indexOf('data-action="delete-entity"')<c.indexOf('data-action="edit-entity"'));
 let s=f.run('renderStorage(state.data.storages[0])');
 assert(s.includes('data-kind="storage"'));assert(!s.includes('data-kind="item"'));
 assert(s.includes('data-action="add-to-storage"'));
 f.run("state.mode='cloud';state.data.viewer={role:'member'}");
 for(const expression of ['renderCatalog()','renderStorageGroups()']){
  const markup=f.run(expression);assert(!markup.includes('edit-entity'));assert(!markup.includes('delete-entity'));
 }
 assert(f.run('renderStorageGroups()').includes('add-to-storage'));
 assert.throws(()=>f.run("editEntityModal('item','item-0')"),/Only admins/);
});
test('quantity starts blank and item editor exposes metadata and picture',()=>{
 const f=fixture();f.run("quantityModal({action:'add',itemId:'item-0',toId:'storage-0'})");
 assert(f.nodes['#modal-root'].innerHTML.includes('value="" inputmode="numeric"'));
 f.run("editEntityModal('item','item-0')");
 for(const field of ['name','category','detail','image'])assert(f.nodes['#modal-root'].innerHTML.includes(`name="${field}"`));
});
test('cancel preserves data; item deletion removes all its stock and preserves other items/history',async()=>{
 const f=fixture();const before=f.run('JSON.stringify(state.data)');
 f.confirm(false);await f.run("deleteEntity('item','item-0')");assert.equal(f.run('JSON.stringify(state.data)'),before);
 f.confirm(true);f.run("logEntry('add','Historical name')");await f.run("deleteEntity('item','item-0')");
 assert.equal(f.run("state.data.items.some(x=>x.id==='item-0')"),false);
 assert.equal(f.run("state.data.stock.some(x=>x.item_id==='item-0')"),false);
 assert(f.run("state.data.stock.some(x=>x.item_id==='item-1')"));
 assert(f.run("state.data.logs.some(x=>x.item_name==='Historical name')"));
});
test('group deletion removes only child storages/stock, keeping catalog and other groups',async()=>{
 const f=fixture();f.run("state.data.storage_groups.push({id:'keep',name:'Keep'});state.data.storages[1].storage_group_id='keep'");
 const catalog=f.run('JSON.stringify(state.data.items)');
 await f.run("deleteEntity('storage_group','local-main')");
 assert.equal(f.run('state.data.storages.length'),1);assert.equal(f.run('state.data.storages[0].id'),'storage-1');
 assert(f.run("state.data.stock.every(x=>x.storage_id==='storage-1')"));
 assert.equal(f.run('JSON.stringify(state.data.items)'),catalog);
});
test('member calls and backend failures do not mutate local data',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';state.data.viewer={role:'member'}");
 const before=f.run('JSON.stringify(state.data)');
 await assert.rejects(f.run("deleteEntity('storage','storage-0')"),/Only admins/);
 assert.equal(f.run('JSON.stringify(state.data)'),before);
 f.run("state.data.viewer.role='admin';rpc=async()=>{throw Error('Denied')}");
 await assert.rejects(f.run("deleteEntity('storage','storage-0')"),/Denied/);
 assert.equal(f.run('state.data.storages.length'),5);assert.equal(f.run('state.busy'),false);
});
test('drop routes outside to remove, other storage to move, same storage to no-op, catalog to add',()=>{
 const f=fixture();f.ctx.capture=null;f.run('quantityModal=x=>capture=x');
 function drop(fromId,targetId){
  f.ctx.capture=null;f.ctx.from=fromId;f.run("state.drag={itemId:'item-0',fromId:from}");
  f.events.drop({target:{closest:()=>targetId?{dataset:{storage:targetId}}:null},preventDefault(){}});
  return f.ctx.capture;
 }
 assert.equal(drop('storage-0',null).action,'remove');
 assert.equal(drop('storage-0','storage-1').action,'move');
 assert.equal(drop('storage-0','storage-0'),null);
 assert.equal(drop('',null),null);
 assert.equal(drop('','storage-0').action,'add');
});
test('editing names preserves IDs and stock; storage images can be removed',async()=>{
 const f=fixture();const stock=f.run('JSON.stringify(state.data.stock)');
 f.run("state.data.storages[0].image_data='data:image/png;base64,AAAA';editEntityModal('storage','storage-0')");
 f.ctx.values={name:'Renamed storage',remove_image:'on'};
 await f.run('saveEntity({get:k=>values[k]||null})');
 assert.equal(f.run('state.data.storages[0].name'),'Renamed storage');assert.equal(f.run('state.data.storages[0].image_data'),null);
 f.run("editEntityModal('storage_group','local-main')");f.ctx.values={name:'Renamed group'};
 await f.run('saveEntity({get:k=>values[k]||null})');
 assert.equal(f.run('state.data.storage_groups[0].name'),'Renamed group');
 assert.equal(f.run('JSON.stringify(state.data.stock)'),stock);
});
