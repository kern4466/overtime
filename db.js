const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data.json');
const SALT_ROUNDS = 10;

const DEFAULT = {
  users: [],
  periods: [],
  submissions: [],
  _nextId: { users: 1, periods: 1, submissions: 1 }
};

function read() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT));
  }
}

function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(data, table) {
  const id = data._nextId[table];
  data._nextId[table]++;
  return id;
}

// ─── Transliteration helpers ─────────────────────────────────────────────────

const TRANSLIT = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh',
  'з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o',
  'п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
  'ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
};

function transliterate(str) {
  return str.toLowerCase()
    .split('')
    .map(c => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

// "Иванов Иван Иванович" → "ivanov", при коллизии "ivanov2", "ivanov3"
function generateLogin(name, existingLogins) {
  const lastName = name.trim().split(/\s+/)[0];
  const base = transliterate(lastName) || 'user';
  const taken = new Set(existingLogins.map(l => l.toLowerCase()));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + i)) i++;
  return base + i;
}

// ─── Password helpers ─────────────────────────────────────────────────────────

function hashPassword(password) {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

function checkPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}

// ─── Users ────────────────────────────────────────────────────────────────────

function getUsers() {
  return read().users.map(sanitizeUser);
}

// Убираем passwordHash из публичного вывода
function sanitizeUser(u) {
  const { passwordHash, ...rest } = u;
  return { ...rest, hasPassword: !!passwordHash };
}

function addUser(name, login, password) {
  const data = read();

  if (!login) throw new Error('Логин обязателен');
  const loginLower = login.toLowerCase().trim();
  const duplicate = data.users.find(u => u.login?.toLowerCase() === loginLower);
  if (duplicate) throw new Error(`Логин «${login}» уже занят`);

  const user = {
    id: nextId(data, 'users'),
    name: name.trim(),
    login: loginLower,
    passwordHash: password ? hashPassword(password) : null
  };
  data.users.push(user);
  write(data);
  return sanitizeUser(user);
}

function deleteUser(id) {
  const data = read();
  data.users = data.users.filter(u => u.id !== id);
  write(data);
}

function setUserPassword(id, newPassword) {
  const data = read();
  const user = data.users.find(u => u.id === id);
  if (!user) throw new Error('Пользователь не найден');
  user.passwordHash = hashPassword(newPassword);
  write(data);
}

// Возвращает пользователя (с хешем) — только для internal проверки пароля
function findUserByLogin(login) {
  return read().users.find(u => u.login?.toLowerCase() === login.toLowerCase().trim()) || null;
}

function verifyUser(login, password) {
  const user = findUserByLogin(login);
  if (!user) return null;
  if (!checkPassword(password, user.passwordHash)) return null;
  return sanitizeUser(user);
}

// ─── Bulk import ──────────────────────────────────────────────────────────────
// items: Array<{ name: string, login?: string }>
// Логика:
//   - Если имя уже есть в базе И указан явный login → обновляет login (upsert)
//   - Если имя уже есть в базе, но login не указан  → пропускает (skipped)
//   - Если имя новое → добавляет с явным или авто-логином
//   - Дубли внутри батча всегда пропускаются
function importUsers(items, defaultPassword) {
  const data = read();
  const added   = [];
  const updated = [];
  const skipped = [];

  // Map name→user для быстрого поиска (с учётом регистра)
  const existingByName = new Map(data.users.map(u => [u.name.toLowerCase(), u]));
  const existingLogins = new Set(data.users.map(u => u.login?.toLowerCase()).filter(Boolean));

  const batchNames  = new Set();
  const batchLogins = new Set();

  const passwordHash = defaultPassword ? hashPassword(defaultPassword) : null;

  for (const item of items) {
    const name         = (item.name || '').trim();
    const explicitLogin = item.login ? item.login.toLowerCase().trim() : null;

    if (!name) continue;
    const nameKey = name.toLowerCase();

    // Дубль внутри батча
    if (batchNames.has(nameKey)) { skipped.push(name); continue; }
    batchNames.add(nameKey);

    const existing = existingByName.get(nameKey);

    if (existing) {
      // Пользователь уже есть в базе
      if (explicitLogin) {
        const loginTaken = (existingLogins.has(explicitLogin) && existing.login?.toLowerCase() !== explicitLogin)
          || batchLogins.has(explicitLogin);
        if (loginTaken) { skipped.push(name); continue; }

        // Обновляем логин (и пароль, если задан)
        existingLogins.delete(existing.login?.toLowerCase());
        existing.login = explicitLogin;
        if (passwordHash) existing.passwordHash = passwordHash;
        existingLogins.add(explicitLogin);
        batchLogins.add(explicitLogin);
        updated.push({ ...sanitizeUser(existing), login: explicitLogin });
      } else {
        skipped.push(name); // нет нового логина — пропускаем
      }
      continue;
    }

    // Новый пользователь
    let login;
    if (explicitLogin) {
      if (existingLogins.has(explicitLogin) || batchLogins.has(explicitLogin)) {
        skipped.push(name); continue;
      }
      login = explicitLogin;
    } else {
      const taken = [...existingLogins, ...batchLogins];
      login = generateLogin(name, taken);
    }
    batchLogins.add(login.toLowerCase());

    const user = {
      id: nextId(data, 'users'),
      name,
      login,
      passwordHash
    };
    data.users.push(user);
    added.push({ ...sanitizeUser(user), login });
  }

  if (added.length || updated.length) write(data);
  return { added, updated, skipped };
}

