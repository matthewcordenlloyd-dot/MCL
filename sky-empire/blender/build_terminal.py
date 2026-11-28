"""Heathrow-inspired terminal block with a baked lightmap.

Outputs
  public/models/egll_terminal.glb     geometry (baked part has one UV set = lightmap atlas)
  public/models/egll_terminal_lm.png  lightmap (diffuse light only, sRGB-encoded, value / lightmapScale)

Local frame: origin at the terminal centre on the ground, Blender +Y = north (landside),
-Y = south (airside, facing the apron). The game places it at egll.json terminal.center.

Run:  npm run assets -- egll_terminal     (bake takes a few minutes on CPU)
Set SE_BAKE_SAMPLES=32 for a quick low-quality bake while iterating.
"""
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Vector

sys.path.append(os.path.dirname(__file__))
import se_common as C  # noqa: E402

AIRPORT = os.environ.get("SE_AIRPORT", "egll")
AP = C.load_json(f"airports/{AIRPORT}.json")
T = AP["terminal"]
SUN = AP["bakeSun"]
LM_SIZE = int(os.environ.get("SE_LM_SIZE", "2048"))
SAMPLES = int(os.environ.get("SE_BAKE_SAMPLES", "160"))
LM_SCALE = T["lightmapScale"]

HX, HY = T["sizeM"][0] / 2, T["sizeM"][1] / 2      # 150, 30
OVER = 6.0                                           # roof overhang beyond the facades
RSPAN = HY + OVER                                    # 36


def roof_under(y):
    return 16.0 + 4.0 * math.cos(math.pi * y / (2 * RSPAN))


ROOF_T = 0.8
FAC_H = roof_under(HY)          # facade height (~17.0 m)
FLOOR_Z = 0.03
DOORS_X = [-60.0, 0.0, 60.0]
DOOR_W = 6.0
DOOR_H = 3.4

C.reset_scene()

# ---------------------------------------------------------------- materials
BAKED = [
    C.material("floor_stone", C.srgb("#d2cec6"), roughness=0.25),   # 0
    C.material("concrete", C.srgb("#aaa59c"), roughness=0.85),      # 1
    C.material("roof_metal", C.srgb("#8b9197"), roughness=0.5, metallic=0.4),  # 2
    C.material("soffit_white", C.srgb("#ebe8e1"), roughness=0.8),   # 3
    C.material("steel_white", C.srgb("#dadbdc"), roughness=0.4, metallic=0.3),  # 4
    C.material("counter", C.srgb("#e9e5dd"), roughness=0.5),        # 5
    C.material("desk_dark", C.srgb("#2b2e34"), roughness=0.6),      # 6
    C.material("carpet", C.srgb("#3c4a5e"), roughness=0.95),        # 7
    C.material("seat_leather", C.srgb("#30343c"), roughness=0.55),  # 8
    C.material("wood", C.srgb("#b08a62"), roughness=0.6),           # 9
    C.material("belt_black", C.srgb("#161616"), roughness=0.7),     # 10
]
FLOOR, CONC, ROOFM, SOFFIT, STEEL, COUNTER, DESK, CARPET, SEAT, WOOD, BELT = range(len(BAKED))
EMIS = [
    C.material("light_panel", (1.0, 0.95, 0.85), emission=(1.0, 0.93, 0.82), emission_strength=7.0),  # 0
    C.material("screen_blue", C.srgb("#1e50d6"), emission=C.srgb("#2c63f0"), emission_strength=3.0),  # 1
    C.material("screen_fids", C.srgb("#0b1530"), emission=C.srgb("#13244d"), emission_strength=2.0),  # 2
    C.material("shop_sign", C.srgb("#f5a30b"), emission=C.srgb("#ffb21a"), emission_strength=3.0),    # 3
]
LIGHT, SCREEN, FIDS, SHOP = range(len(EMIS))
GLASS = [C.material("glass", C.srgb("#9fb7c4"), roughness=0.05, metallic=0.0, alpha=0.28)]
GLASS[0].use_backface_culling = False


def recalc(bm, n0):
    bm.faces.ensure_lookup_table()
    faces = [bm.faces[i] for i in range(n0, len(bm.faces))]
    if faces:
        bmesh.ops.recalc_face_normals(bm, faces=faces)


