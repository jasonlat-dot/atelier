const fs = require('node:fs');
const path = require('node:path');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../apps/web')] }));
const root = path.join(__dirname, '../apps/web/src');
const violations = [];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { scan(file); continue; }
    if (!entry.name.endsWith('.tsx')) continue;
    const source = fs.readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const customConfirms = new Set();
    function collect(node) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
        && node.initializer.expression.getText(tree) === 'useConfirmNotice') customConfirms.add(node.name.getText(tree));
      ts.forEachChild(node, collect);
    }
    collect(tree);
    function visit(node) {
      if (ts.isCallExpression(node) && /^(?:(?:window|globalThis)\.)?(?:alert|confirm)$/.test(node.expression.getText(tree)) && !customConfirms.has(node.expression.getText(tree)))
        violations.push(`${path.relative(root, file)}: native browser prompt`);
      if (ts.isJsxElement(node)) {
        const role = node.openingElement.attributes.properties.find((attribute) =>
          ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === 'role');
        const literal = role?.initializer;
        if (literal && ts.isStringLiteral(literal)) {
          if (literal.text === 'alert') violations.push(`${path.relative(root, file)}: inline error notice`);
          const content = node.children.map((child) => child.getText(tree)).join(' ');
          if (literal.text === 'status' && /\{\s*(?:message|notice|feedback|copied|copyMessage)\s*\}/.test(content))
            violations.push(`${path.relative(root, file)}: inline operation result`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}
scan(root);
if (violations.length) throw new Error(`Use the shared Feedback dialog:\n${violations.join('\n')}`);
console.log('Global feedback contract passed: no native prompts or inline operation results/errors');
