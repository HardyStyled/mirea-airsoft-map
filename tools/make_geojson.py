r"""Конвертация слоёв D:\04_AI\mirea\map\tactical.gpkg в GeoJSON для просмотрщика.

Запуск:  .venv-tile\Scripts\python.exe tools\make_geojson.py
Результат: shelters.geojson (укрытия-призмы), zones.geojson (контуры полигона/зон),
           lines.geojson (дорожки, тактические линии, щиты).

Высоты укрытий в QGIS не хранятся — ставятся типовые по слою (правится в самом GeoJSON
или позже в браузере); все слои уже в EPSG:4326, перепроецирование не нужно.
"""
import json
import os

import pyogrio.raw
from shapely import affinity, from_wkb
from shapely.geometry import mapping, shape

# метры на градус на широте участка (55.673 N): нужно, чтобы «толщина забора» была
# одинаковой по X и Y, а не эллиптической
LAT_M = 110574.0
LON_M = 110574.0 * __import__("math").cos(__import__("math").radians(55.673))

SRC = r"D:\04_AI\mirea\map\tactical.gpkg"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

POLYGON_KINDS = {
    "buildings": ("building", 3.0),
    "objects": ("object", 2.0),
    "Бочки": ("barrel", 1.0),
    "vehicles": ("vehicle", 2.2),
}
ZONES = ["playzone", "restricted"]
ZONE_HEIGHT = 2.0          # м; контур поднимается «забором» по периметру
FENCE_THICKNESS = 1.0      # м; в плане 0.4 м на обзоре меньше пиксела и не рисуется
LINES = {"roads": "road", "tactical": "tactical", "щиты": "shield"}


def collect(layers, kind_of):
    feats = []
    for layer in layers:
        kind, height = kind_of(layer)
        res = pyogrio.raw.read(SRC, layer=layer, read_geometry=True)
        meta, geoms, cols = res[0], res[2], res[3]
        names = list(meta["fields"])
        rows = [{n: cols[j][i] for j, n in enumerate(names)} for i in range(len(geoms))]
        for i, (wkb, p) in enumerate(zip(geoms, rows)):
            if wkb is None:
                continue
            g = from_wkb(wkb)
            if g is None or g.is_empty:
                continue
            name = str(p.get("name", "") or "").strip()
            feats.append({
                "type": "Feature",
                "properties": {
                    "id": f"{layer}-{i+1}",
                    "name": name or f"{layer} {i+1}",
                    "layer": layer,
                    "kind": kind,
                    **({"height_m": height} if height else {}),
                },
                "geometry": mapping(g),
            })
    return feats


def fences(feats, thickness=FENCE_THICKNESS):
    """Тонкое кольцо вдоль контура зоны: полигон минус его внутренний отступ.

    Делим в метрах (иначе «толщина» в градусах разная по X и Y), обратно в градусы.
    Такой забор — обычный экструзионный полигон: работает в любом рендерере и корректно
    клюётся мышью, в отличие от Cesium Entity.wall (тот у нас не отрисовался).
    """
    out = []
    for f in feats:
        if f["geometry"]["type"] != "Polygon":
            continue
        g = shape(f["geometry"])
        m = affinity.scale(g, xfact=LON_M, yfact=LAT_M, origin=(0, 0))
        ring = m.difference(m.buffer(-thickness))
        parts = list(ring.geoms) if ring.geom_type == "MultiPolygon" else [ring]
        for j, part in enumerate(parts):
            if part.is_empty or not isinstance(part, type(m)):
                continue
            props = dict(f["properties"])
            props["id"] = f"{props['id']}-fence"      # id не должен совпадать с id самой зоны
            props["kind"] = "zonewall"
            props["name"] = f"{props.get('name', '')} — контур"
            out.append({"type": "Feature", "properties": props,
                        "geometry": mapping(affinity.scale(part, xfact=1 / LON_M, yfact=1 / LAT_M, origin=(0, 0)))})
    return out


def dump(fname, features):
    path = os.path.join(ROOT, fname)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "name": fname.replace(".geojson", ""),
                   "features": features}, f, ensure_ascii=False, indent=1)
    print(f"{fname}: {len(features)} объектов, {os.path.getsize(path)/1024:.1f} КБ")


def main():
    dump("shelters.geojson", collect(POLYGON_KINDS, lambda l: POLYGON_KINDS[l]))
    zones = collect(ZONES, lambda l: ("zone", ZONE_HEIGHT))
    dump("zones.geojson", zones + fences(zones))
    dump("lines.geojson", collect(LINES, lambda l: (LINES[l], None)))


main()
