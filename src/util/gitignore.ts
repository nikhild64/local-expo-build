import fs from 'fs';
import path from 'path';
import { log } from './log';

export function ensureGitignoreEntries(cwd: string, entries: string[]): void {
  const p = path.join(cwd, '.gitignore');
  let content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const lines = new Set(content.split(/\r?\n/).map((l) => l.trim()));
  const toAdd = entries.filter((e) => !lines.has(e));
  if (!toAdd.length) return;
  if (content.length && !content.endsWith('\n')) content += '\n';
  content += '\n# local-expo-build\n' + toAdd.join('\n') + '\n';
  fs.writeFileSync(p, content, 'utf8');
  log.ok(`.gitignore: added ${toAdd.join(', ')}`);
}
