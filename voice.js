/* Голос: распознавание речи и озвучка ответов помощника.
 *
 * Модуль чистый: DOM и Firebase сюда не проникают. Браузерные объекты приходят
 * снаружи (win, storage, deps), поэтому ветки «браузер не умеет», «нет разрешения»,
 * «нет сети» и «нет русского голоса» проверяются тестами без микрофона.
 *
 * Настройки живут в отдельном слоте localStorage, как ключ DeepSeek: голоса и
 * скорость у каждого устройства свои, в state и Firestore они не идут.
 *
 * Два независимых умения:
 *   распознавание — SpeechRecognition (Chrome/Edge, Safari с iOS 14.5);
 *   синтез — speechSynthesis (голоса берутся из операционной системы).
 * Распознавание в Chrome идёт через серверы Google, то есть требует интернета.
 */

import { speechOf } from './ai.js';

export const VOICE_STORAGE = 'planer_voice_settings';
export const VOICE_LANG = 'ru-RU';
export const VOICE_DEFAULT_RATE = 1;
export const VOICE_MIN_RATE = 0.5;
export const VOICE_MAX_RATE = 2;
export const VOICE_DEFAULT_PITCH = 1;
export const VOICE_MIN_PITCH = 0;
export const VOICE_MAX_PITCH = 2;
/* Длинную простыню помощника вслух слушать невозможно: режем по границе слова. */
export const VOICE_MAX_SPEECH = 600;
/* Сколько тишины после слова «отправить» считается подтверждением отправки. */
export const VOICE_SEND_WINDOW_MS = 2000;

/* Профили озвучки — это пресеты, а не отдельные голоса: Web Speech API играет
   только системными голосами устройства. «Джарвис-стиль» = низкий мужской
   русский голос, чуть медленнее обычного. Настоящего голоса Джарвиса в системе
   нет и подставить его нельзя — см. memory-bank/systemPatterns.md. */
export const VOICE_PROFILES = {
  calm: { id: 'calm', title: 'Спокойный', rate: 1, pitch: 1, gender: '' },
  jarvis: { id: 'jarvis', title: 'Джарвис-стиль', rate: 0.95, pitch: 0.7, gender: 'male' }
};
export const VOICE_PROFILE_IDS = Object.keys(VOICE_PROFILES);

/* Имена русских мужских голосов в Windows, macOS и iOS. Полного списка не
   существует, поэтому это эвристика: не нашли — берём обычный русский голос. */
export const VOICE_MALE_NAMES =
  /(yuri|юр(ий|ия)|dmitry|дмитри|pavel|павел|aleksandr|alexander|александр|artem|арт(е|ё)м|maxim|максим|ivan|иван)/i;

/* По умолчанию озвучка выключена: приложение не должно внезапно заговорить,
   к тому же на iOS первый speak обязан идти из жеста пользователя. */
export const DEFAULT_SETTINGS = {
  speakReplies: false,
  rate: VOICE_DEFAULT_RATE,
  pitch: VOICE_DEFAULT_PITCH,
  profile: 'calm',
  gender: '',
  voiceURI: '',
  autoSend: true,
  sendDelay: VOICE_SEND_WINDOW_MS
};

/* Русские причины вместо кодов Web Speech API: пользователю нужно понимать,
   что именно чинить — разрешение, микрофон или интернет. */
const VOICE_ERRORS = {
  'not-allowed': 'Нет доступа к микрофону: разрешите его для этого сайта в настройках браузера',
  'service-not-allowed': 'Браузер запретил распознавание речи для этого сайта',
  'audio-capture': 'Микрофон не найден или занят другим приложением',
  'no-speech': 'Ничего не расслышал — попробуйте ещё раз ближе к микрофону',
  network: 'Распознавание в Chrome идёт через интернет: проверьте связь',
  aborted: 'Распознавание отменено',
  busy: 'Микрофон уже слушает — сначала остановите запись',
  'language-not-supported': 'Браузер не поддерживает русский язык распознавания',
  unknown: 'Не удалось распознать речь'
};

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch (e) {
    return null;
  }
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/* ---------- Настройки ---------- */

