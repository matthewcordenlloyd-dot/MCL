"""Generates a Global 7500-class business jet -> public/models/gl7t.glb

Run:  npm run assets -- gl7t

Exterior (3 LODs + gear, fans, cabin door and collision hulls) and the interior
(cockpit with live displays and clickable controls, VIP cabin) in one file.
Same conventions as the A320: nose points +Y (three.js -Z), origin on the ground
under the main gear, cylindrical fuselage UV (u = s/length, v = theta/2pi) for the
runtime livery painter, planar UV on the fin for tail art.
The interior is not lightmapped: the runtime lights it (lit materials + soft glow).
"""
import math
import os
import sys

import bmesh
from mathutils import Matrix, Vector

sys.path.append(os.path.dirname(__file__))
import se_common as C  # noqa: E402

AC = C.load_json("aircraft/gl7t.json")
L = AC["dimensions"]["length"]
RX = AC["dimensions"]["fuselageWidth"] / 2
RZ = AC["dimensions"]["fuselageHeight"] / 2
NOSE_Y = AC["model"]["noseY"]
ZC = AC["model"]["centerlineHeight"]
FLOOR_Z = ZC - AC["model"]["cabinFloorBelowCenterline"]
NOSE = [tuple(p) for p in AC["model"]["profile"]["nose"]]
TAIL = [tuple(p) for p in AC["model"]["profile"]["tail"]]
RISE = AC["model"]["profile"]["tailCentreRise"]
DOOR = AC["livery"]["doors"][0]
PANES = AC["livery"]["cockpit"]["panes"]
WIN = AC["livery"]["windows"]
I = AC["model"]["interior"]
CK_BULK, AFT_BULK = I["cockpitBulkheadS"], I["aftBulkheadS"]
TAU = 2 * math.pi
INSET = 0.08
SPAN2 = AC["dimensions"]["span"] / 2

C.reset_scene()

MATS = [
    C.material("fuselage_livery", (0.9, 0.9, 0.9), roughness=0.3),                 # 0
    C.material("wing_grey", C.srgb("#c3c8ce"), roughness=0.4, metallic=0.25),       # 1
    C.material("paint_brand", C.srgb("#0b2545"), roughness=0.35),                  # 2
    C.material("metal_bright", (0.85, 0.86, 0.88), roughness=0.22, metallic=1.0),  # 3
    C.material("metal_dark", (0.04, 0.04, 0.045), roughness=0.45, metallic=0.6),   # 4
    C.material("tyre", (0.025, 0.025, 0.025), roughness=0.92),                     # 5
    C.material("gear_white", (0.75, 0.75, 0.75), roughness=0.4, metallic=0.4),     # 6
    C.material("tail_livery", C.srgb("#0b2545"), roughness=0.33),                  # 7
    C.material("exhaust", (0.12, 0.11, 0.1), roughness=0.6, metallic=0.8),         # 8
]
M_FUS, M_WING, M_BRAND, M_METAL, M_DARK, M_TYRE, M_GEAR, M_TAIL, M_EXH = range(9)
MATS[4].use_backface_culling = False


def recalc(bm, n0):
    bm.faces.ensure_lookup_table()
    fs = [bm.faces[i] for i in range(n0, len(bm.faces))]
    if fs:
        bmesh.ops.recalc_face_normals(bm, faces=fs)


def fus_shape(s):
    if s <= NOSE[-1][0]:
        for (a, fa, za), (b, fb, zb) in zip(NOSE, NOSE[1:]):
            if a <= s <= b:
                t = (s - a) / (b - a)
                return fa + (fb - fa) * t, za + (zb - za) * t
        return NOSE[0][1], NOSE[0][2]
    if s >= TAIL[0][0]:
        for (a, fa), (b, fb) in zip(TAIL, TAIL[1:]):
            if a <= s <= b:
                t = (s - a) / (b - a)
                f = fa + (fb - fa) * t
                return f, RZ * (1 - f) * RISE
        return TAIL[-1][1], RZ * (1 - TAIL[-1][1]) * RISE
    return 1.0, 0.0


DOOR_S0 = DOOR["s"] - DOOR["width"] / 2 - 0.02
DOOR_S1 = DOOR["s"] + DOOR["width"] / 2 + 0.02
DOOR_TH0 = TAU - math.acos(max(-1.0, min(1.0, -(-DOOR["sillBelowCenterline"] + DOOR["height"]) / RZ)))
DOOR_TH1 = TAU - math.acos(max(-1.0, min(1.0, DOOR["sillBelowCenterline"] / RZ)))


