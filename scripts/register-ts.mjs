// Lets `node --import ./scripts/register-ts.mjs script.ts` load the game's TypeScript: Node strips
// the types itself, this only adds the `.ts` the source's extensionless imports leave out.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});
