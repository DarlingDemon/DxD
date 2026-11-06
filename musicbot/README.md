# MusicBot

База — [Remix для Fluxer](https://github.com/remix-bot/fluxer/tree/fa5bc68f16ed191aa25a6ee5dcee09ac62009f0e). Скопируйте содержимое overlay в корень checkout Remix, а deploy — в его папку deploy. Создайте deploy/config.json на основе примера upstream и задайте instanceUrl https://darkdck.duckdns.org/api. Укажите токен и пароли локально, затем заполните MYSQL_ROOT_PASSWORD, MYSQL_PASSWORD и NODELINK_PASSWORD в deploy/.env. Для работы бота используются существующие голосовые каналы Fluxer.

Перед сборкой примените `queue-advance.patch` из корня checkout Remix. Патч восстанавливает переход по очереди после `!skip`, `!skipto` и окончания заданного фрагмента трека.