# ---------------------------------------------------------------- exterior
def fuselage(bm, uv, lod):
    seg = [40, 20, 12][lod]
    if lod == 0:
        st = [0, 0.2, 0.55, 1.0, 1.35, 1.75, 2.05, 2.35, 2.65, 3.0, 3.35, 3.7, 4.0, 4.4, DOOR_S0, DOOR_S1, 5.6]
        st += [5.6 + i * 1.0 for i in range(1, 18)] + [23.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0, 30.0, 31.0, 31.8, 32.5, 33.0, 33.4, 33.8]
    elif lod == 1:
        st = [0, 0.55, 1.35, 2.35, 3.35, 4.8, 9, 14, 19, 23, 25, 27, 29, 31, 32.5, 33.8]
    else:
        st = [0, 1.0, 2.4, 4.8, 23, 28, 32, 33.8]
    st = sorted(set(round(s, 3) for s in st))
    rings, uvs = [], []
    for s in st:
        f, dz = fus_shape(s)
        ring, ruv = [], []
        for i in range(seg):
            th = TAU * i / seg
            ring.append((RX * f * math.sin(th), NOSE_Y - s, ZC + dz - RZ * f * math.cos(th)))
            ruv.append((s / L, th / TAU))
        rings.append(ring)
        uvs.append(ruv)
    n0 = len(bm.faces)
    C.loft(bm, rings, M_FUS, uvs=uvs, uv_layer=uv)
    recalc(bm, n0)
    if lod == 0:
        bm.faces.ensure_lookup_table()
        dead = []
        for i in range(n0, len(bm.faces)):
            c = bm.faces[i].calc_center_median()
            s = NOSE_Y - c.y
            if not (DOOR_S0 < s < DOOR_S1) or c.x > 0:
                continue
            th = math.atan2(c.x / RX, -(c.z - ZC) / RZ) % TAU
            if DOOR_TH0 < th < DOOR_TH1:
                dead.append(bm.faces[i])
        bmesh.ops.delete(bm, geom=dead, context="FACES")
    # wing-to-body fairing
    n0 = len(bm.faces)
    C.ellipsoid(bm, (0, NOSE_Y - 17.6, ZC - 0.95), (1.25, 4.6, 0.55), segments=[20, 12, 8][lod], rings=[10, 6, 4][lod], mat_index=M_FUS)
    recalc(bm, n0)


def airfoil(n, tc, camber=0.02):
    xs = [0.5 * (1 - math.cos(math.pi * i / (n - 1))) for i in range(n)]

    def yt(x):
        return 5 * tc * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4)

    def yc(x):
        return camber * (2 * 0.4 * x - x * x) / 0.16 if x < 0.4 else camber * ((1 - 0.8) + 0.8 * x - x * x) / 0.36

    upper = [(x, yc(x) + yt(x)) for x in reversed(xs)]
    lower = [(x, yc(x) - yt(x)) for x in xs[1:-1]]
    return upper + lower


def section(le, chord, tc, twist_deg, n, up=(0, 0, 1), camber=0.02):
    pts = []
    tw = math.radians(twist_deg)
    up = Vector(up)
    cdir = Vector((0, -1, 0))
    for xc, zc in airfoil(n, tc, camber):
        dx, dz = xc * chord, zc * chord
        rx = dx * math.cos(tw) + dz * math.sin(tw)
        rz = -dx * math.sin(tw) + dz * math.cos(tw)
        pts.append(tuple(Vector(le) + cdir * rx + up * rz))
    return pts


WING_ROOT_S = 14.6      # leading edge at the root
WING_SWEEP = 0.62       # LE moves aft this much per metre of span
WING_Z = ZC - 0.85


def wing_le(x):
    return NOSE_Y - WING_ROOT_S - (x - 1.2) * WING_SWEEP


