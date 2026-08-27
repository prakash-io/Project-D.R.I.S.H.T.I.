// Parse + import + JSX-binding check for the driver client.
//
//   node verify_parse.mjs
//
// There is no React Native toolchain on the development machine, so nothing
// here builds or renders. This is the gate that stands in for it, and it is
// the one CLAUDE.md refers to when it says src/ui is "verified only by
// parse": every .js/.jsx file must compile under the React Native Babel
// preset, every JSX element name must be bound by an import or a local
// declaration in the same file, and every relative import must resolve to a
// file that exists.
//
// It was described in the handover for months before it was a script anyone
// could run. Now it is.
//
// What it does NOT prove, and what a handset still has to: layout, font
// fallback, fontVariant on Android, native module behaviour, and anything
// that depends on a value only the device produces. Pair it with
// verify_runtime.mjs, which catches the other off-device failure mode -- a
// standard global that exists in Node and not in Hermes.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseSync, traverse } from '@babel/core';

const ROOT = path.resolve(process.argv[2] ?? import.meta.dirname);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'android', 'ios', 'native', 'third_party'].includes(name)
        || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(name) && !name.endsWith('.config.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  FAIL ${msg}`); };

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parseSync(src, {
      filename: file,
      cwd: ROOT,
      presets: [['@react-native/babel-preset', {}]],
      plugins: [['@babel/plugin-proposal-decorators', { legacy: true }]],
      babelrc: false,
      configFile: false,
      ast: true,
      code: false,
    });
  } catch (error) {
    fail(`${path.relative(ROOT, file)}: parse error -- ${error.message.split('\n')[0]}`);
    continue;
  }

  const imported = new Set();
  const declared = new Set();
  const usedJsx = new Set();
  const relImports = [];

  traverse(ast, {
    ImportDeclaration(p) {
      const source = p.node.source.value;
      if (source.startsWith('.')) relImports.push({ source, loc: p.node.loc });
      for (const spec of p.node.specifiers) imported.add(spec.local.name);
    },
    VariableDeclarator(p) {
      if (p.node.id.type === 'Identifier') declared.add(p.node.id.name);
    },
    FunctionDeclaration(p) { if (p.node.id) declared.add(p.node.id.name); },
    ClassDeclaration(p) { if (p.node.id) declared.add(p.node.id.name); },
    JSXOpeningElement(p) {
      let n = p.node.name;
      while (n.type === 'JSXMemberExpression') n = n.object;
      if (n.type === 'JSXIdentifier' && /^[A-Z]/.test(n.name)) usedJsx.add(n.name);
    },
  });

  for (const name of usedJsx) {
    if (!imported.has(name) && !declared.has(name)) {
      fail(`${path.relative(ROOT, file)}: <${name}> is not bound by any import or declaration`);
    }
  }

  for (const { source } of relImports) {
    const base = path.resolve(path.dirname(file), source);
    const found = ['', '.js', '.jsx', '.json', '/index.js', '/index.jsx']
      .some((ext) => existsSync(base + ext) && statSync(base + ext).isFile());
    if (!found) fail(`${path.relative(ROOT, file)}: import '${source}' resolves to nothing`);
  }
}

console.log(`\n${files.length} files parsed, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
