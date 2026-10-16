import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Build the in-app notice from the same VERSION and CHANGELOG users receive. */
export function releaseInfo(root) {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Toolkit VERSION');
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replaceAll('\r\n', '\n');
  const block = changelog.split(/\n(?=## \[)/).find(part => part.startsWith(`## [${version}]`));
  if (!block) throw new Error(`CHANGELOG is missing ${version}`);
  const sections = [];
  for (const line of block.split('\n').slice(1)) {
    if (line.startsWith('### ')) sections.push({ title: line.slice(4).trim(), items: [] });
    else if (line.startsWith('- ')) {
      if (!sections.length) sections.push({ title: '本次更新', items: [] });
      sections.at(-1).items.push(line.slice(2).replaceAll('**', '').replaceAll('`', '').trim());
    }
  }
  if (!sections.some(section => section.items.length)) throw new Error('Release notes must contain changes');
  return { version, date: / - (\d{4}-\d{2}-\d{2})/.exec(block.split('\n')[0])?.[1] || '', sections };
}
