/* Отправитель напоминаний: читает план из Firestore и рассылает Web Push.
 *
 * Запускается GitHub Actions по cron (каждые 5 минут) — у GitHub Pages нет
 * бэкенда, а iOS не даёт закрытому приложению таймеров. Секреты живут только
 * в настройках репозитория:
 *
 *   FIREBASE_SERVICE_ACCOUNT — JSON сервисного аккаунта (доступ к базе)
 *   VAPID_PUBLIC_KEY         — публичный ключ (тот же, что в push.js)
 *   VAPID_PRIVATE_KEY        — приватный ключ (только здесь!)
 *   VAPID_SUBJECT            — mailto:... для VAPID
 *
 * Режимы (--mode=):
 *   send    — обычный запуск по расписанию: отправить всё, чей час настал
 *   dry-run — показать, что было бы отправлено, ничего не записывая
 *   test    — одно проверочное уведомление на все подписки
 *
 * Логика «что пора отправить» не дублируется: она берётся из ../push.js —
 * того же файла, который публикуется вместе с приложением.
 */
import admin from 'firebase-admin';
import webpush from 'web-push';
import { dueNow, pushPayload, testPayload, pruneSent } from '../push.js';

const args = process.argv.slice(2);
const modeArg = args.find(a => a.indexOf('--mode=') === 0);
const MODE = (modeArg ? modeArg.split('=')[1] : process.env.PUSH_MODE || 'send').trim();
const DRY = MODE === 'dry-run';
const SEND_LIMIT = 5;
const TTL_SECONDS = 15 * 60;

const config = {
  subject: process.env.VAPID_SUBJECT || 'mailto:karandeevrus@gmail.com',
  publicKey: process.env.VAPID_PUBLIC_KEY || '',
  privateKey: process.env.VAPID_PRIVATE_KEY || '',
  serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || ''
};

function log() {
  console.log('[push]', ...Array.prototype.slice.call(arguments));
}

function fail(message) {
  console.error('[push] ОШИБКА:', message);
  process.exit(1);
}

/* Подписки одного пользователя: users/{uid}/push/{deviceId} */
async function loadSubscriptions(userRef) {
  const snap = await userRef.collection('push').get();
  return snap.docs.map(doc => Object.assign({ id: doc.id }, doc.data()));
}

async function loadDoc(collection, id, userRef) {
  const snap = await userRef.collection(collection).doc(id).get();
  return snap.exists ? snap.data() || {} : {};
}

/* Отправка одному устройству. Возвращает 'ok' | 'gone' (подписка мертва) | 'error' */
async function sendToSubscription(subscription, payload) {
  if (!subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return 'gone';
  }
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      JSON.stringify(payload),
      { TTL: TTL_SECONDS }
    );
    return 'ok';
  } catch (e) {
    const code = e && (e.statusCode || e.code);
    // 404/410 — подписка отозвана (переустановка, очистка данных): чистим её
    if (code === 404 || code === 410) return 'gone';
    log('устройство', subscription.id, 'ошибка', code, (e && e.message) || e);
    return 'error';
  }
}

async function main() {
  if (!config.serviceAccount) fail('нет FIREBASE_SERVICE_ACCOUNT (секрет репозитория)');
  if (!config.publicKey || !config.privateKey) fail('нет VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (секреты репозитория)');

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(config.serviceAccount))
  });
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const db = admin.firestore();

  const now = new Date();
  log('режим:', MODE, 'время:', now.toISOString());

  const userRefs = await db.collection('users').listDocuments();
  if (!userRefs.length) {
    log('пользователей нет — отправлять нечего');
    return;
  }

  let delivered = 0;
  let failed = 0;
  let pruned = 0;

  for (const userRef of userRefs) {
    const subscriptions = await loadSubscriptions(userRef);
    if (!subscriptions.length) {
      log(userRef.id, 'подписок нет');
      continue;
    }

    let items = [];
    if (MODE === 'test') {
      items = [testPayload(now)];
    } else {
      const plan = await loadDoc('pushPlan', 'main', userRef);
      const state = await loadDoc('pushState', 'main', userRef);
      items = dueNow(plan, now, state.sent || {}, SEND_LIMIT);
    }

    if (!items.length) {
      log(userRef.id, 'нечего отправлять, подписок:', subscriptions.length);
      continue;
    }

    const sentKeys = [];
    for (const item of items) {
      const payload = MODE === 'test' ? item : pushPayload(item);
      log(DRY ? 'было бы отправлено:' : 'отправляю:', JSON.stringify(payload));
      if (DRY) continue;

      let ok = 0;
      for (const subscription of subscriptions) {
        const result = await sendToSubscription(subscription, payload);
        if (result === 'ok') {
          ok++;
          delivered++;
        } else if (result === 'gone') {
          pruned++;
          await userRef.collection('push').doc(subscription.id).delete()
            .catch(e => log('не удалось удалить подписку', subscription.id, e.message));
        } else {
          failed++;
        }
      }
      if (ok > 0 && item.key) sentKeys.push(item.key);
    }

    if (DRY || MODE === 'test' || !sentKeys.length) continue;
    const sentState = await loadDoc('pushState', 'main', userRef);
    const sent = pruneSent(sentState.sent || {}, now);
    sentKeys.forEach(key => { sent[key] = now.toISOString(); });
    await userRef.collection('pushState').doc('main')
      .set({ sent: sent, updatedAt: now.toISOString() }, { merge: true });
  }

  log('итог: доставлено', delivered, 'удалено мёртвых подписок', pruned, 'ошибок', failed);
  if (failed && !delivered) fail('ни одно уведомление не доставлено');
}

main().catch(e => fail((e && e.stack) || e));
