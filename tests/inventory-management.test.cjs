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
 f.run("state.mode='cloud';state.roomId='room';state.section='activity';snapshotRoom='room';state.data.viewer={role:'admin'};state.data.logs=Array.from({length:300},(_,i)=>({id:300-i}));render=()=>{}");
 const fresh=Array.from({length:301},(_,i)=>({id:301-i}));let pages=0;
 f.ctx.fakeRpc=async(name,args)=>{
  if(name==='get_panel_delta')return {revision:{viewer:'r1'},data:{viewer:{role:'admin'},logs:[]}};
  pages++;return fresh.slice(args.p_offset,args.p_offset+args.p_limit);
 };
 f.run('rpc=fakeRpc');await f.run('refreshCloud(true)');
 assert.equal(f.run('state.data.logs.length'),301);assert.equal(f.run('state.data.logs.at(-1).id'),1);assert.equal(pages,7);
 f.ctx.fakeRpc=async(name)=>name==='get_panel_delta'?{revision:{viewer:'r1'},data:null}:[];f.run('rpc=fakeRpc');
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
test('category dropdown has Create first, no placeholder, and preserves existing selection',()=>{
 const f=fixture();const markup=f.run("categorySelect('Shotguns',true)");
 assert(!markup.includes('Choose category'));assert(markup.indexOf('data-create-category')<markup.indexOf('value="Shotguns"'));
 assert(markup.includes('value="Shotguns" selected'));
 assert(!f.run('renderHeader(true)').includes('Settings</button>}'));
});
test('Item Prices is separate from storage and members have no editing controls',async()=>{
 const f=fixture();await f.run('loadPrices()');
 f.run("state.priceBoard.vendors.push({id:'v',name:'Pawn Shop'});state.priceBoard.entries.push({id:'p',vendor_id:'v',name:'Telescope',quality:'Epic/Lego',rolls:'160/252'});state.section='prices';render()");
 const markup=f.nodes['#app'].innerHTML;
 assert(markup.includes('Pawn Shop'));assert(markup.includes('160/252'));assert(!markup.includes('Master item catalog'));
 assert(markup.includes('price-edit'));
 f.run("state.mode='cloud';state.data.viewer={role:'member'}");
 assert(!f.run('renderPrices()').includes('price-edit'));assert(!f.run('renderPrices()').includes('price-delete'));
 assert.throws(()=>f.run("priceEditModal('vendor','v')"),/Only admins/);
 await assert.rejects(f.run("deletePrice('vendor','v')"),/Only admins/);
});
test('vendor and entry editing/deletion leaves storage data unchanged',async()=>{
 const f=fixture();let id=0;f.ctx.crypto={randomUUID:()=>`price-${++id}`};
 const before=f.run('JSON.stringify({items:state.data.items,stock:state.data.stock,logs:state.data.logs})');
 await f.run('loadPrices()');f.run("priceEditModal('vendor')");
 f.ctx.values={name:'Fence'};await f.run('savePrice({get:k=>values[k]})');
 f.run("state.priceBoard.qualities=['Epic/Lego'];priceEditModal('entry','','price-1')");f.ctx.values={name:'Telescope',quality:'Epic/Lego',rolls:'160/252'};
 await f.run('savePrice({get:k=>values[k]})');assert.equal(f.run('state.priceBoard.entries.length'),1);
 await f.run("deletePrice('vendor','price-1')");assert.equal(f.run('state.priceBoard.entries.length'),0);
 assert.equal(f.run('JSON.stringify({items:state.data.items,stock:state.data.stock,logs:state.data.logs})'),before);
});
test('activity is a separate admin-only top-level section; category chips stay used-only',()=>{
 const f=fixture();f.run("state.data.categories=['Shotguns','Pistols','Unused'];render()");
 let markup=f.nodes['#app'].innerHTML;
 assert(markup.includes('data-section="activity"'));assert(!markup.includes('data-action="tab"'));
 assert(!markup.includes('data-filter="Unused"'));assert(f.run('categorySelect()').includes('value="Unused"'));
 f.run("state.section='activity';render()");markup=f.nodes['#app'].innerHTML;
 assert(markup.includes('Search activity'));assert(!markup.includes('Master item catalog'));
 f.run("state.mode='cloud';state.roomId='room';state.data.viewer={role:'member'};render()");
 assert(!f.nodes['#app'].innerHTML.includes('Search activity'));assert(!f.run('renderSections()').includes('data-section="activity"'));
});
test('quality dropdown preserves existing choices and only admins can create options',async()=>{
 const f=fixture();await f.run('loadPrices()');f.run("state.priceBoard.entries=[{id:'p',vendor_id:'v',name:'Gold',quality:'Epic',rolls:'228'}];priceEditModal('entry','p')");
 const markup=f.nodes['#modal-root'].innerHTML;
 assert(markup.includes('<select class="field" name="quality"'));assert(markup.includes('value="Epic" selected'));
 assert(markup.includes('Create quality'));
 f.run("state.mode='cloud';state.data.viewer={role:'member'}");
 assert(!f.run("configuredOptionField('quality','quality')").includes('data-action="create-option"'));
 await assert.rejects(f.run('createConfiguredOption({})'),/Only admins/);
});
function blueprintFixture(){
 const f=fixture();f.run("state.data.items.push({id:'bp',name:'Blueprint',category:'Blueprint',detail:'Catalog detail'});state.data.blueprint_descriptions=['Rifle','Armor'];");return f;
}
test('Blueprint descriptions have independent quantities in one storage and never edit catalog metadata',async()=>{
 const f=blueprintFixture();const item=f.run("JSON.stringify(state.data.items.find(x=>x.id==='bp'))");
 f.run("demoChange('add','bp','','storage-0',5,'Rifle');demoChange('add','bp','','storage-0',3,'Armor');demoChange('move','bp','storage-0','storage-1',2,'Rifle')");
 assert.equal(f.run("stockQty('bp','storage-0','Rifle')"),3);assert.equal(f.run("stockQty('bp','storage-0','Armor')"),3);
 assert.equal(f.run("stockQty('bp','storage-1','Rifle')"),2);assert.equal(JSON.parse(f.run("JSON.stringify(state.data.stock)")).filter(x=>x.item_id==='bp').reduce((n,x)=>n+x.quantity,0),8);
 f.run("quantityModal({action:'remove',itemId:'bp',fromId:'storage-0',blueprintDescription:'Armor'})");await f.run('removeAll()');
 assert.equal(f.run("stockQty('bp','storage-0','Armor')"),0);assert.equal(f.run("stockQty('bp','storage-0','Rifle')"),3);
 assert.equal(f.run("JSON.stringify(state.data.items.find(x=>x.id==='bp'))"),item);
 assert.throws(()=>f.run("demoChange('add','bp','','storage-0',1,'Unconfigured')"),/configured/);
});
test('Blueprint description picker appears only for catalog Blueprint adds; rows carry variant identity',()=>{
 const f=blueprintFixture();f.run("quantityModal({action:'add',itemId:'bp',toId:'storage-0'})");
 assert(f.nodes['#modal-root'].innerHTML.includes('name="blueprint_description"'));assert(f.nodes['#modal-root'].innerHTML.includes('Create description'));
 f.run("quantityModal({action:'add',itemId:'item-0',toId:'storage-0'})");assert(!f.nodes['#modal-root'].innerHTML.includes('name="blueprint_description"'));
 f.run("demoChange('add','bp','','storage-0',2,'Rifle')");
 assert(f.run('renderStorage(state.data.storages[0])').includes('data-blueprint-description="Rifle"'));
});
test('legacy unspecified Blueprint stock stays separate and cloud changes pass variant identity',async()=>{
 const f=blueprintFixture();f.run("state.data.stock.push({item_id:'bp',storage_id:'storage-0',quantity:7});demoChange('add','bp','','storage-0',2,'Rifle')");
 assert.equal(f.run("stockQty('bp','storage-0')"),7);
 f.ctx.calls=[];f.run("state.mode='cloud';state.roomId='room';rpc=async(name,args)=>{calls.push({name,args})};refreshCloud=async()=>{}");
 await f.run("executeChange('move','bp','storage-0','storage-1',1,'Rifle')");
 assert.equal(f.ctx.calls[0].args.p_blueprint_description,'Rifle');
 f.run("state.modal={kind:'quantity',action:'remove',itemId:'bp',fromId:'storage-0',blueprintDescription:'Rifle'}");await f.run('removeAll()');
 assert.equal(f.ctx.calls[1].args.p_blueprint_description,'Rifle');
});


