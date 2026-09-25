// Validate character .glb files against the spec: `npm run models:check [file...]`.
import { existsSync, readFileSync } from 'node:fs';
import { BOT_MODELS, PLACEHOLDER_FILE, PLAYER_FILE } from '../src/render/characters/characterSpec';
import { formatReport, inspectCharacter } from '../src/render/characters/glbInspect';

const args = process.argv.slice(2);
const files = args.length ? args : [PLAYER_FILE, ...BOT_MODELS.map((m) => m.file)].map((f) => `public/${f}`);
let failed = false;
for (const file of files) {
  if (!existsSync(file)) {
    console.log(`${file}: not found. Export your character there (see art/characters/README.md).`);
    if (!args.length) console.log(`The generated stand-in can be checked with: npm run models:check public/${PLACEHOLDER_FILE}`);
    failed = true;
    continue;
  }
  const report = inspectCharacter(new Uint8Array(readFileSync(file)));
  console.log(formatReport(file, report));
  if (report.errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