/* Скорость речи: 0.5…2. Мусор и крайние значения не должны ломать озвучку. */
export function clampRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return VOICE_DEFAULT_RATE;
  const limited = Math.min(VOICE_MAX_RATE, Math.max(VOICE_MIN_RATE, n));
  return Math.round(limited * 100) / 100;
}

/* Высота голоса: 0…2 (значения Web Speech API). Низкая высота и есть
   «джарвис-стиль» — другого способа влиять на тембр у нас нет. */
export function clampPitch(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return VOICE_DEFAULT_PITCH;
  const limited = Math.min(VOICE_MAX_PITCH, Math.max(VOICE_MIN_PITCH, n));
  return Math.round(limited * 100) / 100;
}

export function normalizeProfile(value) {
  const id = text(value);
  return VOICE_PROFILE_IDS.indexOf(id) >= 0 ? id : 'calm';
}

export function normalizeGender(value) {
  const id = text(value).toLowerCase();
  return id === 'male' || id === 'female' ? id : '';
}

/* Задержка подтверждения: 1…10 секунд, по умолчанию 2. */
export function clampSendDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return VOICE_SEND_WINDOW_MS;
  return Math.min(10000, Math.max(1000, Math.round(n)));
}

/* Пресет профиля, разложенный в настройки. Скорость после выбора профиля можно
   менять руками — профиль её только задаёт стартовым значением. */
export function profileSettings(profile) {
  const preset = VOICE_PROFILES[normalizeProfile(profile)];
  return {
    profile: preset.id,
    rate: preset.rate,
    pitch: preset.pitch,
    gender: preset.gender
  };
}

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const profile = normalizeProfile(src.profile);
  const preset = VOICE_PROFILES[profile];
  const gender = normalizeGender(src.gender) || preset.gender;
  return {
    speakReplies: src.speakReplies === true,
    rate: clampRate(src.rate),
    pitch: clampPitch(src.pitch === undefined ? preset.pitch : src.pitch),
    profile,
    gender,
    voiceURI: typeof src.voiceURI === 'string' ? src.voiceURI.trim() : '',
    autoSend: src.autoSend !== false,
    sendDelay: clampSendDelay(src.sendDelay)
  };
}

