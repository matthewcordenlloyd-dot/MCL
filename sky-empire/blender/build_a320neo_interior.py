"""A320neo cabin + cockpit interior -> public/models/a320neo_interior.glb (+ baked lightmap)

Same coordinate frame as the exterior (origin on the ground under the main gear, nose +Y),
so the game simply parents it to the aircraft. Passenger seats are NOT baked in: a single
`seat_economy` template is exported and instanced at runtime from the cabin layout data.

Named nodes the game uses:
  disp_*        cockpit display surfaces (UV 0..1) -> live canvas instruments
  ctl_*         clickable cockpit controls (levers, knobs, buttons), origin at their pivot
  seat_captain  where the player sits to fly
Run:  npm run assets -- interior
"""
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.append(os.path.dirname(__file__))
import se_common as C  # noqa: E402
from a320_shape import AC, FLOOR_Z, L, NOSE_Y, RX, RZ, ZC, fus_shape  # noqa: E402

LM_SIZE = int(os.environ.get("SE_LM_SIZE_INT", "1024"))
SAMPLES = int(os.environ.get("SE_BAKE_SAMPLES", "128"))
LM_SCALE = 2.0
TAU = 2 * math.pi
DOOR = AC["livery"]["doors"][0]
PANES = AC["livery"]["cockpit"]["panes"]
WIN = AC["livery"]["windows"]
INSET = 0.09            # inner shell sits this far inside the skin
CAB_S0, CAB_S1 = 4.6, 31.8
CK_S0 = 0.95

C.reset_scene()

BAKED = [
    C.material("cabin_wall", C.srgb("#e7e4de"), roughness=0.6),      # 0
    C.material("cabin_carpet", C.srgb("#3a4456"), roughness=0.95),   # 1
    C.material("bin_white", C.srgb("#f1efea"), roughness=0.5),       # 2
    C.material("galley_metal", C.srgb("#b9bcc0"), roughness=0.35, metallic=0.6),  # 3
    C.material("cockpit_grey", C.srgb("#5d646d"), roughness=0.7),    # 4
    C.material("cockpit_dark", C.srgb("#24282e"), roughness=0.6),    # 5
    C.material("seat_crew", C.srgb("#2c2f35"), roughness=0.7),       # 6
    C.material("floor_dark", C.srgb("#2a2c30"), roughness=0.9),      # 7
]
WALL, CARPET, BIN, GALLEY, CKGREY, CKDARK, CREWSEAT, FLOORD = range(len(BAKED))
EMIS = [
    C.material("cabin_light", (1, 0.96, 0.9), emission=(1, 0.95, 0.88), emission_strength=4.0),
    C.material("window_sky", C.srgb("#cfe3ff"), emission=C.srgb("#cfe3ff"), emission_strength=2.5),
]
CABLIGHT, WINSKY = 0, 1


def recalc(bm, n0):
    bm.faces.ensure_lookup_table()
    fs = [bm.faces[i] for i in range(n0, len(bm.faces))]
    if fs:
        bmesh.ops.recalc_face_normals(bm, faces=fs)


def shell_point(s, th, inset=INSET):
    f, dz = fus_shape(s)
    rx, rz = RX * f - inset, RZ * f - inset
    return (rx * math.sin(th), NOSE_Y - s, ZC + dz - rz * math.cos(th))


def floor_theta(s, inset=INSET):
    """theta on the right side where the inner shell meets the floor."""
    f, dz = fus_shape(s)
    rz = RZ * f - inset
    c = max(-1.0, min(1.0, -(FLOOR_Z - ZC - dz) / rz))
    return math.acos(c)


def in_pane(s, th):
    for s0, s1, t0, t1 in PANES:
        if s0 <= s <= s1 and (t0 <= th <= t1 or t0 <= TAU - th <= t1):
            return True
    return False


def in_door(s, th):
    s0, s1 = DOOR["s"] - DOOR["width"] / 2, DOOR["s"] + DOOR["width"] / 2
    if not (s0 < s < s1) or th < math.pi:
        return False
    z_rel = -RZ * math.cos(th)
    return -DOOR["sillBelowCenterline"] - 0.05 < z_rel < -DOOR["sillBelowCenterline"] + DOOR["height"]


