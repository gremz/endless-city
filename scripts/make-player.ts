// Rebuild the player character from the SWAT source: `npm run models:player [source.glb]`.
import { readFileSync, writeFileSync } from 'node:fs';
import { PLAYER_FILE } from '../src/render/characters/characterSpec';
import { buildSwatCharacter } from '../src/devtools/swatCharacter';

const src = process.argv[2] ?? 'art/characters/swat.glb';
const out = `public/${PLAYER_FILE}`;
const bytes = buildSwatCharacter(new Uint8Array(readFileSync(src)));
writeFileSync(out, bytes);
console.log(`wrote ${out} from ${src} (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
