# Скрипт для консоли Metashape (Scripts → Run Script).
#
# Пишет CSV точных положений камер ПОСЛЕ выравнивания и привязки по GCP:
#   D:/04_AI/mirea/export/lichtfeld_cameras.csv   (image_name,lat,lon,alt)
# Их скармливаем плагину Geo Register в режиме Image Positions CSV вместо EXIF-GPS.
#
# API AffineTransform в разных версиях Metashape разный (где-то есть vect(), где-то только
# mat/vec/scale), поэтому тут несколько путей со фолбэками; если ничего не сработает,
# скрипт печатает структуру трансформации - пришли этот вывод мне.

import math
import os

import Metashape

OUT = "D:/04_AI/mirea/export/lichtfeld_cameras.csv"
COLMAP_IMAGES = "D:/04_AI/mirea/colmap_new/images"


def _vec(v):
    try:
        return (float(v[0]), float(v[1]), float(v[2]))
    except Exception:
        return None


def _mat3(m):
    for row in range(3):
        for col in range(3):
            try:
                float(m[row][col])
            except Exception:
                try:
                    float(m[row * 4 + col])
                except Exception:
                    return None
    return [[float(m[r][c]) for c in range(3)] for r in range(3)]


def xform(t, p):
    """Точка внутренних координат модели -> координаты CRS чанка."""
    f = getattr(t, "vect", None)
    if callable(f):
        try:
            r = f(Metashape.Vector(p))
            v = _vec(r)
            if v:
                return v
        except Exception:
            pass
    m = _mat3(getattr(t, "mat", None))
    if m is None:
        return None
    scale = getattr(t, "scale", 1.0) or 1.0
    tr = None
    for name in ("translation", "vec", "offset"):
        tr = _vec(getattr(t, name, None))
        if tr:
            break
    if tr is None:                                  # перевод может сидеть в 4-м столбце mat
        mm = getattr(t, "mat", None)
        try:
            tr = (float(mm[0][3]), float(mm[1][3]), float(mm[2][3]))
        except Exception:
            tr = (0.0, 0.0, 0.0)
    return tuple(scale * (m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2]) + tr[i] for i in range(3))


def camera_center_local(cam):
    """Центр камеры во внутренних координатах модели (без трансформации чанка)."""
    c = getattr(cam, "center", None)
    v = _vec(c)
    if v:
        return v
    tr = getattr(cam, "transform", None)            # camera -> model: перевод = центр камеры
    if tr is not None:
        m = _mat3(getattr(tr, "mat", None))
        t = None
        for name in ("translation", "vec", "offset"):
            t = _vec(getattr(tr, name, None))
            if t:
                break
        if m and t:
            return t                                #Translation камеры = её центр в модели
    return None


def ecef_to_lla(x, y, z):
    a, f = 6378137.0, 1.0 / 298.257223563
    e2 = 1 - (a * (1 - f) / a) ** 2
    lon = math.atan2(y, x)
    hp = math.hypot(x, y)
    lat = math.atan2(z, hp * (1 - e2))
    N = a
    for _ in range(8):
        N = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        lat = math.atan2(z + e2 * N * math.sin(lat), hp)
    return math.degrees(lat), math.degrees(lon), hp * math.cos(lat) + z * math.sin(lat) - N


def camera_filename(cam, chunk):
    try:
        files = cam.photo.files
        f = files.get(chunk) or (next(iter(files.values())) if files else None)
        if f:
            return os.path.basename(str(f))
    except Exception:
        pass
    return cam.label


def main():
    doc = Metashape.app.document
    if not str(doc.path):
        print("Открой проект Metashape.")
        return
    chunk = next((c for c in doc.chunks if getattr(c, "transform", None) is not None), None)
    if chunk is None:
        print("Нет чанка с трансформацией.")
        return

    t = chunk.transform
    print("CRS чанка: %s | scale=%r" % (chunk.crs.name if chunk.crs else "нет", getattr(t, "scale", None)))
    probe = xform(t, (0.0, 0.0, 0.0))
    print("нулевая точка модели -> %s" % (probe,))
    if probe is None:
        print("не удалось прочитать трансформацию чанка; атрибуты: %s"
              % [a for a in dir(t) if not a.startswith("_")])
        return

    geographic = max(abs(v) for v in probe) < 1e5     # градусы/UTM или ECEF-метры
    colmap_names = {f.lower() for f in os.listdir(COLMAP_IMAGES)} if os.path.isdir(COLMAP_IMAGES) else set()

    rows, matched, exif_diff = [], 0, []
    for cam in chunk.cameras:
        if not cam.enabled:
            continue
        p = camera_center_local(cam)
        if p is None:
            continue
        pos = xform(t, p)
        if pos is None:
            continue
        if geographic:                                # CRS географический: x=lon, y=lat, z=высота
            lat, lon, alt = pos[1], pos[0], pos[2]
        else:                                         # геоцентрическая (ECEF) -> WGS-84
            lat, lon, alt = ecef_to_lla(*pos)
        name = camera_filename(cam, chunk)
        rows.append((name, lat, lon, alt))
        if not colmap_names or name.lower() in colmap_names:
            matched += 1
        ref = getattr(cam, "reference", None)
        if ref and getattr(ref, "location", None):
            r = ref.location
            exif_diff.append(math.hypot((float(r.x) - lon) * 85400.0,
                                        (float(r.y) - lat) * 111000.0, float(r.z) - alt))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("image_name,lat,lon,alt\n")
        for name, lat, lon, alt in rows:
            f.write("%s,%.8f,%.8f,%.3f\n" % (name, lat, lon, alt))

    print("камер в CSV: %d | совпало с именами COLMAP: %d" % (len(rows), matched))
    print("первая строка: %s" % (rows[0] if rows else "нет"))
    if exif_diff:
        exif_diff.sort()
        print("EXIF-GPS против связанной позиции: медиана %.1f м, max %.1f м"
              % (exif_diff[len(exif_diff) // 2], exif_diff[-1]))
    print("файл: %s -> в плагине Source = Image Positions CSV" % OUT)


main()
