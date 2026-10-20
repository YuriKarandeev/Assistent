/* Web Push: подписка устройства, план напоминаний и выбор «что отправить сейчас».
 *
 * Зачем отдельный модуль: iOS не даёт работающему в фоне приложению никаких
 * таймеров — уведомление может прийти только снаружи (Web Push). Браузер не
 * может быть отправителем, поэтому приложение кладёт в облако «план»
 * (users/{uid}/pushPlan/main), а по расписанию его читает GitHub Actions и
 * рассылает push. Здесь живёт вся логика, общая для страницы и отправителя:
 *
 *   buildPushPlan(state, now, settings) — что и когда напоминать (14 дней)
 *   dueNow(plan, now, sent, limit)      — что пора отправить прямо сейчас
 *   pushPayload(item)                   — тело уведомления для service worker
 *
 * Модуль чистый: ни DOM, ни Firebase, ни сети. Всё время берётся аргументом,
 * поэтому и страницу, и Node-отправитель можно проверять без часов и сети.
 */
import { validDate, validTime } from './ai.js';

/* Настройки этого устройства (в облако не уходят: у телефона и ноутбука они разные) */
export const PUSH_STORAGE = 'planer_push_settings';

/* За сколько минут до начала события напоминать. Больше 4 часов — уже не напоминание. */
export const PUSH_LEAD_MIN_DEFAULT = 30;
export const PUSH_LEAD_MIN_MIN = 5;
export const PUSH_LEAD_MIN_MAX = 240;

/* Дальше двух недель план не строим: он всё равно перезаписывается при каждой правке */
export const PUSH_HORIZON_DAYS = 14;
export const PUSH_MAX_ITEMS = 200;

/* Задачи без времени напоминаем утром — срок «сегодня» иначе не заметить */
export const PUSH_TASK_HOUR = 9;

/* Сколько напоминаний отправитель берёт за один запуск (cron идёт каждые 5 минут) */
export const PUSH_SEND_LIMIT = 5;

/* Окно, в котором «просроченное» ещё не считается мусором. Телефон мог быть
   выключен сутки — после включения напоминание про вчерашнюю встречу только
   мешает, поэтому старше 12 часов не отправляем вовсе. */
export const PUSH_GRACE_MS = 12 * 60 * 60 * 1000;

/* Сколько хранить отметки об отправленном (users/{uid}/pushState/main.sent) */
export const PUSH_SENT_KEEP_DAYS = 7;

/* Публичный ключ VAPID (парная половина — в GitHub Actions secrets).
   Пусто = «доставка не настроена»: кнопки в 💾 честно скажут об этом. */
export const VAPID_PUBLIC_KEY = 'BBL7vGDEk8QENmchYh2mpbdoo4f6JSQXwLSHkuv1LOqx0a4e1GQXLbT6B7xXiibKldEOBBUeWzb2x2nGOEceXQE';

export const DEFAULT_SETTINGS = {
  enabled: false,
  events: true,
  tasks: true,
  leadMinutes: PUSH_LEAD_MIN_DEFAULT
};

/* ---------- Мелкие помощники ---------- */

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value, max) {
  if (value === null || value === undefined) return '';
  const out = String(value).replace(/\s+/g, ' ').trim();
  return max && out.length > max ? out.slice(0, max).trim() : out;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  const at = new Date(value === undefined || value === null ? Date.now() : value);
  return Number.isFinite(at.getTime()) ? at : new Date();
}

/* undefined — «возьми настоящее окно», null — «окружения нет» (так тесты
   проверяют Node и пустой браузер). */
function browserWindow(win) {
  if (win !== undefined) return win;
  return typeof window !== 'undefined' ? window : null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/* Местный день DD.MM — так подпись читается на телефоне без часового пояса */
function dayLabel(date, today) {
  const diff = Math.round((startOfDay(date) - startOfDay(today)) / 86400000);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === 2) return 'послезавтра';
  return pad2(date.getDate()) + '.' + pad2(date.getMonth() + 1);
}

/* Дата + время в местной зоне устройства: new Date(y, m, d, hh, mm) — единственный
   способ, который не зависит от часового пояса процесса. В отправителе план уже
   содержит готовые ISO-моменты, поэтому там эта функция не вызывается. */
function stamp(dateStr, hhmm) {
  const raw = validDate(dateStr);
  if (!raw) return null;
  const time = validTime(hhmm) || '00:00';
  return new Date(
    Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10)),
    Number(time.slice(0, 2)), Number(time.slice(3, 5)), 0, 0
  );
}