# ---------------------------------------------------------------- inner shell (cockpit + cabin)
def build_shell(bm):
    """Inward-facing skin from the nose to the aft bulkhead, open where windows/doors are."""
    stations = []
    s = CK_S0
    while s < 4.2:
        stations.append(round(s, 3))
        s += 0.07
    s = 4.2
    while s <= CAB_S1 + 1e-6:
        stations.append(round(s, 3))
        s += 0.4
    stations += [DOOR["s"] - DOOR["width"] / 2, DOOR["s"] + DOOR["width"] / 2]
    stations = sorted(set(stations))
    n = 96
    grid = []
    for s in stations:
        t0 = floor_theta(s)
        row = []
        for i in range(n + 1):
            th = t0 + (TAU - 2 * t0) * i / n
            row.append(bm.verts.new(shell_point(s, th)))
        grid.append((s, t0, row))
    for k in range(len(grid) - 1):
        s0, t0a, ra = grid[k]
        s1, t0b, rb = grid[k + 1]
        for i in range(n):
            sm = (s0 + s1) / 2
            th = t0a + (TAU - 2 * t0a) * (i + 0.5) / n
            if sm < CAB_S0 and in_pane(sm, th):
                continue        # cockpit windows stay open: you see out through them
            if sm < PANES[0][0] and shell_point(sm, th)[2] > ZC + 0.36:
                continue        # nose ahead of the windscreen: open above the glareshield so the view runs out over the nose
            if in_door(sm, th):
                continue
            f = bm.faces.new([ra[i], ra[i + 1], rb[i + 1], rb[i]])
            f.material_index = WALL if sm > CAB_S0 else CKGREY
    # (no radome back wall: the forward view continues out over the nose)


def section_polygon(s, x_from=None, x_to=None):
    """Closed cross-section (floor + inner shell) at station s as (x, z) points."""
    t0 = floor_theta(s)
    pts = []
    for i in range(41):
        th = t0 + (TAU - 2 * t0) * i / 40
        x, _, z = shell_point(s, th)
        pts.append((x, z))
    return pts


def bulkhead(bm, s, door_w=0.0, door_h=1.95, mat=WALL, thick=0.06):
    """Bulkhead at station s (both faces), optional centred doorway."""
    sec = section_polygon(s)
    y0, y1 = NOSE_Y - s + thick / 2, NOSE_Y - s - thick / 2
    if door_w <= 0:
        for y, rev in ((y0, False), (y1, True)):
            pts = [(x, y, z) for x, z in sec]
            if rev:
                pts.reverse()
            bm.faces.new([bm.verts.new(p) for p in pts]).material_index = mat
        return
    half = door_w / 2
    ztop = FLOOR_Z + door_h
    right = [(half, FLOOR_Z)] + [p for p in sec if p[0] > 0] + [(0, sec[20][1]), (0, ztop), (half, ztop)]
    left = [(-half, FLOOR_Z), (-half, ztop), (0, ztop), (0, sec[20][1])] + [p for p in sec if p[0] < 0]
    for poly in (right, left):
        for y, rev in ((y0, False), (y1, True)):
            pts = [(x, y, z) for x, z in poly]
            if rev:
                pts.reverse()
            n0 = len(bm.faces)
            bm.faces.new([bm.verts.new(p) for p in pts]).material_index = mat


def box(bm, s0, s1, x0, x1, z0, z1, mat):
    n0 = len(bm.faces)
    C.box(bm, ((x0 + x1) / 2, NOSE_Y - (s0 + s1) / 2, (z0 + z1) / 2), (x1 - x0, s1 - s0, z1 - z0), mat)
    recalc(bm, n0)


def prism(bm, s0, s1, poly, mat):
    """Extrude an (x, z) polygon along the fuselage between s0 and s1."""
    rings = [[(x, NOSE_Y - s, z) for x, z in poly] for s in (s0, s1)]
    n0 = len(bm.faces)
    C.loft(bm, rings, mat)
    recalc(bm, n0)


# ---------------------------------------------------------------- build static (baked) interior
main = bmesh.new()
emis = bmesh.new()
build_shell(main)