def wing(bm, side, lod):
    n = [14, 8, 5][lod]
    dih = math.tan(math.radians(3.5))
    xs = [1.2, 3.5, 6.0, 9.5, 13.0, SPAN2 - 0.6] if lod == 0 else ([1.2, 6.0, SPAN2 - 0.6] if lod == 1 else [1.2, SPAN2 - 0.6])
    secs = []
    for x in xs:
        t = (x - 1.2) / (SPAN2 - 1.8)
        chord = 5.4 + (1.35 - 5.4) * (t ** 0.85)
        tc = 0.14 - 0.04 * t
        secs.append(section((side * x, wing_le(x), WING_Z + (x - 1.2) * dih), chord, tc, 2.5 - 4.0 * t, n))
    # blended winglet curving up
    tip_x = SPAN2 - 0.6
    tip_le = Vector((tip_x, wing_le(tip_x), WING_Z + (tip_x - 1.2) * dih))
    steps = [0.35, 0.7, 1.0] if lod == 0 else [1.0]
    for k in steps:
        phi = math.radians(80) * k
        le = tip_le + Vector((0.55 * math.sin(phi), -0.5 * k, 0.55 * (1 - math.cos(phi)) + 0.7 * k * k))
        upv = (-side * math.sin(phi), 0, math.cos(phi))
        secs.append(section((side * le.x, le.y, le.z), 1.3 - 0.55 * k, 0.09, -1, n, up=upv, camber=0.0))
    n0 = len(bm.faces)
    C.loft(bm, secs, M_WING)
    recalc(bm, n0)


def engine(bm, side, lod, fan_bm):
    seg = [28, 14, 10][lod]
    x, zc, y_in = side * 2.3, ZC + 0.55, NOSE_Y - 25.4
    outer = [(-4.4, 0.42), (-4.0, 0.55), (-3.2, 0.68), (-2.0, 0.73), (-0.8, 0.73), (-0.2, 0.7), (0.0, 0.64)]
    C.lathe(bm, [(y_in + t, r) for t, r in outer], (x, 0, zc), "Y", seg, M_BRAND)
    C.lathe(bm, [(y_in - 0.08, 0.6), (y_in, 0.64)], (x, 0, zc), "Y", seg, M_METAL, flip=True)
    C.lathe(bm, [(y_in - 0.6, 0.58), (y_in - 0.08, 0.6)], (x, 0, zc), "Y", seg, M_DARK, flip=True)
    C.lathe(bm, [(y_in - 0.62, 0.58), (y_in - 0.61, 0.2)], (x, 0, zc), "Y", seg, M_DARK, flip=True)
    C.lathe(fan_bm, [(y_in - 0.6, 0.2), (y_in - 0.42, 0.13), (y_in - 0.25, 0.0)], (x, 0, zc), "Y", seg, M_DARK)
    if lod == 0:
        for b in range(16):
            a = TAU * b / 16
            pts = []
            for r, sgn in ((0.2, -1), (0.2, 1), (0.57, 1), (0.57, -1)):
                w = 0.08 if r < 0.3 else 0.12
                da = sgn * w / r * 0.5
                pts.append((x + math.cos(a + da) * r, y_in - 0.6 + sgn * w * 0.3, zc + math.sin(a + da) * r))
            f = fan_bm.faces.new([fan_bm.verts.new(p) for p in pts])
            f.material_index = M_DARK
    C.lathe(bm, [(y_in - 4.9, 0.0), (y_in - 4.6, 0.2), (y_in - 4.4, 0.36)], (x, 0, zc), "Y", seg, M_EXH)
    # pylon to the fuselage
    n0 = len(bm.faces)
    C.box(bm, (side * 1.55, y_in - 2.4, zc + 0.05), (1.3, 2.2, 0.3), M_WING)
    recalc(bm, n0)


def fin(bm, uv, lod):
    n = [12, 8, 5][lod]
    z0, z1 = ZC + 1.0, AC["dimensions"]["height"] - 0.25
    zs = [z0, (z0 + z1) / 2, z1] if lod < 2 else [z0, z1]
    secs = []
    le0 = NOSE_Y - 26.2
    for z in zs:
        t = (z - z0) / (z1 - z0)
        chord = 5.2 + (2.7 - 5.2) * t
        secs.append(section((0, le0 - (z - z0) * 0.9, z), chord, 0.1, 0, n, up=(1, 0, 0), camber=0.0))
    n0 = len(bm.faces)
    C.loft(bm, secs, M_TAIL)
    recalc(bm, n0)
    bm.faces.ensure_lookup_table()
    y0, y1 = le0 + 0.1, le0 - (z1 - z0) * 0.9 - 2.7
    for i in range(n0, len(bm.faces)):
        for loop in bm.faces[i].loops:
            co = loop.vert.co
            loop[uv].uv = ((y0 - co.y) / (y0 - y1), (co.z - z0) / (z1 - z0))
    # T-tail stabiliser on top
    top_le = le0 - (z1 - z0) * 0.9
    for side in (1, -1):
        hs = []
        for x in ([0.0, 2.4, 4.6] if lod < 2 else [0.0, 4.6]):
            t = x / 4.6
            hs.append(section((side * x, top_le + 0.3 - x * 0.75, z1 - 0.05 + x * 0.03), 2.8 + (1.2 - 2.8) * t, 0.1, 0, n, camber=-0.01))
        n0 = len(bm.faces)
        C.loft(bm, hs, M_TAIL)
        recalc(bm, n0)