test('text selection ending on backdrop keeps the dialog; deliberate backdrop click closes it',async()=>{
 const f=fixture();
 const overlay={dataset:{action:'close-modal-overlay'}};overlay.closest=()=>overlay;
 const field={dataset:{}};
 f.run("setModal('<input />')");
 const original=f.nodes['#modal-root'].innerHTML;
 f.events.pointerdown({target:field,button:0});
 await f.events.click({target:overlay});
 assert.equal(f.nodes['#modal-root'].innerHTML,original);
 f.events.pointerdown({target:overlay,button:0});
 f.events.pointercancel();
 await f.events.click({target:overlay});
 assert.equal(f.nodes['#modal-root'].innerHTML,original);
 f.events.pointerdown({target:overlay,button:0});
 await f.events.click({target:overlay});
 assert.equal(f.nodes['#modal-root'].innerHTML,'');
});


test('admin storage group move preserves storage identity and all stock; members cannot move',async()=>{
 const f=fixture();f.run("state.data.storage_groups.push({id:'destination',name:'Destination'})");
 const stock=f.run('JSON.stringify(state.data.stock)'),items=f.run('JSON.stringify(state.data.items)');
 assert.match(f.run('renderStorage(state.data.storages[0])'),/data-drag-storage/);
 await f.run("moveStorageToGroup('storage-0','destination')");
 assert.equal(f.run('state.data.storages[0].storage_group_id'),'destination');
 assert.equal(f.run('JSON.stringify(state.data.stock)'),stock);
 assert.equal(f.run('JSON.stringify(state.data.items)'),items);
 assert.equal(f.run('state.data.logs[0].action'),'storage_moved');
 const count=f.run('state.data.logs.length');await f.run("moveStorageToGroup('storage-0','destination')");assert.equal(f.run('state.data.logs.length'),count);
 f.run("state.mode='cloud';state.data.viewer={role:'member'}");
 assert.doesNotMatch(f.run('renderStorage(state.data.storages[0])'),/data-drag-storage/);
 await assert.rejects(f.run("moveStorageToGroup('storage-0','local-main')"),/Only admins/);
});
test('failed cloud storage move leaves local storage and stock untouched',async()=>{
 const f=fixture();f.run("state.data.storage_groups.push({id:'destination',name:'Destination'});state.mode='cloud';state.data.viewer={role:'admin'};state.roomId='room'");
 const before=f.run('JSON.stringify(state.data)');
 f.ctx.failMove=async(name,args)=>{assert.equal(name,'move_storage_group');assert.equal(args.p_storage,'storage-0');assert.equal(args.p_group,'destination');throw Error('denied')};
 f.run('rpc=failMove');await assert.rejects(f.run("moveStorageToGroup('storage-0','destination')"),/denied/);
 assert.equal(f.run('JSON.stringify(state.data)'),before);assert.equal(f.run('state.busy'),false);
});