class Part:
    def __init__(self):
        self.bm = bmesh.new()

    def box(self, center, size, mat, rot_z=0.0):
        C.box(self.bm, center, size, mat, rot_z)

    def cyl(self, p0, p1, r0, r1=None, seg=12, mat=0):
        n0 = len(self.bm.faces)
        C.cylinder(self.bm, p0, p1, r0, r1, seg, mat)
        recalc(self.bm, n0)


main = Part()
props = Part()   # small repeated objects get a lower lightmap density
emis = Part()
glass = Part()
cols = []          # collision boxes: (center, size)


def col_box(center, size):
    cols.append((center, size))


# ---------------------------------------------------------------- shell
main.box((0, 0, (FLOOR_Z - 0.3) / 2), (2 * HX, 2 * HY, FLOOR_Z + 0.3), FLOOR)


def wave_solid(bm, y_samples, x0, x1, z_of_y, thick, mat, top=True):
    """Extruded curved slab spanning x0..x1. Returns faces."""
    n0 = len(bm.faces)
    rings = []
    for x in (x0, x1):
        lower = [(x, y, z_of_y(y)) for y in y_samples]
        upper = [(x, y, z_of_y(y) + thick) for y in reversed(y_samples)]
        rings.append(lower + upper)
    C.loft(bm, rings, mat)
    recalc(bm, n0)


ys = [(-RSPAN + 2 * RSPAN * i / 24) for i in range(25)]
roof_top_part = Part()
roof_under_part = Part()
# roof top (exterior) and underside (interior soffit) are separate so their
# lightmap texel density can differ.
for i in range(len(ys) - 1):
    y0, y1 = ys[i], ys[i + 1]
    bm = roof_top_part.bm
    v = [bm.verts.new(p) for p in ((-HX - 4, y0, roof_under(y0) + ROOF_T), (HX + 4, y0, roof_under(y0) + ROOF_T),
                                   (HX + 4, y1, roof_under(y1) + ROOF_T), (-HX - 4, y1, roof_under(y1) + ROOF_T))]
    bm.faces.new(v).material_index = ROOFM
    bm = roof_under_part.bm
    v = [bm.verts.new(p) for p in ((-HX - 4, y0, roof_under(y0)), (-HX - 4, y1, roof_under(y1)),
                                   (HX + 4, y1, roof_under(y1)), (HX + 4, y0, roof_under(y0)))]
    bm.faces.new(v).material_index = SOFFIT
# roof edge fascia
for s in (-1, 1):
    y = s * RSPAN
    main.box((0, y, roof_under(y) + ROOF_T / 2), (2 * HX + 8, 0.2, ROOF_T), STEEL)
for s in (-1, 1):
    bm = main.bm
    n0 = len(bm.faces)
    prof_lo = [(s * (HX + 4), y, roof_under(y)) for y in ys]
    prof_hi = [(s * (HX + 4), y, roof_under(y) + ROOF_T) for y in reversed(ys)]
    f = bm.faces.new([bm.verts.new(p) for p in prof_lo + prof_hi])
    f.material_index = STEEL
    recalc(bm, n0)

# end walls following the roof curve
for s in (-1, 1):
    bm = main.bm
    n0 = len(bm.faces)
    yy = [(-HY + 2 * HY * i / 12) for i in range(13)]
    rings = []
    for x in (s * HX - 0.3, s * HX + 0.3):
        rings.append([(x, y, FLOOR_Z) for y in (yy[0], yy[-1])] + [(x, y, roof_under(y)) for y in reversed(yy)])
    C.loft(bm, rings, CONC)
    recalc(bm, n0)
    col_box((s * HX, 0, 9), (0.6, 2 * HY, 18))

