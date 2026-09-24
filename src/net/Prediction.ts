import { copyCmd, type UserCmd } from '../input/UserCmd';
import { storePrev, type Actor } from '../sim/Actor';
import type { Simulation } from '../sim/Simulation';
import { storeVehiclePrev } from '../sim/vehicle/Vehicle';
import type { SeqCmd } from './protocol';

/** Unacknowledged commands kept for replay (2 s at 64 Hz). */
const MAX_PENDING = 128;

/**
 * Client-side prediction for the local player: every command runs immediately through the same
 * movement and weapon code the host uses. When the host's state for an acknowledged command
 * arrives, the player is reset to it and the commands the host hasn't run yet are replayed.
 * Movement is deterministic, so replays land where the prediction did unless something only
 * the host knows about (a bump, a hit, a pickup) happened.
 */
export class Prediction {
  private pending: SeqCmd[] = [];
  /** Replays that moved the player (debug overlay). */
  corrections = 0;
  /** Size of the last correction in metres. */
  lastError = 0;
  /**
   * Predict only while the ground around the player has loaded here (else the player would
   * fall through the missing world); until then the host's position is shown as it comes.
   */
  active = true;

  constructor(
    private sim: Simulation,
    private me: Actor,
  ) {}

  /** Run a new local command now (the client's clock moves one tick ahead). */
  predict(seq: number, cmd: UserCmd): void {
    this.pending.push({ seq, cmd: copyCmd(cmd) });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    const sim = this.sim;
    sim.tick++;
    sim.time += sim.dt;
    storePrev(this.me);
    const car = sim.vehicleOf(this.me);
    if (car) storeVehiclePrev(car);
    this.run(cmd);
  }

  /**
   * The mirror just applied the host's state for our player as of command `ackSeq` at host
   * time `time`: replay what the host hasn't run yet, silently.
   */
  reconcile(ackSeq: number, tick: number, time: number, predictedX: number, predictedY: number, predictedZ: number): void {
    const sim = this.sim;
    const me = this.me;
    while (this.pending.length && this.pending[0].seq <= ackSeq) this.pending.shift();
    sim.tick = tick;
    sim.time = time;
    sim.events.muted = true;
    for (const p of this.pending) {
      sim.tick++;
      sim.time += sim.dt;
      this.run(p.cmd);
    }
    sim.events.muted = false;
    // Shift the interpolation start by the same amount so a correction doesn't smear.
    const m = me.move.pos;
    const dx = m.x - predictedX;
    const dy = m.y - predictedY;
    const dz = m.z - predictedZ;
    this.lastError = Math.hypot(dx, dy, dz);
    if (this.lastError > 1e-3) {
      if (this.active) this.corrections++;
      me.prevPos.x += dx;
      me.prevPos.y += dy;
      me.prevPos.z += dz;
      const car = sim.vehicleOf(me);
      if (car) {
        car.prevPos.x += dx;
        car.prevPos.y += dy;
        car.prevPos.z += dz;
      }
    }
  }

  private run(cmd: UserCmd): void {
    if (!this.me.alive || !this.active) return;
    const sim = this.sim;
    sim.predicting = true;
    sim.runCmd(this.me, cmd, false);
    sim.predicting = false;
  }
}