async function ranksFixture(){const f=fixture();f.run("state.data.members=[{user_id:'one',name:'Test Member',active:true,role:'member'},{user_id:'revoked',name:'Old Member',active:false,role:'member'}]");await f.run('loadRanks()');return f}
test('rank editor is admin-only; member view escapes names and excludes revoked members',async()=>{
 const f=await ranksFixture();assert.match(f.run('renderRanks()'),/data-action="rank-edit"/);assert.match(f.run('renderRanks()'),/data-action="rank-assign"/);
 f.run("state.rankBoard.members[0].name='<script>bad</script>';state.mode='cloud';state.data.viewer={role:'member'}");
 const html=f.run('renderRanks()');assert.doesNotMatch(html,/data-action="rank-(edit|assign)"/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/Old Member/);
 assert.throws(()=>f.run("editRankModal('boss')"),/Only admins/);assert.throws(()=>f.run("assignRankModal('one')"),/Only admins/);
 await assert.rejects(f.run('saveRank(new Map())'),/Only admins/);await assert.rejects(f.run('saveRankAssignment(new Map())'),/Only admins/);
});
test('rank edits and assignments preserve inventory and panel roles; in-use promotion removal is rejected',async()=>{
 const f=await ranksFixture(),before=f.run('JSON.stringify({stock:state.data.stock,items:state.data.items,members:state.data.members,logs:state.data.logs})');
 f.run("state.modal={user:'one'}");await f.run("saveRankAssignment(new Map([['rank','lieutenant'],['promotion','Coordinator']]))");
 f.run("state.modal={key:'lieutenant',version:1}");
 await assert.rejects(f.run("saveRank(new Map([['name','Lieutenant'],['subtitle',''],['promotions','Advisor']]))"),/Reassign/);
 f.ctx.rankValues=new Map([['name','Senior Lieutenant'],['subtitle','Team lead'],['promotions','Coordinator\nAdvisor']]);await f.run('saveRank(rankValues)');
 assert.equal(f.run("state.rankBoard.ranks.find(r=>r.key==='lieutenant').name"),'Senior Lieutenant');
 assert.equal(f.run('state.rankBoard.members[0].rank_key'),'lieutenant');
 assert.match(f.run('renderRanks()'),/Senior Lieutenant/);
 assert.equal(f.run('JSON.stringify({stock:state.data.stock,items:state.data.items,members:state.data.members,logs:state.data.logs})'),before);
 f.run("state.modal={user:'one'}");await f.run("saveRankAssignment(new Map([['rank',''],['promotion','']]))");assert.equal(f.run('state.data.family_assignments.length'),0);
 assert.equal(f.run('state.data.rank_activity.length'),3);
});
test('assignment dropdown resets promotions and rejects invalid selections',async()=>{
 const f=await ranksFixture();f.events.change({target:{id:'family-rank-select',value:'soldier'}});
 assert.match(f.nodes['#family-promotion-select'].innerHTML,/Hustler/);assert.doesNotMatch(f.nodes['#family-promotion-select'].innerHTML,/Coordinator/);
 f.run("state.modal={user:'one'}");await assert.rejects(f.run("saveRankAssignment(new Map([['rank','boss'],['promotion','Hustler']]))"),/valid/);
 await assert.rejects(f.run("saveRankAssignment(new Map([['rank','bad'],['promotion','']]))"),/valid/);
});
test('cloud rank failure preserves drafts and data; stale local edits are rejected',async()=>{
 const f=await ranksFixture();f.run("editRankModal('boss');state.mode='cloud';state.data.viewer={role:'admin'};state.roomId='room'");
 const before=f.run('JSON.stringify(state.rankBoard)'),modal=f.nodes['#modal-root'].innerHTML;
 f.ctx.failRank=async(name,args)=>{assert.equal(name,'edit_rank');assert.equal(args.p_version,1);throw Error('denied')};f.run('rpc=failRank');
 await assert.rejects(f.run("saveRank(new Map([['name','New Boss']]))"),/denied/);assert.equal(f.run('JSON.stringify(state.rankBoard)'),before);assert.equal(f.nodes['#modal-root'].innerHTML,modal);
 f.run("state.mode='local';state.rankBoard.ranks[0].version=2");await assert.rejects(f.run("saveRank(new Map([['name','New Boss']]))"),/changed/);
});


