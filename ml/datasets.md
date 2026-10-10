# Hazard datasets (step M2)

The retrained model keeps the 80 COCO class ids and adds four classes: **stairs (80), curb (81), pole (82), door (83)**
(`ml/class_map.hazard.json`). No single dataset has all four, so the training set is a mix. Everything is under
`datasets/`, which git ignores.

## Sources

| Source | Gives us | License (check each page before relying on it) | How we get it |
|---|---|---|---|
| [Open Images V7](https://storage.googleapis.com/openimages/web/factsfigures_v7.html) | stairs, door, pole (from "Street light") | Annotations CC BY 4.0; images listed as CC BY 2.0 (Open Images' statement; I did not re-verify it from the page) | `ml/fetch_zoo.py` (FiftyOne) |
| [Zenodo: Image Dataset of Accessibility Barriers](https://zenodo.org/records/6382090) | stairs, curb | **CC BY 4.0** (read on the record page) | manual download, then `ml/convert_zenodo.py` |
| [COCO 2017](https://cocodataset.org/#download) | our 17 kept obstacle classes | Annotations CC BY 4.0; images are Flickr photos under their own licenses | `ml/fetch_zoo.py` (FiftyOne) |
| [Argoverse-HD](https://docs.ultralytics.com/datasets/detect/argoverse) | person, bicycle, car, motorcycle, bus, truck | **CC BY-NC-SA 4.0, non-commercial** (as stated on the Ultralytics page) | `ml/fetch_argoverse.py` (31.5 GB) |

Things to know:

- **Argoverse is non-commercial.** Fine for a hackathon or research; check with the team before any commercial use of a
  model trained on it. It also has none of the four new classes: it only supplies street-scene people and vehicles.
- **"pole" is approximated by Open Images "Street light"** (a lamp on a post). A real `pole` class would be better; the
  Obstacle-Dataset from TW0521 has one but states no license, so it is not used.
- **Curb comes only from Zenodo**, from the boxes labeled "steps" whose `type` attribute is "curb" (the record says steps
  between a street and a sidewalk are annotated as curbs). Other steps (doorsteps, "other"), ramps, and grab bars are dropped.
  I could not see the dataset's XML before writing the converter, so run `--inspect` first and check the attribute values.
- Open Images labels are not exhaustive: an image picked for "Door" may contain unlabeled stairs. Those become background.

## Class mapping

| Source class | Our class (id) |
|---|---|
| Open Images `Stairs` | stairs (80) |
| Open Images `Door` | door (83) |
| Open Images `Street light` | pole (82) |
| Zenodo `stairs` | stairs (80) |
| Zenodo `steps` with `type` = curb | curb (81) |
| COCO (our 17 kept classes) | same class, same id |
| Argoverse `person`, `bicycle`, `car`, `motorcycle`, `bus`, `truck` | same class, same id |
| Argoverse `traffic_light`, `stop_sign` | dropped (not announced by the app) |

Our 17 kept classes: person, bicycle, car, motorcycle, bus, truck, fire hydrant, parking meter, bench, dog, backpack,
handbag, suitcase, chair, couch, potted plant, dining table. The mapping lives in `ml/dataset_sources.json`.

## Pseudo-labels

Hazard photos contain people, chairs, and cars that the hazard datasets do not label. Left alone they would be learned as
background and the retrained model would get worse at the classes we already rely on. `prepare_dataset.py` therefore runs
the base model (`yolo26n.pt`) on every image from a hazard source and adds its boxes for our 17 kept classes at confidence
0.5, skipping any box that duplicates a label already there (same class, IoU above 0.5). Images from COCO and Argoverse are
labeled by people and get no pseudo-labels.

## Train and validation split

- Open Images, COCO, and Argoverse: their own train and validation splits.
- Zenodo has no split, so images are divided 90 / 10 by a stable hash of the file name. Photos taken during one walk can
  land on both sides, which makes the curb and stairs validation numbers a little optimistic.
- Default sample sizes: Open Images 1,500 training and 250 validation images per class; COCO 300 per kept class per split
  (about 4,000 unique training images); Argoverse 4,000 training and 500 validation images. Change them with the flags of
  `fetch_zoo.py` and the `max_images` entries in `ml/dataset_sources.json`.
- The validation set keeps a record of where each image came from (`datasets/hazards/manifest.csv`). `compare_models.py`
  scores the kept classes only on hand-labeled sources (COCO, Argoverse), because the pseudo-labels came from the base
  model and would favor it.

## What you must do by hand

Disk: plan for about 30 GB without Argoverse and about 95 GB with it, free, on the drive that holds this repo. The downloaded zip files stay after unzipping, so delete them afterwards to get the space back.

1. **Open Images and COCO** (automatic downloads, but the first Open Images run downloads about 7 GB of index files, a 4.8 GB image list and a 2.3 GB box file, of which about 3 GB stays in FiftyOne's cache in your user folder):
   `uv run --group ml python ml/fetch_zoo.py --openimages --coco`
2. **Zenodo**: download `wm_barriers_data.zip` (8.0 GB) from https://zenodo.org/records/6382090 and unzip it to
   `datasets/raw/zenodo-src/`. Then `uv run --group ml python ml/convert_zenodo.py --src datasets/raw/zenodo-src --inspect`
   (look at the `steps.type` values), then the same command without `--inspect`.
3. **Argoverse** (optional but recommended for street-scene people and vehicles; 31.5 GB):
   `uv run --group ml python ml/fetch_argoverse.py`
4. **Merge**: `uv run --group ml python ml/prepare_dataset.py --zip`. Read the per-class counts and warnings it prints.
5. Upload `datasets/hazards.zip` to Google Drive as `My Drive/kenshi/hazards.zip`, then run `ml/train_colab.ipynb` in Colab.

## Attribution text (put in the project's credits)

- Open Images V7: "Open Images Dataset V7. Annotations © Google LLC, licensed CC BY 4.0. Images licensed CC BY 2.0 by their
  authors." (Kuznetsova et al., "The Open Images Dataset V4", IJCV 2020.)
- Zenodo barriers: "Stolberg, J. (2022). Image Dataset of Accessibility Barriers [Data set]. Zenodo.
  https://doi.org/10.5281/zenodo.6382090. Licensed CC BY 4.0."
- COCO: "Microsoft COCO: Common Objects in Context" (Lin et al., ECCV 2014). Annotations licensed CC BY 4.0; the COCO
  Consortium does not own the copyright of the images.
- Argoverse-HD: Li, Wang, and Ramanan, "Towards Streaming Perception", ECCV 2020; and Chang et al., "Argoverse: 3D Tracking
  and Forecasting with Rich Maps", CVPR 2019. Licensed CC BY-NC-SA 4.0 (non-commercial).
