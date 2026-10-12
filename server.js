// Трекер задач «Растем с ИИ»: владелец ставит и проверяет, ИИ-ассистент выполняет через API.
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR, hashPassword, verifyPassword, sha256, seed } = require('./db');

seed();

const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const MAX_PROPOSALS = 5;
const MAX_FILE_MB = 20;
const APP_TZ = process.env.APP_TZ || 'Europe/Rome';

const STATUSES = ['proposed', 'new', 'in_progress', 'review', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const OVERDUE_REASONS = {
  waiting_owner: 'Ждёт моего решения или проверки',
  waiting_external: 'Ждёт ответа клиента или площадки',
  no_access: 'Не хватило доступа или данных',
  underestimated: 'Переоценили объём',
  priority_changed: 'Сменился приоритет',
  other: 'Другое',
};
// Куда ассистент может перевести свою задачу из каждого статуса.
const ASSISTANT_MOVES = {
  new: ['in_progress'],
  in_progress: ['review'],
  review: [],
  done: [],
  proposed: [],
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
});

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ }).format(new Date());
}

function isOverdue(task) {
  return Boolean(task.due_date) && task.due_date < today() && !['done', 'proposed'].includes(task.status);
}

function fail(res, code, error) {
  return res.status(code).json({ error });
}

// --- аутентификация: cookie сессии в браузере или ключ API у ассистента ---
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function currentUser(req) {
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  if (bearer) {
    return db.prepare('SELECT id, login, name, role FROM users WHERE api_key_hash = ?')
      .get(sha256(bearer[1])) || null;
  }
  const token = readCookie(req, 'sid');
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.login, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')`).get(sha256(token)) || null;
}

function auth(req, res, next) {
  const user = currentUser(req);
  if (!user) return fail(res, 401, 'Нужно войти');
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return fail(res, 403, 'Доступно только владельцу');
  next();
}

const isAdmin = (req) => req.user.role === 'admin';

