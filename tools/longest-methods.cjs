/* eslint-disable no-console */
const fs = require('node:fs');

const filePath = process.argv[2] ?? 'src/reolink/baichuan/ReolinkBaichuanApi.ts';
const limit = Number.parseInt(process.argv[3] ?? '25', 10) || 25;

const src = fs.readFileSync(filePath, 'utf8');
const lines = src.split(/\r?\n/);

const classIdx = lines.findIndex((l) => l.includes('export class ReolinkBaichuanApi'));
if (classIdx < 0) {
  console.error('class not found');
  process.exit(1);
}

const starts = [];
for (let i = classIdx; i < lines.length; i++) {
  const line = lines[i];
  if (!line.startsWith('  ')) continue;
  if (line.startsWith('  readonly ')) continue;
  if (line.startsWith('  private ') && !line.includes('(')) continue;

  // Rough match for method implementation headers (opening brace on same line).
  const m = line.match(
    /^  (?:public |private |protected )?(?:static )?(?:async )?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*:\s*[^=]*\{\s*$/,
  );
  const m2 = line.match(/^  (?:public |private |protected )?(?:static )?(?:async )?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{\s*$/);
  if (m || m2) starts.push({ name: (m || m2)[1], line: i });
}

const findEnd = (startLine) => {
  let depth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    const s = lines[i];
    for (let j = 0; j < s.length; j++) {
      const ch = s[j];
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    if (started && depth === 0) return i;
  }
  return lines.length - 1;
};

const methods = starts
  .map((s) => {
    const end = findEnd(s.line);
    return { name: s.name, start: s.line + 1, end: end + 1, lines: end - s.line + 1 };
  })
  .sort((a, b) => b.lines - a.lines);

console.log(`File: ${filePath}`);
console.log(`Methods found: ${methods.length}`);
console.log(`Top ${Math.min(limit, methods.length)}:`);
methods.slice(0, limit).forEach((m, idx) => {
  console.log(`${String(idx + 1).padStart(2, ' ')} ${String(m.lines).padStart(4, ' ')}  ${m.name}  (L${m.start}-L${m.end})`);
});
