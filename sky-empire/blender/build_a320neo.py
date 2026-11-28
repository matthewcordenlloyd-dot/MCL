"""Generates the Airbus A320neo (exterior, 3 LODs + collision hulls) -> public/models/a320neo.glb

Run:  npm run assets -- a320neo

Layout: nose points +Y (three.js -Z). Origin is on the ground under the main gear.
The fuselage uses a cylindrical UV (u = s/length from the nose, v = theta/2pi) so the
runtime livery painter (src/customiser/liveryPainter.ts) can paint windows, doors,
cheatlines and titles for any livery.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.append(os.path.dirname(__file__))
import se_common as C  # noqa: E402

AC = C.load_json("aircraft/a320neo.json")
L = AC["dimensions"]["length"]
RX = AC["dimensions"]["fuselageWidth"] / 2
RZ = AC["dimensions"]["fuselageHeight"] / 2
NOSE_Y = AC["model"]["noseY"]
ZC = AC["model"]["centerlineHeight"]
DOOR = AC["livery"]["doors"][0]
DOOR_S0 = DOOR["s"] - DOOR["width"] / 2 - 0.02
DOOR_S1 = DOOR["s"] + DOOR["width"] / 2 + 0.02
# left side, between sill and head height (theta measured from the belly)
DOOR_TH0 = 2 * math.pi - math.acos(max(-1.0, min(1.0, -(-DOOR["sillBelowCenterline"] + DOOR["height"]) / (AC["dimensions"]["fuselageHeight"] / 2))))
DOOR_TH1 = 2 * math.pi - math.acos(max(-1.0, min(1.0, DOOR["sillBelowCenterline"] / (AC["dimensions"]["fuselageHeight"] / 2))))

C.reset_scene()

# Global material table: every part uses these indices so LOD meshes can be merged.
MATS = [
    C.material("fuselage_livery", (0.9, 0.9, 0.9), roughness=0.32),               # 0
    C.material("wing_grey", C.srgb("#b9bec4"), roughness=0.45, metallic=0.25),      # 1
    C.material("paint_brand", C.srgb("#0b2545"), roughness=0.35),                  # 2
    C.material("metal_bright", (0.85, 0.86, 0.88), roughness=0.22, metallic=1.0),  # 3
    C.material("metal_dark", (0.04, 0.04, 0.045), roughness=0.45, metallic=0.6),   # 4
    C.material("tyre", (0.025, 0.025, 0.025), roughness=0.92),                     # 5
    C.material("gear_white", (0.75, 0.75, 0.75), roughness=0.4, metallic=0.4),     # 6
    C.material("tail_livery", C.srgb("#0b2545"), roughness=0.33),                  # 7
    C.material("light_red", (1, 0.05, 0.05), emission=(1, 0.05, 0.05), emission_strength=4),   # 8
    C.material("light_green", (0.05, 1, 0.15), emission=(0.05, 1, 0.15), emission_strength=4),  # 9
    C.material("exhaust", (0.12, 0.11, 0.1), roughness=0.6, metallic=0.8),         # 10
]
M_FUS, M_WING, M_BRAND, M_METAL, M_DARK, M_TYRE, M_GEAR, M_TAIL, M_RED, M_GREEN, M_EXH = range(11)
MATS[4].use_backface_culling = False


def recalc(bm, n0):
    bm.faces.ensure_lookup_table()
    faces = [bm.faces[i] for i in range(n0, len(bm.faces))]
    if faces:
        bmesh.ops.recalc_face_normals(bm, faces=faces)


# ---------------------------------------------------------------- fuselage
def fus_shape(s):
    """Returns (radius factor f, vertical centre offset) at distance s from the nose."""
    nose = [(0.0, 0.03, -0.62), (0.15, 0.30, -0.58), (0.4, 0.52, -0.50), (0.8, 0.70, -0.40),
            (1.3, 0.83, -0.30), (2.0, 0.91, -0.20), (2.8, 0.955, -0.12), (3.8, 0.98, -0.06),
            (5.0, 0.995, -0.02), (6.2, 1.0, 0.0)]
    tail = [(23.5, 1.0), (26.0, 0.955), (28.5, 0.865), (31.0, 0.72), (33.5, 0.53),
            (35.5, 0.34), (36.8, 0.2), (37.35, 0.12), (37.57, 0.07)]
    if s <= nose[-1][0]:
        for (a, fa, za), (b, fb, zb) in zip(nose, nose[1:]):
            if a <= s <= b:
                t = (s - a) / (b - a)
                return fa + (fb - fa) * t, za + (zb - za) * t
    if s >= tail[0][0]:
        for (a, fa), (b, fb) in zip(tail, tail[1:]):
            if a <= s <= b:
                t = (s - a) / (b - a)
                f = fa + (fb - fa) * t
                # Keep the crown line nearly straight; the belly sweeps up.
                return f, RZ * (1 - f) * 0.92
        return tail[-1][1], RZ * (1 - tail[-1][1]) * 0.92
    return 1.0, 0.0


def fuselage(bm, uv, lod):
    seg = [48, 24, 12][lod]
    if lod == 0:
        stations = [0, 0.15, 0.4, 0.8, 1.3, 1.75, 2.15, 2.5, 2.8, 3.2, 3.75, 4.4, DOOR_S0, DOOR_S1, 6.2]
        stations += [6.2 + i * 1.2 for i in range(1, 15)]
        stations += [23.5, 24.75, 26.0, 27.25, 28.5, 29.75, 31.0, 32.25, 33.5, 34.5, 35.5, 36.2, 36.8, 37.35, 37.57]
    elif lod == 1:
        stations = [0, 0.4, 1.0, 1.75, 2.6, 3.75, 6.2, 12, 18, 23.5, 26, 28.5, 31, 33.5, 35.5, 37.57]
    else:
        stations = [0, 0.8, 2.2, 5.0, 23.5, 28.5, 33.5, 37.57]
    stations = sorted(set(round(s, 3) for s in stations))
    rings, uvs = [], []
    for s in stations:
        f, dz = fus_shape(s)
        ring, ruv = [], []
        for i in range(seg):
            th = 2 * math.pi * i / seg
            x = RX * f * math.sin(th)
            z = ZC + dz - RZ * f * math.cos(th)
            ring.append((x, NOSE_Y - s, z))
            ruv.append((s / L, th / (2 * math.pi)))
        rings.append(ring)
        uvs.append(ruv)
    n0 = len(bm.faces)
    C.loft(bm, rings, M_FUS, uvs=uvs, uv_layer=uv)
    recalc(bm, n0)
    if lod == 0:
        # open the L1 door: remove the skin faces inside the door outline (left side)
        bm.faces.ensure_lookup_table()
        dead = []
        for i in range(n0, len(bm.faces)):
            c = bm.faces[i].calc_center_median()
            s = NOSE_Y - c.y
            if not (DOOR_S0 < s < DOOR_S1) or c.x > 0:
                continue
            th = math.atan2(c.x / RX, -(c.z - ZC) / RZ) % (2 * math.pi)
            if DOOR_TH0 < th < DOOR_TH1:
                dead.append(bm.faces[i])
        bmesh.ops.delete(bm, geom=dead, context="FACES")
    # Wing-to-body belly fairing
    n0 = len(bm.faces)
    C.ellipsoid(bm, (0, 1.4, ZC - 1.6), (1.78, 7.2, 1.0), segments=[24, 12, 8][lod], rings=[12, 8, 4][lod], mat_index=M_FUS)
    recalc(bm, n0)


# ---------------------------------------------------------------- airfoils
def airfoil(n, tc, camber=0.02):
    """Closed loop (TE -> upper -> LE -> lower -> TE) in chord units: list of (xc, zc)."""
    xs = [0.5 * (1 - math.cos(math.pi * i / (n - 1))) for i in range(n)]  # 0..1 cosine spaced

    def yt(x):
        return 5 * tc * (0.2969 * math.sqrt(x) - 0.1260 * x - 0.3516 * x ** 2 + 0.2843 * x ** 3 - 0.1036 * x ** 4)

    def yc(x):
        return camber * (2 * 0.4 * x - x * x) / 0.16 if x < 0.4 else camber * ((1 - 0.8) + 0.8 * x - x * x) / 0.36

    upper = [(x, yc(x) + yt(x)) for x in reversed(xs)]          # TE -> LE
    lower = [(x, yc(x) - yt(x)) for x in xs[1:-1]]              # LE -> TE (exclusive)
    return upper + lower


def section(le, chord, tc, twist_deg, n, span_dir=(1, 0, 0), up=(0, 0, 1), camber=0.02):
    """Airfoil section in 3D. Chord runs along -Y from the LE point."""
    pts = []
    tw = math.radians(twist_deg)
    up = Vector(up)
    cdir = Vector((0, -1, 0))
    for xc, zc in airfoil(n, tc, camber):
        # twist about the LE: rotate (chord, up) plane
        dx = xc * chord
        dz = zc * chord
        rx = dx * math.cos(tw) + dz * math.sin(tw)
        rz = -dx * math.sin(tw) + dz * math.cos(tw)
        p = Vector(le) + cdir * rx + up * rz
        pts.append(tuple(p))
    return pts


def wing(bm, side, lod):
    n = [14, 8, 5][lod]
    zroot = ZC - 1.1
    dih = math.tan(math.radians(5.1))

    def le_y(x):
        return 5.1 - (x - 1.95) * 0.52

    def te_y(x):
        if x <= 6.3:
            return -1.5 - (x - 1.95) * 0.10
        t = (x - 6.3) / (17.6 - 6.3)
        return -1.935 + (-4.588 + 1.935) * t

    xs = [1.2, 3.0, 4.6, 6.3, 9.5, 13.0, 16.0, 17.6] if lod == 0 else ([1.2, 6.3, 12.0, 17.6] if lod == 1 else [1.2, 6.3, 17.6])
    secs = []
    for x in xs:
        tc = 0.15 + (0.125 - 0.15) * min(1, (x - 1.2) / 5.1) if x <= 6.3 else 0.125 + (0.105 - 0.125) * (x - 6.3) / 11.3
        twist = 3.0 + (-1.5 - 3.0) * (x - 1.2) / 16.4
        chord = le_y(x) - te_y(x)
        le = (side * x, le_y(x), zroot + (x - 1.2) * dih)
        secs.append(section(le, chord, tc, twist, n))
    # Sharklet: bend up through ~85 degrees, then a swept vertical blade.
    tip_le = Vector((17.6, le_y(17.6), zroot + 16.4 * dih))
    tip_chord = 1.55
    R = 0.55
    steps = [0.25, 0.5, 0.75, 1.0] if lod == 0 else ([0.5, 1.0] if lod == 1 else [1.0])
    for k in steps:
        phi = math.radians(85) * k
        le = tip_le + Vector((R * math.sin(phi), -0.35 * k, R * (1 - math.cos(phi))))
        chord = tip_chord - 0.45 * k
        upv = (-side * math.sin(phi), 0, math.cos(phi))
        p = section((side * le.x, le.y, le.z), chord, 0.10, -1.5, n, up=upv, camber=0.0)
        secs.append(p)
    top_le = tip_le + Vector((R + 0.18, -0.35 - 1.05, R + 1.85))
    secs.append(section((side * top_le.x, top_le.y, top_le.z), 0.5, 0.09, 0, n, up=(-side, 0, 0), camber=0.0))
    n0 = len(bm.faces)
    C.loft(bm, secs, M_WING)
    recalc(bm, n0)
    # Flap-track fairings ("canoes")
    if lod < 2:
        for x in (4.2, 8.4, 11.4, 14.2):
            y0 = te_y(x)
            z = zroot + (x - 1.2) * dih - 0.12
            n0 = len(bm.faces)
            C.ellipsoid(bm, (side * x, y0 + 0.2, z - 0.1), (0.16, 1.9, 0.22), segments=[10, 6][lod], rings=[6, 4][lod], mat_index=M_WING)
            recalc(bm, n0)
    # Nav light at the wingtip
    n0 = len(bm.faces)
    C.ellipsoid(bm, (side * 17.75, le_y(17.6) - 0.05, zroot + 16.4 * dih + 0.08), (0.06, 0.12, 0.06), 8, 4, M_GREEN if side > 0 else M_RED)
    recalc(bm, n0)


def tailplane(bm, side, lod):
    n = [12, 7, 5][lod]
    secs = []
    xs = [0.3, 3.0, 6.22] if lod < 2 else [0.3, 6.22]
    for x in xs:
        t = (x - 0.3) / 5.92
        chord = 3.9 + (1.35 - 3.9) * t
        le_y = -13.9 - (x - 0.3) * 0.65
        z = 4.45 + (x - 0.3) * 0.105
        secs.append(section((side * x, le_y, z), chord, 0.11 - 0.02 * t, 0, n, camber=-0.01))
    n0 = len(bm.faces)
    C.loft(bm, secs, M_TAIL)
    recalc(bm, n0)


def fin(bm, uv, lod):
    n = [14, 8, 5][lod]
    zs = [5.55, 8.6, 11.76] if lod < 2 else [5.55, 11.76]
    secs = []
    for z in zs:
        t = (z - 5.55) / (11.76 - 5.55)
        chord = 6.1 + (1.9 - 6.1) * t
        le_y = -9.75 - (z - 5.55) * 0.675
        pts = section((0, le_y, z), chord, 0.10, 0, n, up=(1, 0, 0), camber=0.0)
        secs.append(pts)
    n0 = len(bm.faces)
    C.loft(bm, secs, M_TAIL)
    recalc(bm, n0)
    # Planar side UV for the tail art: u along -Y (LE->TE), v up.
    bm.faces.ensure_lookup_table()
    y0, y1, z0, z1 = -9.75 + 0.1, -9.75 - 6.1, 5.55, 11.76
    for i in range(n0, len(bm.faces)):
        for loop in bm.faces[i].loops:
            co = loop.vert.co
            loop[uv].uv = ((y0 - co.y) / (y0 - y1), (co.z - z0) / (z1 - z0))
    # Beacon on the fin tip is red; anti-collision beacons top & bottom of fuselage
    for z in (ZC + RZ + 0.05,):
        n0 = len(bm.faces)
        C.ellipsoid(bm, (0, 2.0, z), (0.09, 0.14, 0.07), 8, 4, M_RED)
        recalc(bm, n0)


# ---------------------------------------------------------------- engines
def engine(bm, side, lod, fan_bm):
    seg = [32, 16, 10][lod]
    x, zc, y_in = side * 5.75, 1.78, 6.05
    outer = [(-3.45, 0.92), (-3.0, 1.03), (-2.2, 1.16), (-1.2, 1.21), (-0.35, 1.2), (-0.08, 1.15), (0.0, 1.06)]
    C.lathe(bm, [(y_in + t - 0 * 1 - 0, r) for t, r in outer], (x, 0, zc), "Y", seg, M_BRAND)
    # inlet lip (polished) and duct
    lip = [(-0.12, 1.0), (-0.02, 1.04), (0.0, 1.06)]
    C.lathe(bm, [(y_in + t, r) for t, r in lip], (x, 0, zc), "Y", seg, M_METAL, flip=True)
    duct = [(-0.8, 0.98), (-0.12, 1.0)]
    C.lathe(bm, [(y_in + t, r) for t, r in duct], (x, 0, zc), "Y", seg, M_DARK, flip=True)
    # fan face + spinner
    C.lathe(bm, [(y_in - 0.82, 0.98), (y_in - 0.81, 0.33)], (x, 0, zc), "Y", seg, M_DARK, flip=True)
    C.lathe(fan_bm, [(y_in - 0.8, 0.33), (y_in - 0.55, 0.22), (y_in - 0.32, 0.0)], (x, 0, zc), "Y", seg, M_DARK)
    if lod == 0:
        for b in range(18):
            a = 2 * math.pi * b / 18
            tw = math.radians(38)
            pts = []
            for r, sgn in ((0.33, -1), (0.33, 1), (0.97, 1), (0.97, -1)):
                w = 0.13 if r < 0.5 else 0.19
                da = sgn * w / r * 0.5
                yy = y_in - 0.79 + sgn * w * 0.5 * math.sin(tw)
                pts.append((x + math.cos(a + da) * r, yy, zc + math.sin(a + da) * r))
            f = fan_bm.faces.new([fan_bm.verts.new(p) for p in pts])
            f.material_index = M_DARK
    # bypass duct rear wall + core cowl + plug
    C.lathe(bm, [(y_in - 3.3, 0.8), (y_in - 3.31, 0.95)], (x, 0, zc), "Y", seg, M_DARK)
    core = [(-4.4, 0.42), (-4.3, 0.55), (-3.45, 0.80), (-3.2, 0.82)]
    C.lathe(bm, [(y_in + t, r) for t, r in core], (x, 0, zc), "Y", seg, M_EXH)
    plug = [(-5.15, 0.0), (-4.9, 0.18), (-4.4, 0.36)]
    C.lathe(bm, [(y_in + t, r) for t, r in plug], (x, 0, zc), "Y", seg, M_EXH)
    C.lathe(bm, [(y_in - 4.41, 0.36), (y_in - 4.4, 0.42)], (x, 0, zc), "Y", seg, M_DARK, flip=True)
    # pylon
    n0 = len(bm.faces)
    C.box(bm, (x, 2.4, zc + 1.25), (0.38, 4.2, 0.75), M_WING)
    recalc(bm, n0)


# ---------------------------------------------------------------- landing gear
def wheel(bm, center, radius, width, lod):
    seg = [20, 12, 8][lod]
    cx, cy, cz = center
    C.cylinder(bm, (cx - width / 2, cy, cz), (cx + width / 2, cy, cz), radius, segments=seg, mat_index=M_TYRE)
    C.cylinder(bm, (cx - width / 2 - 0.01, cy, cz), (cx + width / 2 + 0.01, cy, cz), radius * 0.55, segments=seg, mat_index=M_GEAR)


def gear(bm, lod):
    for side in (1, -1):
        x = side * 3.8
        for dx in (-0.45, 0.45):
            wheel(bm, (x + dx, 0, 0.585), 0.585, 0.42, lod)
        C.cylinder(bm, (x - 0.45, 0, 0.585), (x + 0.45, 0, 0.585), 0.08, segments=8, mat_index=M_GEAR)
        C.cylinder(bm, (x, 0, 0.585), (x * 0.95, -0.15, ZC - 1.15), 0.13, segments=[12, 8, 6][lod], mat_index=M_GEAR)
        if lod < 2:
            C.cylinder(bm, (x, 0.05, 1.4), (x * 0.55, 0.3, ZC - 1.5), 0.06, segments=6, mat_index=M_GEAR)
            n0 = len(bm.faces)
            C.box(bm, (x * 0.93, 0.25, 1.55), (0.04, 1.3, 1.6), M_FUS)
            recalc(bm, n0)
    ny = NOSE_Y - 4.96
    for dx in (-0.24, 0.24):
        wheel(bm, (dx, ny, 0.38), 0.38, 0.22, lod)
    C.cylinder(bm, (-0.24, ny, 0.38), (0.24, ny, 0.38), 0.05, segments=8, mat_index=M_GEAR)
    C.cylinder(bm, (0, ny, 0.38), (0, ny + 0.15, 2.2), 0.09, segments=[10, 8, 6][lod], mat_index=M_GEAR)
    if lod < 2:
        for dx in (-0.45, 0.45):
            n0 = len(bm.faces)
            C.box(bm, (dx, ny + 0.3, 1.75), (0.03, 1.5, 0.7), M_FUS)
            recalc(bm, n0)


def apu(bm, lod):
    s = 37.5
    f, dz = fus_shape(s)
    C.cylinder(bm, (0, NOSE_Y - s + 0.2, ZC + dz), (0, NOSE_Y - s - 0.12, ZC + dz), 0.13, segments=[12, 8, 6][lod], mat_index=M_EXH)


def build_lod(lod):
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    gear_bm = bmesh.new()
    fans = {}
    fuselage(bm, uv, lod)
    for side in (1, -1):
        wing(bm, side, lod)
        tailplane(bm, side, lod)
        fans[side] = bmesh.new()
        engine(bm, side, lod, fans[side])
    fin(bm, uv, lod)
    gear(gear_bm, lod)
    apu(bm, lod)
    if lod == 0:
        # antennas
        for y, h in ((8.0, 0.35), (-4.0, 0.3)):
            n0 = len(bm.faces)
            C.box(bm, (0, y, ZC + RZ + h / 2 - 0.03), (0.05, 0.35, h), M_GEAR)
            recalc(bm, n0)
    return bm, gear_bm, fans


def pivoted(name, bm, mats, parent, pivot, **kw):
    """Object whose origin sits at pivot (for runtime rotation), mesh kept in place."""
    obj = C.new_object(name, bm, mats, parent=parent, **kw)
    obj.data.transform(Matrix.Translation(-Vector(pivot)))
    obj.location = pivot
    return obj


root = C.empty("A320neo", props={"aircraft": "a320neo"})
for lod in range(3):
    e = C.empty(f"LOD{lod}", parent=root)
    bm, gear_bm, fans = build_lod(lod)
    C.new_object(f"a320neo_lod{lod}", bm, MATS, parent=e, sharp_angle=[38, 45, 55][lod])
    C.new_object(f"gear_lod{lod}", gear_bm, MATS, parent=e, sharp_angle=45)
    for side, nm in ((1, "R"), (-1, "L")):
        pivoted(f"fan_{nm}_lod{lod}", fans[side], MATS, e, (side * 5.75, 6.05 - 0.8, 1.78), smooth=False)

# L1 door panel, hinged on its forward edge (opens outward and forward)
door_bm = bmesh.new()
C.box(door_bm, (-RX - 0.02, NOSE_Y - (DOOR_S0 + DOOR_S1) / 2, ZC - 0.66 + 0.95), (0.08, DOOR_S1 - DOOR_S0 - 0.04, 1.95), M_GEAR)
pivoted("door_L1", door_bm, MATS, root, (-RX - 0.02, NOSE_Y - DOOR_S0, ZC), smooth=False)

# ---------------------------------------------------------------- collision hulls
col = C.empty("COL", parent=root, props={"collision": "hulls"})


def hull(name, builder):
    bm = bmesh.new()
    builder(bm)
    C.new_object(name, bm, [], parent=col, smooth=False)


hull("COL_fuselage_front", lambda bm: C.cylinder(bm, (0, NOSE_Y - 0.3, ZC - 0.4), (0, NOSE_Y - 6, ZC), 1.98, 1.98, 12))
hull("COL_fuselage_mid", lambda bm: C.cylinder(bm, (0, NOSE_Y - 6, ZC), (0, NOSE_Y - 24, ZC), 1.98, 1.98, 12))
hull("COL_fuselage_tail", lambda bm: C.cylinder(bm, (0, NOSE_Y - 24, ZC), (0, NOSE_Y - 37.4, ZC + 1.7), 1.98, 0.3, 12))
hull("COL_fairing", lambda bm: C.box(bm, (0, 1.4, ZC - 1.6), (3.4, 13, 1.6)))
for side, nm in ((1, "R"), (-1, "L")):
    hull(f"COL_wing_in_{nm}", lambda bm, s=side: C.box(bm, (s * 4.0, 1.3, ZC - 0.9), (5.6, 5.8, 0.8)))
    hull(f"COL_wing_out_{nm}", lambda bm, s=side: C.box(bm, (s * 12.0, -1.2, ZC - 0.35), (11.0, 3.5, 0.5), rot_z=s * math.radians(-14)))
    hull(f"COL_engine_{nm}", lambda bm, s=side: C.cylinder(bm, (s * 5.75, 6.05, 1.78), (s * 5.75, 0.9, 1.78), 1.21, 0.5, 12))
    hull(f"COL_gear_{nm}", lambda bm, s=side: C.box(bm, (s * 3.8, 0, 0.9), (1.4, 1.3, 1.8)))
    hull(f"COL_htp_{nm}", lambda bm, s=side: C.box(bm, (s * 3.2, -16.0, 4.75), (6.0, 3.0, 0.4)))
hull("COL_fin", lambda bm: C.box(bm, (0, -12.5, 8.6), (0.6, 5.5, 6.2)))
hull("COL_nosegear", lambda bm: C.box(bm, (0, NOSE_Y - 4.96, 0.9), (0.7, 0.9, 1.8)))

C.stats()
C.export_glb("a320neo.glb", pos_bits=14, uv_bits=14)