# floors
for s0, s1, mat in ((1.55, CAB_S0, FLOORD), (CAB_S0, CAB_S1, CARPET)):
    for k in range(int((s1 - s0) / 0.5) + 1):
        a = s0 + k * 0.5
        b = min(s1, a + 0.5)
        if b <= a:
            continue
        sm = (a + b) / 2
        f, dz = fus_shape(sm)
        rz = RZ * f - INSET
        zr = (FLOOR_Z - ZC - dz) / rz
        w = (RX * f - INSET) * math.sqrt(max(0.0, 1 - zr * zr))
        v = [main.verts.new(p) for p in ((-w, NOSE_Y - a, FLOOR_Z), (w, NOSE_Y - a, FLOOR_Z), (w, NOSE_Y - b, FLOOR_Z), (-w, NOSE_Y - b, FLOOR_Z))]
        face = main.faces.new(v)
        face.material_index = mat
        if face.normal.z < 0:
            face.normal_flip()

# bulkheads: cockpit (with door), aft pressure bulkhead
bulkhead(main, CAB_S0, door_w=0.82, mat=WALL)
bulkhead(main, CAB_S1, mat=WALL)

# overhead bins + ceiling + light strips
BIN_S0, BIN_S1 = 6.6, 29.4
for side in (1, -1):
    poly = [(side * 1.68, ZC + 1.42), (side * 1.06, ZC + 1.58), (side * 1.01, ZC + 1.04), (side * 1.58, ZC + 0.86)]
    if side < 0:
        poly.reverse()
    prism(main, BIN_S0, BIN_S1, poly, BIN)
    box(emis, BIN_S0, BIN_S1, side * 1.02 - 0.03, side * 1.02 + 0.03, ZC + 1.56, ZC + 1.6, CABLIGHT)
v = [main.verts.new(p) for p in ((-1.06, NOSE_Y - BIN_S0, ZC + 1.63), (1.06, NOSE_Y - BIN_S0, ZC + 1.63), (1.06, NOSE_Y - BIN_S1, ZC + 1.63), (-1.06, NOSE_Y - BIN_S1, ZC + 1.63))]
ceil = main.faces.new(v)
ceil.material_index = WALL
if ceil.normal.z > 0:
    ceil.normal_flip()

# cabin window reveals (emissive: daylight)
th_win = math.acos(-WIN["centerAboveCenterline"] / RZ)
for i in range(WIN["count"]):
    s = WIN["firstS"] + i * WIN["pitch"]
    if any(a < s < b for a, b in WIN["gaps"]):
        continue
    for th in (th_win, TAU - th_win):
        c = Vector(shell_point(s, th, INSET - 0.005))
        nrm = Vector((math.sin(th) / RX, 0, -math.cos(th) / RZ)).normalized()
        up = Vector((0, 0, 1))
        up = (up - nrm * up.dot(nrm)).normalized()
        along = Vector((0, 1, 0))
        hw, hh = WIN["width"] / 2 + 0.02, WIN["height"] / 2 + 0.02
        pts = [c + along * a + up * b for a, b in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))]
        face = emis.faces.new([emis.verts.new(p) for p in pts])
        face.material_index = WINSKY
        face.normal_update()
        if face.normal.dot(nrm) > 0:
            face.normal_flip()

# galleys and lavatories
box(main, CAB_S0 + 0.05, 5.6, 0.5, 1.35, FLOOR_Z, ZC + 1.35, GALLEY)      # forward galley (opposite door L1)
box(main, 29.6, 30.55, -1.35, -0.42, FLOOR_Z, ZC + 1.15, WALL)            # aft lavs
box(main, 29.6, 30.55, 0.42, 1.35, FLOOR_Z, ZC + 1.15, WALL)
box(main, 30.65, CAB_S1 - 0.05, -1.2, 1.2, FLOOR_Z, ZC + 1.05, GALLEY)    # aft galley

