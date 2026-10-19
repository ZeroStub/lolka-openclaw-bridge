# Lolka × OpenClaw — мост между Lolka и сессиями агентов

Двусторонний текстовый мост между **[Lolka](https://lolka.app)** (российский аналог Discord, API совместим с Discord Bot API v10) и **[OpenClaw](https://docs.openclaw.ai)** — платформой агентов.

Каждый канал Lolka привязывается к конкретной сессии агента OpenClaw: сообщения из канала попадают в сессию, ответы агента и реплики владельца возвращаются в канал. Из чата доступны команды управления сессией (смена модели, компакция контекста, статус, рестарт гейтвея).

```text
   ┌─────────────┐   messageCreate    ┌──────────────────────────┐
   │ канал Lolka │ ─────────────────► │  bridge.js  (Node 22+)   │
   └─────────────┘                    │                          │
          ▲                           │  ws://127.0.0.1:18789    │
          │  REST / вебхук канала     │  OpenClaw Gateway        │
          └───────────────────────────┤  sessions.send / patch / │
                                      │  subscribe …             │
                                      └──────────────────────────┘
```

## Возможности

- **Двусторонний обмен**: канал Lolka ↔ сессия OpenClaw (`sessions.send`), привязка «канал → sessionKey + agentId».
- **Реплики владельца от его имени**: сообщения пользователей публикуются через вебхук канала с именем и аватаром автора, а не от бота.
- **Анти-эхо** и фильтр служебных реплик (`toolUse`, heartbeat, runtime-события, ошибки прогона).
- **Надёжная отправка** (`outbox.js`): один воркер на канал (без гонок и перестановок), ретраи `5/10/15/20/25 с`, парковка буфера при длительном сбое, dead-letter для постоянных 4xx, восстановление состояния при старте.
- **Команды из чата** (только владелец, см. «Безопасность»): `/status`, `/model`, `/models`, `/modelall`, `/modelprovider`, `/think`, `/ctx`, `/ctxwarn`, `/ctxcompact`, `/compact`, `/stop`, `/notices`, `/toolstyle`, `/toolticker`, `/typing`, `/chatadd`, `/restart`, `/help`.
- **Кнопки под `/status`**: «Обновить», «Компакция», «Стоп» (компоненты Lolka, Discord-совместимые).
- **Уведомления о вызовах инструментов**: отдельным сообщением или одним блоком-тикером, который дописывается правкой (`PATCH`).
- **Плашка о заполнении контекста** и принудительная компакция, когда сессия «залипает» на полном окне.
- **Мультибот**: один файл обслуживает несколько ботов Lolka — набор конфигов выбирается переменной `LOLKA_CFG_SUFFIX`.

## Требования

| Что | Версия / примечание |
|---|---|
| Node.js | 22+ (`lolka.js` — форк discord.js 14) |
| OpenClaw | Gateway на `ws://127.0.0.1:18789`, scopes `operator.read` + `operator.write` + `operator.admin` (последний нужен для `sessions.patch`) |
| Бот Lolka | приложение в [портале разработчика](https://lolka.app/developers/portal), бот добавлен на сервер (`/bot-authorize`) |
| Права бота | `VIEW_CHANNEL`, `SEND_MESSAGES`, `MANAGE_WEBHOOKS` (для подписи автора вебхуком), `MANAGE_MESSAGES` (правка сообщений) |

## Установка

```bash
git clone https://github.com/<owner>/lolka-openclaw-bridge.git
cd lolka-openclaw-bridge
npm install
cp bridges.example.json bridges.json
cp .token.example .token        # вписать токен бота Lolka
$EDITOR bridges.json             # заполнить guildId, channelId, sessionKey
```

Токен бота Lolka создаётся в портале разработчика и **показывается один раз**; его нужно положить в `.token` (файл в `.gitignore`) или передать через `LOLKA_BOT_TOKEN`. Токен даёт полный доступ к боту — не коммитить, не логировать, не вставлять в чат.

## Настройка

### `bridges.json`

```json
{
  "guildId": "000000000000000000",
  "mappings": [
    {
      "channelId": "000000000000000001",
      "name": "general",
      "sessionKey": "agent:main:main",
      "agentId": "main",
      "webhookUrl": "",
      "notices": true
    }
  ]
}
```

| Поле | Смысл |
|---|---|
| `guildId` | id сервера Lolka (нужен для `/chatadd`) |
| `channelId` | id канала Lolka |
| `name` | человекочитаемое имя канала (в логах) |
| `sessionKey` | ключ сессии OpenClaw, например `agent:main:main` |
| `agentId` | агент OpenClaw (нужен для `sessions.patch` и подписок) |
| `webhookUrl` | заполняется автоматически при старте (имя/аватар автора) |
| `notices` | уведомления о вызовах инструментов в этом канале |
| `ctxWarn`, `ctxCompact`, `toolStyle`, `toolTicker`, `typing` | per-channel переключатели (пишутся командами из чата) |

### Запуск

```bash
node bridge.js            # вручную
npm run smoke             # проверка токена и списка серверов
npm run test:outbox       # регресс-тест очереди отправки
```

Юнит systemd (user):

```ini
# ~/.config/systemd/user/lolka-bridge.service
[Unit]
Description=Lolka <-> OpenClaw text bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/lolka-openclaw-bridge
ExecStart=/usr/bin/node %h/lolka-openclaw-bridge/bridge.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now lolka-bridge.service
loginctl enable-linger "$USER"   # чтобы мост жил без активной сессии
```

Второй бот — второй юнит с `Environment=LOLKA_CFG_SUFFIX=-bot2` и своим набором файлов (`.token-bot2`, `bridges-bot2.json`, `outbox-bot2.json`).

## Команды в чате

| Команда | Действие |
|---|---|
| `/status` | состояние сессии: модель, токены/окно, расход; сообщение с кнопками |
| `/model` · `/model <provider/id>` · `/model default` | показать / сменить / сбросить модель сессии (id сверяется с каталогом) |
| `/models` · `/modelall` | доступные / все модели провайдеров |
| `/modelprovider [id]` | список провайдеров или модели одного провайдера |
| `/think <off\|minimal\|low\|medium\|high>` | уровень размышлений |
| `/ctx` · `/ctxwarn on\|off` · `/ctxcompact on\|off` | контекст: оценка заполнения, плашка, автокомпакция |
| `/compact` · `/stop` | компакция контекста · прервать прогон |
| `/notices on\|off` · `/toolstyle <стиль>` · `/toolticker on\|off` | уведомления о вызовах инструментов |
| `/typing on\|off` | индикатор «печатает» в канале (см. ограничения) |
| `/chatadd [new\|tree] [имя]` | новый чат OpenClaw + канал Lolka, связанные друг с другом |
| `/restart` | перезапуск гейтвея OpenClaw (`openclaw gateway restart`) |
| `/help` | список команд |

## Переменные окружения

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `LOLKA_BOT_TOKEN` | — | токен бота (альтернатива файлу `.token`) |
| `LOLKA_CFG_SUFFIX` | — | суффикс файлов для второго бота (`-bot2`) |
| `OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` | конфиг OpenClaw |
| `OPENCLAW_BIN` | `openclaw` | бинарь для `/restart` |
| `LOLKA_ADMINS` | пусто | id пользователей (через запятую), которым разрешены команды |
| `LOLKA_CTX_THRESHOLDS` | `80,95,100` | пороги плашки о контексте, % |
| `LOLKA_CTX_AUTOCOMPACT` | `1` | принудительная компакция при полном контексте |
| `LOLKA_TOOL_STYLE` | `code` | оформление уведомлений: `code\|quote\|spoiler\|plain\|off` |
| `LOLKA_TOOL_TICKER` | `1` | серия вызовов одним блоком |
| `LOLKA_TYPING` | `1` | слать `typing` в канал |
| `LOLKA_TYPING_EVERY_MS` | `8000` | период обновления индикатора |
| `LOLKA_TYPING_MIN_MS` | `2500` | минимум показа перед отправкой ответа |
| `LOLKA_TYPING_DELAY` | `min` | `min` — добирать до минимума, `always` — всегда ждать, `off` — без задержки |
| `LOLKA_TYPING_GRACE_MS` | `10000` | грейс после завершения операции |
| `LOLKA_TYPING_MAX_MS` | `1800000` | потолок одного прогона (30 мин) |
| `LOLKA_RETRY_DELAYS` | `5,10,15,20,25` | задержки ретраев outbox, с |
| `LOLKA_OUTBOX_PARK_MS` | `300000` | парковка буфера при сбое |
| `LOLKA_BRIDGE_DEBUG` | — | `1` — писать сырые события в `events.jsonl` |

## Ограничения Lolka Bot API

Проверено на живом API (2026-10):

- **Индикатор набора от ботов не транслируется.** `POST /channels/{id}/typing` отвечает `204`, но это заглушка-no-op («оставлен для совместимости с Discord-клиентами»). Мост держит вызов, но вычеркнуть его из кода — значит потерять индикатор в тот день, когда платформа включит трансляцию.
- `PATCH /channels/{id}/messages/{id}` работает, `PUT` — 404.
- Ограничения по частоте: при превышении `429`, нужен backoff.
- Права проверяются на уровне сервера/канала: без `VIEW_CHANNEL`/`SEND_MESSAGES` — `403`.
- `TYPING_START` — только входящее событие (бот его получает, но не шлёт).

## Безопасность

- **Команды доступны только владельцу.** Владелец определяется по id из `.owner.json` (кто написал в канал; для вебхука — его имя и аватар). Права администратора сервера намеренно **не** учитываются: команды дают доступ к сессиям, смене модели и рестарту гейтвея. Явно расширить круг можно переменной `LOLKA_ADMINS`.
- Остальные участники получают ответ «команды моста доступны только владельцу сервера» (не чаще раза в минуту на канал).
- Обычный текст уходит агенту от любого участника канала — если это не нужно, добавьте проверку на входе.
- Секреты (`.token`, `.appid`, `.owner.json`, `bridges.json` с URL вебхуков) вне репозитория — см. `.gitignore`.

## Структура

| Файл | Назначение |
|---|---|
| `bridge.js` | мост: Lolka-клиент + WS к гейтвею OpenClaw, команды, уведомления, typing |
| `outbox.js` | очередь отправки: воркер на канал, ретраи, парковка, dead-letter, правка сообщений |
| `add-channel.js` | создать канал Lolka и добавить привязку |
| `smoke.js` | проверка токена и списка серверов |
| `webhook.js` | отправка сообщения через входящий вебхук канала |
| `gw-subscribe.js` | PoC подписки на события сессии OpenClaw |
| `test-outbox.js` | регресс-тест очереди (retry, dead-letter, park/poke, restore, edit) |
| `show-msgs.py` | быстрый просмотр последних сообщений канала |

## Лицензия

MIT — см. `LICENSE`.
