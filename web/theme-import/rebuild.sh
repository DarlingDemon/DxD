#!/usr/bin/env bash
set -euo pipefail
# Run against the reviewed, patched source checkout. Does not redeploy services.
cd "${1:-/opt/fluxer/fixes/theme-import/source}"
test "$(git rev-parse HEAD)" = f5c30fdf8fc255b903b08c46afa42cd4188ea9df
git add -N fluxer_app/src/features/theme_studio/sections/BetterDiscordImport.tsx \
  fluxer_app/src/features/theme_studio/sections/BetterDiscordImport.module.css \
  fluxer_app/src/features/theme_studio/utils/BetterDiscordImport.ts \
  fluxer_app/src/features/theme_studio/utils/BetterDiscordImport.test.ts \
  fluxer_app/src/features/theme_studio/utils/ThemeAppearanceImport.ts \
  fluxer_app/src/features/theme_studio/utils/ThemeAppearanceImport.test.ts \
  fluxer_app/src/features/theme_studio/utils/ThemeWallpaperImport.ts \
  fluxer_app/src/features/theme_studio/utils/ThemeWallpaperImport.test.ts
git diff --binary f5c30fdf8fc255b903b08c46afa42cd4188ea9df -- \
  fluxer_app/src/features/theme fluxer_app/src/features/theme_studio \
  fluxer_app/src/features/i18n/locales > dxd-theme-import.patch
python3 - <<'PY'
from pathlib import Path
source = Path('fluxer_app_proxy/Dockerfile').read_text()
prefix = source.split('# ---------- Stage 3:')[0]
runtime = '''
FROM ghcr.io/fluxerapp/fluxer-app-proxy-self-hosted@sha256:e4c6c2fa7cdb0aeb2a336cced263db8b0d0f0b0d7505a469f064056bad702c79
COPY --from=app-assets /assets /srv/app/static/
COPY dxd-theme-import.patch /srv/app/static/assets/dxd-theme-import-source.patch
ENV BUILD_VERSION=2026.1015.51543-dxd-theme-import.3
LABEL app.fluxer.build-version="2026.1015.51543-dxd-theme-import.3"
LABEL app.dxd.source-base="f5c30fdf8fc255b903b08c46afa42cd4188ea9df"
LABEL app.dxd.local-change="BetterDiscord theme importer"
'''
Path('Dockerfile.dxd-theme-import').write_text(prefix + runtime)
PY
docker build --build-arg BUILD_VERSION=2026.1015.51543-dxd-theme-import.3 \
  -f Dockerfile.dxd-theme-import -t fluxer-app-proxy:theme-appearance-20261026 .
