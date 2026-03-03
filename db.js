const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

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

// Users
function getUsers() {
  return read().users;
}

function addUser(name) {
  const data = read();
  const user = { id: nextId(data, 'users'), name: name.trim() };
  data.users.push(user);
  write(data);
  return user;
}

function deleteUser(id) {
  const data = read();
  data.users = data.users.filter(u => u.id !== id);
  write(data);
}

// Periods
function getPeriods() {
  return read().periods;
}

function getActivePeriod() {
  return read().periods.find(p => p.active) || null;
}

function addPeriod(startDate, endDate, label) {
  const data = read();
  // деактивируем все остальные
  data.periods.forEach(p => p.active = false);
  const period = {
    id: nextId(data, 'periods'),
    startDate,
    endDate,
    label: label || `${startDate} – ${endDate}`,
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

// Submissions
function getSubmissions({ userId, periodId } = {}) {
  const data = read();
  let subs = data.submissions;
  if (userId) subs = subs.filter(s => s.userId === userId);
  if (periodId) subs = subs.filter(s => s.periodId === periodId);

  // Обогащаем данными user и period
  const users = data.users;
  const periods = data.periods;
  return subs.map(s => ({
    ...s,
    user: users.find(u => u.id === s.userId) || { name: 'Unknown' },
    period: periods.find(p => p.id === s.periodId) || { label: 'Unknown' }
  }));
}

function addSubmission(userId, periodId, entries) {
  const data = read();
  const user = data.users.find(u => u.id === userId);
  const period = data.periods.find(p => p.id === periodId);
  if (!user) throw new Error('User not found');
  if (!period) throw new Error('Period not found');

  // Проверяем — уже подавал за этот период?
  const existing = data.submissions.find(s => s.userId === userId && s.periodId === periodId);
  if (existing) {
    // обновляем
    existing.entries = entries;
    existing.updatedAt = new Date().toISOString();
    write(data);
    return existing;
  }

  const sub = {
    id: nextId(data, 'submissions'),
    userId,
    periodId,
    entries,
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
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
  getUsers, addUser, deleteUser,
  getPeriods, getActivePeriod, addPeriod, setPeriodActive, deletePeriod,
  getSubmissions, addSubmission, deleteSubmission
};