def wheel(bm, center, radius, width, lod):
    seg = [18, 12, 8][lod]
    cx, cy, cz = center
    C.cylinder(bm, (cx - width / 2, cy, cz), (cx + width / 2, cy, cz), radius, segments=seg, mat_index=M_TYRE)
    C.cylinder(bm, (cx - width / 2 - 0.01, cy, cz), (cx + width / 2 + 0.01, cy, cz), radius * 0.55, segments=seg, mat_index=M_GEAR)


def gear(bm, lod):
    for side in (1, -1):
        x = side * 2.1
        for dx in (-0.26, 0.26):
            wheel(bm, (x + dx, 0, 0.46), 0.46, 0.3, lod)
        C.cylinder(bm, (x, 0, 0.46), (x * 0.85, -0.1, WING_Z), 0.1, segments=[10, 8, 6][lod], mat_index=M_GEAR)
    ny = NOSE_Y - 2.9
    for dx in (-0.17, 0.17):
        wheel(bm, (dx, ny, 0.3), 0.3, 0.17, lod)
    C.cylinder(bm, (0, ny, 0.3), (0, ny + 0.1, ZC - 0.9), 0.07, segments=[10, 8, 6][lod], mat_index=M_GEAR)


def build_lod(lod):
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    gear_bm = bmesh.new()
    fans = {}
    fuselage(bm, uv, lod)
    for side in (1, -1):
        wing(bm, side, lod)
        fans[side] = bmesh.new()
        engine(bm, side, lod, fans[side])
    fin(bm, uv, lod)
    gear(gear_bm, lod)
    return bm, gear_bm, fans


def pivoted(name, bm, mats, parent, pivot, **kw):
    obj = C.new_object(name, bm, mats, parent=parent, **kw)
    obj.data.transform(Matrix.Translation(-Vector(pivot)))
    obj.location = pivot
    return obj


root = C.empty("GL7T", props={"aircraft": "gl7t"})
for lod in range(3):
    e = C.empty(f"LOD{lod}", parent=root)
    bm, gear_bm, fans = build_lod(lod)
    C.new_object(f"gl7t_lod{lod}", bm, MATS, parent=e, sharp_angle=[38, 45, 55][lod])
    C.new_object(f"gear_lod{lod}", gear_bm, MATS, parent=e, sharp_angle=45)
    for side, nm in ((1, "R"), (-1, "L")):
        pivoted(f"fan_{nm}_lod{lod}", fans[side], MATS, e, (side * 2.3, NOSE_Y - 25.4 - 0.6, ZC + 0.55), smooth=False)

# airstair door, hinged at the bottom (opens down and outward)
door_bm = bmesh.new()
C.box(door_bm, (-RX - 0.02, NOSE_Y - DOOR["s"], ZC - DOOR["sillBelowCenterline"] + DOOR["height"] / 2), (0.06, DOOR["width"], DOOR["height"]), M_GEAR)
pivoted("door_L1", door_bm, MATS, root, (-RX - 0.02, NOSE_Y - DOOR_S0, ZC), smooth=False)

col = C.empty("COL", parent=root, props={"collision": "hulls"})


def hull(name, builder):
    bm = bmesh.new()
    builder(bm)
    C.new_object(name, bm, [], parent=col, smooth=False)


hull("COL_fuselage_front", lambda bm: C.cylinder(bm, (0, NOSE_Y - 0.3, ZC - 0.3), (0, NOSE_Y - 5, ZC), RX, RX, 12))
hull("COL_fuselage_mid", lambda bm: C.cylinder(bm, (0, NOSE_Y - 5, ZC), (0, NOSE_Y - 23, ZC), RX, RX, 12))
hull("COL_fuselage_tail", lambda bm: C.cylinder(bm, (0, NOSE_Y - 23, ZC), (0, NOSE_Y - 33.6, ZC + 1.0), RX, 0.2, 12))
for side, nm in ((1, "R"), (-1, "L")):
    hull(f"COL_wing_{nm}", lambda bm, s=side: C.box(bm, (s * 8.5, NOSE_Y - 19.5, WING_Z + 0.25), (14.5, 4.0, 0.5), rot_z=s * math.radians(-30)))
    hull(f"COL_engine_{nm}", lambda bm, s=side: C.cylinder(bm, (s * 2.3, NOSE_Y - 25.4, ZC + 0.55), (s * 2.3, NOSE_Y - 29.8, ZC + 0.55), 0.73, 0.4, 12))
    hull(f"COL_gear_{nm}", lambda bm, s=side: C.box(bm, (s * 2.1, 0, 0.6), (0.9, 1.0, 1.2)))
