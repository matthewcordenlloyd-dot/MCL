"""Shared helpers for Sky Empire Blender generator scripts (Blender 5.x).

Conventions
- Blender is Z-up. Models face +Y (nose / face forward). The glTF exporter converts
  to three.js Y-up with forward = -Z.
- Units are metres.
- Materials are named so the game can find and restyle them at runtime
  (e.g. "fuselage_livery", "paint_brand").
"""
import json
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
MODELS = os.path.join(ROOT, "public", "models")
DATA = os.path.join(ROOT, "data")


def load_json(rel):
    with open(os.path.join(DATA, rel), "r", encoding="utf-8") as f:
        return json.load(f)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.objects):
        for block in list(coll):
            coll.remove(block)


# ---------------------------------------------------------------- materials
_MATS = {}


def material(name, color=(0.8, 0.8, 0.8), roughness=0.5, metallic=0.0,
             emission=None, emission_strength=0.0, alpha=1.0):
    """Create (or fetch) a Principled BSDF material. color is linear RGB."""
    if name in _MATS:
        return _MATS[name]
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = nt.nodes.get("Material Output") or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        try:
            mat.surface_render_method = "BLENDED"
        except Exception:
            pass
    mat.diffuse_color = (*color, alpha)
    _MATS[name] = mat
    return mat


def srgb(hex_or_tuple):
    """Convert an sRGB hex string like '#0B2545' to linear RGB tuple."""
    if isinstance(hex_or_tuple, str):
        h = hex_or_tuple.lstrip("#")
        c = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    else:
        c = list(hex_or_tuple)

    def lin(v):
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return tuple(lin(v) for v in c)


# ---------------------------------------------------------------- objects
def new_object(name, bm, mats, parent=None, smooth=True, sharp_angle=40.0):
    """Turn a bmesh into an object. `mats` is a list of materials; faces use
    face.material_index into it."""
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
        me.set_sharp_from_angle(angle=math.radians(sharp_angle))
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def empty(name, parent=None, props=None):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    if parent is not None:
        e.parent = parent
    for k, v in (props or {}).items():
        e[k] = v
    return e


