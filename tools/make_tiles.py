r"""Нарезка map/orto.tif (EPSG:4326, RGBA) в XYZ-тайлы EPSG:3857 для CesiumJS.

Запуск:  .venv-tile\Scripts\python.exe tools\make_tiles.py --zmin 15 --zmax 22
Результат: tiles/{z}/{x}/{y}.png + сводка в stdout (число тайлов, вес, КБ/тайл).

Схема: копия источника -> внутренние обзоры (.ovr внутри копии) -> WarpedVRT в EPSG:3857
-> окно на тайл 256x256 -> PNG. Пустые (полностью прозрачные) тайлы не пишутся.
"""
import argparse
import math
import os
import shutil
import sys
import time

import numpy as np
import rasterio
import rasterio.enums
import rasterio.warp
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.windows import from_bounds
from PIL import Image

SRC = r"D:\04_AI\mirea\map\orto.tif"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, ".build")
SRCCOPY = os.path.join(BUILD, "orto_src.tif")
TILES = os.path.join(ROOT, "tiles")

ORIGIN_SHIFT = 2 * math.pi * 6378137.0 / 2.0
EMPTY = Image.fromarray(np.zeros((256, 256, 4), dtype="uint8"), "RGBA")


def to_merc(lon, lat):
    x = lon * ORIGIN_SHIFT / 180.0
    y = math.log(math.tan((90.0 + lat) * math.pi / 360.0)) / math.pi * 180.0
    return x, y * ORIGIN_SHIFT / 180.0


def tile_bounds(z, x, y):
    size = 2 * ORIGIN_SHIFT / (2 ** z)
    west = -ORIGIN_SHIFT + x * size
    north = ORIGIN_SHIFT - y * size
    return west, north - size, west + size, north


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zmin", type=int, default=15)
    ap.add_argument("--zmax", type=int, default=22)
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--no-placeholders", dest="placeholders", action="store_false", default=True,
                    help="не писать прозрачные заглушки вместо пустых тайлов")
    args = ap.parse_args()

    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(TILES, exist_ok=True)
    t0 = time.time()

    if args.overwrite and os.path.exists(SRCCOPY):
        os.remove(SRCCOPY)
    if not os.path.exists(SRCCOPY):
        print("копирую источник в .build ...", flush=True)
        shutil.copyfile(SRC, SRCCOPY)

    with rasterio.open(SRCCOPY, "r+") as s:
        if not s.overviews(1):
            print("строю обзоры источника ...", flush=True)
            s.build_overviews([2, 4, 8, 16, 32, 64], rasterio.enums.Resampling.average)
        print("src", s.width, "x", s.height, "crs", s.crs, "overviews", s.overviews(1), flush=True)

        left, top = to_merc(s.bounds.left, s.bounds.top)
        right, bottom = to_merc(s.bounds.right, s.bounds.bottom)
        print(f"экстент 3857: {right-left:.1f} x {top-bottom:.1f} м; src пиксел "
              f"{(right-left)/s.width:.5f} м", flush=True)

        written = skipped = 0
        total_bytes = 0
        for z in range(args.zmin, args.zmax + 1):
            size = 2 * ORIGIN_SHIFT / (2 ** z)
            x0 = int(math.floor((left + ORIGIN_SHIFT) / size))
            x1 = int(math.floor((right + ORIGIN_SHIFT) / size))
            y0 = int(math.floor((ORIGIN_SHIFT - top) / size))
            y1 = int(math.floor((ORIGIN_SHIFT - bottom) / size))
            n = 0
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    west, south, east, north = tile_bounds(z, x, y)
                    if east <= left or west >= right or north <= bottom or south >= top:
                        continue
                    path = os.path.join(TILES, str(z), str(x), f"{y}.png")
                    arr = np.zeros((4, 256, 256), dtype="uint8")
                    rasterio.warp.reproject(
                        source=rasterio.band(s, [1, 2, 3, 4]),
                        destination=arr,
                        src_transform=s.transform, src_crs=s.crs,
                        dst_transform=transform_from_bounds(west, south, east, north, 256, 256),
                        dst_crs="EPSG:3857",
                        resampling=rasterio.enums.Resampling.average,
                    )
                    if arr[3].max() == 0:
                        skipped += 1
                        if args.placeholders:
                            # пустой тайл пишем прозрачной заглушкой: статический хост не должен
                            # сыпать 404 под Cesium (иначе лишние запросы и шум в консоли)
                            os.makedirs(os.path.dirname(path), exist_ok=True)
                            if not os.path.exists(path):
                                EMPTY.save(path, "PNG", optimize=True)
                                total_bytes += os.path.getsize(path)
                                written += 1
                                n += 1
                        continue
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    Image.fromarray(np.transpose(arr, (1, 2, 0)), "RGBA").save(
                        path, "PNG", optimize=True)
                    total_bytes += os.path.getsize(path)
                    written += 1
                    n += 1
            print(f"z{z}: записано {n} (габарит {(x1-x0+1)*(y1-y0+1)}), "
                  f"накоплено {written} тайлов / {total_bytes/1e6:.1f} МБ", flush=True)

    print("\n=== сводка ===")
    print(f"тайлов записано: {written}, пустых пропущено: {skipped}")
    print(f"вес: {total_bytes/1e6:.1f} МБ, средний тайл: {total_bytes/max(written,1)/1024:.1f} КБ")
    print(f"время: {time.time()-t0:.0f} с")


if __name__ == "__main__":
    sys.exit(main())