test('vendor filters and numeric multi-value sorting are independent and do not change data',()=>{
 const f=fixture();f.run("state.priceBoard={vendors:[{id:'a',name:'Pawn'},{id:'b',name:'Fence'}],entries:[{id:'1',vendor_id:'a',name:'Item 10',quality:'Rare',rolls:'100'},{id:'2',vendor_id:'a',name:'Item 2',quality:'Common',rolls:'9'},{id:'3',vendor_id:'a',name:'Item 3',quality:'Rare',rolls:'37/45'},{id:'4',vendor_id:'a',name:'Item 4',quality:'Rare',rolls:'37/40'},{id:'5',vendor_id:'b',name:'Other',quality:'Rare',rolls:'1'}]}");
 const before=f.run('JSON.stringify(state.priceBoard)');
 assert.equal(f.run("filteredPrices('a').map(x=>x.id).join(',')"),'2,3,4,1');
 f.run("priceView('a').sort='rolls'");assert.equal(f.run("filteredPrices('a').map(x=>x.id).join(',')"),'2,4,3,1');
 f.run("priceView('a').direction=-1");assert.equal(f.run("filteredPrices('a').map(x=>x.id).join(',')"),'1,3,4,2');
 f.run("priceView('a').quality='Rare';priceView('a').search=' item 3 '");assert.equal(f.run("filteredPrices('a').map(x=>x.id).join(',')"),'3');
 assert.equal(f.run("filteredPrices('b').length"),1);assert.equal(f.run('JSON.stringify(state.priceBoard)'),before);
 f.run("state.mode='cloud';state.data.viewer={role:'member'}");const rendered=f.run('renderPrices()');assert.match(rendered,/price-sort/);assert.match(rendered,/data-price-quality/);assert.doesNotMatch(rendered,/data-action="price-edit"/);
});
test('vendor header toggles sorting, filters survive new data, and reset affects only one vendor',async()=>{
 const f=fixture();f.run("render=()=>{};priceView('a').search='Gold';priceView('b').quality='Rare'");
 const target={closest:()=>({dataset:{action:'price-sort',vendor:'a',key:'rolls'}})};
 await f.events.click({target});assert.equal(f.run("priceView('a').direction"),1);
 await f.events.click({target});assert.equal(f.run("priceView('a').direction"),-1);
 f.run("state.priceBoard={entries:[{id:'new',vendor_id:'a',name:'Gold',quality:'Epic',rolls:'10'}]}");assert.equal(f.run("filteredPrices('a').length"),1);
 await f.events.click({target:{closest:()=>({dataset:{action:'price-filter-reset',vendor:'a'}})}});
 assert.equal(f.run("priceView('a').search"),'');assert.equal(f.run("priceView('a').sort"),'name');assert.equal(f.run("priceView('b').quality"),'Rare');
});


test('storage creation is admin-only while stock controls remain available',()=>{
 const f=fixture();f.run("state.mode='cloud';state.data.viewer={role:'member'}");
 assert.doesNotMatch(f.run('renderStorageGroups()'),/data-action="new-storage"/);
 assert.throws(()=>f.run("newStorageModal('local-main')"),/Only admins/);
 assert.match(f.run('renderStorage(state.data.storages[0])'),/data-action="add-one"/);
 f.run("state.data.viewer.role='admin'");assert.match(f.run('renderStorageGroups()'),/data-action="new-storage"/);
});
test('profile rename uses self-only RPC, preserves draft on failure and validates names',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';state.data.viewer={role:'member',name:'Before',user_id:'one'};profileModal()");
 assert.match(f.nodes['#modal-root'].innerHTML,/profile-form/);assert.doesNotMatch(f.nodes['#modal-root'].innerHTML,/readonly/);
 f.ctx.rename=async(name,args)=>{assert.equal(name,'update_own_name');assert.deepEqual(Object.keys(args).sort(),['p_name','p_room']);assert.equal(args.p_name,'After');throw Error('inactive')};f.run('rpc=rename');
 await assert.rejects(f.run("saveProfileName('After')"),/inactive/);assert.match(f.nodes['#modal-root'].innerHTML,/profile-form/);assert.equal(f.run('state.data.viewer.name'),'Before');
 await assert.rejects(f.run("saveProfileName('   ')"),/Enter a name/);
 f.ctx.rename=async()=>true;f.run("rpc=rename;refreshCloud=async()=>{state.data.viewer.name='After'}");await f.run("saveProfileName(' After ')");assert.equal(f.run('state.name'),'After');assert.equal(f.run('state.data.viewer.user_id'),'one');assert.equal(f.run('state.data.viewer.role'),'member');
});
test('vendor rarity colors use safe presets and color chooser is admin-only',()=>{
 const f=fixture();f.run("state.priceBoard={vendors:[{id:'v',name:'Vendor'}],entries:[{id:'e',vendor_id:'v',name:'Item',quality:'Epic',rolls:'10'}],qualities:['Epic'],quality_colors:{Epic:'#c084fc'}}");
 assert.match(f.run('renderPrices()'),/color:#c084fc/);assert.match(f.run("configuredOptionField('quality','quality')"),/data-quality-color/);
 f.run("state.priceBoard.quality_colors.Epic='red;position:fixed'");assert.equal(f.run("rarityColor('Epic')"),'#e5e7eb');
 f.run("state.mode='cloud';state.data.viewer={role:'member'}");assert.doesNotMatch(f.run("configuredOptionField('quality','quality')"),/data-quality-color/);
});
test('rank box shows escaped member names while Members list omits rank labels',async()=>{
 const f=await ranksFixture();f.run("state.rankBoard.members[0].rank_key='boss';state.rankBoard.members[0].name='<Member>';state.mode='cloud';state.data.viewer={role:'member'}");
 const html=f.run('renderRanks()');assert.match(html,/class="rank-person">&lt;Member&gt;/);
 const roster=html.slice(html.indexOf('rank-roster'));assert.match(roster,/<h3>Members<\/h3>/);assert.doesNotMatch(roster,/Unassigned|Assign rank|>Boss</);
});


test('storage group creation controls and editor require admin',()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';state.data.viewer={role:'member'};renderContent()");
 assert.doesNotMatch(f.nodes['#app'].innerHTML,/data-action="new-storage-group"/);
 assert.throws(()=>f.run('newStorageGroupModal()'),/Only admins/);
 f.run("state.data.viewer.role='admin';renderContent()");assert.match(f.nodes['#app'].innerHTML,/data-action="new-storage-group"/);
 f.run('newStorageGroupModal()');assert.match(f.nodes['#modal-root'].innerHTML,/storage-group-form/);
});


