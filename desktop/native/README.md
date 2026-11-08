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

При обычном запуске установленный DxD Native проверяет обновления до открытия главного окна. Если есть новая версия, клиент показывает ход загрузки, устанавливает её и автоматически открывается. Если GitHub недоступен или загрузка прерывается, открывается текущая версия. Выбранная папка установки и профиль сохраняются. Переносной режим и запуски с особыми параметрами пропускают проверку.

Версия `2026.1106.11355` получит этот переходный выпуск по прежней схеме, при полном выходе из приложения. Более ранние версии можно обновить вручную этим установщиком.

Перед выпуском увеличьте `version` в `desktop/native/package.json` и обновите `package-lock.json`. Опубликуйте сгенерированные в одной сборке `.exe` и `latest.yml` в новом релизе. Проверьте оба файла в черновике и сделайте релиз последним, чтобы он стал доступен по `releases/latest/download`.

## Подбор кодека демонстрации для GPU

В настройках кодека демонстрации показаны обнаруженная видеокарта и доступность аппаратного кодирования для каждого кодека. Кнопка «Подобрать для моей видеокарты» включает автоматический выбор кодека и предпочтение аппаратного кодирования. Подбор использует штатную проверку возможностей GPU и WebRTC, включая NVIDIA и AMD. Ручной выбор кодека сохраняется до нажатия кнопки.

В режиме «Авто (WebRTC)» физический адаптер выбирают Windows и Chromium.

`gpu-codec-settings.patch` содержит изменения исходников renderer и переводы на русский и украинский для полной сборки из исходников. При использовании готового renderer из зафиксированного официального выпуска `prepare-runtime.cjs` применяет эквивалентное изменение через `patch-renderer-gpu.cjs`. Скрипт проверяет версию и SHA-256 исходного модуля и обновляет его хеш в `module-map.json`. Для нового выпуска upstream преобразование нужно проверить повторно.

## Прямой выбор NVENC и AMF

Выпуск 2026.1108.2 использует Electron 45.2.3 с Chromium 156 и экспериментальными API `RTCEncodedSource` и `RTCEncodedVideoFrameConstructor`. В настройках демонстрации доступны «Авто (WebRTC)», «NVIDIA NVENC (H.264)» и «AMD AMF (H.264)». Выбор сохраняется на устройстве и применяется к следующей демонстрации. Недоступные производители GPU отключены в списке. При выборе проверяется запуск аппаратного кодировщика.

При первом включении загружается отдельный компонент FFmpeg 6.1.1 из выпуска [ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1). Проверяются SHA-256 сжатого архива и исполняемого файла. Компонент хранится в профиле пользователя в `native-encoders/b6.1.1`. Установщик DxD содержит код интеграции. Исходники и сведения о лицензии компонента доступны в [проекте ffmpeg-static](https://github.com/eugeneware/ffmpeg-static/tree/24504b7d549c0400e099720b3d5854577693a63a), [FFmpeg](https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz) и в файлах LICENSE/README соответствующего выпуска.

Штатное окно выбора экрана или приложения сохраняется. Захваченные кадры передаются в выбранный кодировщик как RGBA с ограничением очереди, преобразуются в NV12 и кодируются в H.264. Полученные кадры поступают непосредственно в WebRTC через `RTCEncodedSource`. Звук демонстрации проходит через существующий аудиотракт. Путь использует копирование кадров через CPU.

`native-encoder-main.cjs` проверяет отправителя IPC, владельца сессии, параметры и контрольные суммы. `encoder-runtime.cjs` управляет FFmpeg, границами H.264, временными метками, обратным давлением и остановкой процесса. `native-encoder-renderer.js` связывает захват, публикацию и жизненный цикл демонстрации, а `native-encoder-worker.js` передаёт кадры в WebRTC.

`prepare-runtime.cjs` применяет проверяемые преобразования зафиксированного renderer через `patch-renderer-native-encoder*.cjs`. При смене upstream необходимо повторно проверить точки интеграции публикации и выбора кодека. Для проверок задайте `DXD_TEST_RENDERER_DIR` с официальным renderer и `DXD_TEST_FFMPEG` с проверенным FFmpeg, затем выполните `node --test desktop/native/*.test.cjs`.

На NVIDIA проверена настоящая цепочка от синтетического источника до декодированного видео у WebRTC-получателя. Проверка оборудования AMD AMF требует компьютера с AMD и соответствующим драйвером.