# ---------------------------------------------------------------- cockpit furniture (baked)
box(main, 2.72, 3.02, -1.15, 1.15, ZC + 0.28, ZC + 0.42, CKDARK)                 # glareshield
prism(main, 2.85, 3.05, [(-1.1, ZC - 0.32), (1.1, ZC - 0.32), (1.1, ZC + 0.3), (-1.1, ZC + 0.3)], CKGREY)  # main panel
box(main, 3.0, 4.05, -0.26, 0.26, FLOOR_Z, ZC - 0.34, CKGREY)                     # pedestal
for side in (1, -1):
    box(main, 3.15, 3.95, side * 0.82 if side > 0 else -1.28, 1.28 if side > 0 else -0.82, FLOOR_Z, ZC - 0.22, CKGREY)  # side consoles
    # crew seats
    x = side * 0.55
    box(main, 3.7, 4.15, x - 0.26, x + 0.26, FLOOR_Z, FLOOR_Z + 0.42, CKDARK)
    box(main, 3.7, 4.15, x - 0.25, x + 0.25, FLOOR_Z + 0.42, FLOOR_Z + 0.52, CREWSEAT)
    box(main, 4.08, 4.2, x - 0.25, x + 0.25, FLOOR_Z + 0.52, FLOOR_Z + 1.25, CREWSEAT)
    # sidestick
    n0 = len(main.faces)
    C.cylinder(main, (side * 0.98, NOSE_Y - 3.55, ZC - 0.22), (side * 0.98, NOSE_Y - 3.58, ZC - 0.06), 0.022, 0.03, 10, CKDARK)
    recalc(main, n0)
prism(main, 3.0, 3.85, [(-0.48, ZC + 1.25), (0.48, ZC + 1.25), (0.48, ZC + 1.5), (-0.48, ZC + 1.5)], CKGREY)  # overhead panel
# cockpit dome lights (bake only gives the cockpit a soft working light)
box(emis, 3.95, 4.35, -0.35, 0.35, ZC + 1.55, ZC + 1.58, CABLIGHT)
box(emis, 2.75, 2.8, -0.9, 0.9, ZC + 0.2, ZC + 0.22, CABLIGHT)

# ---------------------------------------------------------------- live displays (not baked)
disp = bmesh.new()
uvl = disp.loops.layers.uv.new("UVMap")
DISP_MATS = []
DISPLAYS = [("disp_pfd_c", -0.8, ZC + 0.02), ("disp_nd_c", -0.53, ZC + 0.02), ("disp_ewd", 0.0, ZC + 0.04),
            ("disp_sd", 0.0, ZC - 0.21), ("disp_nd_f", 0.53, ZC + 0.02), ("disp_pfd_f", 0.8, ZC + 0.02)]
for i, (name, x, z) in enumerate(DISPLAYS):
    DISP_MATS.append(C.material(name, (0.02, 0.02, 0.03), roughness=0.2))
    y = NOSE_Y - 3.051
    h = 0.2 if name != "disp_sd" else 0.19
    pts = [(x - 0.1, y, z - h / 2), (x + 0.1, y, z - h / 2), (x + 0.1, y, z + h / 2), (x - 0.1, y, z + h / 2)]
    face = disp.faces.new([disp.verts.new(p) for p in pts])
    face.material_index = i
    for loop, uv in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uvl].uv = uv
    face.normal_update()
    if face.normal.y > 0:   # must face aft (toward the pilots, -Y)
        face.normal_flip()
DISP_MATS.append(C.material("disp_fcu", (0.02, 0.02, 0.03), roughness=0.2))
y = NOSE_Y - 3.021
pts = [(-0.45, y, ZC + 0.3), (0.45, y, ZC + 0.3), (0.45, y, ZC + 0.4), (-0.45, y, ZC + 0.4)]
face = disp.faces.new([disp.verts.new(p) for p in pts])
face.material_index = len(DISP_MATS) - 1
for loop, uv in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
    loop[uvl].uv = uv
face.normal_update()
if face.normal.y > 0:
    face.normal_flip()

# ---------------------------------------------------------------- objects
root = C.empty("A320neo_Interior", props={"aircraft": "a320neo"})


def cull_hidden(bm):
    bm.normal_update()
    dead = [f for f in bm.faces if f.normal.z < -0.9 and f.calc_center_median().z < FLOOR_Z + 0.02]
    bmesh.ops.delete(bm, geom=dead, context="FACES")


cull_hidden(main)
o_main = C.new_object("interior_baked", main, BAKED, parent=root, sharp_angle=30)
o_emis = C.new_object("interior_emissive", emis, EMIS, parent=root, smooth=False)
o_disp = C.new_object("cockpit_displays", disp, DISP_MATS, parent=root, smooth=False)