test('crew rank boxes show one distinct member each without hiding assignments beyond three',async()=>{
 const f=await ranksFixture();f.run("state.rankBoard.members=Array.from({length:4},(_,i)=>({user_id:'capo-'+i,name:'Capo Person '+i,rank_key:'caporegime'})).concat([{user_id:'lt',name:'Lieutenant Person',rank_key:'lieutenant'}])");
 const html=f.run('renderRanks()'),chart=html.slice(html.indexOf('class="rank-crews"'),html.indexOf('rank-roster'));
 for(let i=0;i<4;i++)assert.equal(chart.split('Capo Person '+i).length-1,1);
 assert.equal(chart.split('Lieutenant Person').length-1,1);
 const cards=chart.match(/<div class="rank-card" data-rank-node="(?:caporegime|lieutenant)-[^"]+">[\s\S]*?<\/strong>[\s\S]*?<\/div><\/div>/g)||[];
 assert.equal(cards.length,8);
 for(const card of cards)assert.ok((card.match(/class="rank-person"/g)||[]).length<=1);
});


test('rank chart removes dotted boxes but preserves assigned promotions and explicit branches',async()=>{
 const f=await ranksFixture();f.run("state.rankBoard.members=[{user_id:'one',name:'Person',rank_key:'lieutenant',promotion:'Coordinator'}]");
 const markup=f.run('renderRanks()');assert.doesNotMatch(markup,/rank-sub|Dashed boxes/);
 assert.match(markup,/Person<small>Coordinator<\/small>/);assert.match(markup,/Small text below a member/);
 const ids=[...markup.matchAll(/data-rank-node="([^"]+)"/g)].map(m=>m[1]);f.ctx.nodeIds=ids;
 const links=JSON.parse(f.run('JSON.stringify(rankConnections(nodeIds))'));
 assert(links.some(([a,b])=>a==='underboss'&&b==='crew_chief'));
 assert(!links.some(([a,b])=>a==='consigliere'&&b==='crew_chief'));
 for(let i=0;i<3;i++)for(const pair of [['crew_chief','caporegime-'+i],['caporegime-'+i,'lieutenant-'+i],['lieutenant-'+i,'soldier']])assert(links.some(([a,b])=>a===pair[0]&&b===pair[1]));
});

test('rank connectors terminate at measured card edges after layout changes',()=>{
 const f=fixture(),svg={setAttribute(){},innerHTML:''};
 const boxes={soldier:{left:30,right:90,top:20,bottom:110},associate:{left:50,right:110,top:138,bottom:200}};
 const chart={getBoundingClientRect:()=>({left:10,top:10,width:200,height:250}),querySelector:()=>svg,querySelectorAll:()=>Object.entries(boxes).map(([id,rect])=>({dataset:{rankNode:id},getBoundingClientRect:()=>rect}))};
 f.ctx.chart=chart;f.run('drawRankLinks(chart)');assert.match(svg.innerHTML,/M50 100V114H70V128/);
 boxes.soldier.bottom=130;boxes.associate.top=158;f.run('drawRankLinks(chart)');assert.match(svg.innerHTML,/M50 120V134H70V148/);
});


