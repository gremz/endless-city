// Regenerate the stand-in character: `npm run models:placeholder`.
import { writeFileSync } from 'node:fs';
import { PLACEHOLDER_FILE } from '../src/render/characters/characterSpec';
import { buildPlaceholderCharacter } from '../src/devtools/placeholderCharacter';

const out = `public/${PLACEHOLDER_FILE}`;
const bytes = buildPlaceholderCharacter();
writeFileSync(out, bytes);
console.log(`wrote ${out} (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
