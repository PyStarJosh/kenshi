# Clips for comparing models

Short videos recorded with the iPhone camera app, **held sideways at eye level** (as Kenshi is used). Put them here;
`uv run --group ml python ml/compare_models.py` runs both models on every clip and saves sample frames with boxes to
`results/m2-compare/`.

- 10 to 30 seconds each; walk slowly. Include stairs, curbs, poles, doors, and the usual obstacles (people, chairs, bags).
- Name them for the scene, for example `curb-crossing-1.mov`, `door-glass-2.mov`.
- Use Settings > Camera > Formats > **Most Compatible** (H.264) before recording. iPhone's default HEVC `.mov` often cannot be
  read on Windows; if a clip will not open, convert it to H.264 `.mp4`.
- Videos are not committed (git ignores `.mp4` and `.mov` under `field-tests/`).
