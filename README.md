# Overtime Tracker

Внутренний инструмент для сбора отчётов по овертаймам от сотрудников.

- **Сотрудники** заходят без авторизации, выбирают себя из списка и подают таски с часами
- **Администратор** смотрит отчёты, фильтрует по периодам и сотрудникам, скачивает CSV

---

## Стек

- Node.js (v18+)
- Express 4
- Хранилище — JSON-файл (`data.json`), без внешних БД
- Basic Auth для админки

---

## Быстрый старт (локально)

```bash
git clone <repo-url>
cd overtime
npm install
node server.js
```

Открыть в браузере:
- Форма сотрудника: http://localhost:3000
- Админка: http://localhost:3000/admin → логин `admin`, пароль `overtime2024`

---

## Деплой на сервер

### 1. Требования

- Ubuntu 20.04+ / Debian 11+ (или любой Linux)
- Node.js 18 или новее
- `npm`
- (опционально) `nginx` как reverse proxy
- (опционально) `pm2` для запуска как сервис

---

### 2. Установка Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v  # должно быть v20.x.x
```

---

### 3. Копирование файлов на сервер

**Вариант А — через git:**
```bash
git clone <repo-url> /opt/overtime
cd /opt/overtime
npm install --omit=dev
```

**Вариант Б — через scp вручную:**
```bash
scp -r ./overtime user@your-server:/opt/overtime
ssh user@your-server
cd /opt/overtime
npm install --omit=dev
```

Убедись что `data.json` **не** копируется из локалки (он создастся чистым на сервере автоматически).

---

### 4. Настройка переменных окружения

Создай файл `/opt/overtime/.env`:

```bash
PORT=3000
ADMIN_USER=admin
ADMIN_PASS=замени_на_сложный_пароль
```

> **Важно:** `.env` не нужно коммитить в git — добавь его в `.gitignore`

Обнови `server.js` чтобы подхватывал `.env` — или просто передавай переменные при запуске (см. ниже).

---

### 5. Запуск через pm2 (рекомендуется)

pm2 перезапускает приложение при падении и стартует его вместе с системой.

```bash
sudo npm install -g pm2

# Запуск с переменными окружения
ADMIN_USER=admin ADMIN_PASS=твой_пароль PORT=3000 pm2 start /opt/overtime/server.js --name overtime

# Сохранить список процессов
pm2 save

# Автозапуск при ребуте
pm2 startup
# → выполни команду которую выведет pm2 startup
```

Полезные команды pm2:
```bash
pm2 status          # статус всех процессов
pm2 logs overtime   # логи в реальном времени
pm2 restart overtime
pm2 stop overtime
```

---

### 6. Nginx как reverse proxy (рекомендуется)

Позволяет открывать сайт по домену на 80/443 порту вместо 3000.

**Установка:**
```bash
sudo apt install -y nginx
```

**Конфиг** `/etc/nginx/sites-available/overtime`:
```nginx
server {
    listen 80;
    server_name overtime.yourcompany.com;  # или IP сервера

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

**Активация:**
```bash
sudo ln -s /etc/nginx/sites-available/overtime /etc/nginx/sites-enabled/
sudo nginx -t          # проверка конфига
sudo systemctl reload nginx
```

---

### 7. HTTPS через Let's Encrypt (опционально, нужен домен)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d overtime.yourcompany.com
```

Certbot сам обновит конфиг nginx и настроит авто-renewal.

---

### 8. Firewall

```bash
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP
sudo ufw allow 443   # HTTPS
sudo ufw enable
```

Порт 3000 открывать **не нужно** — nginx проксирует с 80/443.

---

## Смена пароля админки

Перезапусти pm2 с новым паролем:
```bash
pm2 stop overtime
ADMIN_USER=admin ADMIN_PASS=новый_пароль PORT=3000 pm2 start /opt/overtime/server.js --name overtime
pm2 save
```

---

## Бэкап данных

Все данные хранятся в `/opt/overtime/data.json`. Бэкапить просто:

```bash
# Вручную
cp /opt/overtime/data.json /backup/data-$(date +%Y%m%d).json

# Cron — ежедневно в 3:00
crontab -e
# добавить строку:
0 3 * * * cp /opt/overtime/data.json /backup/overtime-$(date +\%Y\%m\%d).json
```

---

## Обновление приложения

```bash
cd /opt/overtime
git pull
npm install --omit=dev
pm2 restart overtime
```

---

## Структура файлов

```
overtime/
├── server.js        — Express сервер, все API роуты, Basic Auth
├── db.js            — работа с data.json (read/write хелперы)
├── data.json        — база данных (создаётся автоматически)
├── package.json
└── public/
    ├── index.html   — форма для сотрудников (без авторизации)
    └── admin.html   — панель администратора
```

---

## API (краткий справочник)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/users` | Список сотрудников |
| GET | `/api/period` | Активный период |
| POST | `/api/submit` | Подать отчёт |
| GET | `/api/admin/users` | [admin] Список сотрудников |
| POST | `/api/admin/users` | [admin] Добавить сотрудника |
| DELETE | `/api/admin/users/:id` | [admin] Удалить сотрудника |
| GET | `/api/admin/periods` | [admin] Все периоды |
| POST | `/api/admin/periods` | [admin] Создать период |
| PATCH | `/api/admin/periods/:id/activate` | [admin] Активировать период |
| DELETE | `/api/admin/periods/:id` | [admin] Удалить период |
| GET | `/api/admin/submissions?userId=&periodId=` | [admin] Отчёты с фильтрами |
| GET | `/api/admin/export/csv?userId=&periodId=` | [admin] Экспорт CSV |
| DELETE | `/api/admin/submissions/:id` | [admin] Удалить отчёт |
