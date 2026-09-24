# Endless City

A browser first-person shooter with Counter-Strike movement and gunplay, set in an endless,
procedurally generated city. Clear bot squads to earn money, buy better guns, and push further
from spawn, where the bots get sharper. Play alone or co-op with up to three friends.

Built with Vite, TypeScript and three.js. It uses no art or audio assets: textures, gun models,
sounds and music are all generated in code.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also reachable from Windows when running in WSL)
npm run test:run   # unit tests (movement, weapons, cars, generation, nav, bots, co-op networking, boundaries)
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
| `?time=22` | Fix the hour of day (0–24) instead of running the day/night cycle |
| `?weather=rain` | Fix the weather: `clear`, `overcast`, `rain`, `fog` or `storm` |
| `?join=CODE` | Join a co-op game (this is what invite links are) |
| `?netsim=120,5` | Co-op testing: simulate a 120 ms round trip with 5% packet loss on your connection |
| `?peerdebug=3` | Log WebRTC signalling (PeerJS) to the console |

`/gen.html?seed=…` shows a top-down map of the generator output: layouts, nav reachability,
spawn slots and perches.

## Controls

WASD to move, mouse to aim and shoot, right mouse to scope. Space jumps, C crouches (Ctrl
also works in fullscreen), and Shift walks silently. R reloads. 1/2/3 select weapons and 4 selects grenades (press 4 again to cycle types), Q
switches to the last weapon, and the mouse wheel cycles. F inspects the weapon. B opens the
buy menu, which works only in the spawn area or areas you have cleared. The Ammo category
refills your reserve at a per-magazine price; `,` and `.` buy primary and secondary ammo
without opening the menu. Red-cross health packs lie around the city (and bots sometimes drop one): walk over one to
carry it (up to 3), and press H to use it for +50 HP. Using one takes a second and lowers your
gun; H again or firing cancels and keeps the pack. The radar in the top-left corner shows buy zones in green, with a
`$` on its rim pointing to the nearest one when it's out of range. M opens the city map.
L toggles your flashlight. E gets in and out of a car (see [Cars](#cars)). Esc pauses. F3
toggles the debug overlay.

## Grenades

The buy menu has a Grenades category: HE ($300), flashbang ($200), smoke ($300) and molotov
($400). You can carry one of each, except flashbangs (two), and four in total. Hold the left
mouse button to pull the pin and release to throw. The right button lobs the grenade
underhand, and both buttons together throw it at medium strength.

- **HE** explodes after 1.6 s and does up to 98 damage. The damage falls off with distance
  and walls block it.
- **Flashbang** blinds anyone who can see it. The effect lasts longest if you're looking at
  it and close to it. Blinded bots stop shooting and back off, and a flashbang that blinds you
  also muffles your hearing.
- **Smoke** pops once the grenade stops rolling and lasts 18 s. Bots can't see or shoot
  through it, but bullets still pass through.
- **Molotov** bursts into fire on the first floor it hits. The fire burns for 7 s and armor
  doesn't protect against it. Bots walk around fire, and a smoke puts it out.

Bots from difficulty level 3 up carry grenades. Level 5 and up adds flashbangs and level 7 up
adds molotovs. A bot throws a grenade when you break line of sight nearby, and uses a molotov
if you hold one spot too long. Grenades go into your death stash with the rest of your gear,
and dead bots drop theirs.

## Cars

Some of the parked cars still run. A driveable car is intact and clean, with shiny glass and
working lights. Every other car in the city is an obvious wreck: it sits on flat tires, its
windows are smashed black, its paint is faded and rusting, and its lights are dead. Walk up to
a driveable car and the prompt shows **E Drive**, and the radar marks driveable cars with a
small yellow car. The spawn plaza always has one waiting on the road behind you.

- **Driving.** E gets in and out. W accelerates, S brakes and then reverses, A/D steer, and
  Space is the handbrake (use it to slide the back end round). The camera follows behind the
  car; move the mouse to look around, and it swings back behind you once you drive on. You can
  only get out below about 20 km/h, and you get out on the driver's side if there's room.
- **Combat.** Driving into a bot at speed knocks it down and can kill it, and the kill pays like
  an SMG kill. Teammates only get pushed aside. Your guns are put away while you drive. Bots can
  still see and shoot you through the windows, and the body blocks their shots.
- **Damage.** Bullets, HE grenades and hard crashes damage a car. It starts smoking when it's
  badly hurt. If it's destroyed it blows up, throws you out and burns for a while, and the burnt
  shell can't be driven again.
- **Where they stay.** A car you've driven stays where you leave it, even after you move away
  and come back, and it's kept in your save. You can't save while you're in a car.
- At night the car you drive has headlights.

## Day, night and weather

A full day lasts 24 minutes, and a new game starts at 09:00. Night falls around 21:00. At
night bots see about half as far, less when you stand under a street lamp. Turning on your
flashlight lets you see, but bots spot you easily. Kills after dark pay 25% more. Bots out
hunting carry flashlights, which gives them away too.

The weather changes every few minutes and is seeded, so the same seed always has the same
forecast. It can be clear, overcast, rain, fog or a thunderstorm. Rain covers the sound of
your footsteps, and fog cuts everyone's view. The radar shows the time and the weather.
Settings can fix the time of day, turn the weather off and lower the number of rain particles.

## Loot, the city map and saving

- **Drops.** Dead bots drop their guns, with whatever ammo was left in them, and they stay on
  the ground for 60 s. Walk over a gun to take it if that slot is empty, or to take its ammo if
  it's the gun you already carry. For a different gun, press E to swap: the one in your hand
  goes on the ground.
- **Corpse run.** When you die, your guns, ammo and medkits stay where you fell until you pick
  them up. A light beam marks the spot, and so does a bag icon on the radar (pinned to the rim
  when it's out of range) and on the map. If you die again before you get back to it, that
  older pile is lost.
- **City map (M).** Pauses the game and shows the city around you. Blocks you've explored are
  drawn in detail, and the rest are coloured by district (Old Town, Downtown, Industrial). The
  map also shows:
  - danger rings for each difficulty level
  - buy zones and cleared areas
  - hostile areas you've come across
  - spawn and your dropped gear

  Drag to pan, scroll to zoom, C recenters, and M or Esc goes back to the game.
- **Saving.** There is one save slot in localStorage, and it only exists in the city world. The
  game autosaves after you clear an area, once the fight is over. You can also press "Save
  game" in the pause menu, but not while you're dead or fighting. "Continue" on the title
  screen and "Load save" in the pause menu rebuild the saved world. A save keeps:
  - your position and loadout
  - money and cleared areas
  - encounter progress
  - dropped items and health-pack timers
  - the explored map

  A squad that was fighting you when you saved comes back later with just its survivors, at
  their spawn points.

## Co-op

Up to four players can clear the city together. There's no server to run: one player hosts in
their browser and friends join with a room code.

- **Hosting.** On the title screen, enter a name and press **Host co-op game** (or **Host from
  save** to continue your saved city). You get a six-letter room code and a **Copy invite link**
  button in the pause menu. The host's time-of-day and weather settings apply to everyone.
- **Joining.** Enter the code and press **Join**, or open the invite link. You spawn at the
  buy zone nearest to a teammate.
- **Playing together.** Cleared areas and buy zones are shared, and every player gets the clear
  bonus. Kill rewards go to whoever made the kill, and each player has their own money and
  loadout. There's no friendly fire. Squads get one extra bot for each player after the first
  (up to two). Bots go after whoever they see, or whoever shot them. When everyone is down,
  squads heal and forget you, as in solo play. Teammates appear in blue, with names and health
  bars over their heads, and on the radar and the city map.
- **Keys.** Enter opens the chat. Hold Tab for the scoreboard (kills, deaths, money).
- **Saving.** Only the host can save a co-op game (pause menu, and automatically after clears).
  The save keeps the shared progress and the host's own position and gear. Guests start fresh
  each session.
- **Leaving.** If a guest leaves, the gear they dropped when they died goes too. If the host
  ends the game, everyone returns to the title screen, because the game runs on the host's
  machine.

It all goes through WebRTC. The free PeerJS broker only introduces players to each other, and
its default STUN/TURN servers get most home networks connected. The debug overlay (F3) shows
round-trip time, traffic and prediction corrections.

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
  audio. The background music is generative: an ambient pad and arpeggio, with a soft pulse
  that fades in while you're fighting. It has its own volume slider in Settings.
- **Networking** (`src/net`): the host's authoritative game (`ServerGame`) runs the same
  simulation, bots and pickups in a Web Worker, so it keeps full speed when the host's tab is in
  the background. Every player, the host included, connects to it as a client: the host
  through a `MessageChannel`, friends over WebRTC, with PeerJS for signalling. Only inputs,
  snapshots and events go over the wire. The city is regenerated from the seed on every machine.
  - **Channels.** Commands (with the last few repeated) and 32 Hz binary snapshots use an
    unreliable, unordered data channel. Events, pickups, progress and chat use a reliable one.
  - **Prediction.** Each client predicts its own movement and weapon with the same code and
    replays unacknowledged commands on every snapshot. Deterministic movement means
    corrections are rare.
  - **Interpolation.** Everyone else is drawn 100 ms in the past, interpolated between
    snapshots.
  - **Lag compensation.** The host checks a player's shots against where that player saw their
    targets, up to 250 ms back.
  - **Tests.** `src/net/net.test.ts` runs a host with several clients in one process. It covers
    packet loss and reordering, prediction accuracy, lag compensation, buying, clears, chat,
    driving and saves.
- **Cars** (`src/sim/vehicle`): driveable cars are generated as spawn points instead of brushes.
  Their physics (`carPhysics.ts`) is an arcade bicycle model with lateral grip. It moves three
  box hulls against the world with a slide move, and four wheel rays set the ride height and
  tilt. It's deterministic, so a driver's client predicts their car like it predicts walking.
  Each car puts four moving boxes into the collision world: the body blocks movement and
  bullets, and the cabin above the beltline blocks only movement, so shots reach the driver
  through the windows. On screen, a car uses the same brush-built model as the wrecks.