export function loadSettings(storage) {
  const store = storageOf(storage);
  if (!store || typeof store.getItem !== 'function') return normalizeSettings(DEFAULT_SETTINGS);
  try {
    const raw = store.getItem(VOICE_STORAGE);
    if (!raw) return normalizeSettings(DEFAULT_SETTINGS);
    return normalizeSettings(JSON.parse(raw));
  } catch (e) {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings, storage) {
  const store = storageOf(storage);
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    store.setItem(VOICE_STORAGE, JSON.stringify(normalizeSettings(settings)));
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------- Распознавание ---------- */

/* Chrome и Safari называют конструктор по-разному, а Firefox и часть WebView
   не умеют вовсе. Отсутствие — это не ошибка, а честное «кнопка не работает». */
export function recognitionCtor(win) {
  const w = win || globalThis;
  if (!w) return null;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function recognitionAvailable(win) {
  return typeof recognitionCtor(win) === 'function';
}

/* Распознавание требует «безопасного» контекста: https, localhost или 127.0.0.1.
   По file:// и по http://<ip> браузер молча ничего не сделает. */
export function isSecure(win) {
  const w = win || globalThis;
  if (!w) return false;
  if (w.isSecureContext === true) return true;
  try {
    const host = w.location && w.location.hostname ? String(w.location.hostname) : '';
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch (e) {
    return false;
  }
}

export function recognitionOptions(options) {
  const opts = options && typeof options === 'object' ? options : {};
  return {
    lang: text(opts.lang) || VOICE_LANG,
    interimResults: opts.interimResults !== false,
    continuous: opts.continuous === true,
    maxAlternatives: 1
  };
}

/* Разбор события onresult: нужны и промежуточный текст (показываем сразу),
   и финальный (его отправляем наверх).
   fromIndex — event.resultIndex: в continuous-режиме браузер присылает ВСЕ
   результаты сессии, и без этого текст дублировался бы при каждом обновлении. */
export function readResults(event, fromIndex) {
  const results = event && event.results ? event.results : [];
  const length = Number(results.length) || 0;
  let start = Number(fromIndex);
  if (!Number.isFinite(start) || start < 0 || start > length) start = 0;
  const finalParts = [];
  const interimParts = [];
  for (let i = start; i < length; i++) {
    const item = results[i];
    const alt = item && item[0] ? item[0] : null;
    const chunk = alt && alt.transcript ? text(alt.transcript) : '';
    if (!chunk) continue;
    if (item.isFinal) finalParts.push(chunk);
    else interimParts.push(chunk);
  }
  return { final: finalParts.join(' '), interim: interimParts.join(' ') };
}

/* Текст в поле: то, что уже было набрано, плюс распознанное.
   Промежуточный и финальный варианты не склеиваются — второй заменяет первый. */
export function composeText(base, finalText, interimText) {
  const head = text(base);
  const spoken = text(finalText) || text(interimText);
  if (!spoken) return head;
  return head ? head + ' ' + spoken : spoken;
}

/* ---------- Голосовые команды ---------- */

/* Нормализация фразы для сравнения: регистр, ё, пунктуация, лишние пробелы. */
export function normalizeCommand(value) {
  return text(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const SEND_COMMANDS = ['отправить', 'отправь', 'отправьте', 'отправит', 'отправим', 'send'];
export const CANCEL_COMMANDS =
  ['отмена', 'отмени', 'отменить', 'нет', 'стоп', 'cancel', 'не отправляй', 'отставить'];

/* Команда «отправить» понимается только в конце высказывания: иначе фраза
   «отправь письмо Пете» превратилась бы в отправку пустого сообщения.
   Всё, что стоит до команды, — это текст сообщения. */
export function splitSendCommand(value) {
  const raw = text(value);
  if (!raw) return { send: false, rest: '' };
  const trimmed = raw.replace(/[.!?…,;:]+\s*$/, '').trim();
  const pattern = new RegExp(
    '(^|\\s)((отправить|отправь|отправьте) сообщение|' + SEND_COMMANDS.join('|') + ')$',
    'i'
  );
  const match = pattern.exec(trimmed);
  if (!match) return { send: false, rest: raw };
  const rest = trimmed.slice(0, match.index + match[1].length)
    .replace(/[.!?…,;:]+\s*$/, '')
    .trim();
  return { send: true, rest };
}

export function isSendCommand(value) {
  const parsed = splitSendCommand(value);
  return parsed.send && !parsed.rest;
}

export function isCancelCommand(value) {
  const norm = normalizeCommand(value);
  if (!norm) return false;
  return CANCEL_COMMANDS.indexOf(norm) >= 0;
}

export function voiceErrorText(code) {
  const key = text(code) || 'unknown';
  if (Object.prototype.hasOwnProperty.call(VOICE_ERRORS, key)) return VOICE_ERRORS[key];
  return 'Распознавание не удалось: ' + key;
}

/* Запуск распознавания. Возвращает контроллер { stop, abort, ended } или null,
   если браузер не умеет. Колбэки: onResult({final, interim}), onError(code, message),
   onEnd(), onUnsupported(). onEnd вызывается ровно один раз. */
export function recognize(win, handlers, options) {
  const w = win || globalThis;
  const safe = handlers && typeof handlers === 'object' ? handlers : {};
  const Ctor = recognitionCtor(w);
  if (typeof Ctor !== 'function') {
    if (typeof safe.onUnsupported === 'function') safe.onUnsupported();
    return null;
  }
  let rec = null;
  try {
    rec = new Ctor();
  } catch (e) {
    if (typeof safe.onUnsupported === 'function') safe.onUnsupported();
    return null;
  }

  const opts = recognitionOptions(options);
  Object.keys(opts).forEach(key => { rec[key] = opts[key]; });

  let ended = false;
  let stopped = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (typeof safe.onEnd === 'function') safe.onEnd();
  };

  rec.onresult = event => {
    /* resultIndex указывает на первый изменившийся результат: только с него
       и читаем, иначе в continuous-режиме текст приходит повторно */
    const parsed = readResults(event, event ? event.resultIndex : 0);
    if (typeof safe.onResult === 'function') safe.onResult(parsed);
  };
  rec.onerror = event => {
    const code = text(event && event.error) || 'unknown';
    if (typeof safe.onError === 'function') safe.onError(code, voiceErrorText(code));
  };
  rec.onend = finish;

  try {
    rec.start();
  } catch (e) {
    // Второй start() без stop() браузер запрещает: говорим об этом словами
    if (typeof safe.onError === 'function') safe.onError('busy', voiceErrorText('busy'));
    return null;
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { rec.stop(); } catch (e) { finish(); }
    },
    abort() {
      if (stopped) return;
      stopped = true;
      try { rec.abort(); } catch (e) { finish(); }
    },
    get ended() { return ended; }
  };
}


/* ---------- Синтез ---------- */

export function canSpeak(win) {
  const w = win || globalThis;
  return !!w && typeof w.speechSynthesis !== 'undefined' &&
    typeof w.SpeechSynthesisUtterance === 'function';
}

export function listVoices(win) {
  const w = win || globalThis;
  try {
    if (!w || !w.speechSynthesis || typeof w.speechSynthesis.getVoices !== 'function') return [];
    return w.speechSynthesis.getVoices() || [];
  } catch (e) {
    return [];
  }
}

/* Голос выбирается так: сохранённый вручную → русский нужного пола → локальный
   русский → любой русский. Локальные голоса не зависят от сети и звучат
   стабильнее. Пол — только предпочтение: мужского русского голоса в системе
   может не быть, тогда молча берём обычный. */
export function pickVoice(voices, voiceURI, gender) {
  const items = Array.isArray(voices) ? voices.filter(v => v && typeof v === 'object') : [];
  const wanted = text(voiceURI);
  if (wanted) {
    const saved = items.find(v => v.voiceURI === wanted);
    if (saved) return saved;
  }
  const russian = items.filter(v => /^ru([-_]|$)/i.test(String(v.lang || '')));
  if (!russian.length) return null;
  const local = russian.filter(v => v.localService === true);
  const pool = local.length ? local : russian;
  const wantMale = normalizeGender(gender) === 'male';
  const wantFemale = normalizeGender(gender) === 'female';
  if (wantMale) {
    /* Сначала локальный мужской (работает офлайн), потом любой русский мужской. */
    const localMale = pool.find(v => VOICE_MALE_NAMES.test(String(v.name || '')));
    if (localMale) return localMale;
    const anyMale = russian.find(v => VOICE_MALE_NAMES.test(String(v.name || '')));
    if (anyMale) return anyMale;
  }
  const plain = pool.find(v => String(v.lang || '').toLowerCase() === 'ru-ru');
  const fallback = plain || pool[0];
  if (wantFemale) {
    const female = pool.find(v => !VOICE_MALE_NAMES.test(String(v.name || '')));
    if (female) return female;
  }
  return fallback;
}

/* iOS отдаёт список голосов асинхронно: до события voiceschanged getVoices()
   пуст, и первый speak ушёл бы вообще без голоса. Ждём событие один раз. */
export function whenVoicesReady(win, callback) {
  const w = win || globalThis;
  if (!w || typeof callback !== 'function') return false;
  const synth = w.speechSynthesis;
  if (!synth) return false;
  const existing = listVoices(w);
  if (existing.length) {
    callback(existing);
    return true;
  }
  const handler = () => {
    const voices = listVoices(w);
    try {
      if (typeof synth.removeEventListener === 'function') {
        synth.removeEventListener('voiceschanged', handler);
      } else {
        synth.onvoiceschanged = null;
      }
    } catch (e) {
      /* браузер может не дать снять обработчик — не страшно, он одноразовый */
    }
    if (voices.length) callback(voices);
  };
  try {
    if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', handler);
    else synth.onvoiceschanged = handler;
    return true;
  } catch (e) {
    return false;
  }
}

/* Текст для озвучки: без markdown и без бесконечной длины. */
export function prepareSpeech(value, max) {
  const limit = Number(max) > 0 ? Number(max) : VOICE_MAX_SPEECH;
  const phrase = speechOf(value);
  if (phrase.length <= limit) return phrase;
  const cut = phrase.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit * 0.6 ? cut.slice(0, space) : cut).trim();
}

/* Озвучка одной фразы. Предыдущая речь отменяется: очередь из ответов
   помощника пользователю не нужна. Никогда не бросает — только true/false. */
export function speak(value, settings, deps) {
  const phrase = prepareSpeech(value);
  if (!phrase) return false;
  const opts = normalizeSettings(settings);
  const extra = deps && typeof deps === 'object' ? deps : {};
  const w = extra.win || globalThis;
  const synth = extra.synth || (w ? w.speechSynthesis : null);
  const Utterance = extra.Utterance || (w ? w.SpeechSynthesisUtterance : null);
  if (!synth || typeof synth.speak !== 'function' || typeof Utterance !== 'function') return false;
  try {
    if (typeof synth.cancel === 'function') synth.cancel();
    const utter = new Utterance(phrase);
    utter.lang = VOICE_LANG;
    utter.rate = opts.rate;
    utter.pitch = opts.pitch;
    const voice = Object.prototype.hasOwnProperty.call(extra, 'voice')
      ? extra.voice
      : pickVoice(listVoices(w), opts.voiceURI, opts.gender);
    if (voice) utter.voice = voice;
    synth.speak(utter);
    return true;
  } catch (e) {
    return false;
  }
}

export function stopSpeaking(win) {
  const w = win || globalThis;
  try {
    if (w && w.speechSynthesis && typeof w.speechSynthesis.cancel === 'function') {
      w.speechSynthesis.cancel();
      return true;
    }
  } catch (e) {
    /* браузер может запретить — молча считаем, что говорить нечего */
  }
  return false;
}

/* Короткая строка для панели 💾: что умеет именно это устройство. */
export function voiceSummary(win, settings) {
  const w = win || globalThis;
  const opts = normalizeSettings(settings);
  const recognition = recognitionAvailable(w) ? 'да' : 'нет';
  const tts = canSpeak(w) ? 'да' : 'нет';
  const voice = pickVoice(listVoices(w), opts.voiceURI, opts.gender);
  let voiceText = 'нет русского';
  if (voice) voiceText = voice.name || 'без имени';
  else if (tts !== 'да') voiceText = 'нет синтеза';
  const preset = VOICE_PROFILES[opts.profile];
  /* Честность важнее красоты: если мужского русского голоса в системе нет,
     «джарвис-стиль» звучит обычным голосом — так и пишем в диагностике. */
  const maleMissing = opts.gender === 'male' && !!voice &&
    !VOICE_MALE_NAMES.test(String(voice.name || ''));
  const profileText = preset.title + (maleMissing ? ' (мужской голос не найден)' : '');
  return 'распознавание: ' + recognition + ' · озвучка: ' + (opts.speakReplies ? 'вкл' : 'выкл') +
    ' · голос: ' + voiceText + ' · профиль: ' + profileText;
}

