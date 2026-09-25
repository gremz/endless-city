"""Low-poly gang member and terrorist characters (T-pose, unarmed) for Blender 4.0+.

Run headless:
    blender --background --python characters.py -- <output_dir>

Writes into <output_dir>/characters/:
    <Name>.glb for each character (at the origin, ready for a game engine)
    characters.blend with every character laid out in two lineups
    lineup_<group>_<view>.png and preview_<Name>.png renders
Units are metres, Z up, characters face -Y, feet at the origin.
"""
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.join(argv[0] if argv else os.getcwd(), "characters")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


# ---------------------------------------------------------------- character specs
#
# top.style:   tee | tank | hoodie | jacket | tracksuit | military | coat
# legs.style:  pants | shorts          (baggy, pockets, socks are optional flags)
# shoes:       sneakers | boots
# hands:       skin | gloves
# head items:  hair, beard, beanie, cap_back, bandana, balaclava, sunglasses, goggles, gasmask
# extras:      chain, belt, chest_rig, plate_carrier, backpack, knee_pads
# colors:      material colours keyed by part (top, shirt, pants, shoe, sole, hair, hat, mask, ...)

CHARACTERS = [
    dict(name="Gang_Hoodie", group="Gang", skin="#8D5A3B",
         top="hoodie", legs=dict(style="pants", baggy=True), shoes="sneakers", hands="skin",
         head=["beanie", "bandana"], extras=[],
         colors=dict(top="#3A3B40", string="#D0D0D0", pants="#3D5577", shoe="#EDEDED",
                     sole="#FAFAFA", hat="#16171A", bandana="#2F4A3A")),
    dict(name="Gang_Biker", group="Gang", skin="#E0B89A",
         top="jacket", legs=dict(style="pants"), shoes="boots", hands="skin",
         head=["hair", "beard", "sunglasses"], extras=["chain", "belt"],
         colors=dict(top="#1C1B1A", shirt="#7A1F1F", pants="#2A2F3A", shoe="#2B211A",
                     hair="#3B2A1E", glasses="#0D0D0F", belt="#1A1512", buckle="#A8A8A8",
                     chain="#D4AF37")),
    dict(name="Gang_Tracksuit", group="Gang", skin="#5C3A26",
         top="tracksuit", legs=dict(style="pants", stripes=True), shoes="sneakers", hands="skin",
         head=["hair", "cap_back"], extras=["chain"],
         colors=dict(top="#24306B", stripe="#F0F0F0", pants="#24306B", shoe="#F2F2F2",
                     sole="#FFFFFF", hair="#141010", hat="#111111", chain="#D4AF37")),
    dict(name="Gang_Tank", group="Gang", skin="#C99A72",
         top="tank", legs=dict(style="shorts", pockets=True, socks=True), shoes="sneakers",
         hands="skin", head=["hair", "beard", "sunglasses"], extras=["chain"],
         colors=dict(top="#2F2F31", pants="#5E5C45", sock="#F2F2F2", shoe="#222222",
                     sole="#EEEEEE", hair="#2A211B", glasses="#0D0D0F", chain="#D4AF37")),

    dict(name="Terrorist_Balaclava", group="Terrorists", skin="#D9A47E",
         top="military", legs=dict(style="pants", pockets=True), shoes="boots", hands="gloves",
         head=["balaclava"], extras=["chest_rig", "belt"],
         colors=dict(top="#4E5530", pants="#5A5240", shoe="#2E261E", gloves="#1A1A1A",
                     mask="#141414", rig="#6F6448", pouch="#7A6E50", belt="#2A241C",
                     buckle="#6E6E6E")),
    dict(name="Terrorist_Urban", group="Terrorists", skin="#7A4E33",
         top="hoodie", legs=dict(style="pants"), shoes="sneakers", hands="gloves",
         head=["balaclava"], extras=["plate_carrier", "backpack"],
         colors=dict(top="#1F2226", string="#1F2226", pants="#2E3B52", shoe="#1C1C1C",
                     sole="#3A3A3A", gloves="#161616", mask="#2A2B2E", carrier="#3B3F33",
                     pouch="#454A3B", pack="#3A3A36")),
    dict(name="Terrorist_Desert", group="Terrorists", skin="#E6C1A3",
         top="military", legs=dict(style="pants", pockets=True), shoes="boots", hands="gloves",
         head=["balaclava", "goggles"], extras=["plate_carrier", "knee_pads", "backpack", "belt"],
         colors=dict(top="#A89572", pants="#9C8A66", shoe="#7A6245", gloves="#5A4E3C",
                     mask="#B89F78", goggles="#1E1E1E", lens="#C08A2E", carrier="#5D6340",
                     pouch="#6A704A", pads="#4F5436", pack="#6B6B4B", belt="#4A3F2E",
                     buckle="#6E6E6E")),
    dict(name="Terrorist_Gasmask", group="Terrorists", skin="#B07B55",
         top="coat", legs=dict(style="pants"), shoes="boots", hands="gloves",
         head=["beanie", "gasmask"], extras=["chest_rig"],
         colors=dict(top="#3E3A33", button="#1A1A1A", pants="#2C2C2C", shoe="#1F1B17",
                     gloves="#1A1A1A", hat="#232323", mask="#1E1E1E", lens="#4A6B6B",
                     filter="#6B6B6B", rig="#3F4430", pouch="#4A5038")),
]


