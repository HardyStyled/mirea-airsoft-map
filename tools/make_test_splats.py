"""Синтетическая сцена 3D Gaussian Splatting в формате PLY (как пишет reference 3DGS).

Нужна, чтобы проверить всю цепочку «PLY → gotiler → 3D Tiles 1.1 (KHR_gaussian_splatting,
SPZ) → CesiumJS» до того, как он будет учить сплаты на фотографиях.

Формат PLY (SH degree 0): x y z nx ny nz f_dc_0..2 opacity scale_0..2 rot_0..3
  opacity — логит (до сигмоиды), scale — в лог-единицах, rot — кватернион (w,x,y,z).
Сцена: крест 20×2 м на земле + башня 2×2×8 м. Ось «вверх» — +z, единицы — метры.
"""
import math
import struct
import sys

STEP = 0.25


def add_box(pts, x0, x1, y0, y1, z0, z1, rgb):
    x = x0
    while x <= x1 + 1e-9:
        y = y0
        while y <= y1 + 1e-9:
            z = z0
            while z <= z1 + 1e-9:
                pts.append((x, y, z, rgb))
                z += STEP
            y += STEP
        x += STEP


def main(out_path):
    pts = []
    add_box(pts, -10, 10, -1, 1, 0.0, 0.3, (0.9, 0.1, 0.1))     # красная планка вдоль X
    add_box(pts, -1, 1, -10, 10, 0.0, 0.3, (0.1, 0.8, 0.1))     # зелёная планка вдоль Y
    add_box(pts, -1, 1, -1, 1, 0.3, 8.0, (0.1, 0.3, 0.9))       # синяя башня 8 м

    inv_c0 = 1.0 / 0.2806744989                                  # обратная константа 3DGS
    logit = lambda p: math.log(p / (1 - p))
    rows = []
    for x, y, z, rgb in pts:
        fdc = [(c - 0.5) * inv_c0 for c in rgb]
        rows.append((x, y, z, 0.0, 0.0, 0.0,
                     fdc[0], fdc[1], fdc[2],
                     logit(0.99),                                    # opacity
                     math.log(0.15), math.log(0.15), math.log(0.15),  # scale (м)
                     1.0, 0.0, 0.0, 0.0))                             # rot w,x,y,z

    header = "ply\nformat binary_little_endian 1.0\nelement vertex %d\n" % len(rows)
    for name in ("x", "y", "z", "nx", "ny", "nz",
                 "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                 "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"):
        header += "property float %s\n" % name
    header += "end_header\n"

    with open(out_path, "wb") as f:
        f.write(header.encode("ascii"))
        pack = struct.Struct("<17f")
        for r in rows:
            f.write(pack.pack(*r))
    print("сплатов: %d, файл: %s (%.1f КБ)" % (len(rows), out_path, __import__("os").path.getsize(out_path) / 1024))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".build/test_splats.ply")