/* FNV-1a: короткий устойчивый id. Нужен для ключей отправленного и для записей,
   у которых нет своего id (старое событие, задача без id). */
export function shortHash(value) {
  const s = String(value === null || value === undefined ? '' : value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ---------- Настройки ---------- */

export function normalizeLeadMinutes(value) {
  if (value === null || value === undefined || value === '') return PUSH_LEAD_MIN_DEFAULT;
  const asked = Number(value);
  if (!Number.isFinite(asked)) return PUSH_LEAD_MIN_DEFAULT;
  const rounded = Math.round(asked);
  if (rounded < PUSH_LEAD_MIN_MIN) return PUSH_LEAD_MIN_MIN;
  if (rounded > PUSH_LEAD_MIN_MAX) return PUSH_LEAD_MIN_MAX;
  return rounded;
}

/* Мусор в хранилище не должен выключать уведомления: непонятное значение —
   это «по умолчанию», а не «нет». Выключить можно только явным false. */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    events: src.events !== false,
    tasks: src.tasks !== false,
    leadMinutes: normalizeLeadMinutes(src.leadMinutes)
  };
}

export function loadSettings(storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return normalizeSettings(DEFAULT_SETTINGS);
  try {
    const raw = store.getItem(PUSH_STORAGE);
    return normalizeSettings(raw ? JSON.parse(raw) : DEFAULT_SETTINGS);
  } catch (e) {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings, storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const value = normalizeSettings(settings);
  if (!store) return false;
  try {
    store.setItem(PUSH_STORAGE, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- Возможности браузера ---------- */

/* iOS: Web Push есть только в приложении, добавленном на экран «Домой»,
   и только с iOS 16.4. В обычной вкладке Safari PushManager отсутствует. */
export function pushSupported(win) {
  const w = browserWindow(win);
  if (!w) return false;
  if (w.isSecureContext === false) return false;
  return !!(w.Notification && w.navigator && 'serviceWorker' in w.navigator && w.PushManager);
}

export function permissionState(win) {
  const w = browserWindow(win);
  if (!w || !w.Notification) return 'unsupported';
  const value = w.Notification.permission;
  if (value === 'granted' || value === 'denied') return value;
  return 'default';
}

export function pushConfigured(key) {
  const raw = key === undefined ? VAPID_PUBLIC_KEY : key;
  return String(raw || '').replace(/=+$/, '').length >= 60;
}

/* Ключ VAPID приходит в base64url, а PushManager ждёт байты */
export function vapidBytes(value) {
  const key = value === undefined ? VAPID_PUBLIC_KEY : value;
  const clean = String(key || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!clean) return null;
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  try {
    if (typeof atob === 'function') {
      const bin = atob(padded);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(padded, 'base64'));
    }
  } catch (e) {
    return null;
  }
  return null;
}

/* ---------- Устройство ---------- */

/* Имя документа подписки: стабильное и безопасное для Firestore (там нельзя . / ~ * [ ]) */
export function pushDeviceId(endpoint) {
  const raw = String(endpoint || '');
  return raw ? 'd' + shortHash(raw) : '';
}

export function deviceTimeZone() {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone || '';
  } catch (e) {
    return '';
  }
}

/* Документ users/{uid}/push/{deviceId}. Отправителю нужны только endpoint и keys,
   остальное — чтобы в консоли Firebase было видно, чьё это устройство. */
export function subscriptionRecord(subscription, options = {}) {
  const sub = subscription || {};
  const json = typeof sub.toJSON === 'function' ? sub.toJSON() : sub;
  const endpoint = text(json.endpoint, 1000);
  const keys = json.keys && typeof json.keys === 'object' ? json.keys : {};
  const at = toDate(options.now).toISOString();
  return {
    deviceId: pushDeviceId(endpoint),
    endpoint: endpoint,
    keys: { p256dh: text(keys.p256dh, 400), auth: text(keys.auth, 100) },
    ua: text(options.ua, 300),
    platform: text(options.platform, 60),
    timeZone: text(options.timeZone, 60),
    leadMinutes: normalizeLeadMinutes(options.leadMinutes),
    createdAt: text(options.createdAt, 40) || at,
    lastSeenAt: at
  };
}

/* ---------- План напоминаний ---------- */

/* Один элемент плана: что сказать, когда и по какому ключу не повторяться.
   key — имя поля в Firestore, поэтому только безопасные символы (без . / ~ * [ ]). */
function planItem(item) {
  return {
    key: text(item.key, 120),
    kind: text(item.kind, 20),
    at: item.at,
    title: text(item.title, 120),
    body: text(item.body, 200),
    url: text(item.url, 120)
  };
}

/* Собираем всё, о чём стоит напомнить в ближайшие две недели.
   settings.events / settings.tasks выключают целые группы, leadMinutes двигает
   напоминание о событии раньше его начала. */
export function buildPushPlan(state, now, settings, options = {}) {
  const at = toDate(now);
  const conf = normalizeSettings(settings);
  const days = Number(options.days) > 0 ? Number(options.days) : PUSH_HORIZON_DAYS;
  const horizon = at.getTime() + days * 86400000;
  const items = [];
  const seen = Object.create(null);

  const add = raw => {
    const item = planItem(raw || {});
    if (!item.key || !item.at) return;
    if (seen[item.key]) return;
    seen[item.key] = true;
    items.push(item);
  };

  /* Событие: напоминание за leadMinutes до начала. Событие «на весь день»
     времени не имеет — напоминаем утром этого дня. */
  if (conf.events) {
    list(state && state.events).forEach(ev => {
      if (!ev || !text(ev.title)) return;
      const day = validDate(ev.date);
      if (!day) return;
      const time = ev.allDay ? '' : validTime(ev.time);
      const start = stamp(day, time || (PUSH_TASK_HOUR + ':00'));
      if (!start) return;
      if (start.getTime() > horizon) return;
      if (start.getTime() < at.getTime() - PUSH_GRACE_MS) return;
      const when = new Date(start.getTime() - (time ? conf.leadMinutes : 0) * 60000);
      const endTime = validTime(ev.endTime);
      const id = text(ev.id) || 'h' + shortHash(day + ' ' + time + ' ' + text(ev.title));
      add({
        key: 'event:' + id + '@' + day + (time ? 'T' + time : ''),
        kind: 'event',
        at: when.toISOString(),
        title: text(ev.title),
        body: time
          ? 'Начало в ' + time + (endTime ? '–' + endTime : '') + ' · ' + dayLabel(start, at)
          : 'Весь день · ' + dayLabel(start, at),
        url: './#calendar'
      });
    });
  }

  /* Задача верхнего уровня: у срока нет времени — напоминаем утром. */
  if (conf.tasks) {
    list(state && state.tasks).forEach(task => {
      if (!task || task.done || !text(task.title)) return;
      const day = validDate(task.deadline);
      if (!day) return;
      const due = stamp(day, PUSH_TASK_HOUR + ':00');
      if (!due) return;
      if (due.getTime() > horizon) return;
      if (due.getTime() < at.getTime() - PUSH_GRACE_MS) return;
      const id = text(task.id) || 'h' + shortHash(day + ' ' + text(task.title));
      add({
        key: 'task:' + id + '@' + day,
        kind: 'task',
        at: due.toISOString(),
        title: text(task.title),
        body: 'Срок · ' + dayLabel(due, at),
        url: './#hobbies'
      });
    });

    /* Задачи внутри проектов. Вложенные подзадачи сроков не имеют. */
    list(state && state.projects).forEach(project => {
      const projectTitle = text(project && project.title, 40);
      list(project && project.subtasks).forEach(sub => {
        if (!sub || sub.done || !text(sub.title)) return;
        const day = validDate(sub.deadline);
        if (!day) return;
        const due = stamp(day, PUSH_TASK_HOUR + ':00');
        if (!due) return;
        if (due.getTime() > horizon) return;
        if (due.getTime() < at.getTime() - PUSH_GRACE_MS) return;
        const id = text(sub.id) || 'h' + shortHash(day + ' ' + projectTitle + ' ' + text(sub.title));
        add({
          key: 'subtask:' + id + '@' + day,
          kind: 'subtask',
          at: due.toISOString(),
          title: text(sub.title),
          body: (projectTitle ? projectTitle + ' · ' : '') + 'срок ' + dayLabel(due, at),
          url: './#kanban'
        });
      });
    });
  }

  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { items: items.slice(0, PUSH_MAX_ITEMS), generatedAt: at.toISOString() };
}

/* ---------- Выбор и отправка ---------- */

/* Что отправить прямо сейчас. sent — карта «ключ → когда отправлено» из
   users/{uid}/pushState/main: по ней отправитель не повторяет одно и то же,
   даже если cron сработал дважды. */
export function dueNow(plan, now, sent, limit) {
  const at = toDate(now).getTime();
  const done = sent && typeof sent === 'object' ? sent : {};
  const max = Number(limit) > 0 ? Math.floor(Number(limit)) : PUSH_SEND_LIMIT;
  return list(plan && plan.items)
    .filter(item => item && item.key && item.at)
    .filter(item => {
      if (done[item.key]) return false;
      const when = Date.parse(item.at);
      if (!Number.isFinite(when)) return false;
      return when <= at && at - when <= PUSH_GRACE_MS;
    })
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(0, max);
}

/* Ближайшее будущее напоминание — для строки «Следующее: …» в 💾 */
export function nextDue(plan, now) {
  const at = toDate(now).getTime();
  return list(plan && plan.items)
    .filter(item => item && item.at && Date.parse(item.at) > at)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] || null;
}

/* Отметки об отправленном не растут бесконечно: старше недели они бесполезны. */
export function pruneSent(sent, now, days) {
  const at = toDate(now).getTime();
  const keep = (Number(days) > 0 ? Number(days) : PUSH_SENT_KEEP_DAYS) * 86400000;
  const out = {};
  const src = sent && typeof sent === 'object' ? sent : {};
  Object.keys(src).forEach(key => {
    const when = Date.parse(src[key]);
    if (Number.isFinite(when) && at - when <= keep) out[key] = src[key];
  });
  return out;
}

/* Тело уведомления. tag = key: два одинаковых напоминания не висят в шторке
   дважды (service worker заменяет уведомление с тем же тегом). */
export function pushPayload(item) {
  const it = item || {};
  const key = text(it.key) || 'planer';
  return {
    title: text(it.title) || 'Напоминание',
    body: text(it.body) || 'Пора заняться делом',
    tag: key,
    key: key,
    kind: text(it.kind),
    url: text(it.url) || './'
  };
}

/* Уведомление для кнопки «Проверить»: то же тело и тот же вид, что у настоящего */
export function testPayload(now) {
  return {
    title: 'Проверка уведомлений',
    body: 'Если вы это видите, доставка работает.',
    tag: 'planer-test-' + toDate(now).getTime(),
    key: 'planer-test',
    kind: 'test',
    url: './'
  };
}

/* Документ users/{uid}/pushPlan/main: только то, что нужно отправителю. */
export function planDoc(plan, now, timeZone) {
  return {
    items: list(plan && plan.items).map(planItem),
    generatedAt: toDate(now).toISOString(),
    timeZone: text(timeZone, 60)
  };
}

/* ---------- Текст для 💾 ---------- */

/* info: { supported, configured, permission, subscribed, enabled, next } */
export function statusLabel(info) {
  const i = info && typeof info === 'object' ? info : {};
  if (!i.supported) {
    return 'Уведомления недоступны: браузер не умеет Web Push. На iPhone нужны iOS 16.4+ ' +
      'и приложение, добавленное на экран «Домой» (в обычной вкладке Safari Push нет).';
  }
  if (!i.configured) {
    return 'Доставка не настроена: в push.js пустой публичный ключ VAPID. ' +
      'Пока ключа нет, подписка не создаётся и напоминания не приходят.';
  }
  if (i.permission === 'denied') {
    return 'Уведомления запрещены в настройках системы. Разрешите их для этого приложения ' +
      'и откройте страницу заново.';
  }
  if (i.subscribed && i.enabled) {
    return 'Уведомления включены на этом устройстве.' + (i.next ? ' Следующее: ' + i.next + '.' : '');
  }
  if (i.subscribed) return 'Подписка есть, но напоминания выключены.';
  return 'Напоминания выключены. Событие — за полчаса, задача — утром в день срока.';
}

/* ---------- Подписка (только браузер) ---------- */

export async function registerPush(win) {
  const w = browserWindow(win);
  if (!w || !w.navigator || !w.navigator.serviceWorker) throw new Error('sw-missing');
  return (await w.navigator.serviceWorker.ready) || null;
}

export async function currentSubscription(registration) {
  if (!registration || !registration.pushManager ||
    typeof registration.pushManager.getSubscription !== 'function') return null;
  try {
    return (await registration.pushManager.getSubscription()) || null;
  } catch (e) {
    return null;
  }
}

/* Подписка одна на устройство: повторный вызов возвращает уже существующую. */
export async function subscribePush(registration, publicKey) {
  if (!registration || !registration.pushManager) throw new Error('push-manager-missing');
  const bytes = vapidBytes(publicKey);
  if (!bytes) throw new Error('vapid-missing');
  const existing = await currentSubscription(registration);
  if (existing) return existing;
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
}

export async function unsubscribePush(registration) {
  const sub = await currentSubscription(registration);
  if (!sub) return false;
  try {
    return (await sub.unsubscribe()) === true;
  } catch (e) {
    return false;
  }
}
