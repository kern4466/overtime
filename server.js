const express = require('express');
const basicAuth = require('basic-auth');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'overtime2024';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Basic Auth middleware для /admin и /api/admin ───────────────────────────
function requireAuth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== ADMIN_USER || creds.pass !== ADMIN_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Overtime Admin"');
    return res.status(401).send('Unauthorized');
  }
  next();
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Список сотрудников
app.get('/api/users', (req, res) => {
  res.json(db.getUsers());
});

// Активный период
app.get('/api/period', (req, res) => {
  const period = db.getActivePeriod();
  if (!period) return res.json(null);
  res.json(period);
});

// Подача овертаймов
app.post('/api/submit', (req, res) => {
  try {
    const { userId, periodId, entries } = req.body;

    if (!userId || !periodId) {
      return res.status(400).json({ error: 'userId и periodId обязательны' });
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'Нет записей для отправки' });
    }

    // Валидация записей
    const taskRe = /^OSHD-\d+$/;
    for (const e of entries) {
      if (!taskRe.test(e.taskId)) {
        return res.status(400).json({ error: `Неверный формат таска: ${e.taskId}. Должно быть OSHD-12345` });
      }
      if (!e.hours || e.hours <= 0 || e.hours > 24) {
        return res.status(400).json({ error: `Неверное кол-во часов для ${e.taskId}` });
      }
    }

    const sub = db.addSubmission(Number(userId), Number(periodId), entries);
    res.json({ ok: true, submission: sub });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Admin API ───────────────────────────────────────────────────────────────

app.use('/api/admin', requireAuth);
app.use('/admin', requireAuth);

// Отдаём admin.html
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Управление пользователями
app.get('/api/admin/users', (req, res) => res.json(db.getUsers()));

app.post('/api/admin/users', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Имя обязательно' });
  const user = db.addUser(name);
  res.json(user);
});

app.delete('/api/admin/users/:id', (req, res) => {
  db.deleteUser(Number(req.params.id));
  res.json({ ok: true });
});

// Управление периодами
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

// Просмотр отчётов
app.get('/api/admin/submissions', (req, res) => {
  const { userId, periodId } = req.query;
  const subs = db.getSubmissions({
    userId: userId ? Number(userId) : undefined,
    periodId: periodId ? Number(periodId) : undefined
  });
  res.json(subs);
});

app.delete('/api/admin/submissions/:id', (req, res) => {
  db.deleteSubmission(Number(req.params.id));
  res.json({ ok: true });
});

// Скачать CSV
app.get('/api/admin/export/csv', requireAuth, (req, res) => {
  const { userId, periodId } = req.query;
  const subs = db.getSubmissions({
    userId: userId ? Number(userId) : undefined,
    periodId: periodId ? Number(periodId) : undefined
  });

  const rows = ['Сотрудник;Период;Таск;Часов;Дата подачи'];
  for (const s of subs) {
    for (const e of s.entries) {
      rows.push([
        s.user.name,
        s.period.label,
        e.taskId,
        e.hours,
        new Date(s.submittedAt).toLocaleString('ru-RU')
      ].join(';'));
    }
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="overtime_report.csv"');
  res.send('\uFEFF' + rows.join('\n')); // BOM для Excel
});

app.listen(PORT, () => {
  console.log(`\n🚀 Overtime Tracker запущен на http://localhost:${PORT}`);
  console.log(`📊 Админка: http://localhost:${PORT}/admin`);
  console.log(`   Логин: ${ADMIN_USER} / Пароль: ${ADMIN_PASS}\n`);
});
