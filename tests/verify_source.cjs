const ts=require(require.resolve('typescript', {paths:[require('node:path').join(__dirname,'../apps/web')]}));
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const web=path.join(__dirname,'../apps/web/src');
let files=[];function walk(dir){for(const f of fs.readdirSync(dir)){const x=path.join(dir,f);if(fs.statSync(x).isDirectory())walk(x);else if(/\.tsx?$/.test(x) && !x.endsWith('.d.ts'))files.push(x);}}walk(web);
let errors=[];for(const f of files){const source=fs.readFileSync(f,'utf8');const out=ts.transpileModule(source,{fileName:f,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}});for(const d of out.diagnostics||[])if(d.category===ts.DiagnosticCategory.Error)errors.push(`${f}: ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`);}if(errors.length){console.error(errors.join('\n'));process.exit(1);}console.log('Transpile syntax OK:',files.length,'TypeScript / TSX files');
const storage=new Map(), cache={};const sandbox={console,crypto:globalThis.crypto,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},Date,Math,JSON,Set,Error};
function load(name){if(cache[name])return cache[name];const file=path.join(web,'lib',name+'.ts');const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;const mod={exports:{}};const req=x=>{if(x==='./seed')return load('seed');throw new Error('unexpected require '+x)};vm.runInNewContext('(function(require,module,exports){'+code+'})',sandbox,{filename:file})(req,mod,mod.exports);cache[name]=mod.exports;return mod.exports;}
const m=load('mockDb');const check=(cond,msg)=>{if(!cond)throw new Error(msg);};
const user=m.currentUser(),first=m.userProjects()[0],balance=user.credits;check(first.ownerId===user.id,'project scope');
const base={projectId:first.id,nodeId:'node1',kind:'image',prompt:'sunrise',quality:'medium',ratio:'16:9',model:'image-demo',duration:6,count:1};const job=m.createJob(base,'idem-one');check(m.currentUser().credits===balance-job.cost,'hold debited');check(m.createJob(base,'idem-one').id===job.id,'idempotency key');check(m.currentUser().credits===balance-job.cost,'no duplicate charge');m.cancelJob(job.id);check(m.currentUser().credits===balance,'cancel refunded');m.cancelJob(job.id);check(m.currentUser().credits===balance,'no duplicate refund');
const rev=first.revision;const saved=m.saveGraph(first.id,first.graph,rev);check(saved.revision===rev+1,'optimistic version');let conflict=false;try{m.saveGraph(first.id,first.graph,rev);}catch(e){conflict=String(e).includes('REVISION_CONFLICT')}check(conflict,'reject stale revision');
m.switchUser('admin-demo');check(!m.userProjects().some(p=>p.id===first.id),'isolate projects');let foreign=false;try{m.createJob(base,'other');}catch{foreign=true;}check(foreign,'forbid foreign project');m.addCredits('user-demo',125);check(m.snapshot().users.find(u=>u.id==='user-demo').credits===balance+125,'admin credits');
m.switchUser('user-demo');let deny=false;try{m.addCredits('user-demo',1000);}catch{deny=true;}check(deny,'deny user admin operation');
console.log('Mock transaction / idempotency / refund / version conflict / isolation tests passed');

// M0 keeps the original Mock contract, not production financial guarantees.
m.resetDemo();
const initial=m.currentUser().credits;
check(m.checkIn()===true,'first mock checkin');
check(m.checkIn()===false,'repeat mock checkin');
check(m.currentUser().credits===initial+20,'mock checkin grants once');
for(const operation of [()=>m.addCredits('user-demo',1),()=>m.toggleUser('admin-demo'),()=>m.toggleModel('image-demo')]){let rejected=false;try{operation();}catch{rejected=true;}check(rejected,'ordinary user cannot perform mock admin mutation');}
m.switchUser('admin-demo');
for(const delta of [NaN,Infinity,100001,-100001]){let rejected=false;try{m.addCredits('user-demo',delta);}catch{rejected=true;}check(rejected,'invalid mock adjustment');}
console.log('Mock checkin and admin permission regressions passed');
