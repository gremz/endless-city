"""Low-poly SWAT police officer (T-pose, unarmed) generator for Blender 4.0+.

Run headless:
    blender --background --python swat.py -- <output_dir>

Produces swat.blend, swat.glb and preview renders in <output_dir>.
Units are metres, Z up, character faces -Y, feet at the origin.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else os.getcwd()

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


# ---------------------------------------------------------------- materials

def srgb(hex_str):
    """Hex sRGB colour -> linear RGB tuple (Blender material colours are linear)."""
    h = hex_str.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def make_mat(name, hex_str, roughness=0.8, metallic=0.0):
    rgb = srgb(hex_str)
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1.0)
    m.roughness = roughness
    m.metallic = metallic
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return m


M = {
    "skin": make_mat("Skin", "#D9A47E"),
    "uniform": make_mat("Uniform", "#2B3444"),
    "vest": make_mat("Vest", "#1D2025"),
    "pouch": make_mat("Pouch", "#2A2E35"),
    "pads": make_mat("Pads", "#202329", roughness=0.6),
    "helmet": make_mat("Helmet", "#1A1C20", roughness=0.5),
    "balaclava": make_mat("Balaclava", "#15171A"),
    "boots": make_mat("Boots", "#131313", roughness=0.5),
    "belt": make_mat("Belt", "#18191C"),
    "buckle": make_mat("Buckle", "#8A8D92", roughness=0.35, metallic=0.9),
    "gloves": make_mat("Gloves", "#1A1A1C"),
    "eyes": make_mat("Eyes", "#0E0E0E"),
    "label": make_mat("Label", "#EDEDED", roughness=0.6),
}


# ---------------------------------------------------------------- mesh helpers

PARTS = []


def add_obj(name, bm, mat):
    for f in bm.faces:
        f.smooth = False
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    me.materials.append(mat)
    PARTS.append(ob)
    return ob


def box(name, x, y, z, mat, top_scale=(1, 1), shift_top=(0, 0)):
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
    return add_obj(name, bm, mat)


def segment(name, p0, p1, r0, r1, mat, sides=6):
    """Low-poly tapered cylinder running from p0 (radius r0) to p1 (radius r1)."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=sides,
                          radius1=r0, radius2=r1, depth=d.length)
    rot = d.normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p0 + p1) / 2) @ rot, verts=bm.verts)
    return add_obj(name, bm, mat)


def blob(name, center, radii, mat):
    """Faceted ellipsoid (icosphere, 1 subdivision)."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
    bmesh.ops.transform(bm, matrix=Matrix.Translation(center) @ Matrix.Diagonal((*radii, 1)),
                        verts=bm.verts)
    return add_obj(name, bm, mat)


def dome(name, center, radii, mat, segments=8, rings=6):
    """Upper half of a low-poly UV sphere (helmet shell)."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.01], context="VERTS")
    bmesh.ops.transform(bm, matrix=Matrix.Translation(center) @ Matrix.Diagonal((*radii, 1)),
                        verts=bm.verts)
    return add_obj(name, bm, mat)


def label(name, text, size, center, facing, mat):
    """Flat low-resolution text mesh standing upright, facing -Y ("front") or +Y ("back")."""
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = text
    cu.size = size
    cu.align_x = cu.align_y = "CENTER"
    cu.resolution_u = 2
    tmp = bpy.data.objects.new(name, cu)
    scene.collection.objects.link(tmp)
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(tmp)
    bpy.data.curves.remove(cu)
    rot = Matrix.Rotation(math.pi / 2, 4, "X")
    if facing == "back":
        rot = Matrix.Rotation(math.pi, 4, "Z") @ rot
    me.transform(Matrix.Translation(center) @ rot)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    return add_obj(name, bm, mat)


# ---------------------------------------------------------------- legs and boots

for s, side in ((-1, "L"), (1, "R")):
    box(f"Boot.{side}", (0.12 * s - 0.065, 0.12 * s + 0.065), (-0.17, 0.07), (0.0, 0.12),
        M["boots"], top_scale=(1, 0.8), shift_top=(0, 0.02))
    segment(f"BootShaft.{side}", (0.12 * s, 0.0, 0.08), (0.12 * s, 0.0, 0.25), 0.066, 0.064, M["boots"])

    hip, knee, ankle = (0.10 * s, 0.0, 0.92), (0.11 * s, 0.0, 0.52), (0.12 * s, 0.0, 0.20)
    segment(f"Thigh.{side}", hip, knee, 0.102, 0.078, M["uniform"])
    segment(f"Shin.{side}", knee, ankle, 0.078, 0.062, M["uniform"])
    box(f"KneePad.{side}", (knee[0] - 0.05, knee[0] + 0.05), (-0.11, -0.05), (0.46, 0.58),
        M["pads"], top_scale=(0.9, 0.9))


# ---------------------------------------------------------------- torso, plate carrier, duty belt

box("Pelvis", (-0.18, 0.18), (-0.11, 0.11), (0.82, 0.96), M["uniform"])
box("Torso", (-0.17, 0.17), (-0.10, 0.10), (0.92, 1.42), M["uniform"], top_scale=(1.3, 1.1))
box("Vest", (-0.19, 0.19), (-0.13, 0.13), (0.97, 1.36), M["vest"], top_scale=(1.17, 1.04))
for s, side in ((-1, "L"), (1, "R")):
    box(f"VestStrap.{side}", (0.10 * s - 0.035, 0.10 * s + 0.035), (-0.14, 0.14), (1.34, 1.43), M["vest"])
