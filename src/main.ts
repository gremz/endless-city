import { loadSettings } from './core/settings';
import { parseParams, type GameParams } from './core/urlParams';
import { Game, type OnlineGame } from './game/Game';
import { NetClient } from './net/NetClient';
import type { NetParams } from './net/protocol';
import { HostSession, joinSession, parseCode } from './net/Session';
import { NetSimTransport, netSimFromUrl } from './net/NetSim';
import type { Transport } from './net/Transport';
import { loadSave, writeSave } from './core/saveStorage';
import { paramsFromSave, type SaveData } from './sim/save';
import { savedName } from './ui/Menus';
import './ui/ui.css';

let canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const ui = document.querySelector<HTMLDivElement>('#ui')!;

const params = parseParams(location.search, (Math.random() * 2 ** 32) >>> 0);
let game: Game | null = null;
/** The co-op session behind the current game (hosting or joined), if any. */
let session: { close(): void } | null = null;
let connecting = false;

function boot(p: GameParams, save: SaveData | null, online: OnlineGame | null = null): Game {
  if (game) {
    game.dispose();
    // A fresh canvas gets a fresh WebGL context instead of inheriting the old renderer's state.
    const fresh = canvas.cloneNode() as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    canvas = fresh;
  }
  game = new Game(
    canvas,
    ui,
    p,
    save,
    {
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
      host: (name, fromSave) => void host(name, fromSave),
      join: (code, name) => void join(code, name),
    },
    online,
  );
  game.start();
  if (import.meta.env.DEV) (window as unknown as { game: Game | null }).game = game;
  return game;
}

/** Back to a solo game on the title screen, saying why. */
function leaveOnline(reason?: string): void {
  session?.close();
  session = null;
  const q = new URLSearchParams(location.search);
  if (q.has('join')) {
    q.delete('join');
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  }
  boot(params, null).setMenuStatus(reason && reason !== 'closed' ? reason : '');
}

/** `?netsim=rtt,loss` wraps our connection in a simulated bad network (testing). */
const netsim = netSimFromUrl(location.search);
function simulated(t: Transport): Transport {
  return netsim ? new NetSimTransport(t, netsim.rtt, netsim.loss) : t;
}

/** A client's world settings: the host's city, our own local flags (debug...). */
function onlineParams(n: NetParams): GameParams {
  return { ...params, ...n, god: false };
}

async function host(name: string, fromSave: boolean): Promise<void> {
  if (connecting) return;
  const save = fromSave ? loadSave() : null;
  if (fromSave && !save) {
    game?.setMenuStatus('The save could not be read.');
    return;
  }
  connecting = true;
  game?.setMenuStatus('Opening a room…', true);
  // Time-of-day and weather settings apply to the whole game when you host.
  const s = loadSettings();
  const base = save ? paramsFromSave(save, params) : params;
  const hostParams: GameParams = {
    ...base,
    world: 'city',
    god: false,
    hour: params.hour ?? (s.timeOfDay === 'day' ? 13 : s.timeOfDay === 'night' ? 0.5 : null),
    weather: params.weather ?? (s.weather === 'clear' ? 'clear' : null),
  };
  const hs = new HostSession(hostParams, save);
  try {
    const code = await hs.open();
    const net = new NetClient(simulated(hs.localTransport()), name, s.autoBhop);
    const w = await net.welcome();
    session = hs;
    boot(onlineParams(w.params), save, {
      net,
      code,
      host: true,
      leave: (reason) => leaveOnline(reason === 'closed' ? '' : reason),
      save: async (explored, manual) => {
        try {
          const data = await hs.requestSave(explored, manual);
          return writeSave(data) ? null : 'Could not write the save (storage blocked or full).';
        } catch (err) {
          return (err as Error).message;
        }
      },
    });
    hs.onStatus = (text) => game?.setMenuStatus(text);
  } catch (err) {
    hs.close();
    game?.setMenuStatus(`Could not host: ${(err as Error).message}`, false);
  } finally {
    connecting = false;
  }
}

async function join(input: string, name: string): Promise<void> {
  if (connecting) return;
  const code = parseCode(input);
  if (!code) {
    game?.setMenuStatus('Enter the 6-character room code (or paste the invite link).');
    return;
  }
  connecting = true;
  game?.setMenuStatus(`Connecting to ${code}…`, true);
  try {
    const link = await joinSession(code);
    const net = new NetClient(simulated(link.transport), name, loadSettings().autoBhop);
    try {
      const w = await net.welcome();
      session = link;
      boot(onlineParams(w.params), null, {
        net,
        code,
        host: false,
        leave: (reason) => leaveOnline(reason === 'closed' ? '' : (reason ?? '')),
      });
    } catch (err) {
      link.close();
      throw err;
    }
  } catch (err) {
    game?.setMenuStatus((err as Error).message, false);
  } finally {
    connecting = false;
  }
}

boot(params, null);

// Invite links (?join=CODE) connect straight away.
const invite = new URLSearchParams(location.search).get('join');
if (invite) void join(invite, savedName() || 'Player');

window.addEventListener('pagehide', () => session?.close());
import.meta.hot?.dispose(() => {
  session?.close();
  game?.dispose();
});
