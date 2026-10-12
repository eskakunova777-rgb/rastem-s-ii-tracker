#!/usr/bin/env node
// Клиент ассистента для трекера. Ключ и адрес берутся из окружения, на экран не выводятся.
// Запуск: node --env-file=.env.local assistant.js <команда>
//   mine [статус]                      мои задачи
//   show <id>                          задача с историей
//   status <id> <in_progress|review> [комментарий]
//   comment <id> <текст>
//   result <id> <ссылка или путь к файлу>
//   reason <id> <код причины> [комментарий]
//   propose <файл.json>                предложить задачи из файла (массив объектов)
const fs = require('node:fs');
const path = require('node:path');

const BASE = (process.env.TRACKER_URL || 'https://tracker.evskakunova-ai.ru').replace(/\/$/, '');
const KEY = process.env.TRACKER_API_KEY;

async function api(method, url, body) {
  const headers = { Authorization: `Bearer ${KEY}` };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${data.error || 'ошибка'}`);
  return data;
}

function line(t) {
  const flags = [t.overdue ? 'ПРОСРОЧЕНА' : '', t.needs_reason ? 'нужна причина' : ''].filter(Boolean).join(', ');
  return `#${t.id} [${t.status}] ${t.title} | ${t.category_name || '-'} | до ${t.due_date || '-'}${flags ? ` | ${flags}` : ''}`;
}

const commands = {
  async mine(status) {
    const tasks = await api('GET', `/api/tasks?mine=1${status ? `&status=${status}` : ''}`);
    console.log(tasks.length ? tasks.map(line).join('\n') : 'Задач нет');
  },
  async show(id) {
    const t = await api('GET', `/api/tasks/${id}`);
    console.log(line(t));
    if (t.description) console.log(`\n${t.description}`);
    for (const h of t.history) {
      console.log(h.kind === 'comment'
        ? `  ${h.created_at} ${h.user_name}: ${h.text}`
        : `  ${h.created_at} ${h.user_name}: ${h.field} ${h.old_value ?? '-'} → ${h.new_value ?? '-'}`);
    }
  },
  async status(id, status, ...comment) {
    console.log(line(await api('PATCH', `/api/tasks/${id}`, { status, comment: comment.join(' ') })));
  },
  async comment(id, ...text) {
    await api('POST', `/api/tasks/${id}/comments`, { text: text.join(' ') });
    console.log('Комментарий добавлен');
  },
  async result(id, value) {
    if (/^https?:\/\//i.test(value)) {
      console.log(line(await api('POST', `/api/tasks/${id}/result`, { result_url: value })));
      return;
    }
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(value)]), path.basename(value));
    console.log(line(await api('POST', `/api/tasks/${id}/result`, fd)));
  },
  async reason(id, code, ...comment) {
    console.log(line(await api('PATCH', `/api/tasks/${id}`, { overdue_reason: code, overdue_comment: comment.join(' ') })));
  },
  async propose(file) {
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    const meta = await api('GET', '/api/meta');
    for (const item of items) {
      const category = meta.categories.find((c) => c.name === item.category);
      try {
        const r = await api('POST', '/api/proposals', {
          title: item.title, description: item.description || '', due_date: item.due_date,
          priority: item.priority || 'medium', category_id: category ? category.id : null,
        });
        console.log(`Предложена #${r.id}: ${item.title}`);
      } catch (err) {
        console.log(`Не принято (${err.message}): ${item.title}`);
        if (err.message.startsWith('429')) break;
      }
    }
  },
};

async function main() {
  const [name, ...args] = process.argv.slice(2);
  if (!KEY) throw new Error('Нет TRACKER_API_KEY в окружении');
  if (!commands[name]) throw new Error(`Команды: ${Object.keys(commands).join(', ')}`);
  await commands[name](...args);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