for i, px in enumerate((-0.12, -0.04, 0.04, 0.12)):
    box(f"MagPouch.{i}", (px - 0.035, px + 0.035), (-0.17, -0.125), (1.00, 1.14), M["pouch"])
box("BackPanel", (-0.14, 0.14), (0.125, 0.16), (1.01, 1.14), M["pouch"])

box("Belt", (-0.19, 0.19), (-0.125, 0.125), (0.87, 0.95), M["belt"])
box("Buckle", (-0.03, 0.03), (-0.135, -0.12), (0.89, 0.93), M["buckle"])
for s, side in ((-1, "L"), (1, "R")):
    box(f"BeltPouch.{side}", (0.13 * s - 0.035, 0.13 * s + 0.035), (-0.15, -0.115), (0.855, 0.945), M["pouch"])
    box(f"BeltPouchSide.{side}", (0.185 * s - 0.02, 0.185 * s + 0.02), (-0.05, 0.05), (0.85, 0.95), M["pouch"])

label("Label.Front", "POLICE", 0.07, (0, -0.136, 1.255), "front", M["label"])
label("Label.Back", "SWAT", 0.115, (0, 0.14, 1.26), "back", M["label"])
label("Label.BackSub", "POLICE", 0.05, (0, 0.165, 1.075), "back", M["label"])


# ---------------------------------------------------------------- head: balaclava, eyes, helmet, headset

segment("Collar", (0, 0, 1.38), (0, 0, 1.46), 0.09, 0.08, M["uniform"])
segment("Neck", (0, 0, 1.40), (0, 0, 1.53), 0.066, 0.06, M["balaclava"])
blob("Head", (0, -0.005, 1.60), (0.095, 0.105, 0.115), M["balaclava"])
box("EyeSlot", (-0.066, 0.066), (-0.114, -0.075), (1.592, 1.628), M["skin"])
for s, side in ((-1, "L"), (1, "R")):
    box(f"Eye.{side}", (0.034 * s - 0.012, 0.034 * s + 0.012), (-0.118, -0.1), (1.603, 1.619), M["eyes"])
    blob(f"EarCup.{side}", (0.098 * s, 0.0, 1.595), (0.03, 0.042, 0.042), M["helmet"])
    box(f"HelmetRail.{side}", (0.118 * s - 0.009, 0.118 * s + 0.009), (-0.06, 0.05), (1.635, 1.665), M["helmet"])

dome("Helmet", (0, 0.005, 1.632), (0.125, 0.135, 0.12), M["helmet"])
segment("HelmetRim", (0, 0.005, 1.627), (0, 0.005, 1.642), 0.132, 0.13, M["helmet"], sides=8)
box("NVGMount", (-0.022, 0.022), (-0.148, -0.118), (1.655, 1.7), M["pads"])


# ---------------------------------------------------------------- arms (T-pose, palms down)

for s, side in ((-1, "L"), (1, "R")):
    shoulder, elbow, wrist = (0.21 * s, 0.0, 1.385), (0.50 * s, 0.0, 1.385), (0.76 * s, 0.0, 1.385)
    blob(f"Shoulder.{side}", shoulder, (0.08, 0.08, 0.075), M["uniform"])
    segment(f"UpperArm.{side}", shoulder, elbow, 0.068, 0.057, M["uniform"])
    segment(f"ElbowPad.{side}", (0.47 * s, 0.0, 1.385), (0.54 * s, 0.0, 1.385), 0.066, 0.066, M["pads"])
    segment(f"Forearm.{side}", elbow, wrist, 0.057, 0.046, M["uniform"])
    segment(f"GloveCuff.{side}", (0.75 * s, 0.0, 1.385), (0.79 * s, 0.0, 1.385), 0.05, 0.048, M["gloves"])
    box(f"Hand.{side}", (0.78, 0.91) if s > 0 else (-0.91, -0.78), (-0.045, 0.045), (1.36, 1.405), M["gloves"])
    segment(f"Thumb.{side}", (0.80 * s, -0.035, 1.38), (0.85 * s, -0.075, 1.378), 0.019, 0.016, M["gloves"])


# ---------------------------------------------------------------- join into a single game-ready mesh

for ob in scene.objects:
    ob.select_set(ob in PARTS)
bpy.context.view_layer.objects.active = PARTS[0]
with bpy.context.temp_override(active_object=PARTS[0], selected_objects=PARTS,
                               selected_editable_objects=PARTS):
    bpy.ops.object.join()
officer = bpy.context.view_layer.objects.active
officer.name = officer.data.name = "SWAT_Officer"
tris = sum(len(p.vertices) - 2 for p in officer.data.polygons)


# ---------------------------------------------------------------- export (before camera is added)

os.makedirs(OUT, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "swat.glb"), export_format="GLB")


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
scene.render.resolution_x = scene.render.resolution_y = 1000

cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
cam.data.lens = 60
scene.collection.objects.link(cam)
scene.camera = cam
target = Vector((0, 0, 0.95))
for view, direction in (("front", (0.0, -1.0, 0.12)), ("three_quarter", (0.7, -1.0, 0.25)),
                        ("back", (-0.6, 1.0, 0.2))):
    cam.location = target + Vector(direction).normalized() * 4.3
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(OUT, f"swat_preview_{view}.png")
    bpy.ops.render.render(write_still=True)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "swat.blend"))

print(f"SWAT_STATS tris={tris} materials={len(officer.data.materials)}")
