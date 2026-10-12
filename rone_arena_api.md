# Интеграция Rone Arena API в веб-проект MLBB

Этот документ содержит архитектурное описание, рекомендации и рабочий клиентский модуль для работы с неофициальным **Rone Arena API** (данные по Mobile Legends: Bang Bang), включая футер с корректной атрибуцией.

---

## 📑 1. Обзор API и Структура Эндпоинтов

* **Базовый адрес API:** `https://arena.rone.dev/api`
* **Документация Swagger:** `https://arena.rone.dev/api/docs`
* **Python SDK / Репозиторий:** [github.com/ridwaanhall/rone-arena-python](https://github.com/ridwaanhall/rone-arena-python)
* **Пакет:** `rone-arena` (требуется Python >= 3.10)

### Группы эндпоинтов:
1. **`heroes`** — Списки героев, рейтинги, позиции, подробные детали, статистика, комбо, тренды, контрпики и совместимость.
2. **`academy`** — База знаний, роли, билды и рекомендации меты.
3. **`user`** — Авторизация, профили игроков, статистика, настройки приватности, данные о сезонах, история матчей, матчи на конкретных героях, списки друзей.
4. **`addon`** — Калькуляторы винрейта и вспомогательные сервисы.

---

## 🛠 2. Модуль интеграции на Python (`rone_client.py`)

Данный модуль оборачивает вызовы SDK `rone-arena`, реализует TTL-кэширование, обработку отказов (ошибки `503 Service Unavailable`) и переключение на запасные хосты.

```python
import time
from typing import Any, Callable, Dict, Optional
from rone_arena import RoneArena, RoneArenaError

# Инициализация основного клиента
client = RoneArena(timeout=30)

# Локальный кэш структуры: ключ -> (timestamp_создания, данные)
_cache: Dict[str, tuple[float, Any]] = {}

def get_data(key: str, ttl: int, call: Callable[[RoneArena], Any]) -> Any:
    """
    Универсальная обертка для запросов:
    1. Проверяет наличие свежих данных в кэше.
    2. Выполняет запрос к API.
    3. При ошибке 503 пробует использовать альтернативный хост (если подсказан API).
    4. При сбое возвращает устаревшие данные из кэша (если есть), чтобы сайт не падала.
    """
    global client

    # 1. Проверка актуальности кэша
    hit = _cache.get(key)
    if hit and (time.time() - hit[0] < ttl):
        return hit[1]

    # 2. Выполнение запроса
    try:
        data = call(client)
    except RoneArenaError as exc:
        data = None
        # Если API отдал 503 и предложил запасной endpoint
        alt_endpoint = getattr(exc, "alternative_endpoint", None)
        if alt_endpoint:
            client = RoneArena(base_url=f"{alt_endpoint}/api", timeout=30)
            try:
                data = call(client)
            except RoneArenaError:
                pass

        # Если данные так и не получены
        if data is None:
            if hit:
                # Возвращаем устаревший кэш вместо ошибки на сайте
                return hit[1]
            raise exc

    # 3. Сохранение успешного ответа
    _cache[key] = (time.time(), data)
    return data

# --- ПРИМЕРЫ ВЫЗОВОВ МЕТОДОВ ---

def get_heroes_list():
    """Получить список героев (TTL 1 час)."""
    return get_data(
        "heroes_list",
        3600,
        lambda c: c.heroes.heroes(size=20, index=1, order="desc", lang="en")
    )

def get_academy_roles():
    """Получить роли из академии (TTL 24 часа)."""
    return get_data(
        "academy_roles",
        86400,
        lambda c: c.academy.roles(lang="en")
    )
```

---

## 🔒 3. Архитектурные принципы и Безопасность

1. **Запросы только с Бэкенда:**
   Все запросы к Rone Arena API должны проходить через бэкенд вашей системы, а не вызываться напрямую из браузера пользователей. Это предохраняет токены от утечки, а также позволяет контролировать лимиты частоты запросов (Rate Limits).
2. **Обязательное Кэширование:**
   Так как API является бесплатным и поддерживается сообществом, серверы могут испытывать нагрузки. Использование TTL-кэширования минимизирует количество вызовов и снижает вероятность получения `503 Error`.
3. **Изоляция зависимости:**
   Неофициальные API склонны менять домены и структуры хостов (например, ранее использовался `openmlbb.fastapicloud.dev`, сейчас `arena.rone.dev`). Весь код взаимодействия с API изолирован в одном модуле.
4. **Проверка методов `user`:**
   Перед использованием авторизации и статистики пользователей через Swagger (`/api/docs`) или команды в Python (`dir(client.user)`, `help(client.user)`), необходимо убедиться:
   * Не требуется ли ввод токенов подтверждения или паролей от аккаунта самого игрока (что может нарушать правила игры).
   * Достаточно ли публичного User ID и Zone ID для чтения игровой статистики.

---

## 🎨 4. Компонент Атрибуции (Футер Сайта)

Согласно правилам использования данных производными проектами, на страницах сайта необходимо сохранять упоминание правообладателей ассетов и авторов API.

```html
<!-- Footer Component -->
<footer class="site-footer" style="padding: 20px; text-align: center; background-color: #1a1a1a; color: #888888; font-size: 14px;">
    <div class="footer-container">
        <p style="margin: 5px 0;">
            © 2026 <strong>Ваш Проект</strong>. Все права на игровые материалы, наименования и персонажей принадлежат <strong>Moonton</strong>.
        </p>
        <p style="margin: 5px 0;">
            Данные предоставлены неофициальным сообществом через 
            <a href="https://github.com/ridwaanhall/rone-arena-python" target="_blank" rel="noopener noreferrer" style="color: #4da6ff; text-decoration: none;">
                Rone Arena API
            </a> 
            (разработка <strong>ridwaanhall / RoneAI</strong>).
        </p>
    </div>
</footer>
```