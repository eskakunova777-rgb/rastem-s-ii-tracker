// Клиент трекера: доска, мои задачи, сводка, настройки, профиль.
const STATUS_LABELS = {
  proposed: 'Предложена', new: 'Новая', in_progress: 'В работе', review: 'На проверке', done: 'Готово',
};
const BOARD_STATUSES = ['new', 'in_progress', 'review', 'done'];
const ASSISTANT_MOVES = { new: ['in_progress'], in_progress: ['review'], review: [], done: [], proposed: [] };
const PRIORITY_LABELS = { low: 'низкий', medium: 'средний', high: 'высокий' };
const FIELD_LABELS = {
  title: 'название', description: 'описание', category_id: 'категория', assignee_id: 'исполнитель',
  due_date: 'срок', priority: 'приоритет', status: 'статус', result_url: 'ссылку на результат',
  result_file: 'файл результата', overdue_reason: 'причину просрочки', overdue_comment: 'комментарий к просрочке',
};

const state = {
  me: null, meta: null, tasks: [], editing: null, view: 'board', mobileStatus: 'new',
};
const $ = (sel) => document.querySelector(sel);
const isAdmin = () => state.me && state.me.role === 'admin';

async function api(method, url, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : {},
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Ошибка'), { status: res.status });
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function nameById(list, id) {
  const found = list.find((x) => x.id === id);
  return found ? found.name : null;
}

function readableValue(field, value) {
  if (value == null || value === '') return '-';
  if (field === 'status') return STATUS_LABELS[value] || value;
  if (field === 'priority') return PRIORITY_LABELS[value] || value;
  if (field === 'category_id') return nameById(state.meta.categories, Number(value)) || value;
  if (field === 'assignee_id') return nameById(state.meta.users, Number(value)) || value;
  if (field === 'due_date') return formatDate(value);
  if (field === 'overdue_reason') return state.meta.overdue_reasons[value] || value;
  return value;
}

// --- вход ---
async function start() {
  try {
    state.me = await api('GET', '/api/me');
    await showApp();
  } catch {
    $('#login-view').hidden = false;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    state.me = await api('POST', '/api/login', Object.fromEntries(new FormData(e.target)));
    $('#login-view').hidden = true;
    await showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  location.reload();
});

async function showApp() {
  $('#app-view').hidden = false;
  $('#me').textContent = state.me.name;
  document.querySelectorAll('[data-admin]').forEach((n) => { n.hidden = !isAdmin(); });
  $('#new-task').textContent = isAdmin() ? '+ Задача' : '+ Предложить задачу';
  state.meta = await api('GET', '/api/meta');
  fillStaticSelects();
  await refresh();
}

function fillStaticSelects() {
  const { categories, users, overdue_reasons: reasons } = state.meta;
  const opt = (value, text) => el('option', { value, textContent: text });
  $('#f-category').replaceChildren(opt('', 'Все категории'), ...categories.map((c) => opt(c.id, c.name)));
  $('#f-assignee').replaceChildren(opt('', 'Все исполнители'), ...users.map((u) => opt(u.id, u.name)));
  const form = $('#task-form');
  form.category_id.replaceChildren(opt('', '-'), ...categories.map((c) => opt(c.id, c.name)));
  form.assignee_id.replaceChildren(opt('', '-'), ...users.map((u) => opt(u.id, u.name)));
  form.overdue_reason.replaceChildren(opt('', 'не указана'),
    ...Object.entries(reasons).map(([k, v]) => opt(k, v)));
}

// --- навигация ---
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

async function showView(view) {
  state.view = view;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  await refresh();
}

async function refresh() {
  state.tasks = await api('GET', '/api/tasks');
  const review = state.tasks.filter((t) => t.status === 'review').length;
  $('#review-badge').hidden = !review;
  $('#review-badge').textContent = `На проверке: ${review}`;
  if (state.view === 'board') renderBoard();
  if (state.view === 'mine') renderMine();
  if (state.view === 'summary') await renderSummary();
  if (state.view === 'settings') await renderSettings();
  if (state.view === 'profile') renderProfile();
}

// --- доска ---
['#f-category', '#f-assignee', '#f-overdue'].forEach((s) => $(s).addEventListener('change', renderBoard));

function filteredTasks() {
  const cat = $('#f-category').value;
  const who = $('#f-assignee').value;
  const overdueOnly = $('#f-overdue').checked;
  return state.tasks.filter((t) => (!cat || String(t.category_id) === cat)
    && (!who || String(t.assignee_id) === who) && (!overdueOnly || t.overdue));
}

function taskCard(t) {
  const meta = [t.category_name, t.assignee_name, t.due_date && `до ${formatDate(t.due_date)}`].filter(Boolean).join(' · ');
  const classes = ['card', `prio-${t.priority}`, t.overdue ? 'overdue' : '', t.status === 'done' ? 'done' : ''];
  // Предложения мышкой не двигаются: их принимают или отклоняют в карточке.
  const draggable = t.status !== 'proposed' && (isAdmin() || t.assignee_id === state.me.id);
  return el('div', {
    className: classes.join(' '),
    draggable,
    onclick: () => openTask(t.id),
    ondragstart: (e) => {
      e.dataTransfer.setData('text/plain', String(t.id));
      e.dataTransfer.effectAllowed = 'move';
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => e.currentTarget.classList.remove('dragging'),
  },
    el('div', { className: 'card-title', textContent: t.title }),
    el('div', { className: 'meta', textContent: meta }),
    t.needs_reason ? el('div', { className: 'flag', textContent: 'Нужна причина просрочки' }) : null,
    t.overdue && t.overdue_reason ? el('div', { className: 'meta', textContent: `Просрочка: ${state.meta.overdue_reasons[t.overdue_reason]}` }) : null,
    t.result_url || t.has_file ? el('div', { className: 'meta', textContent: 'Есть результат' }) : null);
}

function renderBoard() {
  const tasks = filteredTasks();
  const proposed = tasks.filter((t) => t.status === 'proposed');
  const statuses = proposed.length ? ['proposed', ...BOARD_STATUSES] : BOARD_STATUSES;
  if (!statuses.includes(state.mobileStatus)) state.mobileStatus = 'new';

  $('#status-tabs').replaceChildren(...statuses.map((s) => el('button', {
    className: s === state.mobileStatus ? 'on' : '',
    textContent: `${STATUS_LABELS[s]} ${tasks.filter((t) => t.status === s).length}`,
    onclick: () => { state.mobileStatus = s; renderBoard(); },
  })));

  const board = $('#board');
  board.classList.toggle('with-proposed', Boolean(proposed.length));
  board.replaceChildren(...statuses.map((status) => {
    const cards = tasks.filter((t) => t.status === status).map(taskCard);
    const column = el('section', {
      className: `column col-${status}${status === state.mobileStatus ? ' mobile-on' : ''}`,
    }, el('h3', { textContent: `${STATUS_LABELS[status]} (${cards.length})` }), ...cards);
    if (status !== 'proposed') makeDropTarget(column, status);
    return column;
  }));
}

// Перенос карточки мышкой: то же, что смена статуса в карточке, с теми же правилами сервера.
function makeDropTarget(column, status) {
  column.addEventListener('dragover', (e) => { e.preventDefault(); column.classList.add('drop-on'); });
  column.addEventListener('dragleave', (e) => { if (!column.contains(e.relatedTarget)) column.classList.remove('drop-on'); });
  column.addEventListener('drop', (e) => {
    e.preventDefault();
    column.classList.remove('drop-on');
    const id = Number(e.dataTransfer.getData('text/plain'));
    const task = state.tasks.find((t) => t.id === id);
    if (task && task.status !== status) moveTask(task, status);
  });
}

async function moveTask(task, status) {
  const body = { status };
  if (task.status === 'review' && status === 'in_progress') {
    const comment = prompt('Что доделать? Комментарий увидит исполнитель.');
    if (!comment || !comment.trim()) return;
    body.comment = comment.trim();
  }
  try {
    await api('PATCH', `/api/tasks/${task.id}`, body);
    await refresh();
  } catch (err) {
    // Просрочка без причины: открываем карточку, там причина и сообщение.
    if (task.needs_reason) {
      await openTask(task.id);
      $('#task-form').status.value = status;
      $('#task-error').textContent = err.message;
    } else {
      alert(err.message);
    }
  }
}

// --- мои задачи ---
function renderMine() {
  const mine = state.tasks.filter((t) => t.assignee_id === state.me.id && !['done', 'proposed'].includes(t.status));
  const todayIso = state.meta.today;
  const groups = [
    ['Просрочено', mine.filter((t) => t.overdue)],
    ['На сегодня', mine.filter((t) => !t.overdue && t.due_date === todayIso)],
    ['Дальше', mine.filter((t) => !t.overdue && t.due_date !== todayIso)],
  ];
  $('#mine').replaceChildren(...groups.map(([title, list]) => el('section', { className: 'group' },
    el('h3', { textContent: `${title} (${list.length})` }),
    list.length ? el('div', { className: 'list' }, ...list.map(taskCard)) : el('p', { className: 'muted', textContent: 'Нет задач' }))));
}

// --- сводка ---
async function renderSummary() {
  const s = await api('GET', '/api/summary');
  const reasons = { ...state.meta.overdue_reasons, not_set: 'Причина не указана' };
  const table = el('table', { className: 'table' },
    el('tr', {}, ...['Категория', 'Новые', 'В работе', 'На проверке', 'Готово', 'Просрочено', 'Причины просрочки']
      .map((h) => el('th', { textContent: h }))),
    ...s.rows.map((r) => el('tr', {},
      el('td', { textContent: r.category }),
      el('td', { textContent: r.new }),
      el('td', { textContent: r.in_progress }),
      el('td', { textContent: r.review }),
      el('td', { textContent: r.done }),
      el('td', { className: r.overdue ? 'overdue-cell' : '', textContent: r.overdue }),
      el('td', { textContent: Object.entries(r.reasons).map(([k, n]) => `${reasons[k]}: ${n}`).join('; ') || '-' }))));
  const totals = Object.entries(s.total_reasons);
  $('#summary').replaceChildren(
    el('p', { textContent: `На проверке: ${s.review}. Непринятых предложений: ${s.proposed}.` }),
    table,
    el('h3', { textContent: 'Просрочки по причинам' }),
    totals.length
      ? el('ul', { className: 'plain' }, ...totals.sort((a, b) => b[1] - a[1]).map(([k, n]) => el('li', { textContent: `${reasons[k]}: ${n}` })))
      : el('p', { className: 'muted', textContent: 'Просрочек нет' }));
}

// --- настройки ---
async function renderSettings() {
  const [users, storage] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/storage')]);
  $('#users-table').replaceChildren(
    el('tr', {}, ...['Имя', 'Логин', 'Роль', 'Ключ API', ''].map((h) => el('th', { textContent: h }))),
    ...users.map((u) => el('tr', {},
      el('td', { textContent: u.name }),
      el('td', { textContent: u.login }),
      el('td', { textContent: u.role === 'admin' ? 'владелец' : 'ассистент' }),
      el('td', { textContent: u.role !== 'assistant' ? '-' : (u.has_api_key ? 'выпущен' : 'нет') }),
      el('td', {},
        u.role === 'assistant'
          ? el('button', { type: 'button', textContent: u.has_api_key ? 'Перевыпустить ключ' : 'Выпустить ключ', onclick: () => issueKey(u) })
          : null,
        el('button', { type: 'button', textContent: 'Сменить пароль', onclick: () => resetPassword(u) })))));
  $('#categories-list').replaceChildren(...state.meta.categories.map((c) => el('li', {},
    el('span', { textContent: c.name }),
    el('button', { type: 'button', textContent: 'Переименовать', onclick: () => renameCategory(c) }),
    el('button', { type: 'button', textContent: 'Удалить', onclick: () => deleteCategory(c) }))));
  $('#storage').textContent = `${storage.files_mb} МБ${storage.files_mb > storage.warn_at_mb ? ' (пора переносить старое на Яндекс.Диск)' : ''}`;
}

async function issueKey(u) {
  if (u.has_api_key && !confirm('Старый ключ перестанет работать. Перевыпустить?')) return;
  const { api_key: key } = await api('POST', `/api/users/${u.id}/api-key`);
  const box = $('#api-key-box');
  box.hidden = false;
  box.replaceChildren(`Ключ для «${u.name}» показан один раз, сохраните его: `, el('code', { textContent: key }));
  await renderSettings();
}

async function resetPassword(u) {
  const password = prompt(`Новый пароль для «${u.name}» (от 8 символов)`);
  if (!password) return;
  try {
    await api('POST', `/api/users/${u.id}/password`, { password });
    alert('Пароль изменён');
  } catch (err) { alert(err.message); }
}

async function reloadMeta() {
  state.meta = await api('GET', '/api/meta');
  fillStaticSelects();
}

async function renameCategory(c) {
  const name = prompt('Новое название', c.name);
  if (!name) return;
  await api('PATCH', `/api/categories/${c.id}`, { name });
  await reloadMeta();
  await renderSettings();
}

async function deleteCategory(c) {
  if (!confirm(`Удалить категорию «${c.name}»?`)) return;
  try {
    await api('DELETE', `/api/categories/${c.id}`);
    await reloadMeta();
    await renderSettings();
  } catch (err) { alert(err.message); }
}

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/users', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    await reloadMeta();
    await renderSettings();
  } catch (err) { alert(err.message); }
});

