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
 run(script);ctx.realConfirmAction=run('confirmAction');ctx.testConfirmation=()=>confirmed;run('confirmAction=async()=>testConfirmation();state.data=seedData();bind();');
 return {run,ctx,nodes,events,confirm:v=>confirmed=v};
}
test('admin controls only appear in their entity headers; Add items is removed for all roles',()=>{
 const f=fixture();let c=f.run('renderCatalog()');
 assert(c.indexOf('data-action="delete-entity"')<c.indexOf('data-action="edit-entity"'));
 let s=f.run('renderStorage(state.data.storages[0])');
 assert(s.includes('data-kind="storage"'));assert(!s.includes('data-kind="item"'));
 assert(!s.includes('data-action="add-to-storage"'));
 f.run("state.mode='cloud';state.data.viewer={role:'member'}");
 for(const expression of ['renderCatalog()','renderStorageGroups()']){
  const markup=f.run(expression);assert(!markup.includes('edit-entity'));assert(!markup.includes('delete-entity'));
 }
 assert(!f.run('renderStorageGroups()').includes('add-to-storage'));
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
test('Remove all removes only the selected item/storage pair and retains the catalog',async()=>{
 const f=fixture();f.run("quantityModal({action:'remove',itemId:'item-0',fromId:'storage-0'})");
 assert(f.nodes['#modal-root'].innerHTML.includes('data-action="remove-all"'));
 const other=f.run("stockQty('item-0','storage-1')");
 await f.run('removeAll()');
 assert.equal(f.run("state.data.stock.some(x=>x.item_id==='item-0'&&x.storage_id==='storage-0')"),false);
 assert.equal(f.run("stockQty('item-0','storage-1')"),other);
 assert(f.run("state.data.items.some(x=>x.id==='item-0')"));
});
test('cloud Remove all calls the atomic RPC and preserves data on error',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';quantityModal({action:'remove',itemId:'item-0',fromId:'storage-0'})");
 f.ctx.request=null;f.run("rpc=async(name,args)=>{request={name,args};throw Error('Denied')}");
 const before=f.run('JSON.stringify(state.data.stock)');
 await assert.rejects(f.run('removeAll()'),/Denied/);
 assert.equal(f.ctx.request.name,'remove_all_stock');
 assert.equal(f.ctx.request.args.p_storage,'storage-0');
 assert.equal('p_quantity' in f.ctx.request.args,false);
 assert.equal(f.run('JSON.stringify(state.data.stock)'),before);
 assert.equal(f.run('state.busy'),false);
});
test('themed confirmations cancel on close and only resolve true on confirmation',async()=>{
 const f=fixture();f.run('confirmAction=realConfirmAction');
 let pending=f.run("confirmAction('Delete this?','Delete item','Delete')");
 assert(f.nodes['#modal-root'].innerHTML.includes('<h2>Delete item</h2>'));
 f.run('closeModal()');assert.equal(await pending,false);
 pending=f.run("confirmAction('Delete this?')");
 await f.events.click({target:{closest:()=>({dataset:{action:'confirm-action'}})}});
 assert.equal(await pending,true);
});
test('legacy and new deletion logs show names and quantities without database IDs or JSON',()=>{
 const f=fixture();f.ctx.entry={action:'storage_deleted',detail:'Deleted storage Toolbox (00000000-0000-0000-0000-000000000001); removed stock: [{"item":"Crowbar","storage":"Toolbox","before":3,"after":0}]'};
 let text=f.run('activityDescription(entry)');assert(text.includes('Toolbox'));assert(text.includes('3 &times; Crowbar'));assert(!text.includes('00000000'));assert(!text.includes('"before"'));
 f.ctx.entry={action:'item_deleted',detail:JSON.stringify({name:'<script>',stock:[{item:'AK-47',storage:'Toolbox',before:2},{item:'Other',storage:'Empty',before:0}]})};
 text=f.run('activityDescription(entry)');assert(text.includes('&lt;script&gt;'));assert(text.includes('2 &times; AK-47'));assert(!text.includes('Empty'));
});
test('scroll restoration keeps visible rows anchored and restores page and modal offsets',()=>{
 const f=fixture();let inserted=0;
 const panel={dataset:{scrollKey:'activity'},scrollTop:240,scrollLeft:3,getBoundingClientRect:()=>({top:100}),querySelectorAll:()=>[row]};
 const row={dataset:{scrollAnchor:'log-10'},getBoundingClientRect:()=>({top:350+inserted-panel.scrollTop,bottom:390+inserted-panel.scrollTop})};
 const modal={dataset:{scrollKey:'modal'},scrollTop:75,scrollLeft:0,getBoundingClientRect:()=>({top:20}),querySelectorAll:()=>[]};
 f.ctx.document.querySelectorAll=()=>[panel,modal];
 f.ctx.window.scrollX=0;f.ctx.window.scrollY=500;let page;
 f.ctx.window.scrollTo=p=>page=p;
 f.run('var savedScroll=captureScroll()');
 inserted=80;panel.scrollTop=0;panel.scrollLeft=0;modal.scrollTop=0;
 f.run('restoreScroll(savedScroll)');
 assert.equal(panel.scrollTop,320);assert.equal(panel.scrollLeft,3);assert.equal(modal.scrollTop,75);assert.equal(page.top,500);
});
test('sync reloads older history instead of truncating it and does not resurrect cleared logs',async()=>{
 const f=fixture();
 f.run("state.mode='cloud';state.roomId='room';state.data.viewer={role:'admin'};state.data.logs=Array.from({length:300},(_,i)=>({id:300-i}));render=()=>{}");
 const fresh=Array.from({length:301},(_,i)=>({id:301-i}));let pages=0;
 f.ctx.fakeRpc=async(name,args)=>{
  if(name==='get_snapshot')return {viewer:{role:'admin'},logs:fresh.slice(0,150)};
  pages++;return fresh.slice(args.p_offset,args.p_offset+args.p_limit);
 };
 f.run('rpc=fakeRpc');await f.run('refreshCloud(true)');
 assert.equal(f.run('state.data.logs.length'),301);assert.equal(f.run('state.data.logs.at(-1).id'),1);assert.equal(pages,1);
 f.ctx.fakeRpc=async()=>({viewer:{role:'admin'},logs:[]});f.run('rpc=fakeRpc');
 await f.run('refreshCloud(true)');assert.equal(f.run('state.data.logs.length'),0);
});
test('configured categories drive create/edit dropdowns and rename updates items',async()=>{
 const f=fixture();await f.run("manageCategory('add','Health')");
 f.run('newItemModal()');let markup=f.nodes['#modal-root'].innerHTML;
 assert(markup.includes('<select class="field" name="category" required>'));assert(markup.includes('value="Health"'));
 assert(!markup.includes('<input class="field" name="category"'));
 await f.run("manageCategory('rename','Shotguns','Rifle')");
 assert(f.run("state.data.items.filter(x=>x.category==='Rifle').length>0"));
 await assert.rejects(f.run("manageCategory('delete','Rifle')"),/Reassign items/);
 await f.run("manageCategory('delete','Health')");assert(!f.run('categoryNames()').includes('Health'));
 f.run("editEntityModal('item','item-0')");assert(f.nodes['#modal-root'].innerHTML.includes('value="Rifle" selected'));
});
test('member cannot manage categories or logo; profile has no role field',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';state.data.viewer={role:'member',name:'Member'}");
 await assert.rejects(f.run("manageCategory('add','Rifle')"),/Only admins/);
 await assert.rejects(f.run('saveLogo({get:()=>null})'),/Only admins/);
 f.run('profileModal()');assert(!f.nodes['#modal-root'].innerHTML.includes('>Role</label>'));
});
test('logo renders from room data and removing it restores the text mark',async()=>{
 const f=fixture();f.run("state.data.room.logo_data='data:image/png;base64,AAAA'");
 assert(f.run('renderHeader(true)').includes('alt="RFM logo"'));
 await f.run("saveLogo({get:k=>k==='remove_image'?'on':null})");
 assert(!f.run('renderHeader(true)').includes('alt="RFM logo"'));
 assert.equal(f.run('state.data.room.logo_data'),null);
});
test('members see display settings but no admin settings',()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';state.data.viewer={role:'member'}");
 assert(f.run('renderHeader(true)').includes('data-action="share"'));
 f.run('shareModal()');const markup=f.nodes['#modal-root'].innerHTML;
 assert(markup.includes('id="display-scale"'));
 for(const control of ['invite-form','category-form','logo-form','clear-logs','change-role'])assert(!markup.includes(control));
 f.run("state.data.viewer.role='admin';shareModal()");
 assert(f.nodes['#modal-root'].innerHTML.includes('id="display-scale"'));
 assert(f.nodes['#modal-root'].innerHTML.includes('invite-form'));
});
test('display scaling persists locally and rejects unsupported values',()=>{
 const f=fixture();const saved={};
 f.ctx.localStorage.getItem=k=>saved[k]??null;
 f.ctx.localStorage.setItem=(k,v)=>saved[k]=v;
 f.ctx.document.documentElement={style:{}};
 assert.equal(f.run('displayScale()'),100);
 f.run('applyDisplayScale(125)');assert.equal(f.ctx.document.documentElement.style.zoom,'1.25');
 assert.equal(f.run('displayScale()'),125);
 assert.throws(()=>f.run('applyDisplayScale(999)'),/supported/);
 f.run('applyDisplayScale(100)');assert.equal(f.run('displayScale()'),100);
 saved.rfm_display_scale='invalid';assert.equal(f.run('displayScale()'),100);
});
test('category creation is offered only in the admin new-item dropdown, not Settings',()=>{
 const f=fixture();f.run('newItemModal()');
 assert(f.nodes['#modal-root'].innerHTML.includes('data-create-category="true"'));
 assert(f.nodes['#modal-root'].innerHTML.includes('id="new-category-fields" hidden'));
 f.run('shareModal()');assert(!f.nodes['#modal-root'].innerHTML.includes('Item categories'));
 assert(!f.nodes['#modal-root'].innerHTML.includes('category-form'));
 f.run("editEntityModal('item','item-0')");assert(!f.nodes['#modal-root'].innerHTML.includes('data-create-category'));
 f.run("state.mode='cloud';state.data.viewer={role:'member'}");
 assert(!f.run("categorySelect('',true)").includes('data-create-category'));
});
test('inline category creation selects the category without replacing the item form',async()=>{
 const f=fixture();const input={value:' Health '},button={disabled:false},fields={hidden:false};
 const select={options:[{},{}],add(option){this.added=option},focus(){}};
 const parts={'#new-category-name':input,'[name="category"]':select,'[data-action="create-inline-category"]':button,'#new-category-fields':fields};
 const form={querySelector:s=>parts[s],draftName:'Bandage',selectedFile:{name:'picture.png'}};
 f.nodes['#item-form']=form;f.ctx.document.createElement=()=>({});
 await f.run('createInlineCategory()');
 assert.equal(select.value,'Health');assert.equal(select.added.textContent,'Health');
 assert.equal(fields.hidden,true);assert.equal(form.draftName,'Bandage');assert.equal(form.selectedFile.name,'picture.png');
 assert.equal(button.disabled,false);assert(f.run('categoryNames()').includes('Health'));
});
