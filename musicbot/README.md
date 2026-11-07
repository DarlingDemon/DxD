# MusicBot

База — [Remix для Fluxer](https://github.com/remix-bot/fluxer/tree/fa5bc68f16ed191aa25a6ee5dcee09ac62009f0e). Скопируйте содержимое overlay в корень checkout Remix, а deploy — в его папку deploy. Создайте deploy/config.json на основе примера upstream и задайте instanceUrl https://darkdck.duckdns.org/api. Укажите токен и пароли локально, затем заполните MYSQL_ROOT_PASSWORD, MYSQL_PASSWORD и NODELINK_PASSWORD в deploy/.env. Для работы бота используются существующие голосовые каналы Fluxer.

Перед сборкой примените `queue-advance.patch` из корня checkout Remix. Патч восстанавливает переход по очереди после `!skip`, `!skipto` и окончания заданного фрагмента трека.

Затем примените `player-panel.patch`. Команда `!player` открывает панель с прогрессом, громкостью, очередью и недавними действиями. Управляйте плеером реакциями под сообщением из того же голосового канала, где играет MusicBot.

Примените `player-panel-auto.patch` поверх предыдущего патча. Первый успешный `!play` открывает панель автоматически. При смене трека и изменении очереди бот редактирует то же сообщение. Панель закрывается при выходе бота, по реакции ❌ или после простоя с пустой очередью.

Затем примените `empty-channel-leave.patch`. Бот выходит из пустого голосового канала после `timers.inactivityTimeout`, включая воспроизведение и паузу. Повторные проверки и смена трека сохраняют срок выхода. Возвращение слушателя отменяет выход. Для включения задайте в локальном `deploy/config.json` значение `timers.stayInVoice: false`. На сервере DxD используется `timers.inactivityTimeout: 180000` — три минуты. Режим `!247 on` позволяет оставить бота в выбранном канале.

Проверка таймеров из корня checkout Remix после применения патчей:

```sh
node --test /path/to/DxD/musicbot/empty-channel-leave.test.mjs
```
