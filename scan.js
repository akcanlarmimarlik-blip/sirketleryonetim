// scan.js — Firestore'u tarar, vadesi yaklaşan kalemlere Telegram atar.
const admin = require("firebase-admin");

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const LEAD_DAYS      = parseInt(process.env.LEAD_DAYS || "3", 10);
const INTERVAL_HOURS = parseInt(process.env.INTERVAL_HOURS || "5", 10);
const TZ_OFFSET      = parseInt(process.env.TZ_OFFSET || "3", 10);
const TG_TOKEN       = process.env.TELEGRAM_TOKEN || "";
const TG_CHAT_ID     = process.env.TELEGRAM_CHAT_ID || "";

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

function isTodayNDaysAfter(dayNum, n) {
  const ref = localNow();
  ref.setUTCDate(ref.getUTCDate() - n);
  return ref.getUTCDate() === dayNum;
}

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

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
  });
  const data = await res.json();
  if (!data.ok) console.log("Telegram hata:", JSON.stringify(data));
  return data.ok === true;
}

(async () => {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error("TELEGRAM_TOKEN veya TELEGRAM_CHAT_ID eksik.");
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
    const ok = await sendTelegram(text);
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
  const paidSet = new Set(payments.map((p) => p.id));
  const mk = monthKey();

  console.log(`Kartlar: ${cards.length}`);
  for (const card of cards) {
    const stmt = card.statementDay;
    if (!stmt) continue;
    const trigger = isTodayNDaysAfter(stmt, 1);
    console.log(`  ${card.bank}: statementDay=${stmt}, trigger=${trigger}`);
    if (!trigger) continue;
    if (paidSet.has(`${card.id}__${mk}`)) { console.log("  → Bu ay ödendi, atlandı"); continue; }
    const logKey = `tg_card_${card.id}_${todayDateStr()}`;
    const last = await checkNotifLog(logKey);
    if (last) { console.log("  → Bugün zaten gönderildi"); continue; }
    const debt = card.debt ? ` Borç: ${card.debt} ${card.currency || "TRY"}.` : "";
    const text = `💳 ${card.bank || "Kredi kartı"} hesabı kesildi.${debt}\nSon ödeme: ayın ${card.dueDay || "?"}'i.`;
    const ok = await sendTelegram(text);
    if (ok) { await setNotifLog(logKey); sent++; console.log("  → Gönderildi:", card.bank); }
    else { console.log("  → Gönderilemedi:", card.bank); }
  }

  // --- Krediler: ödeme gününden 3 gün önce ---
  const loans = await getItems("loans");
  console.log(`Krediler: ${loans.length}`);
  for (const loan of loans) {
    if (!loan.dueDay) continue;
    const months = Number(loan.months || 0);
    const paid = Number(loan.paidCount || 0);
    if (months > 0 && paid >= months) { console.log(`  ${loan.title}: tamamlandı, atlandı`); continue; }
    const trigger = isTodayNDaysBefore(loan.dueDay, 3);
    console.log(`  ${loan.title}: dueDay=${loan.dueDay}, trigger=${trigger}`);
    if (!trigger) continue;
    const logKey = `tg_loan_${loan.id}_${todayDateStr()}`;
    const last = await checkNotifLog(logKey);
    if (last) { console.log("  → Bugün zaten gönderildi"); continue; }
    const remain = months > 0 ? months - paid : "?";
    const amt = loan.monthly ? ` ${loan.monthly} ${loan.currency || "TRY"}` : "";
    const text = `🏦 Kredi taksiti 3 gün sonra (ayın ${loan.dueDay}'i):${amt}\n${loan.title} — Kalan: ${remain} taksit.`;
    const ok = await sendTelegram(text);
    if (ok) { await setNotifLog(logKey); sent++; console.log("  → Gönderildi:", loan.title); }
    else { console.log("  → Gönderilemedi:", loan.title); }
  }

  console.log(`Bitti. ${sent} mesaj gönderildi.`);
})();
