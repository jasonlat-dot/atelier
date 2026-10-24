const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../apps/web')] }));
const root = path.join(__dirname, '../apps/web/src');
const failures = [];
let shared = 0, native = 0;
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
        if (tag === 'DatePicker') shared++;
        const type = attributes.find((a) => a.name.getText(tree) === 'type')?.initializer;
        if (tag === 'input' && type && /['"](?:date|datetime-local|time|month|week)['"]/.test(type.getText(tree))) {
          native++;
          if (file !== path.join(root, 'components/DatePicker.tsx'))
            failures.push(`${path.relative(root, file)}: use the shared DatePicker`);
          else {
            assert.ok(attributes.some((a) => a.name.getText(tree) === 'hidden'), 'only the hidden form field may use native date/time input');
            assert.ok(attributes.some((a) => a.name.getText(tree) === 'aria-hidden'), 'one accessible date control only');
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
scan(root);
assert.deepEqual(failures, []);
assert.equal(native, 1, 'one shared backing field for date and datetime modes');
assert.ok(shared >= 4, 'invite, redeem-code and both upstream quota forms use DatePicker');

const output = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.join(root, 'components/datePickerBehavior.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(`(function(exports){${code}})`, {})(output.exports);
const { parseCalendar, serializeCalendar, formatCalendar, localDate, calendarValue, calendarGrid, dateAllowed, clampCalendar, shiftDays, shiftMonths, monthAllowed, normalizedMinuteStep, datePickerPosition } = output.exports;
const serialized = (value, mode) => serializeCalendar(value, mode);
for (const raw of ['2024-02-29T09:05', '2024/2/29 9:05', ' 2024.02.29 09:05 '])
  assert.equal(serialized(parseCalendar(raw)), '2024-02-29T09:05');
for (const raw of ['', '2023-02-29', '1900-02-29', '2024-02-30', '2024-04-31', '2024-00-01', '2024-13-01', '2024-01-00', '2024-01-01T24:00', '2024-01-01T12:60', '0000-01-01', '10000-01-01', '2024-01-01T12:00Z', 'not a date'])
  assert.equal(parseCalendar(raw), null, `reject malformed/overflow date ${raw}`);
assert.equal(serialized(parseCalendar('2000-02-29')), '2000-02-29T00:00');
assert.equal(serialized(parseCalendar('0099-01-02')), '0099-01-02T00:00', 'years below 100 must not jump to 1900');
assert.equal(serialized(parseCalendar('2026-10-24T23:59', 'date'), 'date'), '2026-10-24');
assert.equal(formatCalendar(parseCalendar('2026-10-24T09:05')), '2026/10/24 09:05');
assert.equal(formatCalendar(null), '');
const selected = parseCalendar('2026-10-24T09:05');
assert.equal(serialized(calendarValue(localDate(selected))), '2026-10-24T09:05', 'local fields survive serialization without a UTC offset');
assert.equal(dateAllowed(selected, '2026-10-24T23:59', '2026-10-24T00:00'), true, 'min/max are inclusive day boundaries');
assert.equal(dateAllowed(selected, '2026-10-25'), false);
assert.equal(dateAllowed(selected, undefined, '2026-10-23'), false);
assert.equal(serialized(clampCalendar(selected, '2026-11-02')), '2026-11-02T09:05', 'clamping preserves the chosen local clock');
assert.equal(serialized(clampCalendar(selected, undefined, '2026-10-01')), '2026-10-01T09:05');
assert.equal(serialized(shiftMonths(parseCalendar('2024-01-31T15:42'), 1)), '2024-02-29T15:42');
assert.equal(serialized(shiftMonths(parseCalendar('2023-01-31T15:42'), 1)), '2023-02-28T15:42');
assert.equal(serialized(shiftMonths(parseCalendar('2024-02-29T15:42'), 12)), '2025-02-28T15:42');
assert.equal(serialized(shiftDays(parseCalendar('2024-02-28T15:42'), 2)), '2024-03-01T15:42');
assert.equal(serialized(shiftDays(parseCalendar('2026-01-01'), -1), 'date'), '2025-12-31');
assert.equal(serialized(shiftMonths(parseCalendar('0001-01-01'), -1), 'date'), '0001-01-01');
assert.equal(serialized(shiftMonths(parseCalendar('9999-12-31'), 1), 'date'), '9999-12-31');
const october = calendarGrid(2026, 10);
assert.equal(october.length, 42);
assert.equal(serialized(october[0], 'date'), '2026-09-28', 'calendar starts on Monday');
assert.equal(serialized(october[41], 'date'), '2026-11-08');
assert.equal(calendarGrid(2024, 2).filter((day) => day.month === 2).length, 29);
assert.equal(monthAllowed(2026, 9, '2026-10-24'), false);
assert.equal(monthAllowed(2026, 10, '2026-10-24'), true);
assert.equal(monthAllowed(2026, 11, undefined, '2026-10-24'), false);
assert.equal(monthAllowed(0, 12), false);
for (const step of [1, 5, 10, 15, 60]) assert.equal(normalizedMinuteStep(step), step);
for (const step of [0, -1, 1.5, NaN, 61]) assert.equal(normalizedMinuteStep(step), 1);
for (const width of [320, 390, 1024, 1440]) {
  for (const left of [0, width - 60]) {
    for (const top of [2, 300, 570]) {
      const position = datePickerPosition({ left, top, bottom: top + 40 }, 416, 480, width, 640);
      assert.ok(position.left >= 8 && position.left + position.width <= width - 8, 'picker stays inside narrow viewport');
      assert.ok(position.top >= 8 && position.top + position.maxHeight <= 632, 'picker respects available vertical room');
      if (top === 570) assert.equal(position.placement, 'top', 'near-bottom picker flips upward');
      if (top === 2) assert.equal(position.placement, 'bottom');
    }
  }
}
console.log(`DatePicker contract passed: ${shared} shared controls; parsing, leap years, local values, calendar navigation, bounds and viewport placement passed`);
