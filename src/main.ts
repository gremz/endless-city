import { parseParams, type GameParams } from './core/urlParams';
import { Game } from './game/Game';
import { paramsFromSave, type SaveData } from './sim/save';
import './ui/ui.css';

let canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const ui = document.querySelector<HTMLDivElement>('#ui')!;

const params = parseParams(location.search, (Math.random() * 2 ** 32) >>> 0);
let game: Game | null = null;

function boot(p: GameParams, save: SaveData | null): void {
  if (game) {
    game.dispose();
    // A fresh canvas gets a fresh WebGL context instead of inheriting the old renderer's state.
    const fresh = canvas.cloneNode() as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    canvas = fresh;
  }
  game = new Game(canvas, ui, p, save, {
    loadSave: (s) => {
      // Point the URL at the saved world so a reload regenerates the same city.
      const q = new URLSearchParams(location.search);
      q.set('seed', s.seedText);
      q.delete('world');
      if (s.spawnCx || s.spawnCz) q.set('spawn', `${s.spawnCx},${s.spawnCz}`);
      else q.delete('spawn');
      if (s.level >= 0) q.set('level', String(s.level));
      else q.delete('level');
      history.replaceState(null, '', `${location.pathname}?${q}`);
      boot(paramsFromSave(s, params), s);
    },
  });
  game.start();
  if (import.meta.env.DEV) (window as unknown as { game: Game | null }).game = game;
}

boot(params, null);

import.meta.hot?.dispose(() => game?.dispose());