CTL = [C.material("ctl_lever", C.srgb("#d8d8d8"), roughness=0.4), C.material("ctl_dark", C.srgb("#1b1d20"), roughness=0.5),
       C.material("ctl_amber", C.srgb("#3a2a08"), emission=C.srgb("#ffb020"), emission_strength=0.0)]


def control(name, pivot, builder, props=None):
    bm = bmesh.new()
    builder(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    obj = C.new_object(name, bm, CTL, parent=root, smooth=False)
    obj.data.transform(Matrix.Translation(-Vector(pivot)))
    obj.location = pivot
    for k, v in (props or {}).items():
        obj[k] = v
    return obj


ped_top = ZC - 0.34
for side, nm in ((-1, "L"), (1, "R")):
    px = side * 0.07
    control(f"ctl_thrust_{nm}", (px, NOSE_Y - 3.5, ped_top), lambda bm, px=px: (
        C.box(bm, (px, NOSE_Y - 3.5, ped_top + 0.1), (0.03, 0.03, 0.2), 0),
        C.box(bm, (px, NOSE_Y - 3.5, ped_top + 0.2), (0.07, 0.045, 0.04), 1)), {"control": "thrust"})
control("ctl_flaps", (0.2, NOSE_Y - 3.75, ped_top), lambda bm: (
    C.box(bm, (0.2, NOSE_Y - 3.75, ped_top + 0.06), (0.02, 0.02, 0.12), 0),
    C.box(bm, (0.2, NOSE_Y - 3.75, ped_top + 0.12), (0.06, 0.035, 0.03), 0)), {"control": "flaps"})
control("ctl_speedbrake", (-0.2, NOSE_Y - 3.75, ped_top), lambda bm: (
    C.box(bm, (-0.2, NOSE_Y - 3.75, ped_top + 0.06), (0.02, 0.02, 0.12), 0),
    C.box(bm, (-0.2, NOSE_Y - 3.75, ped_top + 0.12), (0.05, 0.03, 0.03), 1)), {"control": "speedbrake"})
control("ctl_park", (0.0, NOSE_Y - 3.95, ped_top + 0.01), lambda bm: C.cylinder(bm, (0, NOSE_Y - 3.95, ped_top), (0, NOSE_Y - 3.95, ped_top + 0.04), 0.025, 0.025, 10, 1), {"control": "parkbrake"})
control("ctl_gear", (0.26, NOSE_Y - 3.03, ZC - 0.2), lambda bm: (
    C.box(bm, (0.26, NOSE_Y - 3.06, ZC - 0.2), (0.025, 0.06, 0.025), 0),
    C.cylinder(bm, (0.26, NOSE_Y - 3.09, ZC - 0.2), (0.26, NOSE_Y - 3.11, ZC - 0.2), 0.03, 0.03, 12, 0)), {"control": "gear"})
fcu_y = NOSE_Y - 3.03
for name, x in (("ctl_spd", -0.36), ("ctl_hdg", -0.16), ("ctl_alt", 0.16), ("ctl_vs", 0.36)):
    control(name, (x, fcu_y, ZC + 0.33), lambda bm, x=x: C.cylinder(bm, (x, fcu_y, ZC + 0.33), (x, fcu_y - 0.03, ZC + 0.33), 0.018, 0.018, 12, 1), {"control": "knob"})
for name, x in (("ctl_ap1", -0.04), ("ctl_athr", 0.04)):
    control(name, (x, fcu_y, ZC + 0.37), lambda bm, x=x: C.box(bm, (x, fcu_y - 0.01, ZC + 0.37), (0.045, 0.02, 0.022), 2), {"control": "button"})

seat = C.empty("seat_captain", parent=root, props={"seat": "captain"})
seat.location = (-0.55, NOSE_Y - 3.92, ZC + 0.5)

# ---------------------------------------------------------------- economy seat template (instanced at runtime)
SEATM = [C.material("seat_fabric", C.srgb("#2d3a55"), roughness=0.85), C.material("seat_shell", C.srgb("#c9ccd1"), roughness=0.5),
         C.material("seat_headrest", C.srgb("#e8e8e8"), roughness=0.8)]
sb = bmesh.new()
C.box(sb, (0, 0.0, 0.43), (0.44, 0.46, 0.1), 0)            # cushion
C.box(sb, (0, -0.24, 0.78), (0.44, 0.08, 0.66), 0)         # backrest (facing +Y)
C.box(sb, (0, -0.285, 0.75), (0.44, 0.02, 0.6), 1)         # back shell
C.box(sb, (0, -0.21, 1.02), (0.36, 0.03, 0.2), 2)          # headrest cover
for dx in (-0.235, 0.235):
    C.box(sb, (dx, -0.02, 0.6), (0.05, 0.42, 0.04), 1)     # armrests
C.box(sb, (0, 0.05, 0.2), (0.38, 0.06, 0.38), 1)           # leg frame
bmesh.ops.recalc_face_normals(sb, faces=sb.faces[:])
seat_obj = C.new_object("seat_economy", sb, SEATM, parent=root, sharp_angle=40)
# simple baked-in shading via vertex colours (top lit, darker underneath)
col = seat_obj.data.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
for poly in seat_obj.data.polygons:
    shade = 0.55 + 0.35 * max(poly.normal.z, 0) + 0.12 * max(-poly.normal.y, 0) - 0.15 * max(-poly.normal.z, 0)
    for li in poly.loop_indices:
        col.data[li].color = (shade, shade, shade, 1)
seat_obj.location = (0, 0, FLOOR_Z)
seat_obj.hide_render = True  # not part of the bake

# ---------------------------------------------------------------- lightmap bake (sky + cabin lights, no sun)
def select_only(objs, active):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


t0 = time.time()
select_only([o_main], o_main)
o_main.data.uv_layers.new(name="Lightmap")
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.uv.select_all(action="SELECT")
bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=3.0 / LM_SIZE, shape_method="CONCAVE")
bpy.ops.object.mode_set(mode="OBJECT")
o_main["baked"] = 1
o_main["lightmap"] = "models/a320neo_interior_lm.png"
o_main["lightmapScale"] = LM_SCALE

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
world = bpy.data.worlds.new("w")
scene.world = world
bg = world.node_tree.nodes.get("Background")
bg.inputs["Color"].default_value = (*C.srgb("#bcd4f5"), 1.0)
bg.inputs["Strength"].default_value = 1.2
for o in (o_disp,):
    o.hide_render = True
