# Кнопки MusicBot

Веб-клиент DxD и DxD Native 2026.1108.3 отображают настоящие кнопки под панелью MusicBot. Кнопки отправляют авторизованный запрос к собственному API и не создают реакции или сообщения с командами. Серверная часть находится в [musicbot](../../musicbot).

Общий код интерфейса — `desktop/native/music-player-controls-runtime.cjs`. Его фабрика получает React, штатный Button и авторизованный RestTransport клиента. Распознаётся только MusicBot `1562471889513742336` с корректной URL-меткой панели. Пересланные сообщения, webhooks и предпросмотры не получают активных кнопок. Повторные нажатия блокируются до ответа; ошибки видны под панелью.

Веб-сборка сохраняет изменения импорта тем из `web/theme-import`. Для исходников Fluxer `f5c30fdf8fc255b903b08c46afa42cd4188ea9df` выполните из корня DxD:

```sh
node web/music-controls/prepare-source.cjs /path/to/fluxer
```

Скрипт создаёт `MusicPlayerControls.tsx` из общей фабрики и подключает его в `MessageAttachments.tsx`. Эквивалентный исходный патч — `music-player-controls.patch`; используйте один из этих способов. После стандартных codegen, typecheck и production build Fluxer создайте service worker, скопируйте `fluxer_app/dist` в контекст runtime и соберите `Dockerfile.runtime` вместе с upstream `precompress_assets.sh`. Версия развёрнутого веб-клиента — `2026.1108.3-dxd-music-controls`.

Для официального desktop renderer `2026.1106.11354` эквивалентное преобразование выполняет `desktop/native/patch-renderer-music-controls.cjs`. Он проверяет исходный SHA-256, версию и экспорты модулей, затем обновляет хеш изменённого ресурса в `module-map.json`. Для следующей версии upstream точки интеграции нужно проверить повторно.

Проверки из корня DxD:

```sh
DXD_TEST_RENDERER_DIR=/path/to/original/renderer node --test desktop/native/patch-renderer-music-controls.test.cjs
node --test musicbot/player-controls.test.mjs
```
