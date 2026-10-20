/* Слияние состояния планера между устройствами.
 *
 * Зачем: документ в Firestore один, а setDoc(..., {merge: true}) заменяет массивы
 * целиком. Значит, если на телефоне добавить задачу, а на ноутбуке в это время
 * что-то поправить, последняя запись затирала чужие добавления.
 *
 * Здесь массивы сводятся по id (объединение), а удаления запоминаются
 * «надгробиями» (tombstones), чтобы удалённая на одном устройстве запись
 * не воскресала из копии на другом.
 *
 * Модуль чистый: без DOM и без Firebase — поэтому его можно проверять отдельно.
 */

export const SYNC_LISTS = ['tasks', 'kanbanCards', 'works', 'programs', 'events', 'projects', 'messages'];

/* Сколько дней помним надгробия. За это время все устройства успевают синхронизироваться. */
export const TOMBSTONE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/* Время хранится по-разному: ISO-строка у задач и событий, число у программ. */
export function parseTime(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? 0 : ms;
}

export function itemTime(item) {
  if (!item || typeof item !== 'object') return 0;
  return Math.max(parseTime(item.updatedAt), parseTime(item.createdAt), parseTime(item.at));
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

/* ---------- Надгробия (tombstones) ---------- */

export function mergeTombstones(...sources) {
  const out = {};
  sources.forEach(src => {
    if (!src || typeof src !== 'object') return;
    Object.keys(src).forEach(key => {
      const bucket = src[key];
      if (!bucket || typeof bucket !== 'object') return;
      const target = out[key] || (out[key] = {});
      Object.keys(bucket).forEach(id => {
        const at = parseTime(bucket[id]);
        if (!at) return;
        if (!target[id] || parseTime(target[id]) < at) target[id] = toIso(at);
      });
    });
  });
  return out;
}

export function pruneTombstones(tombstones, nowIso, days = TOMBSTONE_DAYS) {
  const now = parseTime(nowIso) || Date.now();
  const limit = days * DAY_MS;
  const out = {};
  Object.keys(tombstones || {}).forEach(key => {
    const bucket = tombstones[key];
    if (!bucket || typeof bucket !== 'object') return;
    const kept = {};
    Object.keys(bucket).forEach(id => {
      const at = parseTime(bucket[id]);
      if (at && now - at <= limit) kept[id] = toIso(at);
    });
    if (Object.keys(kept).length) out[key] = kept;
  });
  return out;
}

export function tombstoneCount(tombstones) {
  return Object.keys(tombstones || {}).reduce((sum, key) => {
    const bucket = tombstones[key];
    return sum + (bucket && typeof bucket === 'object' ? Object.keys(bucket).length : 0);
  }, 0);
}

/* Ключ надгробия — путь: «tasks» или «projects/<id>/subtasks». */
function addTomb(out, path, id, atIso) {
  if (!id) return;
  const bucket = out[path] || (out[path] = {});
  const ms = parseTime(atIso) || Date.now();
  if (!bucket[id] || parseTime(bucket[id]) < ms) bucket[id] = toIso(ms);
}

function collectNestedDeletions(prevItem, nextItem, path, out, atIso) {
  const prevSubs = list(prevItem && prevItem.subtasks);
  if (!prevSubs.length) return;
  const childPath = path + '/subtasks';
  const nextById = new Map(list(nextItem && nextItem.subtasks).map(sub => [sub && sub.id, sub]));
  prevSubs.forEach(sub => {
    if (!sub || !sub.id) return;
    const found = nextById.get(sub.id);
    if (found) collectNestedDeletions(sub, found, childPath + '/' + sub.id, out, atIso);
    else addTomb(out, childPath, sub.id, atIso);
  });
}

/* Что было в базовом состоянии и пропало в текущем → надгробия. */
export function collectDeletions(baseline, next, nowIso) {
  const atIso = nowIso || new Date().toISOString();
  const out = {};
  SYNC_LISTS.forEach(key => {
    const before = list(baseline && baseline[key]);
    if (!before.length) return;
    const afterById = new Map(list(next && next[key]).map(item => [item && item.id, item]));
    before.forEach(item => {
      if (!item || !item.id) return;
      const found = afterById.get(item.id);
      if (found) collectNestedDeletions(item, found, key + '/' + item.id, out, atIso);
      else addTomb(out, key, item.id, atIso);
    });
  });
  return out;
}

/* ---------- Штампы изменений ---------- */

function stampList(prevList, nextList, atIso) {
  const prevById = new Map(list(prevList).map(item => [item && item.id, item]));
  list(nextList).forEach(item => {
    if (!item || !item.id) return;
    const prev = prevById.get(item.id);
    // Сначала дети: их штамп сделает родителя «изменённым»
    if (Array.isArray(item.subtasks)) stampList(prev && prev.subtasks, item.subtasks, atIso);
    const changed = !prev || JSON.stringify(prev) !== JSON.stringify(item);
    if (!changed) return;
    item.updatedAt = atIso;
    if (!prev && !item.createdAt) item.createdAt = atIso;
  });
}

/* Помечает изменённые и новые записи временем: по нему решается, чья версия новее. */
export function stampChanges(baseline, next, nowIso) {
  const atIso = nowIso || new Date().toISOString();
  SYNC_LISTS.forEach(key => stampList(baseline && baseline[key], next && next[key], atIso));
  return next;
}

function stampNewList(cloudList, nextList, atIso) {
  const cloudById = new Map(list(cloudList).map(item => [item && item.id, item]));
  list(nextList).forEach(item => {
    if (!item || !item.id) return;
    const known = cloudById.get(item.id);
    if (!known) {
      item.updatedAt = atIso;
      if (!item.createdAt) item.createdAt = atIso;
      if (Array.isArray(item.subtasks)) stampNewList([], item.subtasks, atIso);
      return;
    }
    if (Array.isArray(item.subtasks)) stampNewList(known.subtasks, item.subtasks, atIso);
  });
}

/* Записи, которых в облаке ещё нет (правки без сети), получают свежий штамп:
   иначе при следующем слиянии их может перебить чужая старая копия. */
function stampNewAgainstCloud(cloud, next, atIso) {
  SYNC_LISTS.forEach(key => stampNewList(cloud && cloud[key], next && next[key], atIso));
  return next;
}

/* ---------- Слияние ---------- */

function mergeItem(local, cloud, tombstones, itemPath) {
  const base = !cloud ? local : (!local ? cloud : (itemTime(local) >= itemTime(cloud) ? local : cloud));
  const out = clone(base);
  const localSubs = list(local && local.subtasks);
  const cloudSubs = list(cloud && cloud.subtasks);
  // Подзадачи сливаются отдельным списком: у них свои id и свои надгробия
  if (Array.isArray(local && local.subtasks) || Array.isArray(cloud && cloud.subtasks)) {
    out.subtasks = mergeList(localSubs, cloudSubs, tombstones, itemPath + '/subtasks');
  }
  return out;
}

/* Объединение по id: порядок локальных записей сохраняется, чужие добавляются в конец. */
export function mergeList(localList, cloudList, tombstones, path) {
  const bucket = (tombstones && tombstones[path]) || {};
  const cloudById = new Map(list(cloudList).map(item => [item && item.id, item]));
  const out = [];
  const seen = new Set();

  list(localList).forEach(item => {
    if (!item || !item.id || seen.has(item.id) || bucket[item.id]) return;
    seen.add(item.id);
    const merged = mergeItem(item, cloudById.get(item.id) || null, tombstones, path + '/' + item.id);
    if (merged) out.push(merged);
  });

  list(cloudList).forEach(item => {
    if (!item || !item.id || seen.has(item.id) || bucket[item.id]) return;
    seen.add(item.id);
    const merged = mergeItem(null, item, tombstones, path + '/' + item.id);
    if (merged) out.push(merged);
  });

  // Чат — единственный список, где важен порядок по времени
  if (path === 'messages') {
    out.sort((a, b) => itemTime(a) - itemTime(b) || String(a.id).localeCompare(String(b.id)));
  }
  return out;
}

function mergeHealth(local, cloud) {
  const out = clone(local && typeof local === 'object' ? local : {});
  const cloudHealth = cloud && typeof cloud === 'object' ? cloud : {};
  Object.keys(cloudHealth).forEach(day => {
    const mine = out[day];
    if (!mine) {
      out[day] = clone(cloudHealth[day]);
      return;
    }
    if (itemTime(cloudHealth[day]) > itemTime(mine)) out[day] = clone(cloudHealth[day]);
  });
  return out;
}

/* Слияние локального состояния с облачным. Локальные настройки интерфейса
   (активная вкладка, открытый проект) остаются локальными. */
export function mergeState(local, cloud, options = {}) {
  const nowIso = options.now || new Date().toISOString();
  const tombstones = pruneTombstones(
    mergeTombstones(local && local.tombstones, cloud && cloud.tombstones),
    nowIso,
    options.days
  );
  const out = clone(local || {});
  SYNC_LISTS.forEach(key => {
    out[key] = mergeList(local && local[key], cloud && cloud[key], tombstones, key);
  });
  out.health = mergeHealth(local && local.health, cloud && cloud.health);
  out.tombstones = tombstones;
  out.rev = Math.max(Number(local && local.rev) || 0, Number(cloud && cloud.rev) || 0);
  out.updatedAt = (cloud && cloud.updatedAt) || (local && local.updatedAt) || '';
  return out;
}

/* Надгробия только для тех id, которых нет в состоянии: иначе запись из файла
   тут же спряталась бы старым надгробием из облака. Пути совпадают с collectDeletions:
   «tasks/t1», «projects/p1/subtasks/s1». */
function keepTombstonesOfMissing(tombstones, state) {
  const present = {};
  const walk = (items, path) => {
    list(items).forEach(item => {
      if (!item || !item.id) return;
      present[path + '/' + item.id] = true;
      if (Array.isArray(item.subtasks)) walk(item.subtasks, path + '/' + item.id + '/subtasks');
    });
  };
  SYNC_LISTS.forEach(key => walk(state && state[key], key));
  const out = {};
  Object.keys(tombstones || {}).forEach(path => {
    const bucket = tombstones[path];
    const kept = {};
    Object.keys(bucket || {}).forEach(id => {
      if (!present[path + '/' + id]) kept[id] = bucket[id];
    });
    if (Object.keys(kept).length) out[path] = kept;
  });
  return out;
}

/* Состояние, которое можно писать в документ:
   фиксируем удаления, ставим штампы изменениям и подмешиваем чужие добавления.
   options.replace = true — режим импорта: пользователь явно сказал «мои данные вот такие»,
   поэтому чужие записи не подмешиваются. Надгробия облачных записей, которых нет в файле,
   сохраняются: иначе устройство со старой копией вернуло бы их обратно при следующей
   синхронизации. Надгробия записей, которые в файле есть, снимаются. */
export function buildWriteState(local, baseline, cloud, nowIso, options = {}) {
  const atIso = nowIso || new Date().toISOString();
  const next = clone(local || {});
  if (options.replace) {
    SYNC_LISTS.forEach(key => {
      next[key] = list(next[key]);
      stampNewList([], next[key], atIso);
    });
    if (!next.health || typeof next.health !== 'object') next.health = {};
    const deletions = collectDeletions(cloud || {}, next, atIso);
    next.tombstones = pruneTombstones(
      keepTombstonesOfMissing(
        mergeTombstones(cloud && cloud.tombstones, deletions),
        next
      ),
      atIso
    );
    return { state: next, deletions };
  }
  const deletions = collectDeletions(baseline, next, atIso);
  next.tombstones = pruneTombstones(
    mergeTombstones(cloud && cloud.tombstones, local && local.tombstones, deletions),
    atIso
  );
  stampChanges(baseline, next, atIso);
  stampNewAgainstCloud(cloud, next, atIso);
  return { state: mergeState(next, cloud || {}, { now: atIso }), deletions };
}

/* Короткая подпись содержимого: по ней видно, есть ли что отправлять в облако. */
export function syncSignature(value) {
  const lists = SYNC_LISTS.map(key => list(value && value[key])
    .map(item => (item && item.id) || '')
    .filter(Boolean)
    .sort());
  const health = Object.keys((value && value.health) || {}).sort();
  return JSON.stringify({ lists, health });
}

export function sameSyncSignature(a, b) {
  return syncSignature(a) === syncSignature(b);
}
