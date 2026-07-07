// scan.js — Firestore'u tarar, vadesi yaklaşan kalemlere WhatsApp atar.
const admin = require("firebase-admin");

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const LEAD_DAYS     = parseInt(process.env.LEAD_DAYS || "3", 10);
const INTERVAL_HOURS = parseInt(process.env.INTERVAL_HOURS || "5", 10);
const TZ_OFFSET     = parseInt(process.env.TZ_OFFSET || "3", 10); // Türkiye UTC+3
const PHONE         = (process.env.WA_PHONE || "").replace(/[^0-9]/g, "");
const APIKEY        = process.env.WA_APIKEY;

// Yerel saate (TZ_OFFSET) göre şu anki Date nesnesi
function localNow() {
  const d = new Date();
  d.setTime(d.getTime() + TZ_OFFSET * 3600 * 1000);
  return d;
}

function daysUntil(dateStr) {
  const today = localNow();
  today.setUTCHours(0, 0, 0, 0);
  const d = new Date(dateStr + "T00:00:00Z");
  return Math.round((d - today) / 86400000);
}

function todayDateStr() {
  const t = localNow();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,"0")}-${String(t.getUTCDate()).padStart(2,"0")}`;
}

function monthKey() {
  const t = localNow();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth()+1).padStart(2,"0")}`;
}

// Bugün (yerel), dayNum'dan n gün sonra mı? (ay sınırı güvenli)
function isTodayNDaysAfter(dayNum, n) {
  const ref = localNow();
  ref.setUTCDate(ref.getUTCDate() - n);
  return ref.getUTCDate() === dayNum;
}

// Bugün (yerel), dayNum'dan n gün önce mi? (ay sınırı güvenli)
function isTodayNDaysBefore(dayNum, n) {
  const ref = localNow();
  ref.setUTCDate(ref.getUTCDate() + n);
  return ref.getUTCDate() === dayNum;
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
  const body = await res.text();
  console.log("WA yanıt:", body.slice(0, 400));
  if (!res.ok) return false;
  if (/color:red|error|failed|invalid|not registered|wrong|you have 0/i.test(body)) return false;
  return true;
}

(async () => {
  if (!PHONE || !APIKEY) {
    console.error("WA_PHONE veya WA_APIKEY eksik.");
    process.exit(1);
  }

  const now = Date.now();
  const gap = INTERVAL_HOURS * 3600 * 1000;
  let sent = 0;

  console.log(`Yerel tarih (UTC+${TZ_OFFSET}): ${todayDateStr()}, ayKey: ${monthKey()}`);

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

  console.log(`Kartlar bulundu: ${cards.length}`);
  for (const card of cards) {
    const stmt = card.statementDay || card.statementDay;
    console.log(`  Kart: ${card.bank}, statementDay:${stmt}, dueDay:${card.dueDay}, isTodayNDaysAfter:${stmt?isTodayNDaysAfter(stmt,1):'-'}`);
    if (!stmt) continue;
    if (!isTodayNDaysAfter(stmt, 1)) continue;
    if (paidSet.has(`${card.id}__${mk}`)) {
      console.log("  → Bu ay ödendi, atlandı:", card.bank);
      continue;
    }
    const logKey = `c3_card_${card.id}_${todayDateStr()}`;
    const last = await checkNotifLog(logKey);
    if (last) { console.log("  → Bugün zaten gönderildi"); continue; }
    const debt = card.debt ? ` Mevcut borç: ${card.debt} ${card.currency || "TRY"}.` : "";
    const text = `💳 ${card.bank || "Kredi kartı"} hesabı kesildi.${debt} Son ödeme günü: ayın ${card.dueDay || "?"}'i.`;
    const ok = await sendWhatsApp(text);
    if (ok) {
      await setNotifLog(logKey);
      sent++;
      console.log("  → Kart bildirimi gönderildi:", card.bank);
    } else {
      console.log("  → Kart bildirimi gönderilemedi:", card.bank);
    }
  }

  // --- Krediler: ödeme gününden 3 gün önce ---
  const loans = await getItems("loans");
  console.log(`Krediler bulundu: ${loans.length}`);
  for (const loan of loans) {
    const months = Number(loan.months || 0);
    const paid = Number(loan.paidCount || 0);
    console.log(`  Kredi: ${loan.title}, dueDay:${loan.dueDay}, ${paid}/${months}, isTodayNDaysBefore:${loan.dueDay?isTodayNDaysBefore(loan.dueDay,3):'-'}`);
    if (!loan.dueDay) continue;
    if (months > 0 && paid >= months) { console.log("  → Tamamlandı, atlandı"); continue; }
    if (!isTodayNDaysBefore(loan.dueDay, 3)) continue;
    const logKey = `c3_loan_${loan.id}_${todayDateStr()}`;
    const last = await checkNotifLog(logKey);
    if (last) { console.log("  → Bugün zaten gönderildi"); continue; }
    const remain = months > 0 ? months - paid : "?";
    const amt = loan.monthly ? ` ${loan.monthly} ${loan.currency || "TRY"}` : "";
    const text = `🏦 Kredi taksiti 3 gün sonra (ayın ${loan.dueDay}'i):${amt} — ${loan.title}. Kalan: ${remain} taksit.`;
    const ok = await sendWhatsApp(text);
    if (ok) {
      await setNotifLog(logKey);
      sent++;
      console.log("  → Kredi bildirimi gönderildi:", loan.title);
    } else {
      console.log("  → Kredi bildirimi gönderilemedi:", loan.title);
    }
  }

  console.log(`Bitti. ${sent} mesaj gönderildi.`);
})();
