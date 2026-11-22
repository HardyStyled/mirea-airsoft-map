"""CSV положений камер для Geo Register (LichtFeld) — считается прямо из проекта Metashape,
без запуска Metashape.

Источник: D:/04_AI/mirea/mirea_mp.files/0/chunk.zip -> doc.xml (Metashape 2.4.0, сохранён 19.11).
Там есть и трансформация чанка (rotation/scale/translation -> ECEF), и 1993 камер, и маркеры (GCP).

Формула Metashape: p_ecef = translation + scale * rotation * p_model
Центр камеры во внутренних координатах = колонка переноса матрицы <transform> камеры.

Результат: D:/04_AI/mirea/export/lichtfeld_cameras.csv (image_name,lat,lon,alt) — то, что скармливаем
плагину в режиме Image Positions CSV вместо EXIF-GPS.

Запуск: .venv-tile\Scripts\python.exe tools\make_camera_csv.py
"""
import math
import os
import re
import zipfile
import xml.etree.ElementTree as ET

PROJECT_CHUNK = r"D:\04_AI\mirea\mirea_mp.files\0\chunk.zip"
IMAGES_DIR = r"D:\04_AI\mirea\colmap_new\images"
OUT = r"D:\04_AI\mirea\export\lichtfeld_cameras.csv"
A, F = 6378137.0, 1.0 / 298.257223563
E2 = 1 - (1 - F) ** 2


def ecef_to_lla(x, y, z):
    lon = math.atan2(y, x)
    hp = math.hypot(x, y)
    lat = math.atan2(z, hp * (1 - E2))
    n = A
    for _ in range(8):
        n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
        lat = math.atan2(z + E2 * n * math.sin(lat), hp)
    # h = hp*cos + z*sin - a^2/N  (не -N: с -N ошибка ~29 км)
    return math.degrees(lat), math.degrees(lon), hp * math.cos(lat) + z * math.sin(lat) - A * A / n


def lla_to_ecef(lat, lon, alt):
    lat, lon = math.radians(lat), math.radians(lon)
    n = A / math.sqrt(1 - E2 * math.sin(lat) ** 2)
    return ((n + alt) * math.cos(lat) * math.cos(lon),
            (n + alt) * math.cos(lat) * math.sin(lon),
            (n * (1 - E2) + alt) * math.sin(lat))


def main():
    with zipfile.ZipFile(PROJECT_CHUNK) as z:
        root = ET.fromstring(z.read("doc.xml").decode("utf-8"))

    tr = root.find("transform")
    rot = [float(v) for v in tr.find("rotation").text.split()]
    trans = [float(v) for v in tr.find("translation").text.split()]
    scale = float(tr.find("scale").text) if tr.find("scale") is not None else 1.0
    R = [rot[0:3], rot[3:6], rot[6:9]]
    print("чанк: scale=%.10f  translation=(%.3f, %.3f, %.3f)" % (scale, *trans))
    print("     rotation =", [round(v, 6) for v in rot])

    def model_to_ecef(p):
        return [trans[i] + scale * sum(R[i][j] * p[j] for j in range(3)) for i in range(3)]

    # --- самопроверка обратного преобразования ---
    lat0, lon0, alt0 = ecef_to_lla(*lla_to_ecef(55.6732, 37.4807, 188.0))
    print("round-trip LLA->ECEF->LLA: %.7f %.7f %.3f (ждём 55.6732000 37.4807000 188.000)" % (lat0, lon0, alt0))

    # --- камеры ---
    ext = {}
    if os.path.isdir(IMAGES_DIR):
        for fn in os.listdir(IMAGES_DIR):
            ext[os.path.splitext(fn)[0].lower()] = fn
    rows, skipped, named = [], 0, 0
    for cam in root.findall("cameras/camera"):
        tm = cam.find("transform")
        if tm is None:
            skipped += 1
            continue
        v = [float(x) for x in tm.text.split()]
        if len(v) != 16:
            skipped += 1
            continue
        center = [v[3], v[7], v[11]]                 # центр камеры во внутренних координатах
        lat, lon, alt = ecef_to_lla(*model_to_ecef(center))
        label = cam.get("label")
        name = ext.get(label.lower(), label)         # с расширением, если такой файл есть в датасете
        if name != label:
            named += 1
        rows.append((name, lat, lon, alt))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("image_name,lat,lon,alt\n")
        for name, lat, lon, alt in rows:
            f.write("%s,%.8f,%.8f,%.3f\n" % (name, lat, lon, alt))
    lats = [r[1] for r in rows]
    lons = [r[2] for r in rows]
    alts = sorted(r[3] for r in rows)
    print("\nкамер в CSV: %d (пропущено: %d, с расширением файла: %d)" % (len(rows), skipped, named))
    print("рамка: lat %.7f…%.7f | lon %.7f…%.7f" % (min(lats), max(lats), min(lons), max(lons)))
    print("высоты: мин %.1f | медиана %.1f | макс %.1f м" % (alts[0], alts[len(alts) // 2], alts[-1]))
    inside = sum(1 for _, la, lo, _a in rows if 37.479588 <= lo <= 37.482130 and 55.672219 <= la <= 55.673728)
    print("попало в прямоугольник полигона (37.479588…37.482130 / 55.672219…55.673728): %d из %d"
          % (inside, len(rows)))

    # наглядно: насколько EXIF-GPS в проекте расходится с реальной позицией камеры
    ext_by_label = {(r[0].rsplit(".", 1)[0].lower()): r for r in rows}
    diffs = []
    for cam in root.findall("cameras/camera"):
        ref = cam.find("reference")
        if ref is None:
            continue
        r = ext_by_label.get((cam.get("label") or "").lower())
        if not r:
            continue
        d = math.hypot((float(ref.get("x")) - r[2]) * 85400.0, (float(ref.get("y")) - r[1]) * 111000.0,
                       float(ref.get("z", "0") or 0) - r[3])
        diffs.append(d)
    if diffs:
        diffs.sort()
        print("EXIF-GPS против позиции из выровненной модели: медиана %.1f м, 90%% %.1f м, max %.1f м"
              % (diffs[len(diffs) // 2], diffs[int(len(diffs) * 0.9)], diffs[-1]))

    print("первая строка:", rows[0])
    print("файл:", OUT)
    print("в Geo Register: Source = Image Positions CSV -> Load CSV File -> пересчитать")


if __name__ == "__main__":
    main()