$('#category-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/categories', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    await reloadMeta();
    await renderSettings();
  } catch (err) { alert(err.message); }
});

// --- профиль ---
function renderProfile() {
  $('#profile-form').name.value = state.me.name;
  $('#profile-msg').hidden = true;
}

function profileMessage(text) {
  $('#profile-msg').hidden = false;
  $('#profile-msg').textContent = text;
}

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const name = e.target.name.value;
    await api('PATCH', '/api/me', { name });
    state.me.name = name;
    $('#me').textContent = name;
    await reloadMeta();
    profileMessage('Имя сохранено');
  } catch (err) { profileMessage(err.message); }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/me/password', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    profileMessage('Пароль изменён');
  } catch (err) { profileMessage(err.message); }
});

// --- карточка задачи ---
$('#new-task').addEventListener('click', () => openTask(null));
$('#task-cancel').addEventListener('click', () => $('#task-dialog').close());

function statusOptions(task) {
  if (!task) return isAdmin() ? BOARD_STATUSES : ['proposed'];
  if (task.status === 'proposed') return ['proposed'];
  if (isAdmin()) return BOARD_STATUSES;
  return [task.status, ...ASSISTANT_MOVES[task.status]];
}

async function openTask(id) {
  const task = id ? await api('GET', `/api/tasks/${id}`) : null;
  state.editing = task;
  const form = $('#task-form');
  form.reset();
  $('#task-error').textContent = '';
  $('#result-file').value = '';
  $('#task-dialog-title').textContent = task ? `Задача №${task.id}` : (isAdmin() ? 'Новая задача' : 'Предложить задачу');
  form.status.replaceChildren(...statusOptions(task).map((s) => el('option', { value: s, textContent: STATUS_LABELS[s] })));

  if (task) {
    for (const name of ['title', 'description', 'category_id', 'assignee_id', 'due_date', 'priority', 'status', 'result_url', 'overdue_reason', 'overdue_comment']) {
      form[name].value = task[name] ?? '';
    }
  } else if (!isAdmin()) {
    form.assignee_id.value = state.me.id;
  }

  // Ассистент редактирует только статус, результат и причину просрочки своих задач.
  const mineAsAssistant = task && !isAdmin() && task.assignee_id === state.me.id;
  const canEditMain = isAdmin() || !task;
  const canEditOwn = isAdmin() || mineAsAssistant;
  for (const name of ['title', 'description', 'category_id', 'due_date', 'priority']) form[name].disabled = !canEditMain;
  form.assignee_id.disabled = !isAdmin();
  form.status.disabled = !canEditOwn || (task && task.status === 'proposed');
  for (const name of ['result_url', 'overdue_reason', 'overdue_comment']) form[name].disabled = !canEditOwn;
  $('#result-file').disabled = !canEditOwn;

  $('#overdue-note').hidden = !(task && task.needs_reason);
  $('#overdue-block').hidden = !(task && task.overdue);
  $('#result-block').hidden = !task;
  $('#change-comment-label').hidden = !task || task.status === 'proposed';
  $('#result-file-line').replaceChildren(task && task.has_file
    ? el('a', { href: `/api/tasks/${task.id}/file`, textContent: `Файл: ${task.result_file_name}` }) : '');

  const proposed = task && task.status === 'proposed';
  $('#task-accept').hidden = !(isAdmin() && proposed);
  $('#task-reject').hidden = !(isAdmin() && proposed);
  $('#task-repeat').hidden = !(isAdmin() && task && !proposed);
  $('#task-delete').hidden = !(isAdmin() && task);
  $('#task-save').hidden = Boolean(task) && !canEditOwn;

  $('#history-block').hidden = !task;
  if (task) renderHistory(task.history);
  $('#task-dialog').showModal();
}