hull("COL_fin", lambda bm: C.box(bm, (0, NOSE_Y - 29.5, ZC + 3.2), (0.5, 5.0, 4.6)))
hull("COL_nosegear", lambda bm: C.box(bm, (0, NOSE_Y - 2.9, 0.6), (0.5, 0.7, 1.2)))


# ---------------------------------------------------------------- interior
IMATS = [
    C.material("vip_wall", C.srgb("#efe9df"), roughness=0.7),        # 0
    C.material("vip_carpet", C.srgb("#6b5a4a"), roughness=0.95),     # 1
    C.material("vip_leather", C.srgb("#d8c7a8"), roughness=0.55),    # 2
    C.material("vip_veneer", C.srgb("#5a3a24"), roughness=0.35),     # 3
    C.material("cockpit_grey", C.srgb("#4b5159"), roughness=0.7),    # 4
    C.material("cockpit_dark", C.srgb("#1f2226"), roughness=0.6),    # 5
    C.material("vip_linen", C.srgb("#f4f1ea"), roughness=0.9),       # 6
    C.material("vip_metal", C.srgb("#c9b07a"), roughness=0.3, metallic=0.8),  # 7
]
WALL, CARPET, LEATHER, VENEER, CKGREY, CKDARK, LINEN, BRASS = range(len(IMATS))
EMIS = [C.material("cabin_light", (1, 0.96, 0.9), emission=(1, 0.95, 0.88), emission_strength=4.0),
        C.material("window_sky", C.srgb("#cfe3ff"), emission=C.srgb("#cfe3ff"), emission_strength=2.5)]


def shell_point(s, th, inset=INSET):
    f, dz = fus_shape(s)
    return ((RX * f - inset) * math.sin(th), NOSE_Y - s, ZC + dz - (RZ * f - inset) * math.cos(th))


def floor_theta(s, inset=INSET):
    f, dz = fus_shape(s)
    rz = RZ * f - inset
    return math.acos(max(-1.0, min(1.0, -(FLOOR_Z - ZC - dz) / rz)))


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


def box(bm, s0, s1, x0, x1, z0, z1, mat):
    n0 = len(bm.faces)
    C.box(bm, ((x0 + x1) / 2, NOSE_Y - (s0 + s1) / 2, (z0 + z1) / 2), (x1 - x0, s1 - s0, z1 - z0), mat)
    recalc(bm, n0)


def section_polygon(s):
    t0 = floor_theta(s)
    return [(shell_point(s, t0 + (TAU - 2 * t0) * i / 40)[0], shell_point(s, t0 + (TAU - 2 * t0) * i / 40)[2]) for i in range(41)]


def bulkhead(bm, s, door_w=0.0, door_h=1.8, mat=WALL, thick=0.05):
    sec = section_polygon(s)
    y0, y1 = NOSE_Y - s + thick / 2, NOSE_Y - s - thick / 2
    if door_w <= 0:
        polys = [sec]
    else:
        half, ztop = door_w / 2, FLOOR_Z + door_h
        polys = [[(half, FLOOR_Z)] + [p for p in sec if p[0] > 0] + [(0, sec[20][1]), (0, ztop), (half, ztop)],
                 [(-half, FLOOR_Z), (-half, ztop), (0, ztop), (0, sec[20][1])] + [p for p in sec if p[0] < 0]]
    for poly in polys:
        for y, rev in ((y0, False), (y1, True)):
            pts = [(x, y, z) for x, z in poly]
            if rev:
                pts.reverse()
            bm.faces.new([bm.verts.new(p) for p in pts]).material_index = mat


main = bmesh.new()
emis = bmesh.new()
# inner shell from the cockpit to the aft bulkhead, open at the windscreen and the door
stations = sorted(set([round(0.9 + 0.06 * i, 3) for i in range(int((4.2 - 0.9) / 0.06) + 1)] + [round(4.2 + 0.35 * i, 3) for i in range(int((AFT_BULK - 4.2) / 0.35) + 1)] + [DOOR["s"] - DOOR["width"] / 2, DOOR["s"] + DOOR["width"] / 2, AFT_BULK]))
n = 72
grid = []
for s in stations:
    t0 = floor_theta(s)
    grid.append((s, t0, [main.verts.new(shell_point(s, t0 + (TAU - 2 * t0) * i / n)) for i in range(n + 1)]))