test('conditional snapshots reuse data and activity is fetched only on its own tab',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';render=()=>{}");let calls=[];
 f.ctx.fetch=async(name,args)=>{calls.push([name,args]);return {revision:{items:'one'},data:args.p_revisions.items?{}:{viewer:{role:'admin'},logs:[],items:[{id:'kept'}]}}};f.run('rpc=fetch');
 await f.run('refreshCloud(true)');await f.run('refreshCloud(true)');
 assert.deepEqual(calls.map(x=>x[0]),['get_panel_delta','get_panel_delta']);assert.equal(calls[1][1].p_revisions.items,'one');assert.equal(f.run('state.data.items[0].id'),'kept');
});
test('unchanged activity head avoids fetching older pages again',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';state.section='activity';state.data.viewer={role:'admin'};state.data.logs=Array.from({length:300},(_,i)=>({id:300-i}))");let calls=0;
 f.ctx.fetch=async()=>{calls++;return Array.from({length:50},(_,i)=>({id:300-i}))};f.run('rpc=fetch');await f.run('refreshActivity()');assert.equal(calls,1);assert.equal(f.run('state.data.logs.length'),300);
});
test('automatic polling pauses while hidden, busy, or already fetching; returning visible refreshes',async()=>{
 const f=fixture();let calls=0;f.ctx.tick=async()=>{calls++};f.run("refreshCloud=tick;state.mode='cloud';state.roomId='room';document.hidden=true");await f.run('autoRefresh()');assert.equal(calls,0);
 f.run('document.hidden=false;state.busy=true');await f.run('autoRefresh()');assert.equal(calls,0);
 f.run('state.busy=false;cloudRefreshPromise=Promise.resolve()');await f.run('autoRefresh()');assert.equal(calls,0);
 f.run('cloudRefreshPromise=null');f.events.visibilitychange();assert.equal(calls,1);
});
test('demotion clears cached logs and revoked membership cannot reuse a revision',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';snapshotRoom='room';snapshotRevision='old';state.section='activity';state.data.logs=[{id:1}];render=()=>{};closeModal=()=>{};toast=()=>{};localStorage.removeItem=()=>{}");
 f.ctx.fetch=async()=>({revision:'member',data:{viewer:{role:'member'},logs:[]}});f.run('rpc=fetch');await f.run('refreshCloud()');assert.equal(f.run('state.data.logs.length'),0);assert.equal(f.run('state.section'),'storage');
 f.ctx.fetch=async()=>{throw Error('membership is inactive')};f.run('rpc=fetch');await f.run('refreshCloud()');assert.equal(f.run('state.data'),null);assert.equal(f.run('snapshotRevision'),null);
});

test('activity offers older pages after the initial 50 rows',()=>{
 const f=fixture();f.run("state.mode='cloud';state.data.logs=Array.from({length:50},(_,i)=>({id:i,action:'test',created_at:'2026-11-24'}))");assert.match(f.run('renderActivity()'),/data-action="load-older"/);
});
test('overlapping automatic refreshes share one request',async()=>{
 const f=fixture();let resolve,calls=0;f.ctx.fetch=()=>{calls++;return new Promise(r=>resolve=r)};f.run("rpc=fetch;state.mode='cloud';state.roomId='room';render=()=>{}");
 const first=f.run('refreshCloud(true)'),second=f.run('refreshCloud(true)');assert.equal(calls,1);resolve({revision:'r',data:{viewer:{role:'member'},logs:[]}});await Promise.all([first,second]);assert.equal(calls,1);
});


test('stock-only sync retains metadata, preserves variants, and replaces cleared stock',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';render=()=>{}");
 const first={viewer:{role:'admin',user_id:'one'},room:{id:'room',logo_data:'logo'},items:[{id:'bp',name:'Blueprint'}],storages:[{id:'a',image_data:'picture'},{id:'b'}],stock:[{item_id:'bp',storage_id:'a',blueprint_description:'Alpha',quantity:2}],members:[],invites:[]};
 let reply={revision:{stock:'s1',items:'i1',storages:'t1'},data:first};f.ctx.fetch=async()=>reply;f.run('rpc=fetch');await f.run('refreshCloud()');
 f.run("state.data.logs=[{id:99}]");
 reply={revision:{stock:'s2',items:'i1',storages:'t1'},data:{stock:[{item_id:'bp',storage_id:'a',blueprint_description:'Alpha',quantity:1},{item_id:'bp',storage_id:'b',blueprint_description:'Alpha',quantity:1},{item_id:'bp',storage_id:'a',blueprint_description:'Beta',quantity:4}]}};
 await f.run('refreshCloud()');assert.equal(f.run('state.data.room.logo_data'),'logo');assert.equal(f.run('state.data.storages[0].image_data'),'picture');assert.equal(f.run('state.data.items[0].name'),'Blueprint');assert.equal(f.run('state.data.stock.length'),3);assert.equal(f.run('state.data.logs[0].id'),99);
 reply={revision:{stock:'empty'},data:{stock:[]}};await f.run('refreshCloud()');assert.equal(f.run('state.data.stock.length'),0);assert.equal(f.run('state.data.items.length'),1);
});
test('room changes send no previous revisions and do not reuse old-room data',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='new';snapshotRoom='old';snapshotRevision={stock:'old'};state.data.room={id:'old',logo_data:'private-old'};render=()=>{}");
 f.ctx.fetch=async(name,args)=>{assert.equal(Object.keys(args.p_revisions).length,0);return {revision:{room:'new'},data:{room:{id:'new'},viewer:{role:'member'},stock:[]}}};f.run('rpc=fetch');await f.run('refreshCloud()');assert.equal(f.run('state.data.room.id'),'new');assert.equal(f.run('state.data.room.logo_data'),undefined);assert.equal(f.run('state.data.logs.length'),0);
});
test('partial demotion clears admin-only caches even if response omits those collections',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';snapshotRoom='room';state.data.viewer={role:'admin'};state.data.members=[{name:'Admin-only'}];state.data.invites=[{id:'private'}];state.data.logs=[{id:1}];render=()=>{}");
 f.ctx.fetch=async()=>({revision:{viewer:'member'},data:{viewer:{role:'member'}}});f.run('rpc=fetch');await f.run('refreshCloud()');for(const key of ['members','invites','logs'])assert.equal(f.run('state.data.'+key+'.length'),0);
});

