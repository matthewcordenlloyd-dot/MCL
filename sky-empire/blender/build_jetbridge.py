"""Jet bridge parts -> public/models/jetbridge.glb

Three nodes the game assembles per stand at runtime:
  jb_rotunda   round room at the terminal end (origin at floor centre, openings at +Y and -Y)
  jb_tunnel    1 m tunnel section along +Y (three.js -Z), stretched to length at runtime
  jb_cab       cab with bellows at the aircraft end (origin at floor centre, opening toward +Y)
Run:  npm run assets -- jetbridge
"""
import math
import os
import sys

import bmesh

sys.path.append(os.path.dirname(__file__))
import se_common as C  # noqa: E402

C.reset_scene()
MATS = [
    C.material("bridge_metal", C.srgb("#c7cbd0"), roughness=0.45, metallic=0.5),   # 0
    C.material("bridge_glass", C.srgb("#22323f"), roughness=0.08, metallic=0.2),   # 1
    C.material("bridge_floor", C.srgb("#3b3d42"), roughness=0.9),                  # 2
    C.material("bridge_inner", C.srgb("#e3e1dc"), roughness=0.7),                  # 3
    C.material("bridge_bellows", C.srgb("#1d1f23"), roughness=0.95),               # 4
    C.material("bridge_light", (1, 0.95, 0.85), emission=(1, 0.95, 0.85), emission_strength=3.0),  # 5
]
METAL, GLASS, FLOOR, INNER, BELLOWS, LIGHT = range(len(MATS))
W, H = 2.6, 2.7          # outer width / height
T = 0.08                 # wall thickness

root = C.empty("JetBridge")

# ---- tunnel unit: floor, walls (window band), roof, ceiling light, all 1 m long along +Y
tb = bmesh.new()
C.box(tb, (0, 0.5, -0.08), (W, 1.0, 0.16), FLOOR)                 # floor slab (top at z = 0)
C.box(tb, (0, 0.5, H), (W, 1.0, 0.12), METAL)                     # roof
for side in (1, -1):
    x = side * (W / 2 - T / 2)
    C.box(tb, (x, 0.5, 0.55), (T, 1.0, 1.1), METAL)               # lower wall
    C.box(tb, (x, 0.5, 1.6), (T * 0.6, 1.0, 1.0), GLASS)          # window band
    C.box(tb, (x, 0.5, 2.35), (T, 1.0, 0.6), METAL)               # upper wall
    C.box(tb, (side * (W / 2 - T - 0.01), 0.5, 0.55), (0.02, 1.0, 1.1), INNER)
C.box(tb, (0, 0.5, H - 0.08), (W - 2 * T, 1.0, 0.03), INNER)      # ceiling
C.box(tb, (0, 0.5, H - 0.1), (0.3, 1.0, 0.02), LIGHT)             # light strip
bmesh.ops.recalc_face_normals(tb, faces=tb.faces[:])
C.new_object("jb_tunnel", tb, MATS, parent=root, smooth=False)

# ---- rotunda: cylinder room with two wide openings, on the ground
rb = bmesh.new()
R, n = 1.9, 28
for i in range(n):
    a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
    am = (a0 + a1) / 2
    # openings centred on +Y (tunnel) and -Y (terminal), each ~100 degrees wide
    if abs(math.cos(am)) < 0.65:
        continue
    p = [(R * math.sin(a), R * math.cos(a)) for a in (a0, a1)]
    for (x0, y0), (x1, y1) in [tuple(p)]:
        pass
    v = [rb.verts.new(q) for q in ((p[0][0], p[0][1], 0), (p[1][0], p[1][1], 0), (p[1][0], p[1][1], H), (p[0][0], p[0][1], H))]
    rb.faces.new(v).material_index = METAL
    v = [rb.verts.new(q) for q in ((p[0][0] * 0.96, p[0][1] * 0.96, H), (p[1][0] * 0.96, p[1][1] * 0.96, H), (p[1][0] * 0.96, p[1][1] * 0.96, 0), (p[0][0] * 0.96, p[0][1] * 0.96, 0))]
    rb.faces.new(v).material_index = INNER
C.cylinder(rb, (0, 0, -0.1), (0, 0, 0.0), R + 0.05, R + 0.05, n, FLOOR)
C.cylinder(rb, (0, 0, H), (0, 0, H + 0.15), R + 0.1, R + 0.1, n, METAL)
C.box(rb, (0, 0, H - 0.05), (0.4, 0.4, 0.04), LIGHT)
C.new_object("jb_rotunda", rb, MATS, parent=root, smooth=False)

# ---- cab: box room open at the back (-Y, tunnel) and front (+Y, bellows), plus control desk
cb = bmesh.new()
CL, CW = 2.4, 3.2
C.box(cb, (0, 0, -0.08), (CW, CL, 0.16), FLOOR)
C.box(cb, (0, 0, H), (CW, CL, 0.12), METAL)
for side in (1, -1):
    C.box(cb, (side * (CW / 2 - T / 2), 0, H / 2), (T, CL, H), METAL)
    C.box(cb, (side * (CW / 2 - T / 2 - 0.05), 0.2, 1.6), (0.02, 1.4, 0.8), GLASS)
C.box(cb, (0.9, -0.1, 0.5), (0.9, 0.6, 1.0), METAL)                # operator desk
C.box(cb, (0, CL / 2 + 0.35, H / 2 + 0.05), (CW - 0.4, 0.7, 0.2), BELLOWS)   # bellows canopy top
for side in (1, -1):
    C.box(cb, (side * (CW / 2 - 0.3), CL / 2 + 0.35, H / 2), (0.2, 0.7, H), BELLOWS)
C.box(cb, (0, CL / 2 + 0.3, -0.05), (CW - 0.6, 0.6, 0.1), FLOOR)   # bridge plate
bmesh.ops.recalc_face_normals(cb, faces=cb.faces[:])
C.new_object("jb_cab", cb, MATS, parent=root, smooth=False)

C.stats()
C.export_glb("jetbridge.glb", pos_bits=14)