for k in range(len(grid) - 1):
    s0, t0a, ra = grid[k]
    s1, _, rb = grid[k + 1]
    sm = (s0 + s1) / 2
    for i in range(n):
        th = t0a + (TAU - 2 * t0a) * (i + 0.5) / n
        if sm < CK_BULK and in_pane(sm, th):
            continue
        if sm < PANES[0][0] and shell_point(sm, th)[2] > ZC - 0.1:
            continue        # nose ahead of the windscreen: open so the view runs out over the nose
        if in_door(sm, th):
            continue
        f = main.faces.new([ra[i], ra[i + 1], rb[i + 1], rb[i]])
        f.material_index = WALL if sm > CK_BULK else CKGREY
        # face inwards: you only ever see the shell from inside
        f.normal_update()
        c = f.calc_center_median()
        if f.normal.dot(Vector((c.x, 0.0, c.z - ZC))) > 0:
            f.normal_flip()
# floor
for a in [1.4 + 0.5 * k for k in range(int((AFT_BULK - 1.4) / 0.5) + 1)]:
    b = min(AFT_BULK, a + 0.5)
    if b <= a:
        continue
    sm = (a + b) / 2
    f, dz = fus_shape(sm)
    rz = RZ * f - INSET
    zr = (FLOOR_Z - ZC - dz) / rz
    w = (RX * f - INSET) * math.sqrt(max(0.0, 1 - zr * zr))
    face = main.faces.new([main.verts.new(p) for p in ((-w, NOSE_Y - a, FLOOR_Z), (w, NOSE_Y - a, FLOOR_Z), (w, NOSE_Y - b, FLOOR_Z), (-w, NOSE_Y - b, FLOOR_Z))])
    face.material_index = CARPET if a >= CK_BULK else CKDARK
    face.normal_update()
    if face.normal.z < 0:
        face.normal_flip()
bulkhead(main, CK_BULK, door_w=0.7)
bulkhead(main, AFT_BULK)
bulkhead(main, 15.3, door_w=0.75, mat=VENEER)    # bedroom partition
# ceiling light strips
for side in (1, -1):
    box(emis, 5.6, AFT_BULK - 0.3, side * 0.45 - 0.03, side * 0.45 + 0.03, ZC + 1.12, ZC + 1.15, 0)
# window reveals (sky glow)
th_win = math.acos(-WIN["centerAboveCenterline"] / RZ)
for i in range(WIN["count"]):
    s = WIN["firstS"] + i * WIN["pitch"]
    for th in (th_win, TAU - th_win):
        c = Vector(shell_point(s, th, INSET - 0.005))
        nrm = Vector((math.sin(th) / RX, 0, -math.cos(th) / RZ)).normalized()
        up = Vector((0, 0, 1))
        up = (up - nrm * up.dot(nrm)).normalized()
        along = Vector((0, 1, 0))
        hw, hh = WIN["width"] / 2, WIN["height"] / 2
        pts = [c + along * a + up * b for a, b in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))]
        face = emis.faces.new([emis.verts.new(p) for p in pts])
        face.material_index = 1
        face.normal_update()
        if face.normal.dot(nrm) > 0:
            face.normal_flip()

# cabin: galley opposite the door, club seats, conference table, divan + screen, bedroom, washroom
box(main, CK_BULK + 0.05, 5.9, 0.35, 1.05, FLOOR_Z, FLOOR_Z + 1.0, VENEER)        # galley counter
box(main, CK_BULK + 0.05, 5.9, 0.35, 1.05, FLOOR_Z + 1.0, FLOOR_Z + 1.04, BRASS)


def club_seat(s, x, facing):
    """facing +1 = looks forward."""
    box(main, s - 0.35, s + 0.35, x - 0.35, x + 0.35, FLOOR_Z, FLOOR_Z + 0.45, LEATHER)
    bs = s + 0.33 * facing
    box(main, bs - 0.1, bs + 0.1, x - 0.35, x + 0.35, FLOOR_Z + 0.45, FLOOR_Z + 1.12, LEATHER)
    for ax in (-0.33, 0.33):
        box(main, s - 0.3, s + 0.3, x + ax - 0.05, x + ax + 0.05, FLOOR_Z + 0.45, FLOOR_Z + 0.65, LEATHER)


for s, facing in ((6.5, 1), (8.1, -1)):
    for x in (-0.68, 0.68):
        club_seat(s, x, facing)
