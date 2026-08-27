// Guard against JS that PARSES but does not RUN on the handset.
//
// The mobile client's only off-device check is a parse pass: every file
// compiles, every JSX tag is bound, every import resolves. That check is
// blind to a real class of bug -- a standard global that exists in Node and
// in every browser but not in React Native's runtime. Such a call compiles
// cleanly, ships, and throws "undefined is not a function" on the phone.
//
// It cost a build cycle once already. `AbortSignal.timeout` is a static that
// React Native's AbortController polyfill does not implement; the corridor
// fetches called it inside a try, so it was caught as a NETWORK failure,
// answered from an empty cache, and the simulated drive fell through to real
// GNSS with no error anywhere except a console.warn.
//
// Everything banned here has been confirmed missing on-device or is
// documented as unavailable in Hermes. Each needs the replacement named.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', '.'];
const BANNED = [
  {
    re: /\bAbortSignal\s*\.\s*timeout\s*\(/,
    why: 'React Native does not implement the AbortSignal.timeout static',
    use: 'new AbortController() + setTimeout(() => c.abort(), ms)',
  },
  {
    re: /\bstructuredClone\s*\(/,
    why: 'not in Hermes',
    use: 'JSON round-trip, or an explicit copy',
  },
  {
    re: /\bIntl\s*\.\s*(RelativeTimeFormat|ListFormat|Segmenter)\b/,
    why: 'absent from the default Hermes Intl build',
    use: 'format it yourself',
  },
  {
    re: /\bFinalizationRegistry\b|\bWeakRef\b/,
    why: 'not in Hermes',
    use: 'explicit lifecycle handling',
  },
  {
    re: /\blocalStorage\b|\bsessionStorage\b/,
    why: 'web-only; there is no DOM on the handset',
    use: 'react-native-fs, or WatermelonDB for anything structured',
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'android' || name === 'ios'
        || name === 'native' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

// Comments legitimately NAME these APIs when explaining why they are banned.
// Stripping first keeps the guard from firing on its own rationale.
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const files = [...new Set(ROOTS.flatMap((r) =>
  statSync(r).isDirectory() ? walk(r) : [r]))]
  .filter((f) => !f.includes('verify_runtime'));

let failures = 0;
for (const file of files) {
  const src = strip(readFileSync(file, 'utf8'));
  for (const rule of BANNED) {
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!rule.re.test(line)) return;
      failures += 1;
      console.log(`  FAIL ${file}:${i + 1}`);
      console.log(`       ${line.trim()}`);
      console.log(`       ${rule.why} -- use ${rule.use}`);
    });
  }
}

console.log(`\n${files.length} files scanned, ${failures} banned runtime call(s)`);
if (failures) process.exit(1);
console.log('no web/Node-only globals reach the handset');