# ---------------------------------------------------------------- materials

def srgb(hex_str):
    """Hex sRGB colour -> linear RGB tuple (Blender material colours are linear)."""
    h = hex_str.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


ROUGHNESS = {"glasses": 0.2, "lens": 0.2, "chain": 0.3, "buckle": 0.35}
METALLIC = {"chain": 1.0, "buckle": 0.9}
_MATS = {}


def mat(key, hex_str):
    """Shared flat-colour material per (part, colour) pair."""
    if (key, hex_str) in _MATS:
        return _MATS[key, hex_str]
    rgb = srgb(hex_str)
    m = bpy.data.materials.new(key.capitalize())
    m.diffuse_color = (*rgb, 1.0)
    m.roughness = ROUGHNESS.get(key, 0.8)
    m.metallic = METALLIC.get(key, 0.0)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = m.roughness
    bsdf.inputs["Metallic"].default_value = m.metallic
    _MATS[key, hex_str] = m
    return m


# ---------------------------------------------------------------- mesh helpers

PARTS = []


def add_obj(name, bm, material):
    for f in bm.faces:
        f.smooth = False
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    me.materials.append(material)
    PARTS.append(ob)
    return ob


def box(name, x, y, z, material, top_scale=(1, 1), shift_top=(0, 0)):
    """Axis-aligned box from (x0,x1),(y0,y1),(z0,z1); the top face can be scaled/shifted."""
    cx, cy = sum(x) / 2, sum(y) / 2
    hx, hy = (x[1] - x[0]) / 2, (y[1] - y[0]) / 2
    bm = bmesh.new()
    v = []
    for zz, (sx, sy), (ox, oy) in ((z[0], (1, 1), (0, 0)), (z[1], top_scale, shift_top)):
        for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            v.append(bm.verts.new((cx + dx * hx * sx + ox, cy + dy * hy * sy + oy, zz)))
    for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([v[i] for i in f])
    return add_obj(name, bm, material)


def segment(name, p0, p1, r0, r1, material, sides=6):
    """Low-poly tapered cylinder running from p0 (radius r0) to p1 (radius r1)."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=sides,
                          radius1=r0, radius2=r1, depth=d.length)
    rot = d.normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p0 + p1) / 2) @ rot, verts=bm.verts)
    return add_obj(name, bm, material)


def blob(name, center, radii, material):
    """Faceted ellipsoid (icosphere, 1 subdivision)."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(center) @ Matrix.Diagonal((*radii, 1)),
                        verts=bm.verts)
    return add_obj(name, bm, material)


