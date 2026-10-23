const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const webRequire=require('node:module').createRequire(path.resolve(__dirname,'../apps/web/package.json'));
const ts=webRequire('typescript');
let serializationCount=0;
const sandbox={console,TextEncoder,crypto:globalThis.crypto,Set,Map,Error,Promise,window:{},JSON:{parse:JSON.parse,stringify(...args){serializationCount++;return JSON.stringify(...args);}}};
function load(file,imports={}){
 const source=fs.readFileSync(path.resolve(__dirname,'../apps/web/src/features/canvas',file),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const mod={exports:{}};
 vm.runInNewContext('(function(require,module,exports){'+code+'})',sandbox,{filename:file})(name=>imports[name]||webRequire(name),mod,mod.exports);
 return mod.exports;
}
const {createEditorStore,connect,connectionIssue}=load('editorStore.ts');
const graph=()=>({version:1,background:'dots',viewport:{x:0,y:0,zoom:1},edges:[],nodes:Array.from({length:500},(_,i)=>({id:'n'+i,type:'text',position:{x:i*300,y:0},size:{width:250,height:180},data:{text:'User text '+i}}))});
test('500-node pointer gesture avoids graph serialization, commits once and undoes the whole gesture',()=>{
 const initial=graph(),store=createEditorStore(initial);
 store.getState().begin();serializationCount=0;
 for(let i=1;i<=200;i++)store.getState().preview(g=>({...g,nodes:g.nodes.map((n,index)=>index===0?{...n,position:{x:i,y:i}}:n)}));
 assert.equal(serializationCount,0);
 assert.equal(store.getState().sequence,0);assert.equal(store.getState().past.length,0);
 store.getState().end();assert.equal(store.getState().sequence,1);assert.equal(store.getState().past.length,1);
 assert.equal(store.getState().graph.nodes[0].position.x,200);
 assert.equal(store.getState().graph.nodes[499],initial.nodes[499]);
 store.getState().undo();assert.equal(store.getState().graph,initial);
 store.getState().redo();assert.equal(store.getState().graph.nodes[0].position.x,200);
 store.getState().undo();store.getState().begin();store.getState().preview(g=>({...g,nodes:g.nodes.map((n,i)=>i===0?{...n,position:{x:300,y:10}}:n)}));store.getState().end();assert.equal(store.getState().future.length,0);store.getState().redo();assert.equal(store.getState().graph.nodes[0].position.x,300);
});
test('connection validation rejects duplicate, wrong-direction and cyclic inputs',()=>{
 const g=graph();g.nodes=[g.nodes[0],{...g.nodes[1],type:'generate',data:{}}];
 const linked=connect(g,'n0','n1');assert.equal(linked.edges[0].role,'prompt');
 assert.match(connectionIssue(linked,'n0','n1'),/已经连接/);
 assert.match(connectionIssue(g,'n0','n0'),/自己/);
 assert.ok(connectionIssue(g,'n1','n0'));
});
test('saving during a pointer gesture captures its final position and one undo checkpoint',async()=>{
 const initial=graph(),store=createEditorStore(initial),writes=[];
 const {ProjectSaver}=load('projectSaver.ts',{'./projectApi':{projectApi:{save:async(id,g,rev)=>{writes.push({g,rev});return {graph:g,assets:[],project:{id,revision:rev+1}};}}},'../auth/sessionApi':{SessionError:class SessionError extends Error{}}});
 const saver=new ProjectSaver('project','csrf',store,()=>{},()=>{});saver.initialize(0);
 store.getState().begin();store.getState().preview(g=>({...g,nodes:g.nodes.map((n,i)=>i===0?{...n,position:{x:150,y:60}}:n)}));
 assert.equal(saver.dirty(),true);await saver.flush();
 assert.equal(writes.length,1);assert.equal(writes[0].g.nodes[0].position.x,150);
 assert.equal(saver.dirty(),false);assert.equal(store.getState().past.length,1);
 saver.close();
});
test('an older save acknowledgement never writes a gesture in progress or discards its final position',async()=>{
 const store=createEditorStore(graph()),writes=[];let acknowledge;
 const {ProjectSaver}=load('projectSaver.ts',{'./projectApi':{projectApi:{save:(id,g,rev)=>{writes.push(g);return new Promise(resolve=>{acknowledge=()=>resolve({graph:g,assets:[],project:{id,revision:rev+1}});});}}},'../auth/sessionApi':{SessionError:class SessionError extends Error{}}});
 const saver=new ProjectSaver('project','csrf',store,()=>{},()=>{});saver.initialize(0);
 store.getState().change(g=>({...g,background:'lines'}));const first=saver.flush();
 store.getState().begin();store.getState().preview(g=>({...g,nodes:g.nodes.map((n,i)=>i===0?{...n,position:{x:400,y:50}}:n)}));
 acknowledge();await first;assert.equal(writes.length,1);assert.equal(saver.dirty(),true);
 store.getState().end();const second=saver.flush();acknowledge();await second;
 assert.equal(writes.length,2);assert.equal(writes[1].nodes[0].position.x,400);assert.equal(saver.dirty(),false);
 saver.close();
});