# facades: mullions, transoms, glass with door openings
TRANSOMS = [DOOR_H, 6.8, 10.2, 13.6]
for s in (-1, 1):
    y = s * HY
    x = -HX
    while x <= HX + 0.01:
        props.box((x, y, FAC_H / 2), (0.16, 0.32, FAC_H), STEEL)
        x += 3.0
    for z in TRANSOMS:
        props.box((0, y, z), (2 * HX, 0.3, 0.14), STEEL)
    main.box((0, y, 0.1 + FLOOR_Z), (2 * HX, 0.35, 0.2), STEEL)
    # glass: bottom row per bay (skip doors), one sheet above
    bm = glass.bm
    for i in range(100):
        x0, x1 = -HX + 3 * i, -HX + 3 * (i + 1)
        xm = (x0 + x1) / 2
        if any(abs(xm - dx) < DOOR_W / 2 for dx in DOORS_X):
            continue
        v = [bm.verts.new(p) for p in ((x0, y, FLOOR_Z), (x1, y, FLOOR_Z), (x1, y, DOOR_H), (x0, y, DOOR_H))]
        bm.faces.new(v).material_index = 0
    v = [bm.verts.new(p) for p in ((-HX, y, DOOR_H), (HX, y, DOOR_H), (HX, y, FAC_H), (-HX, y, FAC_H))]
    bm.faces.new(v).material_index = 0
    # door frames + collision for the glass wall segments
    edges = [-HX] + sum(([dx - DOOR_W / 2, dx + DOOR_W / 2] for dx in DOORS_X), []) + [HX]
    for a, b in zip(edges[0::2], edges[1::2]):
        col_box(((a + b) / 2, y, 9), (b - a, 0.4, 18))
    for dx in DOORS_X:
        col_box((dx, y, (DOOR_H + 18) / 2), (DOOR_W, 0.4, 18 - DOOR_H))
        for e in (-1, 1):
            props.box((dx + e * DOOR_W / 2, y, DOOR_H / 2), (0.3, 0.5, DOOR_H), STEEL)
        # door mats
        main.box((dx, y, FLOOR_Z + 0.005), (DOOR_W, 4.0, 0.01), BELT)

# tree columns
for k in range(9):
    x = -144 + 36 * k
    for s in (-1, 1):
        y = s * 14.0
        main.cyl((x, y, FLOOR_Z), (x, y, 9.5), 0.55, 0.45, 16, STEEL)
        for bx, by in ((-6, -5), (6, -5), (-6, 5), (6, 5)):
            tx, ty = x + bx, y + by
            main.cyl((x, y, 9.3), (tx, ty, roof_under(ty) + 0.1), 0.22, 0.16, 8, STEEL)
        col_box((x, y, 5), (1.2, 1.2, 10))

# ---------------------------------------------------------------- landside: check-in islands
for ix in (-105, -35, 35, 105):
    y = 18.0
    main.box((ix, y, 0.55), (44, 3.0, 1.05), COUNTER)
    main.box((ix, y, 1.09), (44, 1.0, 0.04), BELT)
    main.box((ix, y, 1.8), (44, 0.4, 2.6), DESK)
    emis.box((ix, y, 3.4), (44, 0.5, 0.8), SCREEN)
    for side in (-1, 1):
        for k in range(18):
            dx = ix - 20 + k * 2.35
            emis.box((dx, y + side * 1.3, 1.25), (0.42, 0.05, 0.28), SCREEN)
        # queue posts
        for k in range(10):
            props.cyl((ix - 18 + k * 4, y + side * 6.0, FLOOR_Z), (ix - 18 + k * 4, y + side * 6.0, 1.0), 0.04, None, 6, STEEL)
    col_box((ix, y, 1.3), (44, 3.0, 2.6))

# security arches and scanners
for k in range(8):
    x = -21 + k * 6
    props.box((x, 6.0, 1.2), (0.2, 0.8, 2.4), STEEL)
    props.box((x + 1.1, 6.0, 1.2), (0.2, 0.8, 2.4), STEEL)
    props.box((x + 0.55, 6.0, 2.45), (1.3, 0.8, 0.2), STEEL)
    main.box((x + 3.3, 6.0, 0.6), (1.2, 3.4, 1.2), DESK)
    col_box((x + 3.3, 6.0, 0.6), (1.2, 3.4, 1.2))
emis.box((0, 6.0, 4.2), (14, 0.2, 1.0), SCREEN)

# flight information boards
for x in (-70, 0, 70):
    emis.box((x, 10.0, 7.0), (14, 0.3, 4.0), FIDS)
    for e in (-6.5, 6.5):
        main.box((x + e, 10.0, 2.5), (0.3, 0.3, 5.0), STEEL)
        col_box((x + e, 10.0, 2.5), (0.4, 0.4, 5))

# ---------------------------------------------------------------- central band: shops
for x in (-90, -30, 30, 90):
    main.box((x, 0.0, 2.0), (10, 6, 4.0), WOOD)
    main.box((x, 0.0, 4.05), (10.4, 6.4, 0.1), STEEL)
    for s in (-1, 1):
        emis.box((x, s * 3.02, 3.4), (8, 0.06, 0.7), SHOP)
    col_box((x, 0, 2), (10, 6, 4))

