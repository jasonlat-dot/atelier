const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('active migrations never install the prototype balance schema', () => {
  const files = fs.readdirSync(path.join(root, 'services/api/migrations'));
  assert.ok(files.some((f) => f.endsWith('.sql')));
  for (const file of files) assert.doesNotMatch(read('services/api/migrations/' + file), /credits bigint|wallet_ledger/);
  assert.match(read('docs/legacy/202610210001_init.sql'), /credits bigint/);
});

test('production build has no mock modules, demo identities, or local wallet', () => {
  const dir = path.join(root, 'apps/web/dist');
  assert.ok(fs.existsSync(dir), 'run npm run build first');
  let scripts = 0;
  for (const file of fs.readdirSync(path.join(dir, 'assets'))) {
    if (!/\.(js|map)$/.test(file)) continue;
    scripts++;
    assert.doesNotMatch(read('apps/web/dist/assets/' + file), /mockDb|seedDb|user-demo|admin-demo|root-demo|atelier-react-v1|每日签到 \+20|\/dev\/login/);
  }
  assert.ok(scripts > 0);
});
