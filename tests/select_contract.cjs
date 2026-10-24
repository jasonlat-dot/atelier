const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../apps/web')] }));
const root = path.join(__dirname, '../apps/web/src');
let shared = 0, native = 0;
const sharedFiles = new Set();
const failures = [];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { scan(file); continue; }
    if (!file.endsWith('.tsx')) continue;
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const component = file === path.join(root, 'components/Select.tsx');
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(tree);
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const role = attributes.find((a) => a.name.getText(tree) === 'role')?.initializer;
        if (tag === 'Select') { shared++; sharedFiles.add(path.relative(root, file).split(path.sep).join('/')); }
        if (tag === 'select') {
          native++;
          if (!component) failures.push(`${path.relative(root, file)}: use the shared Select`);
          else {
            assert.ok(attributes.some((a) => a.name.getText(tree) === 'hidden'), 'native backing field must remain hidden');
            assert.ok(attributes.some((a) => a.name.getText(tree) === 'aria-hidden'), 'one accessible trigger only');
          }
        }
        if (!component && file !== path.join(root, 'components/DatePicker.tsx') && role && ts.isStringLiteral(role) && ['listbox', 'combobox'].includes(role.text))
          failures.push(`${path.relative(root, file)}: no separate select popup`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
scan(root);
assert.deepEqual(failures, []);
assert.equal(native, 1, 'one shared form-field implementation');
// Audit actual dropdown owners rather than a fixed total: the plan type and
// resolution controls intentionally became native radio groups in the new editor.
for (const owner of [
  'features/billing/PlanEditor.tsx', 'features/assets/AssetsPage.tsx',
  'features/generation/GenerationPage.tsx', 'features/chat/LiveChatPage.tsx',
  'features/upstream/AdminModelsPage.tsx', 'features/wallet/CreditAdjustmentFields.tsx',
  'features/canvas/CanvasPage.tsx', 'features/canvas/LiveCanvasEditor.tsx',
]) assert.ok(sharedFiles.has(owner), `${owner} dropdowns must use the shared Select`);
const output = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.join(root, 'components/selectBehavior.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(`(function(exports){${code}})`, {})(output.exports);
const { filterChoices, menuChoices, moveChoice, typeaheadChoice, selectPosition } = output.exports;
const choices = [
  { value: '', label: '全部来源' },
  { value: 'a', label: 'Alpha', disabled: true },
  { value: 'b', label: 'Beta', description: '低成本', group: '图片' },
  { value: 'c', label: 'Bravo' },
  { value: 'd', label: 'Delta', disabled: true },
];
assert.equal(menuChoices(choices)[0].value, '', 'a filter empty value is not a placeholder');
assert.ok(!menuChoices(choices, '请选择').some((o) => o.value === ''), 'placeholder is hidden unless clearable');
assert.equal(menuChoices(choices, '请选择', true)[0].value, '');
assert.equal(menuChoices(choices.slice(1), '请选择', true)[0].value, '', 'options API can synthesize the clear choice');
assert.equal(moveChoice(choices, -1, 'first'), 0, 'empty-valued filters remain selectable');
assert.equal(moveChoice(choices, 0, 'next'), 2, 'skip disabled options');
assert.equal(moveChoice(choices, 2, 'previous'), 0);
assert.equal(moveChoice(choices, 0, 'last'), 3);
assert.equal(moveChoice(choices, 3, 'next'), 3, 'do not overshoot end');
assert.equal(moveChoice(choices.filter((o) => o.disabled), -1, 'first'), -1);
assert.equal(moveChoice([], -1, 'next'), -1);
assert.equal(filterChoices(choices, '图片')[0].value, 'b');
assert.equal(filterChoices(choices, '  低成本  ')[0].value, 'b');
assert.equal(filterChoices(choices, 'BETA')[0].value, 'b');
assert.equal(filterChoices(choices, '不存在').length, 0);
assert.equal(typeaheadChoice(choices, 'a', -1), -1, 'typeahead also skips disabled');
assert.equal(typeaheadChoice(choices, 'b', -1), 2);
assert.equal(typeaheadChoice(choices, 'b', 2), 3, 'single character can advance to next match');
assert.equal(typeaheadChoice(choices, 'br', -1), 3);
assert.equal(typeaheadChoice([], 'a', -1), -1);
for (const width of [320, 390, 1024, 1440]) {
  for (const left of [0, 8, width - 100, width - 5]) {
    for (const top of [2, 200, 570]) {
      const p = selectPosition({ left, top, bottom: top + 40, width: 140 }, 1200, 300, width, 640);
      assert.ok(p.left >= 8 && p.left + p.width <= width - 8, 'long menu stays inside horizontal viewport');
      assert.ok(p.top >= 8 && p.top + p.maxHeight <= 632, 'menu height respects available room');
      if (top === 570) assert.equal(p.placement, 'top', 'bottom composer flips upward');
      if (top === 2) assert.equal(p.placement, 'bottom');
    }
  }
}
console.log(`Select contract passed: ${shared} shared controls, one hidden form field; disabled navigation, empty filters, search, typeahead and viewport placement passed`);
