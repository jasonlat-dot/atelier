const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../apps/web')] }));
const source = fs.readFileSync(path.join(__dirname, '../apps/web/src/components/toastStore.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let now = 0, sequence = 0;
const timers = new Map();
const exported = { exports: {} };
const sandbox = {
  crypto: { randomUUID: () => `toast-${++sequence}` },
  Date: { now: () => now },
  setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id; },
  clearTimeout: (id) => timers.delete(id),
  module: exported, exports: exported.exports,
};
vm.runInNewContext(code, sandbox);
const api = exported.exports;
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const next = [...timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    timers.delete(next[0]); now = next[1].at; next[1].callback();
  }
  now = end;
}
const get = (owner, id) => api.getToasts().find((item) => item.owner === owner && item.id === id);
async function run() {
  let elapsed = 0;
  const timer = api.createToastTimer(3000, () => elapsed++);
  timer.resume(); advance(1000); timer.pause(); timer.pause(); advance(9000);
  assert.equal(elapsed, 0, 'paused toast cannot expire');
  timer.resume(); timer.resume(); advance(1999); assert.equal(elapsed, 0);
  advance(1); assert.equal(elapsed, 1, 'resume uses remaining time');
  timer.resume(); advance(3000); assert.equal(elapsed, 1, 'completion only fires once');
  const resident = api.createToastTimer(0, () => elapsed++);
  resident.resume(); advance(60000); assert.equal(elapsed, 1, 'duration zero remains resident');
  resident.pause();

  const id = api.showToast('page', { title: '已复制' });
  assert.equal(get('page', id).duration, 3000);
  assert.equal(get('page', id).position, 'top-center');
  assert.equal(api.showToast('page', { title: '已复制' }), id, 'identical clipboard notices replace themselves');
  assert.equal(api.getToasts().length, 1);
  assert.equal(get('page', id).revision, 1, 'replacement restarts timer/progress revision');
  api.dismissToast('page', id); assert.equal(get('page', id).leaving, true);
  advance(100); api.updateToast('page', id, { title: '仍然显示', type: 'warning' }); advance(200);
  assert.ok(get('page', id), 'update cancels an old exit timer');
  assert.equal(get('page', id).leaving, false);
  assert.equal(get('page', id).duration, 3000);
  api.clearToasts();

  let closed = 0;
  for (let n = 0; n < 4; n++) api.showToast('stack', { id: `id-${n}`, title: `提示 ${n}`, onClose: () => closed++ });
  assert.equal(api.getToasts().length, 3);
  assert.equal(closed, 1, 'oldest eviction closes once');
  assert.equal(api.getToasts()[0].id, 'id-3', 'newest sits nearest the edge');
  api.showToast('other', { id: 'id-3', title: '另一页', position: 'bottom-right' });
  api.updateToast('stack', 'id-3', { type: 'error' });
  assert.equal(get('stack', 'id-3').duration, 5000);
  assert.equal(get('other', 'id-3').title, '另一页', 'same ids from separate owners are isolated');
  api.clearOwnerToasts('stack');
  assert.equal(closed, 1, 'unmounted page callbacks are not invoked');
  assert.equal(api.getToasts().length, 1);
  api.clearToasts();
  const loading = api.showToast('load', { title: '同步中', type: 'loading', closable: false });
  assert.equal(get('load', loading).duration, 0);
  api.updateToast('load', loading, { type: 'success', title: '已完成', closable: true });
  assert.equal(get('load', loading).duration, 3000);
  assert.equal(get('load', loading).closable, true);
  const action = api.showToast('action', { title: '可查看', action: { label: '查看', onClick() {} } });
  assert.equal(get('action', action).duration, 6000, 'action notices allow more reading time');
  api.clearToasts();

  let finishA, finishB;
  const a = new Promise((resolve) => { finishA = resolve; });
  const b = new Promise((resolve) => { finishB = resolve; });
  const messages = { loading: '同步中', success: (value) => `已完成 ${value}`, error: '失败，请重试' };
  assert.equal(api.trackToastPromise('async', a, messages), a, 'promise identity and result are preserved');
  api.trackToastPromise('async', b, messages);
  assert.equal(api.getToasts().length, 2, 'parallel promises keep separate loading entries');
  finishA('A'); await a; await Promise.resolve();
  assert.equal(api.getToasts().filter((item) => item.type === 'success').length, 1);
  api.clearOwnerToasts('async'); finishB('B'); await b; await Promise.resolve();
  assert.equal(api.getToasts().length, 0, 'late promise completion cannot resurrect unmounted feedback');
  const rejection = Promise.reject(new Error('private error'));
  api.trackToastPromise('failure', rejection, messages);
  await rejection.catch(() => {}); await Promise.resolve();
  assert.equal(api.getToasts()[0].type, 'error');
  assert.equal(api.getToasts()[0].title, '失败，请重试');
  assert.equal(api.getToasts()[0].duration, 5000);
  api.clearToasts();
  assert.equal(timers.size, 0, 'all timers and exit callbacks are cleaned up');
  console.log('Toast behavior passed: countdown pause/resume, resident/loading updates, scoped ids, bounded stacking, exit cleanup and promise lifecycle');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