// --- вход, выход, профиль ---
app.post('/api/login', (req, res) => {
  const login = String((req.body || {}).login || '').trim();
  const password = String((req.body || {}).password || '');
  const attempt = db.prepare('SELECT * FROM login_attempts WHERE login = ?').get(login);
  if (attempt && attempt.locked_until && attempt.locked_until > new Date().toISOString()) {
    return fail(res, 429, `Слишком много попыток. Вход заблокирован на ${LOCK_MINUTES} минут`);
  }
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
  if (!user || !verifyPassword(password, user.pass_hash)) {
    const fails = (attempt && !attempt.locked_until ? attempt.fails : 0) + 1;
    const lockedUntil = fails >= MAX_FAILS
      ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
    db.prepare(`INSERT INTO login_attempts (login, fails, locked_until) VALUES (?, ?, ?)
      ON CONFLICT(login) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until`)
      .run(login, lockedUntil ? 0 : fails, lockedUntil);
    return fail(res, 401, 'Неверный логин или пароль');
  }
  db.prepare('DELETE FROM login_attempts WHERE login = ?').run(login);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, datetime('now', ?))`).run(sha256(token), user.id, `+${SESSION_DAYS} days`);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  res.json({ id: user.id, name: user.name, role: user.role });
});

app.post('/api/logout', (req, res) => {
  const token = readCookie(req, 'sid');
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.patch('/api/me', auth, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return fail(res, 400, 'Имя не может быть пустым');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ok: true });
});

app.post('/api/me/password', auth, (req, res) => {
  const { old_password: oldPass, new_password: newPass } = req.body || {};
  const user = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(oldPass || ''), user.pass_hash)) return fail(res, 400, 'Старый пароль неверный');
  if (String(newPass || '').length < 8) return fail(res, 400, 'Новый пароль: минимум 8 символов');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(newPass), req.user.id);
  // Остальные сессии пользователя закрываем, текущую оставляем.
  const token = readCookie(req, 'sid');
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .run(req.user.id, token ? sha256(token) : '');
  res.json({ ok: true });
});

// --- справочники и пользователи ---
app.get('/api/meta', auth, (req, res) => {
  res.json({
    categories: db.prepare('SELECT id, name FROM categories ORDER BY sort, id').all(),
    users: db.prepare('SELECT id, name, role FROM users ORDER BY id').all(),
    overdue_reasons: OVERDUE_REASONS,
    max_file_mb: MAX_FILE_MB,
    today: today(),
  });
});

app.post('/api/categories', auth, adminOnly, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return fail(res, 400, 'Нужно название');
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories').get().s;
  try {
    db.prepare('INSERT INTO categories (name, sort) VALUES (?, ?)').run(name, sort);
  } catch {
    return fail(res, 409, 'Такая категория уже есть');
  }
  res.status(201).json({ ok: true });
});

app.patch('/api/categories/:id', auth, adminOnly, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (!name) return fail(res, 400, 'Нужно название');
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/categories/:id', auth, adminOnly, (req, res) => {
  const used = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE category_id = ?').get(req.params.id).n;
  if (used) return fail(res, 409, `В категории ${used} задач, сначала перенесите их`);
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/users', auth, adminOnly, (req, res) => {
  res.json(db.prepare(`SELECT id, login, name, role, api_key_hash IS NOT NULL AS has_api_key, created_at
    FROM users ORDER BY id`).all());
});

app.post('/api/users', auth, adminOnly, (req, res) => {
  const { login, name, role, password } = req.body || {};
  if (!login || !name || !['admin', 'assistant'].includes(role)) return fail(res, 400, 'Нужны логин, имя и роль');
  if (String(password || '').length < 8) return fail(res, 400, 'Пароль: минимум 8 символов');
  try {
    db.prepare('INSERT INTO users (login, name, role, pass_hash) VALUES (?, ?, ?, ?)')
      .run(String(login).trim(), String(name).trim(), role, hashPassword(String(password)));
  } catch {
    return fail(res, 409, 'Такой логин уже есть');
  }
  res.status(201).json({ ok: true });
});

app.post('/api/users/:id/password', auth, adminOnly, (req, res) => {
  const password = String((req.body || {}).password || '');
  if (password.length < 8) return fail(res, 400, 'Пароль: минимум 8 символов');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Ключ показывается один раз, в базе хранится только хеш.
app.post('/api/users/:id/api-key', auth, adminOnly, (req, res) => {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return fail(res, 404, 'Пользователь не найден');
  if (user.role !== 'assistant') return fail(res, 400, 'Ключ API выдаётся только ассистенту');
  const key = `trk_${crypto.randomBytes(24).toString('hex')}`;
  db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(sha256(key), user.id);
  res.json({ api_key: key });
});

// --- задачи ---
const TASK_SELECT = `
  SELECT t.*, c.name AS category_name, u.name AS assignee_name, cr.name AS creator_name
  FROM tasks t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN users u ON u.id = t.assignee_id
  LEFT JOIN users cr ON cr.id = t.created_by`;

function decorate(task) {
  task.overdue = isOverdue(task);
  task.needs_reason = task.overdue && !task.overdue_reason;
  task.has_file = Boolean(task.result_file);
  delete task.result_file;
  return task;
}

function getTask(id) {
  const task = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
  return task ? decorate(task) : null;
}

function logChange(taskId, userId, field, oldValue, newValue) {
  db.prepare(`INSERT INTO history (task_id, user_id, kind, field, old_value, new_value)
    VALUES (?, ?, 'change', ?, ?, ?)`).run(taskId, userId, field, oldValue ?? null, newValue ?? null);
}

function addComment(taskId, userId, text) {
  db.prepare(`INSERT INTO history (task_id, user_id, kind, text) VALUES (?, ?, 'comment', ?)`)
    .run(taskId, userId, text);
}

app.get('/api/tasks', auth, (req, res) => {
  const where = [];
  const params = [];
  if (req.query.mine === '1') { where.push('t.assignee_id = ?'); params.push(req.user.id); }
  if (req.query.status && STATUSES.includes(req.query.status)) { where.push('t.status = ?'); params.push(req.query.status); }
  if (req.query.category_id) { where.push('t.category_id = ?'); params.push(Number(req.query.category_id)); }
  if (req.query.assignee_id) { where.push('t.assignee_id = ?'); params.push(Number(req.query.assignee_id)); }
  const sql = `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.due_date IS NULL, t.due_date, t.id`;
  let tasks = db.prepare(sql).all(...params).map(decorate);
  if (req.query.overdue === '1') tasks = tasks.filter((t) => t.overdue);
  res.json(tasks);
});

app.get('/api/tasks/:id', auth, (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return fail(res, 404, 'Задача не найдена');
  task.history = db.prepare(`
    SELECT h.id, h.kind, h.field, h.old_value, h.new_value, h.text, h.created_at, u.name AS user_name
    FROM history h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.task_id = ? ORDER BY h.created_at, h.id`).all(task.id);
  res.json(task);
});

function cleanTask(body) {
  const out = {};
  if ('title' in body) out.title = String(body.title || '').trim();
  if ('description' in body) out.description = String(body.description || '');
  if ('category_id' in body) out.category_id = body.category_id ? Number(body.category_id) : null;
  if ('assignee_id' in body) out.assignee_id = body.assignee_id ? Number(body.assignee_id) : null;
  if ('due_date' in body) out.due_date = /^\d{4}-\d{2}-\d{2}$/.test(body.due_date || '') ? body.due_date : null;
  if ('priority' in body && PRIORITIES.includes(body.priority)) out.priority = body.priority;
  if ('status' in body && STATUSES.includes(body.status)) out.status = body.status;
  if ('result_url' in body) {
    const url = String(body.result_url || '').trim();
    out.result_url = /^https?:\/\//i.test(url) ? url : null;
  }
  if ('overdue_reason' in body) out.overdue_reason = OVERDUE_REASONS[body.overdue_reason] ? body.overdue_reason : null;
  if ('overdue_comment' in body) out.overdue_comment = String(body.overdue_comment || '').trim() || null;
  return out;
}

function createProposal(req, res) {
  const data = cleanTask(req.body || {});
  if (!data.title) return fail(res, 400, 'Нужно название');
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'proposed' AND created_by = ?`)
    .get(req.user.id).n;
  if (pending >= MAX_PROPOSALS) {
    return fail(res, 429, `Уже ${MAX_PROPOSALS} непринятых предложений. Сначала владелец их разберёт`);
  }
  const r = db.prepare(`INSERT INTO tasks (title, description, category_id, assignee_id, due_date, priority, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`).run(data.title, data.description || '', data.category_id ?? null,
    req.user.id, data.due_date ?? null, data.priority || 'medium', req.user.id);
  res.status(201).json({ id: Number(r.lastInsertRowid), status: 'proposed' });
}

