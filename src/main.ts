import { parseParams } from './core/urlParams';
import { Game } from './game/Game';
import './ui/ui.css';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const ui = document.querySelector<HTMLDivElement>('#ui')!;

const params = parseParams(location.search, (Math.random() * 2 ** 32) >>> 0);
const game = new Game(canvas, ui, params);
game.start();

if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;

import.meta.hot?.dispose(() => game.dispose());
