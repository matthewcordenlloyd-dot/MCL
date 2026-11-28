"""A320neo fuselage cross-section shared by the exterior and interior generators."""
import se_common as C

AC = C.load_json("aircraft/a320neo.json")
L = AC["dimensions"]["length"]
RX = AC["dimensions"]["fuselageWidth"] / 2
RZ = AC["dimensions"]["fuselageHeight"] / 2
NOSE_Y = AC["model"]["noseY"]
ZC = AC["model"]["centerlineHeight"]
FLOOR_Z = ZC - AC["model"]["cabinFloorBelowCenterline"]

NOSE = [tuple(p) for p in AC["model"]["profile"]["nose"]]
TAIL = [tuple(p) for p in AC["model"]["profile"]["tail"]]


def fus_shape(s):
    """(radius factor f, vertical centre offset dz) at s metres from the nose."""
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
                return f, RZ * (1 - f) * 0.92
        return TAIL[-1][1], RZ * (1 - TAIL[-1][1]) * 0.92
    return 1.0, 0.0
