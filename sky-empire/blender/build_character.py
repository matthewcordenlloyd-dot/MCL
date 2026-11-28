"""Player character (placeholder pilot until the M5 character creator) -> public/models/pilot.glb

A rigged, stylised-realistic figure built from shaped parts, each skinned rigidly to one
bone, with Idle / Walk / Run animation clips. Faces +Y (three.js -Z), feet at the origin.

Run:  npm run assets -- character
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

sys.path.append(os.path.dirname(__file__))
import se_common as C  # noqa: E402

C.reset_scene()
scene = bpy.context.scene
scene.render.fps = 30

MATS = [
    C.material("skin", C.srgb("#c9956f"), roughness=0.6),        # 0
    C.material("uniform_jacket", C.srgb("#141c2e"), roughness=0.7),  # 1
    C.material("uniform_trousers", C.srgb("#10151f"), roughness=0.75),  # 2
    C.material("shirt_white", C.srgb("#eeeeee"), roughness=0.6),  # 3
    C.material("shoes", C.srgb("#0a0a0a"), roughness=0.3),        # 4
    C.material("hair", C.srgb("#3b2a1e"), roughness=0.8),         # 5
    C.material("gold_braid", C.srgb("#d4a537"), roughness=0.35, metallic=0.9),  # 6
    C.material("eyes", C.srgb("#1a1410"), roughness=0.2),         # 7
]
SKIN, JACKET, TROUSERS, SHIRT, SHOES, HAIR, GOLD, EYES = range(len(MATS))

# ---------------------------------------------------------------- skeleton
BONES = {
    # name: (head, tail, parent)
    "hips": ((0, 0, 0.96), (0, 0, 1.08), None),
    "spine": ((0, 0, 1.08), (0, 0, 1.30), "hips"),
    "chest": ((0, 0, 1.30), (0, 0, 1.49), "spine"),
    "neck": ((0, 0.0, 1.49), (0, 0.01, 1.59), "chest"),
    "head": ((0, 0.01, 1.59), (0, 0.01, 1.80), "neck"),
}
for side, sx in (("R", 1), ("L", -1)):
    BONES.update({
        f"upper_arm.{side}": ((sx * 0.20, 0, 1.45), (sx * 0.23, 0, 1.17), "chest"),
        f"forearm.{side}": ((sx * 0.23, 0, 1.17), (sx * 0.245, 0.03, 0.92), f"upper_arm.{side}"),
        f"hand.{side}": ((sx * 0.245, 0.03, 0.92), (sx * 0.25, 0.04, 0.78), f"forearm.{side}"),
        f"thigh.{side}": ((sx * 0.095, 0, 0.94), (sx * 0.1, 0.01, 0.51), "hips"),
        f"shin.{side}": ((sx * 0.1, 0.01, 0.51), (sx * 0.1, -0.01, 0.09), f"thigh.{side}"),
        f"foot.{side}": ((sx * 0.1, -0.01, 0.09), (sx * 0.1, 0.15, 0.03), f"shin.{side}"),
    })

arm_data = bpy.data.armatures.new("pilot_rig")
arm = bpy.data.objects.new("pilot_rig", arm_data)
scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
arm.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
for name, (h, t, _) in BONES.items():
    eb = arm_data.edit_bones.new(name)
    eb.head, eb.tail = Vector(h), Vector(t)
    eb.roll = 0.0
for name, (_, _, p) in BONES.items():
    if p:
        arm_data.edit_bones[name].parent = arm_data.edit_bones[p]
        arm_data.edit_bones[name].use_connect = False
bpy.ops.object.mode_set(mode="OBJECT")

# ---------------------------------------------------------------- body parts
parts = []   # (bmesh, bone)


def part(bone, builder):
    bm = bmesh.new()
    builder(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    parts.append((bm, bone))


E = C.ellipsoid
CY = C.cylinder
part("hips", lambda bm: E(bm, (0, -0.005, 0.97), (0.165, 0.11, 0.12), 20, 10, TROUSERS))
part("hips", lambda bm: CY(bm, (0, 0, 1.06), (0, 0, 1.09), 0.15, 0.15, 20, GOLD * 0 + SHOES))  # belt
part("spine", lambda bm: E(bm, (0, 0.0, 1.19), (0.158, 0.1, 0.15), 20, 10, JACKET))
part("chest", lambda bm: E(bm, (0, 0.0, 1.37), (0.195, 0.118, 0.155), 20, 10, JACKET))
part("chest", lambda bm: E(bm, (0, 0.035, 1.43), (0.05, 0.09, 0.07), 10, 6, SHIRT))   # shirt V
part("chest", lambda bm: E(bm, (0, 0.105, 1.36), (0.018, 0.012, 0.08), 6, 6, TROUSERS))  # tie
for sx in (1, -1):
    part("chest", lambda bm, s=sx: E(bm, (s * 0.175, 0, 1.44), (0.075, 0.08, 0.06), 12, 8, JACKET))  # shoulder
    part("chest", lambda bm, s=sx: C.box(bm, (s * 0.17, 0.0, 1.497), (0.08, 0.05, 0.012), GOLD))   # epaulette
    part("chest", lambda bm, s=sx: C.box(bm, (s * 0.07, 0.112, 1.40), (0.05, 0.01, 0.012), GOLD if s < 0 else JACKET))
part("neck", lambda bm: CY(bm, (0, 0.0, 1.47), (0, 0.01, 1.62), 0.055, 0.05, 14, SKIN))
part("neck", lambda bm: CY(bm, (0, 0.0, 1.48), (0, 0.005, 1.53), 0.066, 0.062, 14, SHIRT))   # collar
part("head", lambda bm: E(bm, (0, 0.015, 1.69), (0.082, 0.098, 0.112), 20, 14, SKIN))
part("head", lambda bm: E(bm, (0, 0.0, 1.725), (0.088, 0.1, 0.09), 20, 10, HAIR))
part("head", lambda bm: E(bm, (0, 0.108, 1.68), (0.016, 0.022, 0.028), 8, 6, SKIN))   # nose
for sx in (1, -1):
    part("head", lambda bm, s=sx: E(bm, (s * 0.032, 0.093, 1.705), (0.011, 0.006, 0.007), 8, 6, EYES))
    part("head", lambda bm, s=sx: E(bm, (s * 0.083, 0.005, 1.69), (0.012, 0.022, 0.03), 8, 6, SKIN))  # ears
    side = "R" if sx > 0 else "L"
    part(f"upper_arm.{side}", lambda bm, s=sx: CY(bm, (s * 0.20, 0, 1.45), (s * 0.23, 0, 1.17), 0.056, 0.047, 14, JACKET))
    part(f"upper_arm.{side}", lambda bm, s=sx: E(bm, (s * 0.23, 0, 1.17), (0.047, 0.047, 0.047), 12, 8, JACKET))
    part(f"forearm.{side}", lambda bm, s=sx: CY(bm, (s * 0.23, 0, 1.17), (s * 0.245, 0.03, 0.935), 0.046, 0.04, 14, JACKET))
    for k in range(4):   # four gold stripes: captain
        part(f"forearm.{side}", lambda bm, s=sx, k=k: CY(bm, (s * 0.243, 0.027, 0.955 + k * 0.014), (s * 0.243, 0.027, 0.963 + k * 0.014), 0.0415, 0.0415, 14, GOLD))
    part(f"forearm.{side}", lambda bm, s=sx: CY(bm, (s * 0.245, 0.03, 0.94), (s * 0.245, 0.03, 0.925), 0.036, 0.034, 12, SHIRT))
    part(f"hand.{side}", lambda bm, s=sx: E(bm, (s * 0.248, 0.035, 0.86), (0.026, 0.045, 0.075), 12, 8, SKIN))
    part(f"thigh.{side}", lambda bm, s=sx: CY(bm, (s * 0.095, 0, 0.98), (s * 0.1, 0.01, 0.51), 0.078, 0.056, 14, TROUSERS))
    part(f"thigh.{side}", lambda bm, s=sx: E(bm, (s * 0.1, 0.01, 0.51), (0.056, 0.058, 0.058), 12, 8, TROUSERS))
    part(f"shin.{side}", lambda bm, s=sx: CY(bm, (s * 0.1, 0.01, 0.51), (s * 0.1, -0.01, 0.1), 0.054, 0.044, 14, TROUSERS))
    part(f"foot.{side}", lambda bm, s=sx: E(bm, (s * 0.1, 0.05, 0.05), (0.048, 0.13, 0.05), 14, 8, SHOES))

objs = []
for i, (bm, bone) in enumerate(parts):
    o = C.new_object(f"p{i}", bm, MATS, sharp_angle=60)
    vg = o.vertex_groups.new(name=bone)
    vg.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
    objs.append(o)
for o in bpy.context.view_layer.objects:
    o.select_set(False)
for o in objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = objs[0]
bpy.ops.object.join()
body = bpy.context.view_layer.objects.active
body.name = "pilot_body"
body.parent = arm
mod = body.modifiers.new("rig", "ARMATURE")
mod.object = arm

# ---------------------------------------------------------------- animation
# Rotations are authored about armature-space axes, then converted to each
# bone's local frame: q_local = B^-1 * R * B (B = bone rest orientation).
REST = {b.name: b.matrix_local.to_quaternion() for b in arm_data.bones}


def q_world(axis, deg):
    return Quaternion(axis, math.radians(deg))


def set_rot(pb, q_arm, frame):
    B = REST[pb.name]
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = B.inverted() @ q_arm @ B
    pb.keyframe_insert("rotation_quaternion", frame=frame)


X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)


def pose_walk(t, run=False):
    """t in [0,1) -> dict bone -> armature-space quaternion, plus hip offset."""
    w = 2 * math.pi * t
    s = math.sin(w)
    amp_leg = 42 if run else 24
    amp_arm = 38 if run else 18
    lean = 9 if run else 2
    out = {}
    for side, ph in (("R", 0.0), ("L", math.pi)):
        sw = math.sin(w + ph)              # +1 = leg fully forward
        swing_fwd = math.cos(w + ph)       # >0 while the leg is moving forward (swing phase)
        thigh = amp_leg * sw + (12 if run else 4)
        knee = -(10 + (75 if run else 40) * max(0.0, swing_fwd) ** 1.5) - (15 if run else 0)
        foot = 10 * max(0.0, -sw) - 8 * max(0.0, sw)
        out[f"thigh.{side}"] = q_world(X, thigh)
        out[f"shin.{side}"] = q_world(X, knee)
        out[f"foot.{side}"] = q_world(X, foot)
        arm_sw = -amp_arm * sw
        out[f"upper_arm.{side}"] = q_world(X, arm_sw) @ q_world(Y, (-1 if side == "R" else 1) * 4)
        out[f"forearm.{side}"] = q_world(X, (80 if run else 12) + max(0.0, arm_sw) * 0.6)
    out["spine"] = q_world(Z, (6 if run else 4) * s) @ q_world(X, lean)
    out["chest"] = q_world(Z, -(8 if run else 5) * s)
    out["head"] = q_world(Z, (2 if run else 1.5) * s) @ q_world(X, -lean * 0.7)
    out["hips"] = q_world(Z, -(5 if run else 3) * s)
    bob = (0.045 if run else 0.025) * (abs(math.cos(w)) - 0.5)
    return out, bob


def pose_idle(t):
    w = 2 * math.pi * t
    b = math.sin(w)
    out = {
        "chest": q_world(X, -1.2 * b),
        "head": q_world(X, 1.0 * b) @ q_world(Z, 3 * math.sin(w * 0.5 + 1)),
        "spine": q_world(Z, 0.8 * math.sin(w * 0.5)),
    }
    for side, sg in (("R", -1), ("L", 1)):
        out[f"upper_arm.{side}"] = q_world(X, 2 + 1.5 * b) @ q_world(Y, sg * 5)
        out[f"forearm.{side}"] = q_world(X, 8 + 2 * b)
    return out, 0.004 * b


arm.animation_data_create()
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
clips = [("Idle", 90, lambda t: pose_idle(t)), ("Walk", 32, lambda t: pose_walk(t)), ("Run", 20, lambda t: pose_walk(t, True))]
for name, frames, fn in clips:
    act = bpy.data.actions.new(name)
    arm.animation_data.action = act
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    step = 2
    for f in list(range(0, frames, step)) + [frames]:
        t = (f % frames) / frames
        rots, bob = fn(t)
        for pb in arm.pose.bones:
            set_rot(pb, rots.get(pb.name, Quaternion()), f)
        hips = arm.pose.bones["hips"]
        hips.location = Vector((0, bob, 0))   # bone-local Y is world up for the vertical hips bone
        hips.keyframe_insert("location", frame=f)
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, act)
    arm.animation_data.action = None
bpy.ops.object.mode_set(mode="OBJECT")
for pb in arm.pose.bones:
    pb.rotation_quaternion = Quaternion()
    pb.location = Vector()

C.stats()
C.export_glb("pilot.glb", draco=False, animations=True, anim_mode="NLA_TRACKS")