def box(bm, center, size, mat_index=0, rot_z=0.0):
    """Add an axis-aligned (optionally Z-rotated) box to bm."""
    cx, cy, cz = center
    sx, sy, sz = (s / 2.0 for s in size)
    m = Matrix.Translation((cx, cy, cz)) @ Matrix.Rotation(rot_z, 4, "Z")
    verts = []
    for dx, dy, dz in [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
                       (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]:
        verts.append(bm.verts.new(m @ Vector((dx * sx, dy * sy, dz * sz))))
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    out = []
    for f in faces:
        face = bm.faces.new([verts[i] for i in f])
        face.material_index = mat_index
        out.append(face)
    return out


def cylinder(bm, p0, p1, r0, r1=None, segments=16, mat_index=0, caps=True):
    """Tapered cylinder between points p0 and p1."""
    r1 = r0 if r1 is None else r1
    p0, p1 = Vector(p0), Vector(p1)
    axis = (p1 - p0)
    length = axis.length
    q = axis.normalized().to_track_quat("Z", "Y")
    m = Matrix.Translation(p0) @ q.to_matrix().to_4x4()
    ring0, ring1 = [], []
    for i in range(segments):
        a = 2 * math.pi * i / segments
        ring0.append(bm.verts.new(m @ Vector((math.cos(a) * r0, math.sin(a) * r0, 0))))
        ring1.append(bm.verts.new(m @ Vector((math.cos(a) * r1, math.sin(a) * r1, length))))
    for i in range(segments):
        j = (i + 1) % segments
        f = bm.faces.new([ring0[i], ring0[j], ring1[j], ring1[i]])
        f.material_index = mat_index
    if caps:
        f = bm.faces.new(list(reversed(ring0)))
        f.material_index = mat_index
        f = bm.faces.new(ring1)
        f.material_index = mat_index


def ellipsoid(bm, center, radii, segments=16, rings=10, mat_index=0):
    cx, cy, cz = center
    rx, ry, rz = radii
    grid = []
    for r in range(rings + 1):
        phi = math.pi * r / rings
        row = []
        for s in range(segments):
            th = 2 * math.pi * s / segments
            if r in (0, rings):
                if s > 0:
                    row.append(row[0])
                    continue
            x = rx * math.sin(phi) * math.cos(th)
            y = ry * math.sin(phi) * math.sin(th)
            z = rz * math.cos(phi)
            row.append(bm.verts.new((cx + x, cy + y, cz + z)))
        grid.append(row)
    for r in range(rings):
        for s in range(segments):
            t = (s + 1) % segments
            vs = [grid[r][s], grid[r + 1][s], grid[r + 1][t], grid[r][t]]
            uniq = []
            for v in vs:
                if v not in uniq:
                    uniq.append(v)
            if len(uniq) >= 3:
                f = bm.faces.new(uniq)
                f.material_index = mat_index


def loft(bm, rings, mat_index=0, close_start=True, close_end=True, uvs=None, uv_layer=None):
    """Connect a list of equal-length vertex-position rings (closed loops).
    uvs: optional parallel list of lists of (u, v) per vertex."""
    vrings = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for k in range(len(vrings) - 1):
        a, b = vrings[k], vrings[k + 1]
        for i in range(n):
            j = (i + 1) % n
            f = bm.faces.new([a[i], a[j], b[j], b[i]])
            f.material_index = mat_index
            if uvs is not None and uv_layer is not None:
                for loop in f.loops:
                    pass
                lu = [uvs[k][i], uvs[k][j], uvs[k + 1][j], uvs[k + 1][i]]
                # seam fix: wrap u/v where the ring closes
                if j == 0:
                    lu[1] = (lu[1][0], lu[1][1] + 1.0)
                    lu[2] = (lu[2][0], lu[2][1] + 1.0)
                for loop, uv in zip(f.loops, lu):
                    loop[uv_layer].uv = uv
    caps = []
    if close_start:
        f = bm.faces.new(list(reversed(vrings[0])))
        f.material_index = mat_index
        caps.append(f)
    if close_end:
        f = bm.faces.new(vrings[-1])
        f.material_index = mat_index
        caps.append(f)
    return vrings, caps


def lathe(bm, profile, center, axis="Y", segments=32, mat_index=0, flip=False):
    """Revolve a profile [(t, r), ...] around an axis through center.
    t runs along the axis, r is the radius."""
    cx, cy, cz = center
    rings = []
    for t, r in profile:
        ring = []
        for i in range(segments):
            a = 2 * math.pi * i / segments
            c, s = math.cos(a) * r, math.sin(a) * r
            if axis == "Y":
                ring.append((cx + c, cy + t, cz + s))
            elif axis == "X":
                ring.append((cx + t, cy + c, cz + s))
            else:
                ring.append((cx + c, cy + s, cz + t))
        rings.append(ring if not flip else list(reversed(ring)))
    vrings = [[bm.verts.new(p) for p in ring] for ring in rings]
    for k in range(len(vrings) - 1):
        a, b = vrings[k], vrings[k + 1]
        for i in range(segments):
            j = (i + 1) % segments
            f = bm.faces.new([a[i], b[i], b[j], a[j]])
            f.material_index = mat_index
    return vrings


# ---------------------------------------------------------------- export
def export_glb(filename, draco=True, pos_bits=14, uv_bits=12, animations=False,
               anim_mode="ACTIONS", **extra):
    os.makedirs(MODELS, exist_ok=True)
    path = os.path.join(MODELS, filename)
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_extras=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_texcoords=True,
        export_animations=animations,
        export_draco_mesh_compression_enable=draco,
    )
    if draco:
        kwargs.update(export_draco_mesh_compression_level=6,
                      export_draco_position_quantization=pos_bits,
                      export_draco_texcoord_quantization=uv_bits,
                      export_draco_normal_quantization=10)
    if animations:
        kwargs.update(export_animation_mode=anim_mode)
    kwargs.update(extra)
    bpy.ops.export_scene.gltf(**kwargs)
    size = os.path.getsize(path)
    print(f"EXPORTED {path} ({size / 1024:.0f} KB)")
    return path


def stats():
    tris = 0
    for o in bpy.data.objects:
        if o.type == "MESH" and not o.name.startswith("COL"):
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    print(f"STATS objects={len(bpy.data.objects)} tris={tris}")