test('tab navigation caches successful reads, expires after 30 seconds, and forced refresh bypasses cache',async()=>{
 const f=fixture();let calls=0;f.ctx.fetch=async()=>{calls++;return {revision:'v1',data:{vendors:[],entries:[]}}};
 f.run("state.mode='cloud';state.roomId='room';state.data.viewer={user_id:'one',role:'admin'};rpc=fetch");
 await f.run('loadPrices(true)');await f.run('loadPrices(true)');assert.equal(calls,1);
 await f.run('loadPrices()');assert.equal(calls,2);
 f.run("tabReadCache.get('prices').time-=30000");await f.run('loadPrices(true)');assert.equal(calls,3);
 f.run("state.data.viewer.role='member'");await f.run('loadPrices(true)');assert.equal(calls,4);
 f.run("state.roomId='other'");await f.run('loadPrices(true)');assert.equal(calls,5);
});

test('failed tab reads are retried and successful mutations invalidate cached tabs',async()=>{
 const f=fixture();let calls=0,fail=false;
 f.ctx.api=async(name)=>{calls++;return fail?{error:{message:'offline'}}:{data:{revision:'v1',data:{vendors:[],entries:[]}}}};
 f.run("state.mode='cloud';state.roomId='room';state.client={rpc:api}");
 await f.run('loadPrices(true)');await f.run('loadPrices(true)');assert.equal(calls,1);
 await f.run("rpc('change_stock',{})");await f.run('loadPrices(true)');assert.equal(calls,3);
 fail=true;await assert.rejects(f.run('loadPrices()'),/offline/);
 fail=false;await f.run('loadPrices(true)');assert.equal(calls,5);
});

test('cached activity keeps loaded history and cannot bypass the admin check',async()=>{
 const f=fixture();let calls=0;f.ctx.fetch=async()=>{calls++;return [{id:1}]};
 f.run("state.mode='cloud';state.roomId='room';state.section='activity';state.data.viewer={role:'admin'};rpc=fetch");
 await f.run('refreshActivity(true)');await f.run('refreshActivity(true)');assert.equal(calls,1);assert.equal(f.run('state.data.logs.length'),1);
 await f.run('refreshActivity()');assert.equal(calls,2);
 f.run("state.data.viewer.role='member'");await f.run('refreshActivity(true)');assert.equal(calls,2);
});

test('section revisions retain unchanged boards and replace empty data after deletion',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';state.data.viewer={user_id:'one',role:'member'}");
 let calls=[],reply={revision:'v1',data:{vendors:[{id:'v'}],entries:[{id:'e'}],quality_colors:{Rare:'#fff'}}};
 f.ctx.fetch=async(name,args)=>{calls.push([name,args]);return reply};f.run('rpc=fetch');
 await f.run('loadPrices()');reply={revision:'v1',data:null};await f.run('loadPrices()');
 assert.equal(calls[0][0],'get_prices_snapshot');assert.equal(calls[0][1].p_revision,null);assert.equal(calls[1][1].p_revision,'v1');assert.equal(f.run('state.priceBoard.entries.length'),1);
 reply={revision:'v2',data:{vendors:[],entries:[],quality_colors:{}}};await f.run('loadPrices()');assert.equal(f.run('state.priceBoard.entries.length'),0);
 f.run("state.roomId='other'");await f.run('loadPrices()');assert.equal(calls.at(-1)[1].p_revision,null);
});

test('rank snapshot retains names and assignments when unchanged and retries failures',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room'");let reply={revision:'r1',data:{ranks:Array.from({length:9},(_,i)=>({key:String(i)})),members:[{name:'Person'}]}};
 f.ctx.fetch=async()=>reply;f.run('rpc=fetch');await f.run('loadRanks()');reply={revision:'r1',data:null};await f.run('loadRanks()');assert.equal(f.run('state.rankBoard.members[0].name'),'Person');
 f.ctx.fetch=async()=>{throw Error('no access')};f.run('rpc=fetch');await assert.rejects(f.run('loadRanks()'),/no access/);assert.equal(f.run('state.rankBoard'),null);
});

function sharedBrowser(){
 const channels=new Set(),queues=new Map();
 class Channel{
  constructor(key){this.key=key;channels.add(this)}
  postMessage(data){for(const c of channels)if(c!==this&&c.key===this.key)c.onmessage?.({data:structuredClone(data)})}
  close(){channels.delete(this)}
 }
 const locks={request(key,{signal},callback){return new Promise((resolve,reject)=>{
  const queue=queues.get(key)||[];queues.set(key,queue);
  const job={start(){if(signal.aborted){finish();reject(Error('aborted'));return}job.active=true;Promise.resolve(callback()).then(resolve,reject).finally(finish)}};
  function finish(){const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);if(index===0)queue[0]?.start()}
  signal.addEventListener('abort',()=>{if(!job.active){finish();reject(Error('aborted'))}},{once:true});queue.push(job);if(queue.length===1)job.start();
 })}};
 return {Channel,locks};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function sharedFixture(browser){
 const f=fixture();f.ctx.BroadcastChannel=browser.Channel;f.ctx.navigator={locks:browser.locks};f.ctx.AbortController=AbortController;
 f.run("state.mode='cloud';state.roomId='room';state.authUserId='user';state.client={supabaseUrl:'https://project.supabase.co'};state.data.viewer={user_id:'user',role:'admin'};render=()=>{};state.lastSync=Date.now();");
 return f;
}