def dome(name, center, radii, material, segments=8, rings=6):
    """Upper half of a low-poly UV sphere (hats, hair)."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.01], context="VERTS")
    bmesh.ops.transform(bm, matrix=Matrix.Translation(center) @ Matrix.Diagonal((*radii, 1)),
                        verts=bm.verts)
    return add_obj(name, bm, material)


def xr(s, a, b):
    """x range (a, b) mirrored to side s (+1 right, -1 left), returned in ascending order."""
    return (a, b) if s > 0 else (-b, -a)


SIDES = ((-1, "L"), (1, "R"))


# ---------------------------------------------------------------- body builder

def build(c):
    PARTS.clear()
    col = c["colors"]
    m = lambda key: mat(key, col[key])  # noqa: E731
    skin = mat("skin", c["skin"])
    head = c["head"]
    extras = c["extras"]
    style = c["top"]
    legs = c["legs"]
    masked = "balaclava" in head

    # --- feet and legs
    boots = c["shoes"] == "boots"
    ankle_z = 0.20 if boots else 0.13
    bag = 0.015 if legs.get("baggy") else 0.0
    pants = m("pants")
    for s, side in SIDES:
        fx = 0.12 * s
        if boots:
            box(f"Boot.{side}", (fx - 0.065, fx + 0.065), (-0.17, 0.07), (0.0, 0.12), m("shoe"),
                top_scale=(1, 0.8), shift_top=(0, 0.02))
            segment(f"BootShaft.{side}", (fx, 0, 0.08), (fx, 0, 0.25), 0.066, 0.064, m("shoe"))
        else:
            box(f"Sole.{side}", (fx - 0.062, fx + 0.062), (-0.175, 0.07), (0.0, 0.03), m("sole"))
            box(f"Sneaker.{side}", (fx - 0.058, fx + 0.058), (-0.165, 0.062), (0.03, 0.11), m("shoe"),
                top_scale=(0.9, 0.7), shift_top=(0, 0.025))
            segment(f"SneakerCollar.{side}", (fx, 0.0, 0.08), (fx, 0.0, 0.15), 0.056, 0.054, m("shoe"))

        hip, knee, ankle = (0.10 * s, 0, 0.92), (0.11 * s, 0, 0.52), (fx, 0, ankle_z)
        if legs["style"] == "shorts":
            segment(f"Shorts.{side}", hip, (0.11 * s, 0, 0.46), 0.105, 0.095, pants)
            segment(f"Leg.{side}", (0.11 * s, 0, 0.55), (fx, 0, 0.12), 0.064, 0.05, skin)
            if legs.get("socks"):
                segment(f"Sock.{side}", (fx, 0, 0.08), (fx, 0, 0.24), 0.056, 0.055, m("sock"))
        else:
            segment(f"Thigh.{side}", hip, knee, 0.095 + bag, 0.074 + bag, pants)
            segment(f"Shin.{side}", knee, ankle, 0.074 + bag, 0.062 + bag, pants)
        if legs.get("pockets"):
            box(f"ThighPocket.{side}", xr(s, 0.17, 0.215), (-0.05, 0.05), (0.62, 0.76), pants)
        if legs.get("stripes"):
            segment(f"LegStripe.{side}", (0.193 * s, 0, 0.90), (0.182 * s, 0, 0.52), 0.011, 0.011, m("stripe"))
            segment(f"ShinStripe.{side}", (0.182 * s, 0, 0.52), (0.178 * s, 0, 0.15), 0.011, 0.011, m("stripe"))
        if "knee_pads" in extras:
            box(f"KneePad.{side}", (knee[0] - 0.05, knee[0] + 0.05), (-0.11, -0.05), (0.46, 0.58),
                m("pads"), top_scale=(0.9, 0.9))
    box("Pelvis", (-0.18, 0.18), (-0.11, 0.11), (0.82, 0.96), pants)

    # --- torso
    top = m("top")
    front_y = -0.12  # where chest accessories sit
    if style == "hoodie":
        box("Hoodie", (-0.18, 0.18), (-0.108, 0.108), (0.86, 1.43), top, top_scale=(1.25, 1.08))
        box("HoodiePocket", (-0.11, 0.11), (-0.128, -0.104), (0.90, 1.04), top, top_scale=(0.8, 1))
        box("Hood", (-0.12, 0.12), (0.04, 0.16), (1.36, 1.48), top, top_scale=(0.85, 0.8))
        for s, side in SIDES:
            segment(f"Drawstring.{side}", (0.035 * s, -0.118, 1.41), (0.035 * s, -0.124, 1.28),
                    0.006, 0.006, m("string"), sides=4)
    elif style in ("jacket", "coat"):
        if style == "jacket":
            box("Shirt", (-0.17, 0.17), (-0.10, 0.10), (0.92, 1.42), m("shirt"), top_scale=(1.3, 1.1))
            box("Jacket", (-0.185, 0.185), (-0.115, 0.115), (0.88, 1.43), top, top_scale=(1.22, 1.06))
            box("ShirtFront", (-0.055, 0.055), (-0.13, -0.11), (0.90, 1.38), m("shirt"))
            front_y = -0.14
        else:
            box("Coat", (-0.19, 0.19), (-0.115, 0.115), (0.94, 1.43), top, top_scale=(1.18, 1.05))
            box("CoatSkirt", (-0.23, 0.23), (-0.14, 0.14), (0.58, 0.95), top, top_scale=(0.83, 0.82))
            for i, bz in enumerate((1.02, 1.14, 1.26)):
                box(f"Button.{i}", (-0.012, 0.012), (-0.126, -0.112), (bz, bz + 0.024), m("button"))
        segment("Collar", (0, 0.01, 1.40), (0, 0.01, 1.47), 0.092, 0.088, top, sides=8)
    else:  # tee, tank, tracksuit, military
        box("Shirt", (-0.17, 0.17), (-0.10, 0.10), (0.92, 1.42), top, top_scale=(1.3, 1.1))
        if style != "tank":
            segment("Collar", (0, 0.0, 1.39), (0, 0.0, 1.45), 0.08, 0.074, top, sides=8)
        if style == "tracksuit":
            box("Zipper", (-0.006, 0.006), (-0.118, -0.104), (0.95, 1.42), m("stripe"))
        if style == "military":
            for s, side in SIDES:
                box(f"ChestPocket.{side}", xr(s, 0.05, 0.13), (-0.122, -0.104), (1.22, 1.32), top)

    # --- arms (T-pose, palms down)
    sleeves = {"tee": "short", "tank": "none"}.get(style, "long")
    hand_mat = m("gloves") if c["hands"] == "gloves" else skin
    for s, side in SIDES:
        sh, el, wr = (0.21 * s, 0, 1.385), (0.50 * s, 0, 1.385), (0.76 * s, 0, 1.385)
        if sleeves == "long":
            blob(f"Shoulder.{side}", sh, (0.08, 0.08, 0.075), top)
            segment(f"UpperArm.{side}", sh, el, 0.068, 0.058, top)
            segment(f"Forearm.{side}", el, wr, 0.058, 0.048, top)
            if style == "tracksuit":
                segment(f"ArmStripe.{side}", (0.23 * s, 0, 1.447), (0.75 * s, 0, 1.43), 0.011, 0.011, m("stripe"))
        else:
            if sleeves == "short":
                blob(f"Shoulder.{side}", sh, (0.08, 0.08, 0.075), top)
                segment(f"Sleeve.{side}", sh, (0.37 * s, 0, 1.385), 0.072, 0.068, top)
            else:
                blob(f"Shoulder.{side}", sh, (0.07, 0.07, 0.065), skin)
            segment(f"UpperArm.{side}", sh, el, 0.058, 0.05, skin)
            segment(f"Forearm.{side}", el, wr, 0.05, 0.042, skin)
        if c["hands"] == "gloves":
            segment(f"GloveCuff.{side}", (0.74 * s, 0, 1.385), (0.785 * s, 0, 1.385), 0.052, 0.05, hand_mat)
        box(f"Hand.{side}", xr(s, 0.755, 0.90), (-0.045, 0.045), (1.36, 1.405), hand_mat)
        segment(f"Thumb.{side}", (0.79 * s, -0.035, 1.38), (0.84 * s, -0.075, 1.378), 0.019, 0.016, hand_mat)

    # --- neck, head, face
    face = m("mask") if masked else skin
    segment("Neck", (0, 0, 1.40), (0, 0, 1.53), 0.058, 0.054, face)
    blob("Head", (0, -0.005, 1.60), (0.095, 0.105, 0.115), face)
    if masked:
        dome("MaskTop", (0, 0.0, 1.605), (0.1, 0.11, 0.118), face)
        box("EyeSlot", (-0.066, 0.066), (-0.114, -0.075), (1.592, 1.628), skin)
    else:
        box("Nose", (-0.013, 0.013), (-0.122, -0.09), (1.568, 1.602), skin, top_scale=(0.7, 0.6))
        for s, side in SIDES:
            blob(f"Ear.{side}", (0.093 * s, 0.0, 1.597), (0.018, 0.028, 0.034), skin)
    if "gasmask" not in head:
        for s, side in SIDES:
            box(f"Eye.{side}", xr(s, 0.022, 0.046), (-0.118, -0.1), (1.603, 1.619), mat("eyes", "#101010"))

    if "hair" in head:
        dome("Hair", (0, 0.012, 1.615), (0.1, 0.112, 0.112), m("hair"))
    if "beard" in head:
        blob("Beard", (0, -0.03, 1.54), (0.088, 0.085, 0.055), m("hair"))
    if "beanie" in head:
        dome("Beanie", (0, 0.003, 1.625), (0.107, 0.117, 0.115), m("hat"))
        segment("BeanieRim", (0, 0.003, 1.62), (0, 0.003, 1.655), 0.113, 0.113, m("hat"), sides=8)
    if "cap_back" in head:
        dome("Cap", (0, 0.003, 1.635), (0.104, 0.114, 0.09), m("hat"))
        box("CapBrim", (-0.065, 0.065), (0.08, 0.19), (1.632, 1.646), m("hat"))
    if "bandana" in head:
        blob("Bandana", (0, -0.012, 1.548), (0.1, 0.112, 0.052), m("bandana"))
        segment("BandanaNeck", (0, 0, 1.44), (0, 0, 1.52), 0.066, 0.07, m("bandana"))
    if "sunglasses" in head:
        for s, side in SIDES:
            box(f"SunglassLens.{side}", xr(s, 0.014, 0.052), (-0.121, -0.106), (1.601, 1.621), m("glasses"))
        box("SunglassBridge", (-0.014, 0.014), (-0.121, -0.11), (1.613, 1.618), m("glasses"))
    if "goggles" in head:
        segment("GoggleStrap", (0, 0, 1.64), (0, 0, 1.662), 0.1, 0.096, m("goggles"), sides=8)
        for s, side in SIDES:
            box(f"GoggleLens.{side}", xr(s, 0.008, 0.06), (-0.118, -0.09), (1.632, 1.672), m("lens"))
    if "gasmask" in head:
        blob("GasMask", (0, -0.065, 1.58), (0.08, 0.065, 0.08), m("mask"))
        for s, side in SIDES:
            segment(f"MaskLens.{side}", (0.035 * s, -0.11, 1.612), (0.035 * s, -0.133, 1.612),
                    0.024, 0.024, m("lens"), sides=8)
        segment("MaskFilter", (0, -0.12, 1.54), (0, -0.185, 1.525), 0.032, 0.032, m("filter"), sides=8)

    # --- gear and accessories
    if "chain" in extras:
        gold = m("chain")
        for s, side in SIDES:
            segment(f"Chain.{side}", (0.062 * s, front_y + 0.018, 1.435), (0.0, front_y, 1.30), 0.007, 0.007, gold, sides=4)
        box("Pendant", (-0.015, 0.015), (front_y - 0.008, front_y + 0.004), (1.255, 1.30), gold)
    if "belt" in extras:
        bz = (0.93, 0.99) if style == "coat" else (0.88, 0.94)
        by = 0.122 if style == "coat" else 0.118
        box("Belt", (-0.192, 0.192), (-by, by), bz, m("belt"))
        box("Buckle", (-0.028, 0.028), (-by - 0.01, -by + 0.004), (bz[0] + 0.01, bz[1] - 0.01), m("buckle"))
    if "chest_rig" in extras:
        box("ChestRig", (-0.16, 0.16), (-0.135, -0.10), (1.0, 1.2), m("rig"))
        for i, px in enumerate((-0.1, 0.0, 0.1)):
            box(f"RigPouch.{i}", (px - 0.035, px + 0.035), (-0.172, -0.13), (1.02, 1.16), m("pouch"))
        for s, side in SIDES:
            box(f"RigStrapFront.{side}", xr(s, 0.07, 0.12), (-0.13, -0.106), (1.2, 1.45), m("rig"))
            box(f"RigStrapTop.{side}", xr(s, 0.07, 0.12), (-0.13, 0.13), (1.415, 1.45), m("rig"))
            box(f"RigStrapBack.{side}", xr(s, 0.07, 0.12), (0.106, 0.13), (1.05, 1.45), m("rig"))
    if "plate_carrier" in extras:
        box("PlateCarrier", (-0.2, 0.2), (-0.135, 0.135), (0.97, 1.36), m("carrier"), top_scale=(1.15, 1.04))
        for s, side in SIDES:
            box(f"CarrierStrap.{side}", xr(s, 0.07, 0.14), (-0.142, 0.142), (1.34, 1.448), m("carrier"))
        for i, px in enumerate((-0.1, 0.0, 0.1)):
            box(f"CarrierPouch.{i}", (px - 0.035, px + 0.035), (-0.175, -0.13), (1.0, 1.13), m("pouch"))
    if "backpack" in extras:
        box("Backpack", (-0.15, 0.15), (0.14, 0.28), (1.0, 1.34), m("pack"), top_scale=(0.95, 0.9))
        box("BackpackPocket", (-0.1, 0.1), (0.27, 0.31), (1.03, 1.16), m("pack"))

    # --- join into a single mesh named after the character
    for ob in scene.objects:
        ob.select_set(ob in PARTS)
    bpy.context.view_layer.objects.active = PARTS[0]
    with bpy.context.temp_override(active_object=PARTS[0], selected_objects=PARTS,
                                   selected_editable_objects=PARTS):
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = ob.data.name = c["name"]
    return ob


# ---------------------------------------------------------------- build, export, lay out

os.makedirs(OUT, exist_ok=True)
collections = {}
stats = []
counts = {}
for c in CHARACTERS:
    ob = build(c)

    # export on its own, standing at the origin
    for o in scene.objects:
        o.select_set(o is ob)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f"{c['name']}.glb"),
                              export_format="GLB", use_selection=True)

    group = c["group"]
    if group not in collections:
        collections[group] = bpy.data.collections.new(group)
        scene.collection.children.link(collections[group])
    scene.collection.objects.unlink(ob)
    collections[group].objects.link(ob)
    i = counts.get(group, 0)
    counts[group] = i + 1
    ob["lineup_index"] = i
    stats.append(f"{c['name']}={sum(len(p.vertices) - 2 for p in ob.data.polygons)}")

SPACING = 2.1
for row, (group, coll) in enumerate(collections.items()):
    n = len(coll.objects)
    for ob in coll.objects:
        ob.location = ((ob["lineup_index"] - (n - 1) / 2) * SPACING, row * 6.0, 0)


# ---------------------------------------------------------------- preview renders

world = bpy.data.worlds.new("World")
world.color = srgb("#C9CED3")
scene.world = world
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.display.shading.show_object_outline = True
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x, scene.render.resolution_y = 2200, 900

cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
cam.data.type = "ORTHO"
cam.data.ortho_scale = 8.6
scene.collection.objects.link(cam)
scene.camera = cam

for row, (group, coll) in enumerate(collections.items()):
    for other in collections.values():
        other.hide_render = other is not coll
    target = Vector((0, row * 6.0, 0.95))
    for view, direction in (("front", (0.12, -1.0, 0.15)), ("back", (-0.12, 1.0, 0.15))):
        cam.location = target + Vector(direction).normalized() * 12
        cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(OUT, f"lineup_{group.lower()}_{view}.png")
        bpy.ops.render.render(write_still=True)
for coll in collections.values():
    coll.hide_render = False

# individual three-quarter close-ups
cam.data.type = "PERSP"
cam.data.lens = 60
scene.render.resolution_x = scene.render.resolution_y = 1000
characters = [o for coll in collections.values() for o in coll.objects]
for ob in characters:
    for other in characters:
        other.hide_render = other is not ob
    target = ob.location + Vector((0, 0, 0.95))
    cam.location = target + Vector((0.7, -1.0, 0.25)).normalized() * 4.3
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(OUT, f"preview_{ob.name}.png")
    bpy.ops.render.render(write_still=True)
for ob in characters:
    ob.hide_render = False

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "characters.blend"))
print("CHAR_STATS " + " ".join(stats))
