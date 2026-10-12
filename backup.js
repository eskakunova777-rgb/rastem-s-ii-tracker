// Ночная копия: база целиком (храним 14 последних) и зеркало файлов результатов (только новые).
// Запуск: node backup.js  (внутри контейнера: docker exec tracker node backup.js)
const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const KEEP = 14;

async function main() {
  fs.mkdirSync(path.join(BACKUP_DIR, 'files'), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(BACKUP_DIR, `tracker-${stamp}.db`);
  const source = new DatabaseSync(path.join(DATA_DIR, 'tracker.db'));
  await backup(source, target);
  source.close();

  const copies = fs.readdirSync(BACKUP_DIR).filter((f) => /^tracker-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - KEEP))) {
    fs.rmSync(path.join(BACKUP_DIR, old));
  }

  let added = 0;
  const filesDir = path.join(DATA_DIR, 'files');
  for (const name of fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : []) {
    const dest = path.join(BACKUP_DIR, 'files', name);
    if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(filesDir, name), dest); added += 1; }
  }
  console.log(`Копия ${path.basename(target)} готова, копий базы: ${Math.min(copies.length, KEEP)}, новых файлов: ${added}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