// ─── Periods ──────────────────────────────────────────────────────────────────

// Форматирует "2025-01-28" → "28 янв 2025"
function formatDate(iso) {
  const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${months[m - 1]} ${y}`;
}

// Авто-лейбл: "28 янв – 14 фев 2025" или "28 дек 2024 – 10 янв 2025" (cross-year)
function buildPeriodLabel(startDate, endDate) {
  const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);

  if (sy === ey) {
    return `${sd} ${months[sm-1]} – ${ed} ${months[em-1]} ${ey}`;
  } else {
    return `${sd} ${months[sm-1]} ${sy} – ${ed} ${months[em-1]} ${ey}`;
  }
}

function getPeriods() {
  return read().periods;
}

function getActivePeriod() {
  return read().periods.find(p => p.active) || null;
}

function addPeriod(startDate, endDate, label) {
  const data = read();
  data.periods.forEach(p => p.active = false);
  const period = {
    id: nextId(data, 'periods'),
    startDate,
    endDate,
    label: label || buildPeriodLabel(startDate, endDate),
    active: true,
    createdAt: new Date().toISOString()
  };
  data.periods.push(period);
  write(data);
  return period;
}

function setPeriodActive(id) {
  const data = read();
  data.periods.forEach(p => p.active = p.id === id);
  write(data);
}

function deletePeriod(id) {
  const data = read();
  data.periods = data.periods.filter(p => p.id !== id);
  write(data);
}

// ─── Submissions ──────────────────────────────────────────────────────────────

function getSubmissions({ userId, periodId } = {}) {
  const data = read();
  let subs = data.submissions;
  if (userId)   subs = subs.filter(s => s.userId === userId);
  if (periodId) subs = subs.filter(s => s.periodId === periodId);

  const users   = data.users;
  const periods = data.periods;
  return subs.map(s => ({
    ...s,
    user:   users.find(u => u.id === s.userId)     || { name: 'Unknown' },
    period: periods.find(p => p.id === s.periodId) || { label: 'Unknown' }
  }));
}

function addSubmission(userId, periodId, entries) {
  const data = read();
  const user   = data.users.find(u => u.id === userId);
  const period = data.periods.find(p => p.id === periodId);
  if (!user)   throw new Error('User not found');
  if (!period) throw new Error('Period not found');

  // Добавляем timestamp к каждой записи чтобы знать когда что было подано
  const now = new Date().toISOString();
  const stampedEntries = entries.map(e => ({ ...e, submittedAt: now }));

  const existing = data.submissions.find(s => s.userId === userId && s.periodId === periodId);
  if (existing) {
    // Аккумулируем — добавляем новые записи к уже существующим
    existing.entries.push(...stampedEntries);
    existing.updatedAt = now;
    write(data);
    return existing;
  }

  const sub = {
    id: nextId(data, 'submissions'),
    userId,
    periodId,
    entries: stampedEntries,
    submittedAt: now,
    updatedAt:   now
  };
  data.submissions.push(sub);
  write(data);
  return sub;
}

function deleteSubmission(id) {
  const data = read();
  data.submissions = data.submissions.filter(s => s.id !== id);
  write(data);
}

module.exports = {
  // users
  getUsers, addUser, deleteUser, setUserPassword, verifyUser, findUserByLogin, importUsers,
  // periods
  getPeriods, getActivePeriod, addPeriod, setPeriodActive, deletePeriod, buildPeriodLabel,
  // submissions
  getSubmissions, addSubmission, deleteSubmission,
  // helpers
  generateLogin, transliterate
};
