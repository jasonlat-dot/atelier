const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../apps/web')] }));
const root = path.join(__dirname, '../apps/web/src');
const failures = [];
let hosts = 0, targets = 0;
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(file); continue; }
    if (!file.endsWith('.tsx')) continue;
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(tree);
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const has = (name) => attributes.some((a) => a.name.getText(tree) === name);
        if (tag === 'TooltipHost') hosts++;
        if (has('data-tip') || tag === 'Tooltip') targets++;
        if ((/^[a-z]/.test(tag) || tag === 'Handle') && tag !== 'iframe' && has('title')) failures.push(`${path.relative(root, file)}: native title tooltip`);
        const role = attributes.find((a) => a.name.getText(tree) === 'role')?.initializer;
        if (role && ts.isStringLiteral(role) && role.text === 'tooltip' && path.relative(root, file) !== path.join('components', 'Tooltip.tsx')) failures.push(`${path.relative(root, file)}: separate tooltip host`);
        if (has('data-tip') && has('disabled')) failures.push(`${path.relative(root, file)}: disabled tooltip trigger must use Tooltip wrapper`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
scan(root);
assert.deepEqual(failures, []);
assert.equal(hosts, 1, 'one shared TooltipHost must serve both production and mock');
const output = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.join(root, 'components/tooltipPosition.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(`(function(exports){${code}})`, {})(output.exports);
const place = output.exports.tooltipPosition;
const anchor = { left: 200, right: 240, width: 40, top: 200, bottom: 240 };
let position = place(anchor, 140, 50, 800, 600);
assert.equal(position.placement, 'top');
assert.ok(position.top + 50 < anchor.top);
position = place({ ...anchor, top: 3, bottom: 43 }, 140, 50, 800, 600);
assert.equal(position.placement, 'bottom', 'top edge flips below');
position = place({ ...anchor, top: 560, bottom: 590 }, 140, 50, 800, 600, 'bottom');
assert.equal(position.placement, 'top', 'bottom edge flips above');
for (const viewport of [320, 390, 1024, 1440]) {
  for (const x of [0, 4, 80, viewport - 40, viewport - 2]) {
    const width = 280;
    position = place({ left: x, right: x + 20, width: 20, top: 200, bottom: 230 }, width, 60, viewport, 600);
    assert.ok(position.left >= 8 && position.left + width <= viewport - 8, 'bubble stays within viewport');
    assert.ok(position.arrow >= 14 && position.arrow <= width - 14, 'arrow stays clear of rounded corners');
    assert.ok(position.top >= 8 && position.top + 60 <= 592);
  }
}
console.log(`Tooltip contract passed: ${targets} shared targets, one host, no native title tooltips; placement flips and viewport clamping passed`);
