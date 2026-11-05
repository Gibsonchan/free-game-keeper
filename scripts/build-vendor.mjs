import { stripTypeScriptTypes } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('../vendor/freekeep/steam.ts', import.meta.url), 'utf8');
const js = stripTypeScriptTypes(source, { mode: 'transform' });
await writeFile(new URL('../vendor/freekeep/steam.mjs', import.meta.url),
  '// Derived from FreeKeep for Steam, Copyright (c) 2026 SmailDot. MIT; see LICENSE in this directory.\n' + js);