box(main, 7.0, 7.6, -1.0, -0.4, FLOOR_Z + 0.68, FLOOR_Z + 0.72, VENEER)            # fold-out tables
box(main, 7.0, 7.6, 0.4, 1.0, FLOOR_Z + 0.68, FLOOR_Z + 0.72, VENEER)
# conference: table with four seats
box(main, 9.7, 11.1, -0.45, 0.45, FLOOR_Z + 0.7, FLOOR_Z + 0.75, VENEER)
box(main, 10.2, 10.6, -0.12, 0.12, FLOOR_Z, FLOOR_Z + 0.7, BRASS)
for s, facing in ((9.2, 1), (11.6, -1)):
    for x in (-0.55, 0.55):
        club_seat(s, x, facing)
# divan along the right wall, screen on the left
box(main, 12.2, 14.6, 0.55, 1.05, FLOOR_Z, FLOOR_Z + 0.45, LEATHER)
box(main, 12.2, 14.6, 0.95, 1.1, FLOOR_Z + 0.45, FLOOR_Z + 1.0, LEATHER)
box(main, 12.8, 14.0, -1.12, -1.06, FLOOR_Z + 0.7, FLOOR_Z + 1.4, CKDARK)
# bedroom: double bed and side tables
box(main, 16.2, 18.4, -0.75, 0.75, FLOOR_Z, FLOOR_Z + 0.5, VENEER)
box(main, 16.25, 18.35, -0.72, 0.72, FLOOR_Z + 0.5, FLOOR_Z + 0.6, LINEN)
box(main, 16.2, 16.5, -0.7, 0.7, FLOOR_Z + 0.6, FLOOR_Z + 1.1, LEATHER)         # headboard
# washroom with shower
bulkhead(main, 19.6, door_w=0.7, mat=VENEER)
box(main, 20.0, 21.2, 0.2, 1.05, FLOOR_Z, FLOOR_Z + 1.9, WALL)
box(main, 21.4, 22.9, -1.05, -0.25, FLOOR_Z, FLOOR_Z + 0.85, VENEER)

# cockpit furniture
box(main, 2.4, 2.65, -0.85, 0.85, ZC + 0.18, ZC + 0.3, CKDARK)                   # glareshield
box(main, 2.5, 2.62, -0.85, 0.85, ZC - 0.35, ZC + 0.2, CKGREY)                    # main panel
box(main, 2.6, 3.55, -0.2, 0.2, FLOOR_Z, ZC - 0.35, CKGREY)                       # pedestal
for side in (1, -1):
    x = side * 0.45
    box(main, 3.0, 3.4, x - 0.25, x + 0.25, FLOOR_Z, FLOOR_Z + 0.42, CKDARK)       # crew seats
    box(main, 3.0, 3.4, x - 0.24, x + 0.24, FLOOR_Z + 0.42, FLOOR_Z + 0.5, LEATHER)
    box(main, 3.35, 3.47, x - 0.24, x + 0.24, FLOOR_Z + 0.5, FLOOR_Z + 1.2, LEATHER)
    n0 = len(main.faces)
    C.cylinder(main, (side * 0.82, NOSE_Y - 3.0, ZC - 0.25), (side * 0.82, NOSE_Y - 3.03, ZC - 0.08), 0.02, 0.028, 10, CKDARK)  # side yokes
    recalc(main, n0)

disp = bmesh.new()
uvl = disp.loops.layers.uv.new("UVMap")
DISP_MATS = []
y = NOSE_Y - 2.621     # just proud of the main panel face (s 2.62)
DISPLAYS = [("disp_pfd_c", -0.62, ZC + 0.02), ("disp_nd_c", -0.33, ZC + 0.02), ("disp_ewd", 0.0, ZC + 0.04),
            ("disp_sd", 0.0, ZC - 0.19), ("disp_nd_f", 0.33, ZC + 0.02), ("disp_pfd_f", 0.62, ZC + 0.02)]
for i, (name, x, z) in enumerate(DISPLAYS):
    DISP_MATS.append(C.material(name, (0.02, 0.02, 0.03), roughness=0.2))
    hw, hh = 0.13, (0.11 if name == "disp_sd" else 0.12)
    face = disp.faces.new([disp.verts.new(p) for p in ((x - hw, y, z - hh), (x + hw, y, z - hh), (x + hw, y, z + hh), (x - hw, y, z + hh))])
    face.material_index = i
    for loop, uv in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uvl].uv = uv
    face.normal_update()
    if face.normal.y > 0:
        face.normal_flip()