app.post('/api/proposals', auth, createProposal);

app.post('/api/tasks', auth, (req, res) => {
  if (!isAdmin(req)) return createProposal(req, res);
  const data = cleanTask(req.body || {});
  if (!data.title) return fail(res, 400, 'Нужно название');
  const status = data.status && data.status !== 'proposed' ? data.status : 'new';
  const r = db.prepare(`INSERT INTO tasks (title, description, category_id, assignee_id, due_date, priority, status, result_url, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(data.title, data.description || '', data.category_id ?? null,
    data.assignee_id ?? null, data.due_date ?? null, data.priority || 'medium', status, data.result_url ?? null, req.user.id);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.patch('/api/tasks/:id', auth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return fail(res, 404, 'Задача не найдена');
  let data = cleanTask(req.body || {});
  const comment = String((req.body || {}).comment || '').trim();

  if (!isAdmin(req)) {
    if (task.assignee_id !== req.user.id) return fail(res, 403, 'Можно менять только свои задачи');
    const allowed = ['status', 'result_url', 'overdue_reason', 'overdue_comment'];
    const extra = Object.keys(data).filter((k) => !allowed.includes(k) && String(task[k] ?? '') !== String(data[k] ?? ''));
    if (extra.length) return fail(res, 403, `Ассистент не может менять: ${extra.join(', ')}`);
    if (data.status && data.status !== task.status && !ASSISTANT_MOVES[task.status].includes(data.status)) {
      return fail(res, 403, data.status === 'done'
        ? 'Перевести в «Готово» может только владелец'
        : 'Такой переход статуса недоступен ассистенту');
    }
  } else if (data.status === 'proposed' && task.status !== 'proposed') {
    return fail(res, 400, 'Вернуть задачу в предложения нельзя');
  }

  const statusChanges = data.status && data.status !== task.status;
  if (statusChanges && task.status === 'review' && data.status === 'in_progress' && !comment) {
    return fail(res, 400, 'Чтобы вернуть задачу в работу, напишите комментарий: что доделать');
  }
  const merged = { ...task, ...data };
  if (statusChanges && isOverdue(task) && !merged.overdue_reason) {
    return fail(res, 400, 'Задача просрочена: укажите причину просрочки');
  }
  if (merged.overdue_reason === 'other' && !merged.overdue_comment && 'overdue_reason' in data) {
    return fail(res, 400, 'Для причины «Другое» нужен комментарий');
  }

  for (const [field, value] of Object.entries(data)) {
    if (String(task[field] ?? '') === String(value ?? '')) continue;
    db.prepare(`UPDATE tasks SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(value, task.id);
    logChange(task.id, req.user.id, field, task[field], value);
  }
  if (comment) addComment(task.id, req.user.id, comment);
  res.json(getTask(task.id));
});

