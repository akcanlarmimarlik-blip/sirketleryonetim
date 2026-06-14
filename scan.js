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
  const snap = await db.collection("reminders").where("done", "==", false).get();
  const now = Date.now();
  const gap = INTERVAL_HOURS * 3600 * 1000;
  let sent = 0;

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
  console.log(`Bitti. ${sent} mesaj gönderildi.`);
})();