DISP_MATS.append(C.material("disp_fcu", (0.02, 0.02, 0.03), roughness=0.2))
yf = NOSE_Y - 2.66
face = disp.faces.new([disp.verts.new(p) for p in ((-0.4, yf, ZC + 0.2), (0.4, yf, ZC + 0.2), (0.4, yf, ZC + 0.29), (-0.4, yf, ZC + 0.29))])
face.material_index = len(DISP_MATS) - 1
for loop, uv in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
    loop[uvl].uv = uv
face.normal_update()
if face.normal.y > 0:
    face.normal_flip()

iroot = C.empty("GL7T_Interior", props={"aircraft": "gl7t"})
C.new_object("interior_lit", main, IMATS, parent=iroot, sharp_angle=30)
C.new_object("interior_emissive", emis, EMIS, parent=iroot, smooth=False)
C.new_object("cockpit_displays", disp, DISP_MATS, parent=iroot, smooth=False)

CTL = [C.material("ctl_lever", C.srgb("#d8d8d8"), roughness=0.4), C.material("ctl_dark", C.srgb("#1b1d20"), roughness=0.5),
       C.material("ctl_amber", C.srgb("#3a2a08"), emission=C.srgb("#ffb020"), emission_strength=0.0)]


def control(name, pivot, builder, props=None):
    bm = bmesh.new()
    builder(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    obj = C.new_object(name, bm, CTL, parent=iroot, smooth=False)
    obj.data.transform(Matrix.Translation(-Vector(pivot)))
    obj.location = pivot
    for k, v in (props or {}).items():
        obj[k] = v
    return obj


ped_top = ZC - 0.35
for side, nm in ((-1, "L"), (1, "R")):
    px = side * 0.06
    control(f"ctl_thrust_{nm}", (px, NOSE_Y - 3.0, ped_top), lambda bm, px=px: (
        C.box(bm, (px, NOSE_Y - 3.0, ped_top + 0.09), (0.025, 0.025, 0.18), 0),
        C.box(bm, (px, NOSE_Y - 3.0, ped_top + 0.18), (0.06, 0.04, 0.035), 1)), {"control": "thrust"})
control("ctl_flaps", (0.15, NOSE_Y - 3.25, ped_top), lambda bm: (
    C.box(bm, (0.15, NOSE_Y - 3.25, ped_top + 0.05), (0.02, 0.02, 0.1), 0),
    C.box(bm, (0.15, NOSE_Y - 3.25, ped_top + 0.1), (0.05, 0.03, 0.025), 0)), {"control": "flaps"})
control("ctl_speedbrake", (-0.15, NOSE_Y - 3.25, ped_top), lambda bm: (
    C.box(bm, (-0.15, NOSE_Y - 3.25, ped_top + 0.05), (0.02, 0.02, 0.1), 0),
    C.box(bm, (-0.15, NOSE_Y - 3.25, ped_top + 0.1), (0.045, 0.028, 0.025), 1)), {"control": "speedbrake"})
control("ctl_park", (0.0, NOSE_Y - 3.45, ped_top + 0.01), lambda bm: C.cylinder(bm, (0, NOSE_Y - 3.45, ped_top), (0, NOSE_Y - 3.45, ped_top + 0.04), 0.022, 0.022, 10, 1), {"control": "parkbrake"})
control("ctl_gear", (0.2, NOSE_Y - 2.52, ZC - 0.28), lambda bm: (
    C.box(bm, (0.2, NOSE_Y - 2.55, ZC - 0.28), (0.022, 0.06, 0.022), 0),
    C.cylinder(bm, (0.2, NOSE_Y - 2.58, ZC - 0.28), (0.2, NOSE_Y - 2.6, ZC - 0.28), 0.028, 0.028, 12, 0)), {"control": "gear"})
for name, x in (("ctl_spd", -0.32), ("ctl_hdg", -0.14), ("ctl_alt", 0.14), ("ctl_vs", 0.32)):
    control(name, (x, yf, ZC + 0.24), lambda bm, x=x: C.cylinder(bm, (x, yf, ZC + 0.24), (x, yf - 0.03, ZC + 0.24), 0.016, 0.016, 12, 1), {"control": "knob"})
for name, x in (("ctl_ap1", -0.04), ("ctl_athr", 0.04)):
    control(name, (x, yf, ZC + 0.275), lambda bm, x=x: C.box(bm, (x, yf - 0.01, ZC + 0.275), (0.04, 0.02, 0.02), 2), {"control": "button"})

C.stats()
C.export_glb("gl7t.glb", pos_bits=14, uv_bits=14)
