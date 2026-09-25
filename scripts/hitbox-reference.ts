// Write the Blender modelling reference: `npm run models:reference`.
import { writeFileSync } from 'node:fs';
import { hitboxReferenceObj } from '../src/devtools/hitboxReference';

const out = 'art/characters/hitbox_reference.obj';
writeFileSync(out, hitboxReferenceObj());
console.log(`wrote ${out}: import it in Blender (File > Import > Wavefront, default axes)`);
