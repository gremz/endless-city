// Rebuild the bot characters from their static sources: `npm run models:bots`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BOT_MODELS } from '../src/render/characters/characterSpec';
import { buildBotCharacter } from '../src/devtools/botCharacters';

mkdirSync('public/models/characters/bots', { recursive: true });
for (const m of BOT_MODELS) {
  const src = `art/characters/bots/${m.source}.glb`;
  const out = `public/${m.file}`;
  const bytes = buildBotCharacter(new Uint8Array(readFileSync(src)), m.source);
  writeFileSync(out, bytes);
  console.log(`wrote ${out} from ${src} (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
}