# ---------------------------------------------------------------- airside: gate seating
for gx in (-130, -90, -30, 30, 90, 130):
    main.box((gx, -18.0, FLOOR_Z + 0.005), (26, 14, 0.012), CARPET)
    for r in range(4):
        y = -13.5 - r * 2.6
        props.box((gx, y + 0.05, 0.25), (12 * 0.56, 0.1, 0.1), STEEL)
        for e in (-1, 1):
            props.box((gx + e * 3.0, y + 0.05, 0.12), (0.1, 0.4, 0.24), STEEL)
        for k in range(12):
            x = gx - 6 * 0.56 + 0.28 + k * 0.56
            props.box((x, y, 0.45), (0.5, 0.5, 0.08), SEAT)
            props.box((x, y + 0.24, 0.72), (0.5, 0.07, 0.5), SEAT)
        col_box((gx, y + 0.05, 0.5), (12 * 0.56, 0.6, 1.0))
# gate desks next to each airside door
for dx in DOORS_X:
    for e in (-1, 1):
        main.box((dx + e * 6, -25.5, 0.55), (3.0, 1.0, 1.1), COUNTER)
        emis.box((dx + e * 6, -25.0, 2.2), (1.4, 0.06, 0.8), SCREEN)
        col_box((dx + e * 6, -25.5, 0.55), (3.0, 1.0, 1.1))

# ---------------------------------------------------------------- pendant lights
for y in (-22, -8, 8, 22):
    x = -144
    while x <= 144.1:
        emis.box((x, y, 11.0), (5.0, 1.0, 0.12), LIGHT)
        x += 12
# landside canopy downlights
for x in range(-144, 145, 12):
    emis.box((x, HY + 3.0, roof_under(HY + 3.0) - 0.05), (1.2, 1.2, 0.06), LIGHT)
    emis.box((x, -HY - 3.0, roof_under(HY + 3.0) - 0.05), (1.2, 1.2, 0.06), LIGHT)

# ---------------------------------------------------------------- objects
def cull_hidden(bm, below):
    """Remove downward faces on/under the floor: never visible, they only waste lightmap space."""
    bm.normal_update()
    dead = [f for f in bm.faces if f.normal.z < -0.9 and f.calc_center_median().z < below]
    bmesh.ops.delete(bm, geom=dead, context="FACES")


cull_hidden(main.bm, 0.2)
cull_hidden(props.bm, 0.2)

root = C.empty("Terminal", props={"airport": AP["icao"]})
o_main = C.new_object("terminal_baked", main.bm, BAKED, parent=root, sharp_angle=35)
o_props = C.new_object("terminal_props", props.bm, BAKED, parent=root, sharp_angle=35)
o_rtop = C.new_object("terminal_roof_top", roof_top_part.bm, BAKED, parent=root, smooth=False)
o_rund = C.new_object("terminal_roof_under", roof_under_part.bm, BAKED, parent=root, smooth=False)
o_emis = C.new_object("terminal_emissive", emis.bm, EMIS, parent=root, smooth=False)
o_glass = C.new_object("terminal_glass", glass.bm, GLASS, parent=root, smooth=False)

col_root = C.empty("COL", parent=root, props={"collision": "hulls"})
for i, (c, s) in enumerate(cols):
    bm = bmesh.new()
    C.box(bm, c, s)
    C.new_object(f"COL_{i:03d}", bm, [], parent=col_root, smooth=False)


# ---------------------------------------------------------------- lightmap UVs
def select_only(objs, active):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def smart_uv(obj, scale):
    select_only([obj], obj)
    obj.data.uv_layers.new(name="Lightmap")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    if scale != 1.0:
        uvl = obj.data.uv_layers["Lightmap"].data
        arr = np.zeros(len(uvl) * 2, dtype=np.float32)
        uvl.foreach_get("uv", arr)
        uvl.foreach_set("uv", arr * scale)


