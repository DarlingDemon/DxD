# DxD Native для Windows x64

Исходная версия — [Fluxer Canary 2026.1106.11354](https://github.com/fluxerapp/fluxer/tree/fluxer-desktop-canary%402026.1106.11354), коммит 4d2df4f250d15fb04cf04f902678b03d392c0c46. Патч задаёт API DxD при запуске и отдельный профиль, а конфигурация NSIS упаковывает клиент. Из официального выпуска того же тега берутся готовые нативные модули, renderer и иконки.

Сборка из корня репозитория в PowerShell с Node.js 24 и npm.

1. Клонируйте указанный тег Fluxer в upstream/native и примените desktop/native/dxd-native-source.patch в том checkout.
2. Выполните `npm ci` в `desktop/web` и `desktop/native` для установки упаковщика и модуля обновления.
3. В upstream/native установите зависимости командой npx pnpm@11.27.0 --filter fluxer_desktop... --filter fluxer_app... install --frozen-lockfile --ignore-scripts.
4. Запустите node desktop/native/prepare-runtime.cjs с путём к папке resources официальной установки Fluxer Canary этого тега.
5. В upstream/native/fluxer_desktop соберите оболочку командой node scripts/build.mjs --use-shared-renderer, задав DXD_PREPARED_BUILD_CHANNEL=1, BUILD_CHANNEL=canary, BUILD_VERSION=2026.1106.11354, FLUXER_OFFLINE=1, FLUXER_MODULES=0, FLUXER_SKIP_NATIVE=true и NODE_ENV=production.
6. Скопируйте dist из upstream/native/fluxer_desktop в desktop/native/payload/dist. Из корня выполните node desktop/web/node_modules/electron-builder/cli.js --projectDir desktop/native --config electron-builder.yml --win --x64 --publish never.

## Обновления через GitHub Releases

Пользователи предыдущих сборок устанавливают версию с автообновлением один раз вручную поверх текущей. Установленный DxD Native проверяет обновления после запуска и каждые четыре часа. Загруженная версия устанавливается при выходе через меню приложения или значок в трее. Выбранная папка установки и профиль сохраняются. В переносном режиме клиент пропускает автообновление, чтобы сохранить профиль внутри папки программы.

Перед выпуском увеличьте `version` в `desktop/native/package.json` и обновите `package-lock.json`. Опубликуйте сгенерированные в одной сборке `.exe` и `latest.yml` в новом релизе. Проверьте оба файла в черновике и сделайте релиз последним, чтобы он стал доступен по `releases/latest/download`.
