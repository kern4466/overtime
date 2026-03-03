const express = require('express');
const basicAuth = require('basic-auth');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'overtime2024';

// Сессии в памяти: token → { userId, userName, userLogin, userAgent, expiresAt }
const sessions = new Map();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

// Нормализует User-Agent: убирает версии чтобы мелкие обновления браузера
// не инвалидировали сессию — сравниваем только "движок" браузера
function normalizeUA(ua = '') {
  // Берём первые 60 символов UA — достаточно для идентификации браузера/ОС
  return (ua || '').slice(0, 60).toLowerCase();
}

function createSession(user, userAgent = '') {
  // Одна сессия на пользователя: убиваем все существующие сессии этого юзера
  for (const [token, s] of sessions) {
    if (s.userId === user.id) sessions.delete(token);
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId:    user.id,
    userName:  user.name,
    userLogin: user.login,
    userAgent: normalizeUA(userAgent), // привязка к браузеру
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getSession(token, userAgent = '') {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  // Проверяем привязку к браузеру
  if (session.userAgent && normalizeUA(userAgent) !== session.userAgent) {
    return null; // токен используется из другого браузера
  }
  return session;
}

// Чистим просроченные сессии раз в час
setInterval(() => {
  for (const [token, s] of sessions) {
    if (Date.now() > s.expiresAt) sessions.delete(token);
  }
}, 60 * 60 * 1000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Basic Auth для /admin ────────────────────────────────────────────────────
function requireAdminAuth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== ADMIN_USER || creds.pass !== ADMIN_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Overtime Admin"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

// ─── Token Auth для /api/submit ───────────────────────────────────────────────
function requireUserAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const session = getSession(token, req.headers['user-agent']);
  if (!session) return res.status(401).json({ error: 'Необходима авторизация' });
  req.session = session;
  next();
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Активный период (публичный — нужен до логина)
app.get('/api/period', (req, res) => {
  const period = db.getActivePeriod();
  res.json(period || null);
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }

  const user = db.verifyUser(login, password);
  if (!user) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  const token = createSession(user, req.headers['user-agent']);
  res.json({ token, userId: user.id, userName: user.name, userLogin: user.login });
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireUserAuth, (req, res) => {
  res.json({
    userId:    req.session.userId,
    userName:  req.session.userName,
    userLogin: req.session.userLogin
  });
});

// ─── Подача овертаймов (требует авторизации) ──────────────────────────────────
app.post('/api/submit', requireUserAuth, (req, res) => {
  try {
    const { periodId, entries } = req.body;
    const userId = req.session.userId;

    if (!periodId) {
      return res.status(400).json({ error: 'periodId обязателен' });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'Нет записей для отправки' });
    }

    const taskRe = /^OSHD-\d+$/;
    for (const e of entries) {
      if (!taskRe.test(e.taskId)) {
        return res.status(400).json({ error: `Неверный формат таска: ${e.taskId}` });
      }
      if (!e.hours || e.hours <= 0 || e.hours > 24) {
        return res.status(400).json({ error: `Неверное кол-во часов для ${e.taskId}` });
      }
    }

    const sub = db.addSubmission(userId, Number(periodId), entries);
    res.json({ ok: true, submission: sub });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Отчёты текущего пользователя
app.get('/api/my-submissions', requireUserAuth, (req, res) => {
  const subs = db.getSubmissions({ userId: req.session.userId });
  res.json(subs);
});

// ─── Admin API ────────────────────────────────────────────────────────────────

app.use('/api/admin', requireAdminAuth);
app.use('/admin', requireAdminAuth);

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Сотрудники
app.get('/api/admin/users', (req, res) => res.json(db.getUsers()));

app.post('/api/admin/users', (req, res) => {
  const { name, login, password } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Имя обязательно' });
  if (!login || !login.trim()) return res.status(400).json({ error: 'Логин обязателен' });
  if (!password) return res.status(400).json({ error: 'Пароль обязателен' });
  try {
    const user = db.addUser(name, login, password);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', (req, res) => {
  db.deleteUser(Number(req.params.id));
  res.json({ ok: true });
});

// Сброс пароля
app.patch('/api/admin/users/:id/password', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Пароль обязателен' });
  try {
    db.setUserPassword(Number(req.params.id), password);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Предпросмотр логина по имени (для UI)
app.post('/api/admin/users/suggest-login', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const users = db.getUsers();
  const login = db.generateLogin(name, users.map(u => u.login).filter(Boolean));
  res.json({ login });
});

// Импорт сотрудников
// Принимает { users: [{name, login?}], defaultPassword }
// или legacy { names: string[], defaultPassword }
app.post('/api/admin/users/import', (req, res) => {
  const { users, names, defaultPassword } = req.body;

  let items;
  if (Array.isArray(users) && users.length) {
    items = users; // [{name, login?}]
  } else if (Array.isArray(names) && names.length) {
    items = names.map(n => ({ name: String(n) })); // legacy
  } else {
    return res.status(400).json({ error: 'Передайте массив users или names' });
  }

  if (!defaultPassword) {
    return res.status(400).json({ error: 'Укажите defaultPassword для импортированных пользователей' });
  }
  const result = db.importUsers(items, defaultPassword);
  res.json(result);
});

// Периоды
app.get('/api/admin/periods', (req, res) => res.json(db.getPeriods()));

app.post('/api/admin/periods', (req, res) => {
  const { startDate, endDate, label } = req.body;
  if (!startDate || !endDate) return res.status(400).json({ error: 'Даты обязательны' });
  const period = db.addPeriod(startDate, endDate, label);
  res.json(period);
});

app.patch('/api/admin/periods/:id/activate', (req, res) => {
  db.setPeriodActive(Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/admin/periods/:id', (req, res) => {
  db.deletePeriod(Number(req.params.id));
  res.json({ ok: true });
});

// Отчёты
app.get('/api/admin/submissions', (req, res) => {
  const { userId, periodId } = req.query;
  const subs = db.getSubmissions({
    userId:   userId   ? Number(userId)   : undefined,
    periodId: periodId ? Number(periodId) : undefined
  });
  res.json(subs);
});

app.delete('/api/admin/submissions/:id', (req, res) => {
  db.deleteSubmission(Number(req.params.id));
  res.json({ ok: true });
});

// Экспорт CSV
app.get('/api/admin/export/csv', requireAdminAuth, (req, res) => {
  const { userId, periodId, detail } = req.query;
  const subs = db.getSubmissions({
    userId:   userId   ? Number(userId)   : undefined,
    periodId: periodId ? Number(periodId) : undefined
  });

  let rows, filename;

  if (detail === '1') {
    // Детализация: одна строка на каждую запись entries, с индивидуальной датой
    rows = ['Дата подачи;Сотрудник;Логин;Период;Таск;Часов'];
    for (const s of subs) {
      for (const e of s.entries) {
        const dt = new Date(e.submittedAt || s.submittedAt).toLocaleString('ru-RU');
        rows.push([dt, s.user.name, s.user.login || '', s.period.label, e.taskId, e.hours].join(';'));
      }
    }
    filename = 'overtime_detail.csv';
  } else {
    // Сводный: группируем по taskId, суммируем часы, берём последнюю дату
    rows = ['Сотрудник;Логин;Период;Таск;Часов;Последняя подача'];
    for (const s of subs) {
      const taskMap = new Map();
      for (const e of s.entries) {
        if (taskMap.has(e.taskId)) {
          const ex = taskMap.get(e.taskId);
          ex.hours += e.hours;
          if (!ex.submittedAt || (e.submittedAt && e.submittedAt > ex.submittedAt)) ex.submittedAt = e.submittedAt;
        } else {
          taskMap.set(e.taskId, { ...e });
        }
      }
      for (const e of taskMap.values()) {
        const dt = new Date(e.submittedAt || s.submittedAt).toLocaleString('ru-RU');
        rows.push([s.user.name, s.user.login || '', s.period.label, e.taskId, e.hours, dt].join(';'));
      }
    }
    filename = 'overtime_report.csv';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + rows.join('\n'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 Overtime Tracker запущен на http://localhost:${PORT}`);
  console.log(`📊 Админка: http://localhost:${PORT}/admin`);
  console.log(`   Логин: ${ADMIN_USER} / Пароль: ${ADMIN_PASS}\n`);
});
