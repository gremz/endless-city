# Endless City

A browser first-person shooter with Counter-Strike movement and gunplay, set in an endless,
procedurally generated city. Clear bot squads to earn money, buy better guns, and push further
from spawn, where the bots get sharper. Play alone or co-op with up to three friends.

Built with Vite, TypeScript and three.js. Textures, gun models, sounds and music are all
generated in code. The only recorded audio is the voice lines, made in ElevenLabs (see
[Voice lines](#voice-lines)).

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (also reachable from Windows when running in WSL)
npm run test:run   # unit tests (movement, weapons, cars, generation, nav, bots, co-op networking, characters, boundaries)
npm run build      # type-check + production build to dist/
```

If `localhost` doesn't reach WSL from Windows, use the Network URL that Vite prints.

To reach the dev server through a tunnel, name the tunnel's hostname when starting it:
`ALLOWED_HOSTS=abc.free.pinggy.net npm run dev` (comma-separate several). The dev server isn't
hardened for the open internet; for anything longer-lived, share a `npm run build` instead.

### URL parameters

| Parameter | Effect |
|---|---|
| `?seed=1337` | World seed (numbers or any text); the same seed always builds the same city |
| `?debug=1` | Debug overlay on; enables noclip (F9) and slow motion (F10) |
| `?world=gym` / `?world=range` | Movement test course / shooting range with target dummies |
| `?level=N` | Force bot difficulty 0–10 everywhere |
| `?nobots=1`, `?god=1` | No encounters / invulnerable |
| `?peds=0` | Pedestrian density, 0–2 (overrides the Pedestrians setting) |
| `?spawn=cx,cz` | Spawn in another chunk |
| `?tick=16` | Simulation tick rate (default 64), for checking interpolation |
| `?time=22` | Fix the hour of day (0–24) instead of running the day/night cycle |
| `?weather=rain` | Fix the weather: `clear`, `overcast`, `rain`, `fog` or `storm` |
| `?join=CODE` | Join a co-op game (this is what invite links are) |
| `?netsim=120,5` | Co-op testing: simulate a 120 ms round trip with 5% packet loss on your connection |
| `?peerdebug=3` | Log WebRTC signalling (PeerJS) to the console |
| `?charmodel=placeholder` | Character model to draw bots with: `placeholder` (the generated stand-in), `none` (box figures) or a `.glb` path |

`/gen.html?seed=…` shows a top-down map of the generator output: layouts, nav reachability,
spawn slots and perches. Where a column has several floors, the floor picker chooses which
one the nav overlay shows (top, ground, or upper floors only).

`/models.html` previews a character model the way the game drives it (see
[Character models](#character-models)).

## Controls

WASD to move, mouse to aim and shoot, right mouse to scope. Space jumps (hold it at a ledge to climb up), C crouches (Ctrl
also works in fullscreen), and Shift walks silently. R reloads. 1/2/3 select weapons and 4 selects grenades (press 4 again to cycle types), Q
switches to the last weapon, and the mouse wheel cycles. F inspects the weapon. B opens the
buy menu, which works only in the spawn area or areas you have cleared. The Ammo category
refills your reserve at a per-magazine price; `,` and `.` buy primary and secondary ammo
without opening the menu. Red-cross health packs lie around the city (and bots sometimes drop one): walk over one to
carry it (up to 3), and press H to use it for +50 HP. Using one takes a second and lowers your
gun; H again or firing cancels and keeps the pack. The radar in the top-left corner shows buy zones in green, with a
`$` on its rim pointing to the nearest one when it's out of range. M opens the city map.
L toggles your flashlight. E gets in and out of a car (see [Cars](#cars)) and opens doors, and held on a
bricked-up doorway it plants a breaching charge (see [Breaching walls](#breaching-walls)). Esc pauses. F3
toggles the debug overlay.

## The opening and objectives

A new game drops you on the spawn plaza facing north. The block beyond the fountain is the only
area near spawn with bots: two barely trained gang members stand in plain view 40–55 m away,
looking the other way. One has an MP9, which stays on the ground until someone takes it; the
other only has a knife and charges you with it.

A panel under the compass says what to do next, with a gold waypoint on screen (an arrow on
the edge when it's off screen) and a diamond on the radar. Each new objective first appears
large in the middle of the screen with a chime, then moves up into place. A new game walks you
through these steps:

1. **Clear the pair ahead.** Shift walks quietly.
2. **Grab the MP9 and draw it.**
3. **Take a car.** The waypoint points at the nearest one that runs.
4. **Drive to the next area and clear it.**
5. **Upgrade.** Once the fight there is over, if you can afford something better you're told
   what (a rifle, Kevlar or a helmet), and the buy menu marks it.

6. **How the city works.** Once you're out of combat, five short cards follow one another, about
   8 seconds each: clearing areas (buy zones and respawn points), danger levels, dying and your
   dropped gear, night, and the city map and autosaves. They pause during a fight.

After that the panel goes away for good. The "Press B to buy" hint still names the best upgrade
you can afford, and the radar and compass still show nearby areas.

A step with nothing to point at is skipped. Tips appear once, the first time you reach a door, a
locked door and a ladder. Your progress through these steps is kept in your save. Settings →
Gameplay → "Objectives, waypoint and tips" turns all of this off.

## Climbing and rooftops

Most roofs in the city can be reached, and fights spill onto them.

- **Ladders.** Walk into a ladder to climb it. Look up or level to go up, look down to go
  down, and jump to kick off it. At the top, keep walking forward to step onto the roof. Rungs
  clank, so others can hear you climb.
- **Mantling.** Hold Space while jumping at a wall or ledge up to about 2.2 m high (a bit
  more than a crouch-jump clears) and you pull yourself up. Your gun is lowered for the half
  second it takes, and you need room to crouch on top.
- **Fire escapes.** Blocks of two floors or more often have one: a drop ladder to the first
  landing, then stairs up each floor to the roof.
- **Roof access.** Other buildings sometimes have a ladder up a wall with no door. Neighboring
  roofs a few metres apart are sometimes joined by plank bridges.
- **Falling hurts.** Drops of up to about 5 m are free. Longer ones hurt, and from about 17 m
  they kill. Armor doesn't help.

Bots use ladders, fire escapes and bridges too. Some overwatch bots start on rooftops.

## Landmark buildings

About one block in three has a landmark building on one of its streets, several storeys high
and open all the way up:

- **Apartment blocks** (Old Town and Downtown, 3–5 floors). A corridor runs down every floor
  with rooms on both sides behind doors, some of them locked. Furniture gives cover, and the
  stairs go up to a stair house on the roof. There's a door into the corridor at one end and
  a street door into a front room.
- **Offices** (Downtown, 4–6 floors). Open-plan floors of desks and screens behind glass
  curtain walls, with a glazed lobby. The elevator is out of order, so take the stairs.
- **Parking garages** (Downtown and Industrial). Open decks every 3 m, joined by long ramps you
  can drive up, with wrecks in the bays and sometimes a car that still runs on the roof.

Bots spawn and fight on every floor, and snipers take the upper windows and the roofs.
`gen.html` labels the chunks that have one.

## River, highways, parks and plazas

- **The river** winds through the city a few blocks from spawn. Its banks are embankment
  streets with a railing along the water, and most of the streets that cross it do so on
  bridges (there's always one within a couple of blocks). The water is about waist-deep: you
  can wade across, slowly, splashing as you go and barely able to jump. Stairs lead back up the
  embankment, and bots only wade if there's no bridge nearby.
- **Elevated highways** run north–south above some streets, 9 m up on pillars. On-ramps climb
  up from the blocks beside them, so you can drive or walk up. The deck makes a long firing
  line with abandoned cars for cover.
- **Parks** have lawns and paths, trees whose crowns block sight and shots, hedges to crouch
  behind, a fountain and a bandstand with a ladder up to its roof. **Plazas** are paved squares
  with a monument or big fountain, raised planters, kiosks and a colonnade.
- The city map (M) shows the river, parks, plazas and highways even where you haven't been.

## Doors and glass

- **Doors.** Many doorways have doors. E opens and closes the one you're looking at, and
  you can't close it on someone standing in the doorway. Opening one is audible, so nearby
  bots may come to look. Running at a door (faster than about 5 m/s) and pressing E kicks it
  in. That's loud, and it knocks whoever stands behind it.
- **Locked doors.** Some doors are locked. A locked wooden door gives way to two kicks,
  gunfire or an HE grenade. Warehouse side doors are metal, which bullets don't go through
  and kicks barely dent. Bullets do go through wooden doors, closed or not.
- **Bots** open the doors they walk into and kick in locked ones.
- **Glass.** Windows have panes. Bots can see and shoot through them, but nobody can walk or
  climb through until the glass is broken. A bullet shatters a pane and keeps going, and so
  do grenades. An HE blast takes out every pane within about 6 m.
- Open, broken and kicked-in doors and shattered windows stay that way. They're in your save
  and shared in co-op.

## Breaching walls

Some doorways have been bricked up: a door-sized patch of brick (or concrete block, in brick
walls) under a lintel. You can blow them open to make your own way in. They're in the
partitions of houses and between apartment rooms, and one or two per building face an alley,
yard or street. `/gen.html` shows them in orange.

- **Breaching charges** are Gear in the buy menu ($300; carry up to 2). Look at a bricked-up
  doorway and hold E for 1.5 s to plant one. Your gun is lowered while you do. Letting go of E,
  firing or looking away cancels, and you keep the charge.
- **The blast.** The charge beeps faster and faster for 3 s, then blows the patch out. Everyone
  within 3.5 m takes damage (you don't), nearby glass shatters and doors take a hit. The beeping
  is audible, so bots on either side may come to look.
- **HE grenades** also blow a patch out, but only one that goes off within about a meter of it.
- **Bots** path through a hole once it's blown, but never make one themselves.
- Blown-out walls stay that way. They're in your save and shared in co-op.
- On the shooting range (`?world=range`) you start with two charges, and there are two
  bricked-up walls past the doorway.

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

## Pedestrians

Civilians walk the sidewalks around you: office workers, joggers, tourists, students, workers
and pensioners. They cross at the corners, stop now and then, and thin out at night and in the
rain. Downtown is busiest and the industrial district quietest.

- **Gunfire.** A shot or an explosion nearby sends them running away from it, and the panic
  spreads to the people around them. Once they're clear they crouch and wait, then carry on
  walking after a while.
- **Fines.** Killing a civilian costs you $300, by any means: gun, grenade or car. Bots don't
  aim at civilians, but stray fire can still hit them, and then nobody pays. Civilian kills
  don't count on the co-op scoreboard.
- **Where they keep away.** Nobody wanders into an area while its squad is out, or into the
  opening scene before you've dealt with it.
- **Performance.** Settings → Graphics → Pedestrians (Off / Few / Normal) caps how many there
  are. There are at most 24 at a time, and nobody is drawn past the fog.

How it works: pedestrians are ordinary actors on their own team, so hits, damage, rendering and
co-op sync all work as for anyone else. But there's no player movement or pathfinding for them.
`src/ai/civilians/sidewalks.ts` treats the city's sidewalk corners as a lattice. Each stretch of
sidewalk or crossing is checked against the collision world the first time someone wants to
walk it, which rules out rivers, ramps and anything in the way. `Pedestrians.ts` steers each
person along those lines, and co-op hosts run it like the bots.

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
  - opened doors, broken windows and blown-out walls
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

## Character models

Bots and co-op players can be drawn with an animated character made in Blender, exported to
`public/models/characters/soldier.glb`. The file contract (scale, bone and clip names, sockets,
materials, budgets and export settings) is in [art/characters/README.md](art/characters/README.md).
Until that file exists, or if it fails to load, the game draws the box figures. You can also pick
them under Settings → Graphics → Characters.

```bash
npm run models:check        # validate soldier.glb (or any .glb given as an argument) against the spec
npm run models:reference    # write art/characters/hitbox_reference.obj to model around
npm run models:placeholder  # regenerate the stand-in (public/models/characters/placeholder.glb)
```

The placeholder is a jointed box soldier that follows the spec exactly. Open it with
`?charmodel=placeholder`, or import it into Blender to see the rig names and socket axes. In
game, each character is a pooled skinned clone. Walk, run and crouch cycles share one phase
matched to ground speed, aim pitch bends the spine, the game's own gun models sit in the weapon
socket, and shots, reloads, throws and hits play as additive upper-body overlays. Characters off
screen aren't animated, and far ones update every third frame.

## Voice lines

Bots speak. The opening scene has its own lines. Squads outside it bark in a fight: spotting you,
reloading, throwing, a squadmate going down, taunting you while you hide. They also chat idly,
which you can overhear while sneaking up. Unarmoured bots use the gang's two voices, armoured ones
the terrorist cell's. Both voices in a faction say the same lines.

The lines, the voices and how to design each one are in `src/ai/voiceLines.ts`. When each bark
fires, and how often, is in `src/ai/barks.ts`. The clips are recorded in
[ElevenLabs](https://elevenlabs.io/):

```bash
npm run voices -- --sheet [gang1 ...]   # lines still to record (id, tab, text), by voice
# save each clip as public/voice/<id>.mp3, then:
npm run voices -- --measure             # write every clip's length to src/ai/voiceDurations.ts
```

The game only loads clips listed in `voiceDurations.ts`. A line without a clip shows its caption
with no sound. The bots use the lengths to space lines out: one squad member talks at a time,
unless something more urgent (a grenade) cuts in. The host decides who speaks and when. Everyone
hears it positionally and sees a caption: within 70 m for the scene, and within 30 m (under the
bot's name) for barks. `/voices.html` on the dev server plays every recorded line.

A voice can also be generated locally with [Piper](https://github.com/OHF-Voice/piper1-gpl), a
neural TTS, by giving it `source: 'piper'` settings in `VOICES`:

```bash
pip install piper-tts soundfile pyworld   # once (PYTHON=... picks the interpreter)
npm run voices                            # the Piper voices' lines, or: npm run voices <line-id> ...
npm run voices -- --audition [officer]    # candidate voices (gang, officer), to compare on /voices.html
```

Pitch and formant changes go through the WORLD vocoder (`pyworld`), so a lowered voice keeps its
character instead of sounding like slowed tape. This downloads the voices into `.voices/` on first
use (about 60–120 MB each, not committed).

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
  baked into brushes, per-material meshes, and a layered 0.5 m nav grid with cover and
  reachability. Each nav column holds every floor with standing room in it (street, upper
  storeys, catwalks), so bots path up stairs and ramps and fight on more than one level.
  Chunks stream in around the player.
  - **Chunk pieces** (`src/sim/Pieces.ts`): parts of a chunk that can be destroyed for good
    (window panes, breachable wall patches). Each is one brush, named by its index in the chunk.
    The destroyed set is saved, sent to co-op clients, and re-applied when a chunk streams back
    in. A breachable patch is drawn apart from the chunk's meshes, so it can vanish. It also
    carries a nav patch: chunks with patches bake their nav twice, with the patches standing and
    with them gone. The spans only the open bake has (the floor through the doorway) start out
    not walkable, and blowing a patch out switches the spans around it to their open values.
    A new kind of destructible belongs here as a new `PieceKind`.
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
