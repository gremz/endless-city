import type { GameParams } from '../core/urlParams';
import type { UserCmd } from '../input/UserCmd';
import { CollisionWorld } from '../physics/CollisionWorld';
import { playerMove } from '../player/pmove';
import { makeActor, storePrev, Team, type Actor } from './Actor';

export interface SimOptions {
  autoBhop: boolean;
}

/** Headless game simulation: owns collision, actors and game rules. Never touches the DOM or three.js. */
export class Simulation {
  readonly world = new CollisionWorld();
  readonly player: Actor;
  readonly actors: Actor[] = [];
  tick = 0;
  time = 0;
  paused = false;
  private nextActorId = 1;

  constructor(
    readonly params: GameParams,
    public opts: SimOptions,
    readonly dt: number,
  ) {
    this.player = makeActor(this.nextActorId++, 'You', Team.Player, 0, 0, 0);
    this.actors.push(this.player);
  }

  step(cmd: UserCmd): void {
    this.tick++;
    this.time += this.dt;
    for (const a of this.actors) storePrev(a);

    const p = this.player;
    p.yaw = cmd.yaw;
    p.pitch = cmd.pitch;
    if (p.alive) playerMove(p.move, cmd, this.world, this.dt, { autoBhop: this.opts.autoBhop });
  }
}
