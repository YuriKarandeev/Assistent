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
/* Длинную простыню помощника вслух слушать невозможно: режем по границе слова. */
export const VOICE_MAX_SPEECH = 600;

/* По умолчанию озвучка выключена: приложение не должно внезапно заговорить,
   к тому же на iOS первый speak обязан идти из жеста пользователя. */
export const DEFAULT_SETTINGS = {
  speakReplies: false,
  rate: VOICE_DEFAULT_RATE,
  voiceURI: ''
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

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    speakReplies: src.speakReplies === true,
    rate: clampRate(src.rate),
    voiceURI: typeof src.voiceURI === 'string' ? src.voiceURI.trim() : ''
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
   и финальный (его отправляем наверх). */
export function readResults(event) {
  const results = event && event.results ? event.results : [];
  const length = Number(results.length) || 0;
  const finalParts = [];
  const interimParts = [];
  for (let i = 0; i < length; i++) {
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
    const parsed = readResults(event);
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

/* Голос выбирается так: сохранённый вручную → русский локальный → любой русский.
   Локальные голоса не зависят от сети и звучат стабильнее. */
export function pickVoice(voices, voiceURI) {
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
  return pool.find(v => String(v.lang || '').toLowerCase() === 'ru-ru') || pool[0];
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
    const voice = Object.prototype.hasOwnProperty.call(extra, 'voice')
      ? extra.voice
      : pickVoice(listVoices(w), opts.voiceURI);
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
  const voice = pickVoice(listVoices(w), opts.voiceURI);
  let voiceText = 'нет русского';
  if (voice) voiceText = voice.name || 'без имени';
  else if (tts !== 'да') voiceText = 'нет синтеза';
  return 'распознавание: ' + recognition + ' · озвучка: ' + (opts.speakReplies ? 'вкл' : 'выкл') +
    ' · голос: ' + voiceText;
}

