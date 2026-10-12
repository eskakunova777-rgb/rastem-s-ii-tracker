// Автотесты API на временной базе. Пароли здесь тестовые, только для этой базы.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_PASSWORD = 'test-admin-pass';
process.env.ASSISTANT_PASSWORD = 'test-assistant-pass';
const app = require('../server');

let base;
let server;
const jar = {};

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  jar.admin = await login('evgenia', 'test-admin-pass');
  jar.assistant = await login('assistant', 'test-assistant-pass');
});

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function login(loginName, password) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: loginName, password }),
  });
  assert.equal(res.status, 200, `вход ${loginName}`);
  return res.headers.get('set-cookie').split(';')[0];
}

async function call(who, method, url, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (who && jar[who]) headers.Cookie = jar[who];
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${base}${url}`, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function newTask(fields = {}) {
  const r = await call('admin', 'POST', '/api/tasks', { title: 'Задача', assignee_id: 2, category_id: 1, ...fields });
  assert.equal(r.status, 201);
  return r.data.id;
}

test('без входа API закрыт', async () => {
  assert.equal((await call(null, 'GET', '/api/tasks')).status, 401);
});

test('безопасность: заголовки и cookie сессии', async () => {
  const r = await call(null, 'GET', '/');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.match(jar.admin, /^sid=[0-9a-f]{64}$/);
});

test('1. ассистент не может перевести задачу в «Готово»', async () => {
  const id = await newTask({ status: 'review' });
  const r = await call('assistant', 'PATCH', `/api/tasks/${id}`, { status: 'done' });
  assert.equal(r.status, 403);
  assert.equal((await call('admin', 'GET', `/api/tasks/${id}`)).data.status, 'review');
});

test('1а. ассистент двигает свою задачу Новая → В работе → На проверке', async () => {
  const id = await newTask();
  assert.equal((await call('assistant', 'PATCH', `/api/tasks/${id}`, { status: 'in_progress' })).status, 200);
  assert.equal((await call('assistant', 'PATCH', `/api/tasks/${id}`, { status: 'review' })).status, 200);
  assert.equal((await call('assistant', 'PATCH', `/api/tasks/${id}`, { status: 'in_progress' })).status, 403);
});

test('1б. ассистент не меняет чужие задачи и чужие поля', async () => {
  const foreign = await newTask({ assignee_id: 1 });
  assert.equal((await call('assistant', 'PATCH', `/api/tasks/${foreign}`, { status: 'in_progress' })).status, 403);
  const own = await newTask();
  assert.equal((await call('assistant', 'PATCH', `/api/tasks/${own}`, { title: 'Переименовал' })).status, 403);
  assert.equal((await call('assistant', 'PATCH', `/api/tasks/${own}`, { due_date: daysFromToday(30) })).status, 403);
});

test('2. ассистент не может удалить задачу, владелец может', async () => {
  const id = await newTask();
  assert.equal((await call('assistant', 'DELETE', `/api/tasks/${id}`)).status, 403);
  assert.equal((await call('admin', 'DELETE', `/api/tasks/${id}`)).status, 200);
  assert.equal((await call('admin', 'GET', `/api/tasks/${id}`)).status, 404);
});

test('3. задача от ассистента становится предложением, лимит 5, владелец принимает', async () => {
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await call('assistant', 'POST', '/api/tasks', { title: `Идея ${i}`, status: 'new' });
    assert.equal(r.status, 201);
    assert.equal(r.data.status, 'proposed');
    ids.push(r.data.id);
  }
  assert.equal((await call('assistant', 'POST', '/api/proposals', { title: 'Шестая' })).status, 429);
  assert.equal((await call('assistant', 'POST', `/api/tasks/${ids[0]}/accept`)).status, 403);
  assert.equal((await call('admin', 'POST', `/api/tasks/${ids[0]}/accept`)).status, 200);
  assert.equal((await call('admin', 'GET', `/api/tasks/${ids[0]}`)).data.status, 'new');
  assert.equal((await call('admin', 'POST', `/api/tasks/${ids[1]}/reject`)).status, 200);
  assert.equal((await call('assistant', 'POST', '/api/proposals', { title: 'Теперь можно' })).status, 201);
  // Убираем остальные, чтобы не мешали другим тестам.
  for (const id of ids.slice(2)) await call('admin', 'POST', `/api/tasks/${id}/reject`);
});

test('4. после 5 неверных паролей вход блокируется', async () => {
  await call('admin', 'POST', '/api/users', { login: 'victim', name: 'Тест', role: 'assistant', password: 'right-password' });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call(null, 'POST', '/api/login', { login: 'victim', password: 'wrong' })).status, 401);
  }
  const locked = await call(null, 'POST', '/api/login', { login: 'victim', password: 'right-password' });
  assert.equal(locked.status, 429);
});

test('5. смена имени и пароля в профиле', async () => {
  await call('admin', 'POST', '/api/users', { login: 'profile', name: 'Старое', role: 'assistant', password: 'first-password' });
  jar.profile = await login('profile', 'first-password');
  assert.equal((await call('profile', 'PATCH', '/api/me', { name: 'Новое имя' })).status, 200);
  assert.equal((await call('profile', 'GET', '/api/me')).data.name, 'Новое имя');
  assert.equal((await call('profile', 'POST', '/api/me/password', { old_password: 'wrong', new_password: 'second-password' })).status, 400);
  assert.equal((await call('profile', 'POST', '/api/me/password', { old_password: 'first-password', new_password: 'short' })).status, 400);
  assert.equal((await call('profile', 'POST', '/api/me/password', { old_password: 'first-password', new_password: 'second-password' })).status, 200);
  await login('profile', 'second-password');
});

test('6. владелец добавляет члена команды, ассистент нет', async () => {
  assert.equal((await call('assistant', 'POST', '/api/users', { login: 'x', name: 'x', role: 'admin', password: '12345678' })).status, 403);
  assert.equal((await call('admin', 'POST', '/api/users', { login: 'helper', name: 'Помощник', role: 'assistant', password: 'helper-pass' })).status, 201);
  assert.equal((await call('admin', 'POST', '/api/users', { login: 'helper', name: 'Дубль', role: 'assistant', password: 'helper-pass' })).status, 409);
  assert.equal((await call('assistant', 'GET', '/api/users')).status, 403);
});

test('7. просроченная задача требует причину, «Другое» требует комментарий', async () => {
  const id = await newTask({ due_date: daysFromToday(-2) });
  const t = (await call('admin', 'GET', `/api/tasks/${id}`)).data;
  assert.equal(t.overdue, true);
  assert.equal(t.needs_reason, true);
  assert.equal((await call('assistant', 'PATCH', `/api/tasks/${id}`, { status: 'in_progress' })).status, 400);
  assert.equal((await call('assistant', 'PATCH', `/api/tasks/${id}`, { overdue_reason: 'other' })).status, 400);
  const ok = await call('assistant', 'PATCH', `/api/tasks/${id}`, { status: 'in_progress', overdue_reason: 'no_access' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.needs_reason, false);
});

test('8. результат файлом до 20 МБ, больше нельзя; скачивание только с входом', async () => {
  const id = await newTask();
  const fd = new FormData();
  fd.append('file', new Blob(['готовый текст поста']), 'пост.txt');
  const r = await call('assistant', 'POST', `/api/tasks/${id}/result`, fd);
  assert.equal(r.status, 200);
  assert.equal(r.data.has_file, true);
  assert.equal(r.data.result_file_name, 'пост.txt');
  const file = await call('admin', 'GET', `/api/tasks/${id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.data, 'готовый текст поста');
  assert.equal((await call(null, 'GET', `/api/tasks/${id}/file`)).status, 401);
  const big = new FormData();
  big.append('file', new Blob([Buffer.alloc(21 * 1024 * 1024)]), 'big.bin');
  assert.equal((await call('assistant', 'POST', `/api/tasks/${id}/result`, big)).status, 400);
  assert.equal((await call('assistant', 'POST', `/api/tasks/${id}/result`, { result_url: 'javascript:alert(1)' })).status, 400);
});

