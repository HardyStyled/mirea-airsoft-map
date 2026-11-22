# Чеклист экспорта: QGIS → 2D, Metashape 2.4.x → 3D

Проверено по файлам проекта и по официальному Reference Manual Agisoft 2.3 (`metashape-pro_2_3_en.pdf`).
Отдельный PDF-мануал на 2.4 на сайте Agisoft на 21.11.2026 **не публикуется** (страница
`/downloads/user-manuals/` отдаёт только `metashape-pro_2_3_en.pdf`, `metashape_2_3_en.pdf`,
`metashape_python_api_2_3_2.pdf`) — имена пунктов в 2.4 те же, сверяй по диалогу.

---

## A. QGIS (2D-часть)

**Уже готово, делать ничего не нужно:** тайлы нарезаны из `D:\04_AI\mirea\map\orto.tif` (он уже EPSG:4326, RGBA,
11 849 × 12 442 px, GSD 1.35 см/px) скриптом `tools/make_tiles.py` → `tiles/{z}/{x}/{y}.png`, z15–z22.
Повторять экспорт нужно только если поменялось орто.

### Если орто меняется — что выгружать

| Что | Формат | Настройки |
|---|---|---|
| Ортофотоплан | GeoTIFF (профиль **COG** в диалоге «Сохранить как») | CRS **EPSG:4326**, RGBA/альфа обязательна (заполненность 8.84 %), сжатие DEFLATE/ZSTD, обзоры не обязательны — `make_tiles.py` построит сам |
| Полигон участка, дорожки, укрытия | **GeoJSON** | CRS EPSG:4326 (у GeoJSON он фиксированный), поля `id`, `name`, `height_m`; галку «Save layer styles into GeoJSON» **снять** — стиль делает браузер |
| Рельеф (dem.tif) | не выгружать | Cesium принимает только quantized-mesh; DEM оставляем как источник высот для укрытий |

Нельзя: JPEG-тайлы (теряется альфа → чёрные дыры вне полигона), MBTiles/GPKG (для Pages не нужен), QWC2/QGIS Server.

### Вариант «тайлы прямо из QGIS» (если не хочется Python)

Processing → **Generate XYZ tiles (XYZ)**:

- Extent: экстент слоя орто (не всего проекта);
- Min zoom **15**, Max zoom **22** (выше — апсемплинг: источник 1.35 см/px, z22 = 2.1 см/px);
- Tile size **256**, Image format **PNG**;
- **Skip tiles that are completely blank: ON**; **TMS: OFF** (у нас y растёт с севера на юг);
- Profile: **Web Mercator EPSG:3857**; результат в `tiles/`.

---

## B. Metashape 2.4.x (3D-часть)

### B.1 Префлайт — до всякого экспорта

1. **Опорные точки.** Сейчас в чанке 5 маркеров, и все в одном углу (разброс 43 × 46 м при габарите модели
   270.9 × 142.8 м). Manual требует **не менее 10 GCP, равномерно по площади**. Добавить точки по углам полигона
   (координаты снять с орто в QGIS) и проверить невязки в окне References; цель по XY — сантиметры.
2. **Закрепление осей.** В XML у маркеров `sxyz="5"` — проверить в Properties, закреплены ли X/Y/Z (или только XY).
3. Чанк геопривязан (`<reference>` = EPSG:4326, `transform.translation` = метры ECEF, `scale` = 11.8893) —
   заново привязывать не нужно.

### B.2 Build Tiled Model (строим LOD-блоки)

Workflow → **Build Tiled Model**:

| Параметр | Значение | Почему |
|---|---|---|
| Surface type | Curved | участок с рельефом |
| Pixel size | **0.02 м** | нативный GSD орто 0.0135 м; 0.02 ≈ z22, дальше только апсемплинг |
| Tile size | 512 px | лист = 512 × 0.02 = 10.24 м → ≈ 27 × 14 = **~380 листов**. При 0.01 м/px и 512 px → ~1500 листов |
| Max faces count (per tile) | 500 000 | мобильный GPU; меньше — больше листов |
| Bounding volume | Ellipsoid | быстрее отсечение |
| Apply masking | ON, если маски ставились | иначе в кадр попадёт то, что замаскировано |

### B.3 Export Tiled Model (основной путь)

File → **Export → Export Tiled Model…**

- **Format: Cesium 3D Tiles** (`tileset.json` + `.b3dm`);
- **Coordinate system: WGS 84 (ECEF)** = EPSG:4978 (не UTM, не Local);
- 3D Tiles version: 1.0 (CesiumJS читает и 1.1, если 2.4 предложит);
- Include: **Model ON**, Point clouds OFF (по желанию), **Texture ON**;
- Screen space error: **16 px** (дальше крутим на клиенте через `maximumScreenSpaceError`);
- **Compress into 3TZ: OFF** — нужен распакованный каталог, CesiumJS `.3tz` напрямую не грузит;
- Куда: `D:\04_AI\mirea\mirea-airsoft-map\3dtiles\tileset.json`.

### B.4 Export Model (запасной путь: одна сетка)

File → **Export → Export Model…**: формат **Binary glTF (`.glb`)**, CRS WGS 84 (ECEF), Merge model parts ON,
Include texture ON, Max faces ~2 000 000, текстуры ≤ **4096 px** (лимит мобильной текстуры), кладём в
`3dtiles/model.glb`. Грузится в просмотрщике через `Model.fromGltfAsync`.

Минус: вершины в ECEF (~6.4 млн м) → в float32 дрожание на зуме. Если дрожит — экспорт той же сетки **в Local
Coordinates** и посадка матрицей в просмотрщике (`modelMatrix`), параметры чанка известны:
translation (2 860 831.6257666373, 2 193 683.2297762097, 5 244 148.326598525), rotation locked,
scale 11.889340912162234.

### B.5 Приёмка экспорта (замерить, а не на глаз)

- самый большой файл **≤ 100 МБ** (git отказывает с 100 МБ, комфорт 1 МБ);
- весь каталог **≤ 1 ГБ** (лимит сайта Pages);
- **файлов в одном каталоге ≤ 3000** — у Metashape контент плоский (`Data/*.b3dm`), при ~380–1500 листов это
  проходит, при бо́льших разрешениях — дробить каталог или отдавать с R2;
- после копирования в `3dtiles/` открыть `http://127.0.0.1:8765/` — модель должна лечь на орто без сдвига.

### B.6 Автотизация (по желанию)

`tools/metashape_export.py` — тот же набор шагов для Python-консоли Metashape (Tools → Python console) или
`metashape-cli.exe eval`. Перед запуском поправить пути и разрешения в начале файла.