t0 = time.time()
smart_uv(o_main, 1.0)
smart_uv(o_props, 0.4)
smart_uv(o_rtop, 0.2)
smart_uv(o_rund, 0.5)
select_only([o_main, o_props, o_rtop, o_rund], o_main)
bpy.ops.object.join()
o_bake = bpy.context.view_layer.objects.active
o_bake.name = "terminal_baked"
o_bake["baked"] = 1
o_bake["lightmap"] = T["lightmap"]
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.select_all(action="SELECT")
margin = 3.0 / LM_SIZE
bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, margin_method="FRACTION", margin=margin, shape_method="CONCAVE")
bpy.ops.object.mode_set(mode="OBJECT")
print(f"UV done in {time.time() - t0:.1f}s; islands packed for {LM_SIZE}px")

# ---------------------------------------------------------------- bake lighting
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = False
scene.render.bake.margin = 6
scene.render.bake.use_clear = True

world = bpy.data.worlds.new("bake_world")
scene.world = world
bg = world.node_tree.nodes.get("Background")
bg.inputs["Color"].default_value = (*C.srgb("#9cc3ff"), 1.0)
bg.inputs["Strength"].default_value = SUN["skyStrength"]

sun_data = bpy.data.lights.new("sun", "SUN")
sun_data.energy = SUN["strength"]
sun_data.angle = math.radians(0.6)
sun = bpy.data.objects.new("sun", sun_data)
scene.collection.objects.link(sun)
az, el = math.radians(SUN["azimuthDeg"]), math.radians(SUN["elevationDeg"])
to_sun = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
sun.rotation_mode = "QUATERNION"
sun.rotation_quaternion = to_sun.to_track_quat("Z", "Y")

# Glass does not block light in the bake; collision meshes are not part of the scene light.
o_glass.hide_render = True
for o in bpy.data.objects:
    if o.name.startswith("COL"):
        o.hide_render = True
# Ground around the building so it receives bounce light from the apron.
gbm = bmesh.new()
C.box(gbm, (0, -60, -0.25), (800, 600, 0.5), 0)
ground = C.new_object("bake_ground", gbm, [C.material("bake_ground", C.srgb("#8f8f8a"), roughness=0.9)], smooth=False)

img = bpy.data.images.new("lightmap", LM_SIZE, LM_SIZE, float_buffer=True, alpha=False)
img.colorspace_settings.name = "Linear Rec.709"
for mat in BAKED:
    nt = mat.node_tree
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = img
    nt.nodes.active = node

select_only([o_bake], o_bake)
t0 = time.time()
bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=6, use_clear=True)
print(f"BAKE done in {time.time() - t0:.1f}s ({SAMPLES} samples, {LM_SIZE}px)")

# encode: value / LM_SCALE -> sRGB 8-bit PNG
px = np.zeros(LM_SIZE * LM_SIZE * 4, dtype=np.float32)
img.pixels.foreach_get(px)
px = px.reshape(LM_SIZE, LM_SIZE, 4)
def blur(a, sigma=1.1, r=2):
    """Small separable Gaussian to knock down bake noise (islands have margins, so bleed is minimal)."""
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    tmp = np.zeros_like(a)
    for i, w in enumerate(k):
        tmp += w * np.roll(a, i - r, axis=0)
    out = np.zeros_like(a)
    for i, w in enumerate(k):
        out += w * np.roll(tmp, i - r, axis=1)
    return out


rgb = np.clip(blur(px[:, :, :3]) / LM_SCALE, 0.0, 1.0)
srgb_v = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
out = bpy.data.images.new("lightmap_out", LM_SIZE, LM_SIZE, alpha=False)
out.colorspace_settings.name = "Non-Color"
o_px = np.ones((LM_SIZE, LM_SIZE, 4), dtype=np.float32)
o_px[:, :, :3] = srgb_v
out.pixels.foreach_set(o_px.ravel())
out.filepath_raw = os.path.join(C.MODELS, os.path.basename(T["lightmap"]))
out.file_format = "PNG"
out.save()
print(f"LIGHTMAP saved {out.filepath_raw} max={rgb.max():.3f} mean={rgb.mean():.3f}")

# clean up bake-only data before export
for mat in BAKED:
    nt = mat.node_tree
    for n in [n for n in nt.nodes if n.bl_idname == "ShaderNodeTexImage"]:
        nt.nodes.remove(n)
bpy.data.objects.remove(ground)
bpy.data.objects.remove(sun)
o_glass.hide_render = False

C.stats()
C.export_glb(f"{AIRPORT}_terminal.glb", pos_bits=18, uv_bits=16)