test('9. API ассистента по ключу: свои задачи, статус, комментарий', async () => {
  const key = (await call('admin', 'POST', '/api/users/2/api-key')).data.api_key;
  assert.match(key, /^trk_/);
  const bearer = { Authorization: `Bearer ${key}` };
  const id = await newTask({ title: 'Через API' });
  const mine = await call(null, 'GET', '/api/tasks?mine=1&status=new', null, bearer);
  assert.equal(mine.status, 200);
  assert.ok(mine.data.some((t) => t.id === id));
  assert.ok(mine.data.every((t) => t.assignee_id === 2));
  assert.equal((await call(null, 'PATCH', `/api/tasks/${id}`, { status: 'in_progress' }, bearer)).status, 200);
  assert.equal((await call(null, 'POST', `/api/tasks/${id}/comments`, { text: 'Взял в работу' }, bearer)).status, 201);
  assert.equal((await call(null, 'GET', '/api/users', null, bearer)).status, 403);
  assert.equal((await call('admin', 'POST', '/api/users/1/api-key')).status, 400);
  // Перевыпуск ключа: старый перестаёт работать.
  await call('admin', 'POST', '/api/users/2/api-key');
  assert.equal((await call(null, 'GET', '/api/tasks', null, bearer)).status, 401);
});

