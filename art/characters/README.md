# Character models: art spec

The game draws **bots** with the gang and terrorist models in `public/models/characters/bots/`,
and **players** (other players, co-op allies) with `public/models/characters/player.glb`. Both
are generated (see [The bot models](#the-bot-models) and [The player model](#the-player-model)).
If `player.glb` is missing, players use the bot models.

This spec is for a hand-made model. Export it to `public/models/characters/soldier.glb` and load
it for every bot with `?charmodel=soldier`.

It's a glTF Binary file with the mesh, the armature and every animation in it. Keep your
`.blend` source here in `art/characters/`. Commit it if it's under about 50 MB, otherwise use
Git LFS. If a model is missing or doesn't pass the checks below, the game leaves it out, and
draws the old box figures if none load, so an unfinished export never breaks anything.

## Workflow

1. `npm run models:reference` writes `hitbox_reference.obj` here. In Blender, use
   **File → Import → Wavefront (.obj)** with the default axes. You get the hitboxes as solid
   boxes, the crouched hitboxes and the collision hull as wires, an eye-height cross and an
   arrow pointing to the front. Model around them.
2. For a working example, import `public/models/characters/placeholder.glb` (File → Import →
   glTF 2.0). It's a jointed box soldier that follows this spec exactly: rig names, sockets,
   gear and clips.
3. Export to `public/models/characters/soldier.glb` (settings below).
4. `npm run models:check` validates the file and lists anything missing or over budget.
5. `npm run dev`, then open **http://localhost:5173/models.html**. The page drives your model
   the way the game does:
   - speed, direction, crouch and aim sliders
   - weapon, look, helmet, vest and flashlight toggles
   - Shoot, Reload, Throw, Hit and Die buttons
   - the live clip weights
   - a single-clip mode for checking one animation on its own
   - the hitboxes drawn over the model

   After re-exporting, click **Reload**. Then play the game and check it in context.

## Scale and orientation

- 1 Blender unit = 1 metre. Apply all transforms (Ctrl+A) before exporting.
- Feet on the ground at the origin. The character stands about **1.80 m** tall.
- Face **Blender −Y**, which is what the Front view (numpad 1) looks at. The game turns the
  model to its own forward direction.
- For reference, in game units:
  - The standing collision hull is 1.83 m tall and 0.81 m square. Crouched, it's 1.37 m.
  - The eyes are at 1.63 m standing and 1.17 m crouched.
- **Match the hitboxes**, because players aim at what they see and damage uses the boxes:

  | Box | Size (w × h × d) | Centre height | Crouched centre |
  |---|---|---|---|
  | Head | 0.24 × 0.26 × 0.24 | 1.66 | 1.19 |
  | Chest | 0.46 × 0.45 × 0.28 | 1.275 | 0.92 |
  | Stomach | 0.38 × 0.25 × 0.26 | 0.925 | 0.66 |
  | Legs | 0.40 × 0.80 × 0.28 | 0.40 | 0.29 |

  Gear sticking out a little is fine. A head much bigger than its box is not.

## Budget

| | Limit |
|---|---|
| Triangles | about 5,000 per character (up to 48 can be on screen) |
| Materials | 3 or fewer (each one is a draw call per character) |
| Bones | about 40 or fewer, with at most 4 influences per vertex (the exporter's default) |
| Textures | none (flat colours) or one atlas up to 1024², embedded in the GLB |
| File size | under 2 MB |

## Rig

Any humanoid armature works. The rest pose can be a T-pose or an A-pose.

**Use underscores, not dots, in names.** Three.js strips dots, so write `UpperArm_L`, not
`UpperArm.L`.

The game looks up these names exactly:

| Name | What | Required |
|---|---|---|
| `Hips` | Root of the deforming bones | yes |
| `Spine` | Everything from here up counts as the **upper body**, where overlays play. It bends with aim pitch. | yes |
| `Chest` | Takes the other half of the aim bend. Without it, `Spine` bends alone. | no |
| `Head` | Must be below `Spine` | yes |
| `Socket_Weapon` | **Empty** parented to the right-hand bone, at the grip | yes |
| `Socket_Torch` | Empty under the barrel for the flashlight beam (same axes as the weapon socket). Without it, the beam is placed 0.55 m along the barrel. | no |

### The weapon socket

The game attaches its own gun models to `Socket_Weapon`: the same ones you see in first person
and lying on the ground. They switch with whatever the actor has out (rifle, pistol, knife,
grenade). **Don't model a gun into the character**, but do **pose every animation as if
holding a rifle**.

Set the socket up like this:

1. Add an empty of type **Single Arrow** and parent it to the right-hand bone (parent type
   Bone).
2. Move it to the middle of the grip, where the index finger wraps.
3. Rotate it so the **arrow (its blue +Z) points along the barrel**, out of the muzzle.
4. Then roll it around the arrow so its **green +Y points out of the gun's underside**, the
   magazine side.

If the gun shows up upside down or sideways in `/models.html`, fix the roll in step 4.

## Materials and gear

- **`Uniform`**: this material gets tinted per team: olive bots, dark grey armoured elites,
  blue co-op allies and tan range dummies. Paint it **light neutral grey**, because the tint
  multiplies it.
- **`Skin`**: never tinted.
- Any other material (boots, gloves, straps) is drawn as authored.
- **`Helmet`** (object): only shown when the actor wears a helmet.
- **`Vest`** (object): only shown when the actor has armour.
- Both gear pieces can be skinned meshes or plain meshes parented to a bone. Keep them separate
  objects with exactly these names.

## Animations

Make each clip its **own Action**, named exactly as below.

- **Make everything in place.** The game moves the character, so `Hips` must not travel
  forward.
- Loops must loop seamlessly: the last frame should match the first.
- **Start every locomotion cycle** (Walk, Run and Crouch_Walk, plus any strafe or back
  versions) **with the left foot planting at frame 0.** The game plays them in step with each
  other while blending, so they have to agree on which foot is down when.
- **Don't animate aiming up or down.** The game bends `Spine` and `Chest` to the actor's
  pitch.

| Clip | Kind | Required | Notes |
|---|---|---|---|
| `Idle` | loop | **yes** | Rifle at the ready. Breathing, small weight shifts |
| `Walk` | loop | **yes** | Feet authored for **1.6 m/s** |
| `Run` | loop | **yes** | Authored for **5.5 m/s**. The in-game rifle run is 5.5 and the knife sprint 6.35 |
| `Crouch_Idle` | loop | **yes** | Hips at about 0.55 m, head centre at about 1.2 m (the crouched head box) |
| `Crouch_Walk` | loop | **yes** | Authored for **2.0 m/s** |
| `Death` | once | **yes** | Falls **backwards** within about 0.6 s and ends lying flat. The last frame is held, and the body sinks into the ground after 8 s |
| `Jump` | loop | no | Airborne pose, used after 0.15 s off the ground. Without it, the idle plays |
| `Walk_Back`, `Walk_Left`, `Walk_Right` | loop | no | Strafing while facing forward. Without them, backwards plays `Walk` in reverse and sideways plays `Walk` (the feet slide) |
| `Run_Back`, `Run_Left`, `Run_Right` | loop | no | Same as above. Directional clips are used only in walk/run pairs |
| `Shoot` | once | no | About 0.15 s recoil kick |
| `Reload` | once | no | About 1.4 s |
| `Throw` | once | no | Grenade throw, about 0.7 s |
| `Hit` | once | no | About 0.3 s flinch |
| `Hold_Pistol`, `Hold_Knife`, `Hold_Grenade` | loop | no | The standing Idle pose with the arms holding that item instead of a rifle. Played while it's out. Without them, the rifle hold is used for everything |
| `Hold_Ready` | loop | no | Low ready: the rifle across the chest, muzzle angled down. Used with rifles, SMGs and snipers while moving, until the character fires. Without it, they stay aimed |

**Overlays** (`Shoot`, `Reload`, `Throw`, `Hit`) must **start and end on the Idle pose**. The
game plays only their `Spine`-and-up part, *added on top* of whatever the legs are doing, so a
reload works while running or crouching. It measures each overlay against the clip's own first
frame, so keys below `Spine` are ignored.

**Holds** (`Hold_*`) work the same way, except that they're measured against `Idle`'s first frame.
Pose them standing like Idle and change only the arms. The difference is added on top of every
clip (walk, run, crouch) while a pistol, knife or grenade is out.

The authored speeds live in `src/render/characters/characterSpec.ts` (`WALK_SPEED`,
`RUN_SPEED`, `CROUCH_WALK_SPEED`). If your cycles look better at other speeds, change the
numbers there rather than the animation. The playback-speed slider in `/models.html` helps you
find the speed where the feet stop sliding.

## Blender export

**File → Export → glTF 2.0**:

- **Format:** glTF Binary (`.glb`)
- **Include:** Selected Objects or Visible Objects (the armature, the body, the gear)
- **Transform:** +Y Up (the default)
- **Data → Mesh:** Apply Modifiers, UVs and Normals on; Tangents off
- **Data → Material:** Export
- **Data → Shape Keys:** off unless you use them
- **Data → Armature:** export deformation bones only is fine, as long as the named bones above are deforming bones
- **Data → Skinning:** on
- **Animation:** mode **Actions**, and tick **Always Sample Animations**

Then run `npm run models:check`.

## The player model

`player.glb` is built from the SWAT officer in `swat.glb` (made by `swat.py`), not exported by
hand. `swat.glb` is a static T-posed mesh; `npm run models:player` puts it on the same rig and
procedural clips as the placeholder:

- It finds each part (thigh, knee pad, glove...) and binds it whole to one bone.
- It swings the arms down from the T-pose.
- The helmet parts become `Helmet` and the vest, pouches and lettering become `Vest`.
- It bakes all colours into vertex colours on a single material.

Because there's no `Uniform` material, players keep the navy uniform instead of a team tint.

After changing the SWAT, re-export `swat.glb` (with transforms applied, keeping each part's
own material), run `npm run models:player`, then check `/models.html?model=player`. The joint
positions live in `SWAT_RIG` in `src/devtools/swatCharacter.ts`.

`?playermodel=` in the game URL overrides the player model the same way `?charmodel=` does for
bots: `none`, `placeholder`, or a path.

## The bot models

The eight bots in `bots/` (`Gang_Hoodie`, `Gang_Biker`, `Gang_Tracksuit`, `Gang_Tank`,
`Terrorist_Balaclava`, `Terrorist_Urban`, `Terrorist_Desert`, `Terrorist_Gasmask`) are made by
`characters.py`. It's built like `swat.py`, with the same joints, so `npm run models:bots` puts
each one on the SWAT's rig the same way. It writes `public/models/characters/bots/<name>.glb`
(lower case). Changes from the SWAT rules:

- A plate carrier (the `Carrier` material, plus its `Pouch`es) becomes `Vest`, hidden while the
  bot has no armour. Chest rigs stay on as clothing, and there's no `Helmet`.
- The tracksuit's arm stripes bend with the elbow. The coat's skirt and the belts ride the hips.

The six `Civ_*` models (office worker, jogger, elderly, tourist, student, worker) are the
pedestrians. They use the same pipeline, in the `civilian` group. The game lets their arms hang
from the bind pose, since every clip holds a gun.

Armoured bots use a terrorist model and the rest a gang model. The actor id picks which one,
so every client in co-op shows the same model, and a bot keeps its model when its armour breaks.
The list lives in `BOT_MODELS` in `src/render/characters/characterSpec.ts`.

After changing `characters.py`, copy the new `.glb`s here and run `npm run models:bots`. Then
check them with `/models.html?model=gang_biker` (or any other id). `?charmodel=gang_biker` in
the game URL draws every bot with that one model.
