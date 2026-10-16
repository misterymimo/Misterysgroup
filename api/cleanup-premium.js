// Vercel Cron: tiap hari cek user yang premiumnya sudah habis.
// Kalau grup > 1 dan masa tenggang lewat -> sisakan 1 grup (rating tertinggi), sisanya dihapus.
//
// Env yang dibutuhkan (Vercel > Settings > Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT = isi JSON service account Firebase (satu baris)
//   CRON_SECRET              = string acak panjang (Vercel otomatis mengirimnya saat cron jalan)
// Tes manual tanpa menghapus:  GET /api/cleanup-premium?dry=1  dengan header Authorization: Bearer <CRON_SECRET>

const admin = require('firebase-admin');

const GRACE_MS = 3 * 24 * 60 * 60 * 1000; // harus sama dengan di grupai.html & admin.html

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

function safeId(k) { return k.replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 200); }
// Sama persis dengan linkKeyOf di grupai.html
function linkKeyOf(raw) {
  let u = (raw || '').trim();
  if (!u) return '';
  try {
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'chat.whatsapp.com' && parts[0]) return safeId('wa:' + parts[0]);
    if (host === 't.me' || host === 'telegram.me') {
      if (parts[0] === 'joinchat' && parts[1]) return safeId('tg:' + parts[1]);
      if (parts[0] && parts[0].startsWith('+')) return safeId('tg:' + parts[0].slice(1));
      if (parts[0]) return safeId('tg:' + parts[0].toLowerCase());
    }
    return safeId(host + url.pathname.replace(/\/+$/, ''));
  } catch (e) { return safeId(u.toLowerCase()); }
}

async function rankByRating(groups) {
  await Promise.all(groups.map(async (g) => {
    const rs = await db.collection('groups').doc(g.id).collection('ratings').get();
    const v = rs.docs.map((r) => r.data().value).filter((x) => typeof x === 'number');
    g._avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    g._votes = v.length;
  }));
  return groups.sort((a, b) => (b._avg - a._avg) || (b._votes - a._votes) || ((a.createdAt || 0) - (b.createdAt || 0)));
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const dry = req.query && (req.query.dry === '1' || req.query.dry === 'true');

  try {
    const now = Date.now();
    const [gSnap, pSnap] = await Promise.all([
      db.collection('groups').get(),
      db.collection('premiumUsers').get(),
    ]);

    const premium = new Map(); // email -> data
    pSnap.docs.forEach((d) => premium.set(d.id, d.data()));

    const byOwner = new Map();
    gSnap.docs.forEach((d) => {
      const g = { id: d.id, ...d.data() };
      if (!g.ownerId || !g.ownerEmail) return;
      if (!byOwner.has(g.ownerId)) byOwner.set(g.ownerId, []);
      byOwner.get(g.ownerId).push(g);
    });

    const report = { notified: 0, deletedGroups: 0, waiting: 0, users: [] };

    for (const [uid, list] of byOwner) {
      if (list.length <= 1) continue;
      const email = list[0].ownerEmail;
      const p = premium.get(email);
      const active = !!p && (!p.expiresAt || p.expiresAt > now);
      const userRef = db.collection('users').doc(uid);

      if (active) { // premium aktif lagi -> batalkan proses kalau ada
        if (!dry) {
          const u = await userRef.get();
          if (u.exists && u.data().downgradeDeadline) await userRef.set({ downgradeDeadline: null }, { merge: true });
        }
        continue;
      }

      const uSnap = await userRef.get();
      let deadline = uSnap.exists ? uSnap.data().downgradeDeadline : null;
      let freshDeadline = false;
      if (!deadline) {
        // premium sudah lama habis -> masa tenggang dihitung dari tanggal kedaluwarsa
        deadline = (p && p.expiresAt) ? p.expiresAt + GRACE_MS : now + GRACE_MS;
        freshDeadline = true;
      }

      if (now <= deadline) {
        if (freshDeadline && !dry) {
          await userRef.set({ downgradeDeadline: deadline }, { merge: true });
          await db.collection('messages').add({
            toEmail: email,
            text: 'Masa aktif premium kamu sudah habis. Paket gratis hanya boleh 1 grup, sedangkan kamu punya ' + list.length +
              ' grup. Pilih 1 grup yang mau dipertahankan sebelum ' + new Date(deadline).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) +
              '. Kalau belum dipilih sampai batas waktu, grup dengan rating tertinggi yang dipertahankan dan sisanya dihapus otomatis.',
            createdAt: now, read: false, isDowngradeNotice: true, deadline,
          });
        }
        if (freshDeadline) report.notified++; else report.waiting++;
        continue;
      }

      // Masa tenggang lewat -> sisakan grup rating tertinggi
      await rankByRating(list);
      const keep = list[0];
      const toDelete = list.slice(1);
      report.users.push({ email, keep: keep.title, deleted: toDelete.map((g) => g.title) });

      if (!dry) {
        for (const g of toDelete) {
          const k = g.linkKey || linkKeyOf(g.link);
          if (k) {
            const lRef = db.collection('groupLinks').doc(k);
            const l = await lRef.get();
            if (l.exists && l.data().groupId === g.id) await lRef.delete();
          }
          await db.recursiveDelete(db.collection('groups').doc(g.id)); // termasuk subkoleksi ratings
        }
        await userRef.set({ downgradeDeadline: null }, { merge: true });
      }
      report.deletedGroups += toDelete.length;
    }

    return res.status(200).json({ ok: true, dry: !!dry, ...report });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