test('two visible tabs elect one poller, share data, and hand over when the leader hides',async()=>{
 const browser=sharedBrowser(),a=sharedFixture(browser),b=sharedFixture(browser);let reads=0;
 for(const f of [a,b]){f.ctx.fetch=async()=>{reads++;return {revision:{stock:'s1'},data:{viewer:{user_id:'user',role:'admin'},stock:[{item_id:'item',quantity:7}]}}};f.run('rpc=fetch;configureSharedSync()')}
 assert.equal(a.run('sharedSync.leader'),true);assert.equal(b.run('sharedSync.leader'),false);
 await a.run('autoRefresh()');await b.run('autoRefresh()');assert.equal(reads,1);assert.equal(b.run('state.data.stock[0].quantity'),7);
 a.run('document.hidden=true;configureSharedSync()');await settle();assert.equal(b.run('sharedSync.leader'),true);
 await b.run('autoRefresh()');assert.equal(reads,2);
 a.run('stopSharedSync()');b.run('stopSharedSync()');await settle();
});

test('shared polling does not block own edits, cross roles, or overwrite a busy tab',async()=>{
 const browser=sharedBrowser(),a=sharedFixture(browser),b=sharedFixture(browser);let writes=0;
 for(const f of [a,b])f.run('configureSharedSync()');
 b.ctx.api=async()=>{writes++;return {data:true}};b.run('state.client.rpc=api');await b.run("rpc('change_stock',{})");assert.equal(writes,1);
 b.run('state.busy=true');a.run("state.data.stock=[{quantity:88}];snapshotRevision={stock:'s'};state.lastSync=Date.now()+10;publishSharedSync()");assert.notEqual(b.run('state.data.stock[0]?.quantity'),88);
 b.run("state.busy=false;state.data.viewer.role='member';configureSharedSync()");assert.equal(b.run('sharedSync.leader'),true);
 a.run('publishSharedSync()');assert.notEqual(b.run('state.data.stock[0]?.quantity'),88);
 a.run('stopSharedSync()');b.run('stopSharedSync()');await settle();
});

test('follower watchdog polls on a stalled leader and Activity keeps independent paging',async()=>{
 const browser=sharedBrowser(),a=sharedFixture(browser),b=sharedFixture(browser);let reads=0;
 for(const f of [a,b])f.run('configureSharedSync()');
 b.ctx.fetch=async()=>{reads++};b.run('refreshCloud=fetch;sharedSync.received=Date.now()-46000');await b.run('autoRefresh()');assert.equal(reads,1);
 b.run("state.section='activity';configureSharedSync()");assert.equal(b.run('sharedSync'),null);await b.run('autoRefresh()');assert.equal(reads,2);
 a.run('stopSharedSync()');b.run('stopSharedSync()');await settle();
});

test('indicator turns red on request failure and green after a successful complete sync',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';state.lastSync=Date.now();render=()=>{};state.client={rpc:async()=>({error:{message:'offline'}})}");
 await assert.rejects(f.run("rpc('get_panel_delta',{})"),/offline/);assert.match(f.run('syncStatus()'),/dot error/);assert.doesNotMatch(f.run('syncStatus()'),/RFM connected/);
 f.ctx.api=async()=>({data:{revision:{},data:{viewer:{role:'member'}}}});f.run('state.client.rpc=api');await f.run('refreshCloud()');assert.doesNotMatch(f.run('syncStatus()'),/dot error/);assert.match(f.run('syncStatus()'),/RFM connected/);
});

test('a peer revocation clears cached panel data and stops coordination',async()=>{
 const browser=sharedBrowser(),a=sharedFixture(browser),b=sharedFixture(browser);
 for(const f of [a,b])f.run('localStorage.removeItem=()=>{};closeModal=()=>{};toast=()=>{};configureSharedSync()');
 a.run("sendSharedMessage({type:'revoked'})");assert.equal(b.run('state.data'),null);assert.equal(b.run('sharedSync'),null);assert.equal(b.run('state.roomId'),null);
 a.run('stopSharedSync()');await settle();
});

test('a broken browser channel cannot turn a successful stock save into a failed save',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.client={rpc:async()=>({data:true})};sharedSync={channel:{postMessage(){throw Error('channel closed')},close(){}},controller:{abort(){}}}");
 assert.equal(await f.run("rpc('change_stock',{})"),true);assert.equal(f.run('sharedSync'),null);
});

test('sync does not apply a response overtaken by a local or peer mutation',async()=>{
 const f=fixture();let resolve;f.ctx.fetch=()=>new Promise(r=>resolve=r);
 f.run("state.mode='cloud';state.roomId='room';rpc=fetch;render=()=>{}");const before=f.run('JSON.stringify(state.data.stock)');
 const pending=f.run('refreshCloud()');f.run('mutationEpoch++');resolve({revision:{stock:'old'},data:{stock:[]}});await pending;
 assert.equal(f.run('JSON.stringify(state.data.stock)'),before);
});

test('a failed section refresh keeps the indicator red even if the panel read succeeded',async()=>{
 const f=fixture();f.run("state.mode='cloud';state.roomId='room';state.section='prices';render=()=>{}");
 f.ctx.api=async(name)=>name==='rfm_get_panel_delta'?{data:{revision:{},data:{viewer:{role:'member'}}}}:{error:{message:'section unavailable'}};
 f.run('state.client={rpc:api}');await f.run('refreshCloud()');assert.match(f.run('syncStatus()'),/dot error/);
});
