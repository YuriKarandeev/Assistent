/* Справочник лекарств и динамика приёма.
 *
 * Зачем отдельный модуль: доза дня — это сумма доз по слотам приёма («утро 100 +
 * вечер 100 = 200 мг»), а из этих сумм строится график. Такая арифметика ломается
 * незаметно, поэтому она живёт отдельно от интерфейса: модуль чистый (без DOM и
 * без Firebase) и проверяется в _health_test.html.
 *
 * Совместимость: до v15 у дня были только два флага — medMorning и medEvening.
 * Новый формат — rec.meds = { morning, day, evening, night }. Если объект meds
 * есть, он главный; если нет — читаем старые флаги. Обратная запись (meds + старые
 * флаги) делается в index.html, чтобы устройство с закэшированной старой версией
 * видело те же галочки.
 */

export const MED_SLOTS = [
  { id: 'morning', label: 'Утро', legacy: 'medMorning' },
  { id: 'day', label: 'День', legacy: null },
  { id: 'evening', label: 'Вечер', legacy: 'medEvening' },
  { id: 'night', label: 'Перед сном', legacy: null }
];

export const MED_SLOT_IDS = MED_SLOTS.map(slot => slot.id);

/* Пока справочник пуст, показываем привычные «Утро / Вечер» */
export const DEFAULT_SLOTS = ['morning', 'evening'];

/* Ось графика: 0…200 мг с шагом 25; если принято больше — верхняя граница растёт */
export const DEFAULT_CEILING_MG = 200;
export const TICK_STEP_MG = 25;

/* Защита от опечаток в поле «мг»: больше 1000 мг за приём не бывает */
export const MAX_DOSE_MG = 1000;

/* ---------- Слоты ---------- */

export function slotById(id) {
  return MED_SLOTS.find(slot => slot.id === id) || null;
}

export function slotIndex(id) {
  const index = MED_SLOT_IDS.indexOf(String(id || ''));
  return index < 0 ? MED_SLOT_IDS.length : index;
}

export function slotLabel(id) {
  const slot = slotById(id);
  return slot ? slot.label : String(id || '');
}

/* Ключ может прийти старым (medMorning) — вызовы из закэшированной разметки не должны падать */
export function slotFromKey(key) {
  const raw = String(key || '');
  const legacy = MED_SLOTS.find(slot => slot.legacy === raw);
  if (legacy) return legacy.id;
  return MED_SLOT_IDS.indexOf(raw) >= 0 ? raw : '';
}

/* ---------- Числа ---------- */

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value === null || value === undefined ? '' : value).replace(',', '.');
  const num = parseFloat(text);
  return Number.isFinite(num) ? num : 0;
}

export function round1(value) {
  return Math.round(toNumber(value) * 10) / 10;
}

/* Доза: 0 значит «не задана». Отрицательные и мусор дают 0, а не NaN */
export function normalizeDose(value) {
  const num = toNumber(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const rounded = round1(num);
  return rounded > MAX_DOSE_MG ? MAX_DOSE_MG : rounded;
}

export function formatMg(value) {
  const num = round1(value);
  if (!num) return '—';
  const text = Number.isInteger(num) ? String(num) : String(num).replace('.', ',');
  return text + ' мг';
}

/* ---------- Справочник ---------- */

export function normalizeMed(item) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || '').trim();
  const name = String(item.name || '').trim().slice(0, 60);
  if (!id || !name) return null;
  const slot = slotFromKey(item.slot) || MED_SLOTS[0].id;
  return {
    id,
    name,
    doseMg: normalizeDose(item.doseMg),
    slot,
    active: item.active !== false,
    createdAt: String(item.createdAt || ''),
    updatedAt: String(item.updatedAt || '')
  };
}

/* Порядок строк в справочнике сохраняем, дубли по id отбрасываем */
export function normalizeMedList(items) {
  const out = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach(item => {
    const med = normalizeMed(item);
    if (!med || seen.has(med.id)) return;
    seen.add(med.id);
    out.push(med);
  });
  return out;
}

/* В таблице: сначала утро, потом день, вечер, ночь; внутри слота — по алфавиту */
export function sortMeds(meds) {
  return normalizeMedList(meds).sort((a, b) => {
    const bySlot = slotIndex(a.slot) - slotIndex(b.slot);
    if (bySlot) return bySlot;
    return a.name.localeCompare(b.name, 'ru', { numeric: true });
  });
}

export function activeMeds(meds) {
  return normalizeMedList(meds).filter(med => med.active);
}