function renderHistory(items) {
  $('#history').replaceChildren(...items.map((h) => {
    const when = `${formatDate(h.created_at.slice(0, 10))} ${h.created_at.slice(11, 16)}`;
    const text = h.kind === 'comment'
      ? `${h.user_name}: ${h.text}`
      : `${h.user_name} изменил(а) ${FIELD_LABELS[h.field] || h.field}: ${readableValue(h.field, h.old_value)} → ${readableValue(h.field, h.new_value)}`;
    return el('li', { className: h.kind }, el('span', { className: 'when', textContent: when }), ` ${text}`);
  }));
}

$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = {};
  for (const node of form.elements) {
    if (node.name && !node.disabled && node.type !== 'file') data[node.name] = node.value;
  }
  const file = $('#result-file').files[0];
  try {
    const task = state.editing;
    if (file && file.size > state.meta.max_file_mb * 1048576) {
      throw new Error(`Файл больше ${state.meta.max_file_mb} МБ. Положите его на Яндекс.Диск и вставьте ссылку`);
    }
    if (task) {
      // Сначала результат и причина, потом статус: так сервер увидит всё сразу.
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        await api('POST', `/api/tasks/${task.id}/result`, fd);
      }
      await api('PATCH', `/api/tasks/${task.id}`, data);
    } else {
      await api('POST', isAdmin() ? '/api/tasks' : '/api/proposals', data);
    }
    $('#task-dialog').close();
    await refresh();
  } catch (err) {
    $('#task-error').textContent = err.message;
  }
});

async function taskAction(method, suffix, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await api(method, `/api/tasks/${state.editing.id}${suffix}`);
    $('#task-dialog').close();
    await refresh();
  } catch (err) {
    $('#task-error').textContent = err.message;
  }
}

$('#task-accept').addEventListener('click', () => taskAction('POST', '/accept'));
$('#task-reject').addEventListener('click', () => taskAction('POST', '/reject', 'Отклонить предложение? Оно будет удалено.'));
$('#task-repeat').addEventListener('click', () => taskAction('POST', '/repeat'));
$('#task-delete').addEventListener('click', () => taskAction('DELETE', '', 'Удалить задачу?'));

$('#comment-send').addEventListener('click', async () => {
  const text = $('#comment-text').value.trim();
  if (!text) return;
  await api('POST', `/api/tasks/${state.editing.id}/comments`, { text });
  $('#comment-text').value = '';
  const task = await api('GET', `/api/tasks/${state.editing.id}`);
  renderHistory(task.history);
});

start();