test('9а. сводка считает просрочки по категориям и причинам', async () => {
  const s = (await call('admin', 'GET', '/api/summary')).data;
  const social = s.rows.find((r) => r.category === 'Соцсети РФ');
  assert.ok(social.overdue >= 1);
  assert.ok(s.total_reasons.no_access >= 1);
});

test('12. повтор задачи и выгрузка CSV', async () => {
  const id = await newTask({ title: 'Еженедельный пост', due_date: daysFromToday(1) });
  const r = await call('admin', 'POST', `/api/tasks/${id}/repeat`);
  assert.equal(r.status, 201);
  const copy = (await call('admin', 'GET', `/api/tasks/${r.data.id}`)).data;
  assert.equal(copy.title, 'Еженедельный пост');
  assert.equal(copy.due_date, daysFromToday(8));
  assert.equal(copy.status, 'new');
  assert.equal((await call('assistant', 'POST', `/api/tasks/${id}/repeat`)).status, 403);
  await newTask({ title: '=HYPERLINK("http://evil")' });
  const csv = await call('admin', 'GET', '/api/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Еженедельный пост/);
  assert.match(csv.data, /"'=HYPERLINK/);
  assert.equal((await call('assistant', 'GET', '/api/export.csv')).status, 403);
});

test('возврат с проверки в работу только с комментарием', async () => {
  const id = await newTask({ status: 'review' });
  assert.equal((await call('admin', 'PATCH', `/api/tasks/${id}`, { status: 'in_progress' })).status, 400);
  const ok = await call('admin', 'PATCH', `/api/tasks/${id}`, { status: 'in_progress', comment: 'Добавь ссылку на пост' });
  assert.equal(ok.status, 200);
  const hist = (await call('admin', 'GET', `/api/tasks/${id}`)).data.history;
  assert.ok(hist.some((h) => h.kind === 'comment' && h.text === 'Добавь ссылку на пост'));
  assert.ok(hist.some((h) => h.field === 'status' && h.new_value === 'in_progress'));
});

test('безопасность: SQL-инъекция в фильтрах и названии не ломает базу', async () => {
  const r = await call('admin', 'GET', "/api/tasks?status=new' OR 1=1--&category_id=1 OR 1=1");
  assert.equal(r.status, 200);
  const id = await newTask({ title: "'); DROP TABLE tasks; --" });
  assert.equal((await call('admin', 'GET', `/api/tasks/${id}`)).data.title, "'); DROP TABLE tasks; --");
});