app.post('/api/tasks/:id/accept', auth, adminOnly, (req, res) => {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND status = 'proposed'`).get(req.params.id);
  if (!task) return fail(res, 404, 'Предложение не найдено');
  db.prepare(`UPDATE tasks SET status = 'new', updated_at = datetime('now') WHERE id = ?`).run(task.id);
  logChange(task.id, req.user.id, 'status', 'proposed', 'new');
  res.json({ ok: true });
});

app.post('/api/tasks/:id/reject', auth, adminOnly, (req, res) => {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND status = 'proposed'`).get(req.params.id);
  if (!task) return fail(res, 404, 'Предложение не найдено');
  removeTask(task);
  res.json({ ok: true });
});

function removeTask(task) {
  if (task.result_file) fs.rmSync(path.join(FILES_DIR, task.result_file), { force: true });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
}

app.delete('/api/tasks/:id', auth, adminOnly, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return fail(res, 404, 'Задача не найдена');
  removeTask(task);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/repeat', auth, adminOnly, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return fail(res, 404, 'Задача не найдена');
  const base = task.due_date && task.due_date > today() ? task.due_date : today();
  const due = new Date(`${base}T12:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 7);
  const r = db.prepare(`INSERT INTO tasks (title, description, category_id, assignee_id, due_date, priority, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`).run(task.title, task.description, task.category_id, task.assignee_id,
    due.toISOString().slice(0, 10), task.priority, req.user.id);
  addComment(Number(r.lastInsertRowid), req.user.id, `Повтор задачи №${task.id}`);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.post('/api/tasks/:id/comments', auth, (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return fail(res, 400, 'Пустой комментарий');
  if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id)) return fail(res, 404, 'Задача не найдена');
  addComment(req.params.id, req.user.id, text);
  res.status(201).json({ ok: true });
});

// Результат: ссылка в JSON или файл в multipart (поле file).
app.post('/api/tasks/:id/result', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? `Файл больше ${MAX_FILE_MB} МБ` : 'Не удалось загрузить файл');
    }
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    const dropUpload = () => req.file && fs.rmSync(req.file.path, { force: true });
    if (!task) { dropUpload(); return fail(res, 404, 'Задача не найдена'); }
    if (!isAdmin(req) && task.assignee_id !== req.user.id) { dropUpload(); return fail(res, 403, 'Можно менять только свои задачи'); }
    const url = String((req.body || {}).result_url || '').trim();
    if (!req.file && !url) return fail(res, 400, 'Нужна ссылка или файл');
    if (url) {
      if (!/^https?:\/\//i.test(url)) { dropUpload(); return fail(res, 400, 'Ссылка должна начинаться с http'); }
      db.prepare(`UPDATE tasks SET result_url = ?, updated_at = datetime('now') WHERE id = ?`).run(url, task.id);
      logChange(task.id, req.user.id, 'result_url', task.result_url, url);
    }
    if (req.file) {
      if (task.result_file) fs.rmSync(path.join(FILES_DIR, task.result_file), { force: true });
      const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200);
      db.prepare(`UPDATE tasks SET result_file = ?, result_file_name = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(req.file.filename, name, task.id);
      logChange(task.id, req.user.id, 'result_file', task.result_file_name, name);
    }
    res.json(getTask(task.id));
  });
});

