# Carrot Cluster

Standalone raylib cluster UI bundle for openpilot devices.

Run from the openpilot root:

```bash
python selfdrive/carrot/cluster_run.py --output usb

python selfdrive/carrot/cluster_run.py --output usb --profile-render
```

Useful options:

```bash
python selfdrive/carrot/cluster_run.py --output window --width 1920 --height 480
python selfdrive/carrot/cluster_run.py --output usb --live-no-can
python selfdrive/carrot/cluster_run.py --output usb --usb-codec jpeg --usb-jpeg-quality 68
python selfdrive/carrot/cluster_run.py --output usb --fps 10 --usb-jpeg-quality 55 --route-overlay off
python selfdrive/carrot/cluster_run.py --output usb --profile-render --profile-interval 2
```

`--usb-jpeg-encoder auto` tries optional `turbojpeg` first and falls back to
Pillow. Route replay defaults to `--route-overlay compact`, which shows the
right-side qcamera/debug panel. Use `--route-overlay off` for performance tests
that should match live rendering cost more closely.

The launcher defaults to `--input live`, subscribes to openpilot cereal services,
and renders live `carState`, `modelV2`, `radarState`, `liveTracks`, and raw
Hyundai CAN-FD radar points when CAN subscription is enabled.

The bundled TURZX code includes only the Python vendor library. The openpilot
device uses the system `libusb-1.0.so` through `pyusb`.

The renderer prefers
`/data/openpilot/selfdrive/assets/fonts/KaiGenGothicKR-Bold.ttf` for HUD text.
It falls back to the bundled/addon KaiGen copy, then JetBrainsMono and
system/platform fonts if KaiGen is not present.

USB frame upload runs in no-ACK mode by default because some TURZX panels accept
image data but never return a frame-upload response. Use `--usb-wait-frame-ack`
only when testing a panel/driver combination known to reply after each frame.

## Lane/path smoothing

`--lane-smoothing smooth` (default) enables four data-side stabilizers without
touching the camera, scene intent, or vehicle 3D rendering. Pass
`--lane-smoothing legacy` to fall back to the raw modelV2 + synthetic-curve
behavior:

1. EMA-filter modelV2 lane lines, road edges, and the planned path
   (`alpha=CLUSTER_LANE_ALPHA`, default 0.25 → ~0.2s time constant).
2. Heavier EMA on `lane_width_m` (alpha × 0.4 → ~0.5s) and `lane_center_offset_m`
   (alpha) to stop frame-to-frame lateral shift jitter.
3. Drop the `steering × forward²` synthetic-curve fallback. Lanes without
   modelV2 points simply disappear instead of wobbling.
4. Catmull-Rom interpolation between the 33 sparse modelV2 sample points for
   smoother centerlines.

Tune the filter strength without editing code:

```bash
CLUSTER_LANE_ALPHA=0.18 python selfdrive/carrot/cluster_run.py --input route \
  --route /data/media/0/realdata/<route_id> --output usb --route-loop \
  --lane-smoothing smooth
```

Range: 0.02–1.0. Lower = smoother but slower lane-change response. Recommended
0.15–0.35.
