export const Buttons = {
  ATTACK: 1,
  ATTACK2: 2,
  JUMP: 4,
  DUCK: 8,
  WALK: 16,
  RELOAD: 32,
  USE: 64,
  INSPECT: 128,
  BUY: 256,
} as const;

/** One tick of input, produced by the local player's Input or by a bot brain. */
export interface UserCmd {
  /** View angles in radians. */
  yaw: number;
  pitch: number;
  /** -1..1 */
  forward: number;
  /** -1..1, positive = right */
  side: number;
  buttons: number;
  /** Buttons that went down since the previous cmd (edge-triggered actions). */
  pressed: number;
  /** View angles at the moment ATTACK went down (sub-tick first shot). */
  attackYaw: number;
  attackPitch: number;
  /** Weapon slot/selection request, or -1. */
  weaponSelect: number;
}

export function makeCmd(): UserCmd {
  return {
    yaw: 0,
    pitch: 0,
    forward: 0,
    side: 0,
    buttons: 0,
    pressed: 0,
    attackYaw: 0,
    attackPitch: 0,
    weaponSelect: -1,
  };
}

export function clearCmd(c: UserCmd): UserCmd {
  c.forward = 0;
  c.side = 0;
  c.buttons = 0;
  c.pressed = 0;
  c.weaponSelect = -1;
  return c;
}