app.get('/api/tasks/:id/file', auth, (req, res) => {
  const task = db.prepare('SELECT result_file, result_file_name FROM tasks WHERE id = ?').get(req.params.id);
  if (!task || !task.result_file) return fail(res, 404, 'Файла нет');
  res.download(path.join(FILES_DIR, task.result_file), task.result_file_name);
});

// --- сводка, выгрузка, место на диске ---
app.get('/api/summary', auth, (req, res) => {
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY sort, id').all();
  const tasks = db.prepare('SELECT * FROM tasks').all();
  const rows = [{ id: null, name: 'Без категории' }, ...categories].map((c) => {
    const own = tasks.filter((t) => (t.category_id ?? null) === c.id);
    const overdue = own.filter(isOverdue);
    const reasons = {};
    for (const t of overdue) {
      const key = t.overdue_reason || 'not_set';
      reasons[key] = (reasons[key] || 0) + 1;
    }
    return {
      category: c.name,
      new: own.filter((t) => t.status === 'new').length,
      in_progress: own.filter((t) => t.status === 'in_progress').length,
      review: own.filter((t) => t.status === 'review').length,
      done: own.filter((t) => t.status === 'done').length,
      overdue: overdue.length,
      reasons,
    };
  }).filter((r) => r.category !== 'Без категории' || r.new + r.in_progress + r.review + r.done + r.overdue > 0);
  const totalReasons = {};
  for (const r of rows) for (const [k, n] of Object.entries(r.reasons)) totalReasons[k] = (totalReasons[k] || 0) + n;
  res.json({
    rows,
    total_reasons: totalReasons,
    proposed: tasks.filter((t) => t.status === 'proposed').length,
    review: tasks.filter((t) => t.status === 'review').length,
  });
});

function csvCell(value) {
  const s = String(value ?? '');
  // Защита от формул при открытии в Excel и экранирование кавычек.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

app.get('/api/export.csv', auth, adminOnly, (req, res) => {
  const tasks = db.prepare(`${TASK_SELECT} ORDER BY t.id`).all().map(decorate);
  const head = ['id', 'Название', 'Категория', 'Исполнитель', 'Срок', 'Приоритет', 'Статус', 'Просрочена',
    'Причина просрочки', 'Комментарий к просрочке', 'Ссылка на результат', 'Файл результата', 'Создана'];
  const lines = tasks.map((t) => [t.id, t.title, t.category_name, t.assignee_name, t.due_date, t.priority, t.status,
    t.overdue ? 'да' : 'нет', OVERDUE_REASONS[t.overdue_reason] || '', t.overdue_comment, t.result_url,
    t.result_file_name, t.created_at].map(csvCell).join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tracker-${today()}.csv"`);
  res.send(`﻿${[head.map(csvCell).join(';'), ...lines].join('\r\n')}`);
});

app.get('/api/storage', auth, adminOnly, (req, res) => {
  let bytes = 0;
  for (const f of fs.readdirSync(FILES_DIR)) bytes += fs.statSync(path.join(FILES_DIR, f)).size;
  res.json({ files_mb: Math.round((bytes / 1048576) * 10) / 10, warn_at_mb: 5120 });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, () => console.log(`Трекер запущен: http://localhost:${PORT}`));
}

module.exports = app;
