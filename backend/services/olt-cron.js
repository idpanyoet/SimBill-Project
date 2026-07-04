'use strict';
/**
 * services/olt-cron.js — Sync match ONU<->pelanggan terjadwal (harian)
 *
 * Aktifkan di server.js dengan SATU baris (lihat BACA-DULU.txt):
 *   require('./services/olt-cron').start();
 * atau atur jam:
 *   require('./services/olt-cron').start({ hour: 3, minute: 15 });
 *
 * Tanpa dependency baru. Cek tiap menit, jalan 1x/hari pada jam WIB yang diset.
 * Status tagihan TIDAK butuh ini (sudah live); ini cuma refresh mapping.
 */

const olt = require('./olt');

// Jam:menit di zona Asia/Jakarta, lepas dari TZ server (VPS bisa UTC)
function jakartaHM() {
  const s = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [h, m] = s.split(':').map(Number);
  return { h, m };
}
function jakartaDate() {
  // YYYY-MM-DD versi Jakarta (buat guard 1x/hari)
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

let timer = null;

function start(opts = {}) {
  const hour = opts.hour ?? 3;          // default 03:15 WIB
  const minute = opts.minute ?? 15;
  const fetchNames = opts.fetchNames ?? true; // true = match pakai Name (lengkap)
  let lastRun = null;

  if (timer) clearInterval(timer);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  console.log(`[OLT-CRON] Aktif | sync match harian ${hh}:${mm} WIB`);

  timer = setInterval(async () => {
    const { h, m } = jakartaHM();
    const today = jakartaDate();
    if (h === hour && m === minute && lastRun !== today) {
      lastRun = today;
      let olts = [];
      try { olts = olt.listOlts(); } catch (e) { console.error('[OLT-CRON] listOlts gagal:', e.message); return; }
      for (const o of olts) {
        try {
          const s = await olt.syncMatch(o.id, { fetchNames });
          console.log(`[OLT-CRON] ${o.id} OK | matched=${(s.sn + s.username + s.nama + s.manual)}/${s.total} unmatched=${s.unmatched}`);
        } catch (e) {
          console.error(`[OLT-CRON] ${o.id} GAGAL:`, e.message);
        }
      }
    }
  }, 60 * 1000);

  // jangan tahan proses kalau ini satu-satunya timer (aman utk pm2)
  if (timer.unref) timer.unref();
  return timer;
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop };
