// scan.js — Firestore'u tarar, vadesi yaklaşan kalemlere WhatsApp atar.
const admin = require("firebase-admin");

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const LEAD_DAYS = parseInt(process.env.LEAD_DAYS || "3", 10);
const INTERVAL_HOURS = parseInt(process.env.INTERVAL_HOURS || "5", 10);
const PHONE = (process.env.WA_PHONE || "").replace(/[^0-9]/g, "");
const APIKEY = process.env.WA_APIKEY;

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + "T00:00:00");
  return Math.round((d - today) / 86400000);
}

function todayDateStr() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

function monthKey() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
}

// Bugün, dayNum'dan n gün sonra mı? (ay sınırı güvenli)
function isTodayNDaysAfter(dayNum, n) {
  const ref = new Date();
  ref.setDate(ref.getDate() - n);
  return ref.getDate() === dayNum;
}

// Bugün, dayNum'dan n gün önce mi? (ay sınırı güvenli)
function isTodayNDaysBefore(dayNum, n) {
  const ref = new Date();
  ref.setDate(ref.getDate() + n);
  return ref.getDate() === dayNum;
}

async function getItems(store) {
  const snap = await db.collection("appdata").doc(store).get();
  return snap.exists ? snap.data().items || [] : [];
}

async function checkNotifLog(key) {
  const doc = await db.collection("notifLog").doc(key).get();
  return doc.exists ? doc.data().lastNotified || 0 : 0;
}

async function setNotifLog(key) {
  await db.collection("notifLog").doc(key).set({ lastNotified: Date.now() });
}

async function sendWhatsApp(text) {
  const url =
    "https://api.callmebot.com/whatsapp.php" +
    `?phone=${encodeURIComponent(PHONE)}` +
    `&text=${encodeURIComponent(text)}` +
    `&apikey=${encodeURIComponent(APIKEY)}`;
  const res = await fetch(url);
  return res.ok;
}

(async () => {
  if (!PHONE || !APIKEY) {
    console.error("WA_PHONE veya WA_APIKEY eksik.");
    process.exit(1);
  }

  const now = Date.now();
  const gap = INTERVAL_HOURS * 3600 * 1000;
  let sent = 0;

  // --- Genel hatırlatıcılar (reminders koleksiyonu) ---
  const snap = await db.collection("reminders").where("done", "==", false).get();
  for (const doc of snap.docs) {
    const it = doc.data();
    if (!it.dueDate) continue;
    const days = daysUntil(it.dueDate);
    if (days > LEAD_DAYS) continue;
    const last = it.lastNotified || 0;
    if (now - last < gap) continue;
    const when =
      days < 0 ? `${-days} gün GECİKTİ`
      : days === 0 ? "bugün son gün"
      : days === 1 ? "yarın"
      : `${days} gün kaldı`;
    const amt = it.amount ? ` (${it.amount} ${it.currency || "TRY"})` : "";
    const text = `⏰ ${it.sub || "Hatırlatma"}: ${it.title}${amt} — ${when}. Tamamlayınca durur.`;
    const ok = await sendWhatsApp(text);
    if (ok) {
      await doc.ref.update({ lastNotified: now });
      sent++;
      console.log("Gönderildi:", it.title);
    } else {
      console.log("Gönderilemedi:", it.title);
    }
  }

  // --- Kredi kartları: hesap kesilmesinden 1 gün sonra ---
  const cards = await getItems("cards");
  const payments = await getItems("payments");
  const paidSet = new Set(payments.map((p) => p.id)); // "cardId__YYYY-MM"
  const mk = monthKey();

  for (const card of cards) {
    if (!card.statementDay) continue;
    if (!isTodayNDaysAfter(card.statementDay, 1)) continue;
    if (paidSet.has(`${card.id}__${mk}`)) {
      console.log("Kart bu ay ödendi, atlandı:", card.bank);
      continue;
    }
    const logKey = `card_${card.id}_${todayDateStr()}`;
    const last = await checkNotifLog(logKey);
    if (now - last < gap) continue;
    const debt = card.debt ? ` Mevcut borç: ${card.debt} ${card.currency || "TRY"}.` : "";
    const text = `💳 ${card.bank || "Kredi kartı"} hesabı kesildi.${debt} Son ödeme günü: ayın ${card.dueDay || "?"}\'i.`;
    const ok = await sendWhatsApp(text);
    if (ok) {
      await setNotifLog(logKey);
      sent++;
      console.log("Kart bildirimi gönderildi:", card.bank);
    } else {
      console.log("Kart bildirimi gönderilemedi:", card.bank);
    }
  }

  // --- Krediler: ödeme gününden 3 gün önce ---
  const loans = await getItems("loans");
  for (const loan of loans) {
    if (!loan.dueDay) continue;
    const months = Number(loan.months || 0);
    const paid = Number(loan.paidCount || 0);
    if (months > 0 && paid >= months) {
      console.log("Kredi tamamlandı, atlandı:", loan.title);
      continue;
    }
    if (!isTodayNDaysBefore(loan.dueDay, 3)) continue;
    const logKey = `loan_${loan.id}_${todayDateStr()}`;
    const last = await checkNotifLog(logKey);
    if (now - last < gap) continue;
    const remain = months > 0 ? months - paid : "?";
    const amt = loan.monthly ? ` ${loan.monthly} ${loan.currency || "TRY"}` : "";
    const text = `🏦 Kredi taksiti 3 gün sonra (ayın ${loan.dueDay}\'i):${amt} — ${loan.title}. Kalan: ${remain} taksit.`;
    const ok = await sendWhatsApp(text);
    if (ok) {
      await setNotifLog(logKey);
      sent++;
      console.log("Kredi bildirimi gönderildi:", loan.title);
    } else {
      console.log("Kredi bildirimi gönderilemedi:", loan.title);
    }
  }

  console.log(`Bitti. ${sent} mesaj gönderildi.`);
})();
