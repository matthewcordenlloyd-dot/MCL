"""Heathrow airfield surfaces + paint markings -> public/models/egll_airfield.glb

Built directly in ARP-local coordinates (Blender x = east, y = north). The game places
this GLB at the world origin. Surfaces are flat; materials are restyled at runtime with
procedural textures (asphalt, concrete, grass, paint) by material name.

Run:  npm run assets -- egll_airfield
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.append(os.path.dirname(__file__))
import se_common as C  # noqa: E402

AIRPORT = os.environ.get("SE_AIRPORT", "egll")
AP = C.load_json(f"airports/{AIRPORT}.json")
C.reset_scene()

MATS = [
    C.material("grass", C.srgb("#5d7a3a"), roughness=0.95),        # 0
    C.material("asphalt", C.srgb("#3a3b3d"), roughness=0.85),      # 1
    C.material("asphalt_runway", C.srgb("#2e2f31"), roughness=0.8),  # 2
    C.material("concrete", C.srgb("#9a9a96"), roughness=0.8),      # 3
    C.material("paint_white", C.srgb("#e8e8e4"), roughness=0.6),   # 4
    C.material("paint_yellow", C.srgb("#e2b322"), roughness=0.6),  # 5
]
GRASS, ASPH, RWY, CONC, WHITE, YELLOW = range(6)

Z_SURF = 0.03     # paved surfaces sit 3 cm above the grass
Z_PAINT = 0.05    # markings 2 cm above that (plus polygon offset at runtime)


def to_bl(x3, z3):
    """egll.json [x, z] (three.js, z = south) -> Blender (x, y = north)."""
    return x3, -z3


class Surf:
    def __init__(self):
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")

    def quad(self, cx, cy, length, width, angle, z, mat, tile=20.0):
        """Rectangle centred at (cx, cy) with its length along `angle` (radians from +X, CCW)."""
        ca, sa = math.cos(angle), math.sin(angle)
        hl, hw = length / 2, width / 2
        pts = []
        for a, b in ((-hl, -hw), (hl, -hw), (hl, hw), (-hl, hw)):
            pts.append((cx + a * ca - b * sa, cy + a * sa + b * ca, z))
        f = self.bm.faces.new([self.bm.verts.new(p) for p in pts])
        f.material_index = mat
        for loop in f.loops:
            co = loop.vert.co
            loop[self.uv].uv = (co.x / tile, co.y / tile)
        return f

    def rect(self, x0, y0, x1, y1, z, mat, tile=20.0):
        return self.quad((x0 + x1) / 2, (y0 + y1) / 2, abs(x1 - x0), abs(y1 - y0), 0.0, z, mat, tile)

    def add_mesh(self, me, matrix, mat):
        n0 = len(self.bm.faces)
        self.bm.from_mesh(me)
        self.bm.faces.ensure_lookup_table()
        self.bm.verts.ensure_lookup_table()
        new_faces = [self.bm.faces[i] for i in range(n0, len(self.bm.faces))]
        verts = {v for f in new_faces for v in f.verts}
        for v in verts:
            v.co = matrix @ v.co
        for f in new_faces:
            f.material_index = mat


def text_mesh(body, size):
    cu = bpy.data.curves.new("txt", type="FONT")
    cu.body = body
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.fill_mode = "BOTH"
    ob = bpy.data.objects.new("txt", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob)
    return me


surf = Surf()

# ---------------------------------------------------------------- grass
surf.rect(-8000, -8000, 8000, 8000, 0.0, GRASS, tile=24.0)

# ---------------------------------------------------------------- runway
for rw in AP["runways"]:
    cx, cy = to_bl(*rw["center"])
    hdg = math.radians(rw["headingTrueDeg"])
    ang = math.pi / 2 - hdg                 # heading (from north, CW) -> angle from +X (CCW)
    Lr, W, S = rw["lengthM"], rw["widthM"], rw["shoulderM"]
    surf.quad(cx, cy, Lr + 60, W + 2 * S, ang, Z_SURF - 0.005, ASPH)
    surf.quad(cx, cy, Lr, W, ang, Z_SURF, RWY, tile=30.0)
    ux, uy = math.cos(ang), math.sin(ang)
    vx, vy = -uy, ux

    def at(along, across):
        return cx + ux * along + vx * across, cy + uy * along + vy * across

    def paint(along, across, length, width, mat=WHITE):
        px, py = at(along, across)
        surf.quad(px, py, length, width, ang, Z_PAINT, mat)

    # edge lines and centreline
    for s in (-1, 1):
        paint(0, s * (W / 2 - 0.45), Lr, 0.9)
    a = -Lr / 2 + 6 + 30 + 12 + 9 + 12 + 30
    while a < Lr / 2 - 120:
        paint(a + 15, 0, 30, 0.9)
        a += 50
    # both ends: piano keys, designators, aiming points, touchdown zone
    for end, sign, name in ((0, -1, rw["ends"][0]), (1, 1, rw["ends"][1])):
        th = sign * Lr / 2          # threshold position along the runway
        inward = -sign
        # threshold bar + 16 piano keys (8 each side of centre)
        paint(th + inward * 1.5, 0, 3.0, W - 2)
        for k in range(8):
            off = 1.5 + 1.8 / 2 + k * 2.9
            for s in (-1, 1):
                paint(th + inward * (6 + 15), s * off, 30, 1.8)
        # designator: letter nearer the threshold, number further in
        num, letter = name[:2], name[2:]
        rot = ang - math.pi / 2 if sign < 0 else ang + math.pi / 2  # text reads from the approach
        for txt, dist in ((letter, 48), (num, 66)):
            if not txt:
                continue
            me = text_mesh(txt, 13.0)
            px, py = at(th + inward * dist, 0)
            mtx = Matrix.Translation((px, py, Z_PAINT + 0.003)) @ Matrix.Rotation(rot, 4, "Z")
            surf.add_mesh(me, mtx, WHITE)
            bpy.data.meshes.remove(me)
        # aiming point markers at 400 m
        for s in (-1, 1):
            paint(th + inward * (400 + 30), s * 10.5, 60, 10)
        # touchdown zone pairs: 3,3 at 150, 2,2 at 450/600, 1,1 at 750/900 (simplified)
        for dist, bars in ((150, 3), (300, 3), (600, 2), (750, 2), (900, 1)):
            for s in (-1, 1):
                for b in range(bars):
                    paint(th + inward * (dist + 11.25), s * (7.5 + b * 2.7), 22.5, 1.8)

# ---------------------------------------------------------------- taxiways
for tw in AP["taxiways"]:
    x0, y0 = to_bl(*tw["from"])
    x1, y1 = to_bl(*tw["to"])
    L = math.hypot(x1 - x0, y1 - y0)
    ang = math.atan2(y1 - y0, x1 - x0)
    w = tw["widthM"]
    surf.quad((x0 + x1) / 2, (y0 + y1) / 2, L + w, w, ang, Z_SURF - 0.002, ASPH)
    surf.quad((x0 + x1) / 2, (y0 + y1) / 2, L + w * 0.3, 0.3, ang, Z_PAINT, YELLOW)
    for s in (-1, 1):
        ox, oy = -math.sin(ang) * s * (w / 2 - 1.0), math.cos(ang) * s * (w / 2 - 1.0)
        surf.quad((x0 + x1) / 2 + ox, (y0 + y1) / 2 + oy, L, 0.15, ang, Z_PAINT, YELLOW)

# ---------------------------------------------------------------- apron & stands
(ax0, az0), (ax1, az1) = AP["apron"]["min"], AP["apron"]["max"]
bx0, by0 = to_bl(ax0, az0)
bx1, by1 = to_bl(ax1, az1)
surf.rect(bx0, by1, bx1, by0, Z_SURF, CONC, tile=10.0)
# apron edge line
for (xa, ya, xb, yb) in ((bx0, by1, bx1, by1), (bx0, by1, bx0, by0), (bx1, by1, bx1, by0)):
    L = math.hypot(xb - xa, yb - ya)
    surf.quad((xa + xb) / 2, (ya + yb) / 2, L, 0.3, math.atan2(yb - ya, xb - xa), Z_PAINT, YELLOW)
# apron taxilane runs 86 m in front of the stand noses
LANE_Y = -(AP["stands"][0]["nose"][1] + 86)
for st in AP["stands"]:
    nx, ny = to_bl(*st["nose"])
    # lead-in line from the apron taxilane to the nose position, then the stop bar
    surf.quad(nx, (ny + LANE_Y) / 2, ny - LANE_Y, 0.3, math.pi / 2, Z_PAINT, YELLOW)
    surf.quad(nx, ny - 0.3, 6.0, 0.6, 0, Z_PAINT, YELLOW)
    # stand safety box (red would be ideal; white for now)
    for s in (-1, 1):
        surf.quad(nx + s * 19.0, ny - 22, 46, 0.25, math.pi / 2, Z_PAINT, WHITE)
    me = text_mesh(st["id"], 3.2)
    surf.add_mesh(me, Matrix.Translation((nx - 4.5, ny - 8, Z_PAINT + 0.003)), YELLOW)
    bpy.data.meshes.remove(me)
# apron taxilane (parallel to the terminal)
surf.quad((bx0 + bx1) / 2, LANE_Y, bx1 - bx0 - 20, 0.3, 0, Z_PAINT, YELLOW)

# ---------------------------------------------------------------- landside
ls = AP["landside"]
rz = -ls["roadZ"]
surf.rect(-1120, rz - ls["roadWidthM"] / 2, -680, rz + ls["roadWidthM"] / 2, Z_SURF, ASPH)
x = -1115
while x < -690:
    surf.quad(x + 1.5, rz, 3, 0.15, 0, Z_PAINT, WHITE)
    x += 9
for s in (-1, 1):
    surf.quad(-900, rz + s * (ls["roadWidthM"] / 2 - 0.4), 440, 0.15, 0, Z_PAINT, WHITE)
# forecourt between road and terminal
term = AP["terminal"]
tz = -term["center"][1]
surf.rect(-1060, tz + term["sizeM"][1] / 2, -740, rz - ls["roadWidthM"] / 2, Z_SURF + 0.005, CONC, tile=6.0)
(cx0, cz0), (cx1, cz1) = ls["carParkMin"], ls["carParkMax"]
surf.rect(cx0, -cz1, cx1, -cz0, Z_SURF, ASPH)
for row in range(3):
    yy = -cz1 + 10 + row * 18
    xx = cx0 + 5
    while xx < cx1 - 5:
        surf.quad(xx, yy, 0.12, 5.0, 0, Z_PAINT, WHITE)
        xx += 2.6

obj = C.new_object("egll_airfield", surf.bm, MATS, smooth=False)
obj["surface"] = "ground"
C.stats()
C.export_glb(f"{AIRPORT}_airfield.glb", pos_bits=20, uv_bits=16)