/* Препараты слота, которые реально дают дозу (активны и доза задана) */
export function slotMeds(meds, slot) {
  const id = slotFromKey(slot);
  if (!id) return [];
  return activeMeds(meds).filter(med => med.slot === id && med.doseMg > 0);
}

export function slotTotalMg(meds, slot) {
  return round1(slotMeds(meds, slot).reduce((sum, med) => sum + med.doseMg, 0));
}

/* Сколько будет принято за сутки, если отметить все слоты справочника */
export function dailyTotalMg(meds) {
  return round1(activeMeds(meds).reduce((sum, med) => sum + (med.doseMg > 0 ? med.doseMg : 0), 0));
}

/* Слоты, которые нужно показать в дневнике: из справочника, иначе старые два */
export function visibleSlots(meds) {
  const used = new Set(activeMeds(meds).filter(med => med.doseMg > 0).map(med => med.slot));
  const ids = MED_SLOT_IDS.filter(id => used.has(id));
  const picked = ids.length ? ids : DEFAULT_SLOTS;
  return picked.map(id => slotById(id));
}

/* ---------- День ---------- */

/* Отметки приёма дня как { morning: bool, ... } */
export function daySlots(rec) {
  const out = {};
  MED_SLOT_IDS.forEach(id => { out[id] = false; });
  if (!rec || typeof rec !== 'object') return out;
  const stored = rec.meds && typeof rec.meds === 'object' ? rec.meds : null;
  MED_SLOTS.forEach(slot => {
    if (stored) out[slot.id] = !!stored[slot.id];
    else if (slot.legacy) out[slot.id] = !!rec[slot.legacy];
  });
  return out;
}

export function isSlotTaken(rec, slot) {
  const id = slotFromKey(slot);
  return id ? !!daySlots(rec)[id] : false;
}

export function takenSlots(rec) {
  const slots = daySlots(rec);
  return MED_SLOT_IDS.filter(id => slots[id]);
}

/* Сумма доз за день; null — приёмов не отмечено (на графике это разрыв, а не ноль) */
export function dayTotalMg(rec, meds) {
  const taken = takenSlots(rec);
  if (!taken.length) return null;
  return round1(taken.reduce((sum, id) => sum + slotTotalMg(meds, id), 0));
}

/* Расшифровка «что именно принято» для подсказки на карточке дня */
export function dayBreakdown(rec, meds) {
  return takenSlots(rec).map(id => {
    const list = slotMeds(meds, id);
    return {
      slot: id,
      label: slotLabel(id),
      mg: slotTotalMg(meds, id),
      names: list.map(med => med.name)
    };
  });
}

/* ---------- График ---------- */

/* Дата без часового пояса: new Date('2026-10-20') в UTC+3 может дать 19-е число */
export function addDaysIso(iso, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + (Number(days) || 0));
  return date.toISOString().slice(0, 10);
}

/* Точки для столбчатого графика: последний день включён, дни идут по возрастанию */
export function medSeries(health, meds, endIso, days) {
  const total = Math.max(1, Math.floor(toNumber(days) || 1));
  const end = String(endIso || '');
  if (!addDaysIso(end, 0)) return [];
  const out = [];
  let iso = addDaysIso(end, -(total - 1));
  for (let i = 0; i < total; i++) {
    const rec = health && typeof health === 'object' ? health[iso] : null;
    out.push({ iso, mg: dayTotalMg(rec, meds) });
    iso = addDaysIso(iso, 1);
  }
  return out;
}

/* Верхняя граница оси: не ниже 200 мг и всегда кратна шагу */
export function chartCeiling(maxValue) {
  const value = Math.max(0, toNumber(maxValue));
  if (value <= DEFAULT_CEILING_MG) return DEFAULT_CEILING_MG;
  return Math.ceil(value / TICK_STEP_MG) * TICK_STEP_MG;
}

export function chartTicks(maxValue, step = TICK_STEP_MG) {
  const size = TICK_STEP_MG * Math.max(1, Math.round(toNumber(step) / TICK_STEP_MG));
  const top = chartCeiling(maxValue);
  const ticks = [];
  for (let value = 0; value <= top + 0.001; value += size) ticks.push(Math.round(value * 10) / 10);
  if (ticks[ticks.length - 1] !== top) ticks.push(top);
  return ticks;
}

/* Подписи не на каждой линии: иначе на телефоне они слипаются */
export function tickLabelEvery(maxValue) {
  return chartCeiling(maxValue) > 400 ? 100 : 50;
}
