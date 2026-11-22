# -*- coding: utf-8 -*-
"""Экспорт 3D из Metashape 2.4.x в Cesium 3D Tiles + (опция) одна сетка .glb.

Запуск:
  1) Metashape → Tools → Python console → exec(open(r"D:\\04_AI\\mirea\\mirea-airsoft-map\\tools\\metashape_export.py").read())
  2) или metashape-cli.exe eval "exec(open(r'...metashape_export.py').read())"

Имена параметров экспорта по Reference Manual 2.3 (отдельного PDF для 2.4 Agisoft не публикует).
Если 2.4 переименовала константу/параметр — скрипт печатает доступные варианты и продолжает с тем, что нашёл.
"""
import metashape as ms

PROJECT = r"D:\04_AI\mirea\mirea_mp.psx"
OUT_TILES = r"D:\04_AI\mirea\mirea-airsoft-map\3dtiles\tileset.json"
OUT_GLB = r"D:\04_AI\mirea\mirea-airsoft-map\3dtiles\model.glb"

PIXEL_SIZE = 0.02          # м/пиксел листа; GSD орто 0.0135, дальше — только апсемплинг
TILE_SIZE = 512            # px, лист = 512 * 0.02 = 10.24 м
MAX_FACES_PER_TILE = 500_000
SCREEN_SPACE_ERROR = 16.0  # px, на клиенте крутится Cesium3DTileset.maximumScreenSpaceError
TEXTURE_SIZE = 4096        # px, лимит текстуры мобильного GPU (пример MDN MAX_TEXTURE_SIZE)


def pick(names):
    """Вернуть первую существующую константу Metashape из перечисленных имён."""
    for n in names:
        v = getattr(ms, n, None)
        if v is not None:
            print(f"  константа: {n}")
            return v
    raise AttributeError(f"нет ни одной константы из {names}; доступные: "
                         f"{[a for a in dir(ms) if 'ormat' in a or 'urface' in a or 'ounding' in a][:40]}")


def main():
    doc = ms.Document()
    doc.read(PROJECT)
    chunk = doc.chunk
    if chunk is None:
        raise SystemExit("в проекте нет активного чанка")

    print("чанк:", chunk.label)
    print("  transform.scale      =", chunk.transform.scale)
    print("  transform.translation=", chunk.transform.translation)
    print("  transform.rotation   =", chunk.transform.rotation)
    print("  маркеров:", len(chunk.markers), "камер:", len(chunk.cameras))
    fixed = [m for m in chunk.markers if getattr(m, "fixed", False)]
    print(f"  зафиксировано маркеров: {len(fixed)} из {len(chunk.markers)}")
    if len(chunk.markers) < 10:
        print("  !! GCP меньше 10 и они в одном углу — сначала добавить точки по углам полигона "
              "(см. docs/EXPORT.md, п. B.1), иначе привязка на дальних углах будет плыть")

    print("\n1) Build Tiled Model")
    chunk.buildTiledModel(
        surface_type=pick(["curvedSurface"]),
        max_faces=MAX_FACES_PER_TILE,
        max_points=0,
        downscaled=0,
        pixel_size=PIXEL_SIZE,
        tile_size=TILE_SIZE,
        bounding_volume=pick(["ellipsoidBoundingVolume", "boxBoundingVolume", "boundingVolumeEllipsoid"]),
    )

    print("\n2) Export Tiled Model → Cesium 3D Tiles (EPSG:4978 = WGS84 ECEF)")
    kwargs = dict(
        path=OUT_TILES,
        format=pick(["tilesFormatCesium"]),
        crs=ms.CRS("EPSG", "4978"),
        tile_size=TILE_SIZE,
        screen_space_error=SCREEN_SPACE_ERROR,
        model=True,
        points=False,
        clouds=False,
        images=False,
        shapes=False,
        save_3dz=False,
        save_3tz=False,
        texture_size=TEXTURE_SIZE,
    }
    try:
        chunk.exportTiledModel(**kwargs, tileset_version="1.0")
    except TypeError as e:
        print("  tileset_version не принят (", e, ") — без него")
        chunk.exportTiledModel(**kwargs)

    print("\n3) Export Model → Binary glTF (запасной путь, см. docs/EXPORT.md п. B.4)")
    try:
        chunk.exportModel(
            path=OUT_GLB,
            format=pick(["modelFormatGlb", "modelFormatGlB", "modelFormatGltf"]),
            merge=True,
            texture_format=pick(["modelTextureFormatJpeg", "modelTextureFormatPng"]),
            texture_color=True,
            crs=ms.CRS("EPSG", "4978"),
            max_faces=2_000_000,
            max_points=0,
        )
    except Exception as e:
        print("  экспорт .glb не сделан:", e)
        print("  параметры метода:", chunk.exportModel.__doc__)

    print("\nготово. Проверить размеры (git: файл ≤ 100 МБ, каталог ≤ 1 ГБ, ≤ 3000 файлов в каталоге):")
    import os
    for p in (OUT_TILES, OUT_GLB):
        if os.path.exists(p):
            print(f"  {p}: {os.path.getsize(p)/1e6:.1f} МБ")
    d = os.path.dirname(OUT_TILES)
    if os.path.isdir(d):
        n = sum(len(fs) for _, _, fs in os.walk(d))
        tot = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(d) for f in fs)
        print(f"  каталог {d}: {n} файлов, {tot/1e6:.1f} МБ")


main()