for o in bpy.data.objects:
    if o.name.startswith("ctl_"):
        o.hide_render = True
img = bpy.data.images.new("lm", LM_SIZE, LM_SIZE, float_buffer=True, alpha=False)
for mat in BAKED:
    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = img
    mat.node_tree.nodes.active = node
select_only([o_main], o_main)
bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=6, use_clear=True)
print(f"BAKE done in {time.time() - t0:.1f}s")
px = np.zeros(LM_SIZE * LM_SIZE * 4, dtype=np.float32)
img.pixels.foreach_get(px)
px = px.reshape(LM_SIZE, LM_SIZE, 4)[:, :, :3]
k = np.exp(-0.5 * (np.arange(-2, 3) / 1.1) ** 2)
k /= k.sum()
tmp = sum(w * np.roll(px, i - 2, axis=0) for i, w in enumerate(k))
px = sum(w * np.roll(tmp, i - 2, axis=1) for i, w in enumerate(k))
rgb = np.clip(px / LM_SCALE, 0, 1)
enc = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(rgb, 1 / 2.4) - 0.055)
out = bpy.data.images.new("lm_out", LM_SIZE, LM_SIZE, alpha=False)
out.colorspace_settings.name = "Non-Color"
o_px = np.ones((LM_SIZE, LM_SIZE, 4), dtype=np.float32)
o_px[:, :, :3] = enc
out.pixels.foreach_set(o_px.ravel())
out.filepath_raw = os.path.join(C.MODELS, "a320neo_interior_lm.png")
out.file_format = "PNG"
out.save()
print(f"LIGHTMAP max={rgb.max():.3f} mean={rgb.mean():.3f}")
for mat in BAKED:
    for n in [n for n in mat.node_tree.nodes if n.bl_idname == "ShaderNodeTexImage"]:
        mat.node_tree.nodes.remove(n)
for o in bpy.data.objects:
    o.hide_render = False

C.stats()
C.export_glb("a320neo_interior.glb", pos_bits=16, uv_bits=14, export_vertex_color="ACTIVE")
