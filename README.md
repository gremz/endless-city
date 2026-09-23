# Endless City

A browser first-person shooter with Counter-Strike movement and gunplay, set in an endless,
procedurally generated city. Clear bot squads to earn money, buy better guns, and push further
from spawn, where the bots get sharper.

Built with Vite, TypeScript and three.js. It uses no art or audio assets: textures, gun models
and sounds are all generated in code.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also reachable from Windows when running in WSL)
npm run test:run   # unit tests (movement, weapons, generation, nav, bots, boundaries)
npm run build      # type-check + production build to dist/
```

If `localhost` doesn't reach WSL from Windows, use the Network URL that Vite prints.

### URL parameters

| Parameter | Effect |
|---|---|
| `?seed=1337` | World seed (numbers or any text); the same seed always builds the same city |
| `?debug=1` | Debug overlay on; enables noclip (F9) and slow motion (F10) |
| `?world=gym` / `?world=range` | Movement test course / shooting range with target dummies |
| `?level=N` | Force bot difficulty 0–10 everywhere |
| `?nobots=1`, `?god=1` | No encounters / invulnerable |
| `?spawn=cx,cz` | Spawn in another chunk |
| `?tick=16` | Simulation tick rate (default 64), for checking interpolation |

`/gen.html?seed=…` shows a top-down map of the generator output: layouts, nav reachability,
spawn slots and perches.

## Controls

WASD to move, mouse to aim and shoot, right mouse to scope. Space jumps, C crouches (Ctrl
also works in fullscreen), and Shift walks silently. R reloads. 1/2/3 select weapons, Q
switches to the last weapon, and the mouse wheel cycles. F inspects the weapon. B opens the
buy menu, which works only in the spawn area or areas you have cleared. Esc pauses. F3 toggles
the debug overlay.

## How it works

- **Simulation** (`src/sim`, `src/physics`, `src/player`, `src/weapons`, `src/ai`): the
  simulation is headless and deterministic and runs at a fixed 64 Hz tick. Movement is
  Source-style: swept AABB hull against convex brushes, ground and air acceleration with
  strafe-jumping, step/slide moves, and crouch-jumping. Gunplay follows CS: inaccuracy model,
  spray patterns, hitboxes, armor and penetration. Bots produce the same `UserCmd` input as the
  player. None of this code imports three.js or touches the DOM; `src/boundaries.test.ts`
  enforces that.
- **World** (`src/world`): 64 m chunks are generated purely from `(seed, cx, cz)` in web
  workers. Each chunk gets streets, districts, terraces, buildings, courtyards and props. It is
  baked into brushes, per-material meshes, and a 0.5 m nav grid with cover and reachability.
  Chunks stream in around the player.
- **Presentation** (`src/render`, `src/ui`, `src/audio`, `src/game`) reads simulation state and
  events to draw the world, the viewmodel, effects and HUD, and to play synthesized positional
  audio.
