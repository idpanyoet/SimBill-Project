#!/usr/bin/env node
/**
 * sync_masa_aktif.js
 * Sinkronisasi masa aktif (kolom NEXT SUSPEND dari billing lama) ke SimBill.
 *
 * Default = DRY RUN (tidak mengubah apa pun, cuma menampilkan rencana).
 * Tambahkan --commit untuk benar-benar meng-UPDATE.
 *
 * Jalankan dari /opt/simbill (atau folder mana pun, asal CSV ada di sebelahnya):
 *   node sync_masa_aktif.js                 # dry run
 *   node sync_masa_aktif.js --commit        # eksekusi
 *   node sync_masa_aktif.js --strip-domain  # cocokkan username tanpa @rfnet/@spu
 *
 * DB creds dibaca dari environment / .env SimBill.
 */

const fs = require('fs');
const path = require('path');

// ====== KONFIGURASI — sesuaikan kalau perlu ======
const CFG = {
  CSV_FILE:   path.join(__dirname, 'masa_aktif_clean.csv'),
  TABLE:      'customers',     // <-- ganti kalau nama tabel pelanggan beda
  COL_USER:   'username',      // <-- kolom username
  COL_MASA:   'masa_aktif',    // <-- kolom masa aktif / expired
  TIME_SUFFIX:'',              // mis. ' 23:59:59' kalau kolomnya DATETIME & mau jam tertentu
  DB: {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'billing_radius',
    port: Number(process.env.DB_PORT || 3306),
  },
};
// =================================================

const COMMIT = process.argv.includes('--commit');
const STRIP  = process.argv.includes('--strip-domain');

let mysql;
try { mysql = require('mysql2/promise'); }
catch { console.error('❌ Butuh mysql2. Jalankan: npm i mysql2 (di folder ini atau /opt/simbill)'); process.exit(1); }

function parseCSV(file) {
  const txt = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  const lines = txt.split('\n').filter(l => l.trim());
  lines.shift(); // buang header
  const out = [];
  for (const ln of lines) {
    const [username, nama, masa] = ln.split(',');
    if (!username || !masa) continue;
    out.push({ username: username.trim(), nama: (nama||'').trim(), masa: masa.trim() });
  }
  return out;
}
const key = u => STRIP ? u.split('@')[0].toLowerCase() : u.toLowerCase();

(async () => {
  const data = parseCSV(CFG.CSV_FILE);
  console.log(`\n📄 CSV: ${data.length} baris masa aktif dibaca`);
  console.log(`🎯 Target: ${CFG.DB.database}.${CFG.TABLE} (${CFG.COL_USER} → ${CFG.COL_MASA})`);
  console.log(`🔧 Mode: ${COMMIT ? '⚠️  COMMIT (akan mengubah DB)' : 'DRY RUN (aman, tidak mengubah apa pun)'}` +
              `${STRIP ? '  | match tanpa domain' : ''}\n`);

  const db = await mysql.createConnection(CFG.DB);

  // Ambil semua pelanggan yang ada di DB
  const [rowsDb] = await db.execute(
    `SELECT \`${CFG.COL_USER}\` AS u, \`${CFG.COL_MASA}\` AS m FROM \`${CFG.TABLE}\``
  );
  const dbMap = new Map();
  for (const r of rowsDb) dbMap.set(key(String(r.u)), r);

  const toFmt = d => (d == null ? '(kosong)' : String(d).slice(0, 10));
  const changes = [], unchanged = [], notFound = [];

  for (const row of data) {
    const hit = dbMap.get(key(row.username));
    if (!hit) { notFound.push(row); continue; }
    const cur = hit.m == null ? '' : String(hit.m).slice(0, 10);
    if (cur === row.masa) unchanged.push(row);
    else changes.push({ ...row, from: cur });
  }

  console.log('────────────────────────────────────────');
  console.log(`✅ Ketemu & berubah : ${changes.length}`);
  console.log(`➖ Ketemu, sama     : ${unchanged.length}`);
  console.log(`❓ TIDAK ketemu DB  : ${notFound.length}`);
  console.log('────────────────────────────────────────\n');

  if (changes.length) {
    console.log('PERUBAHAN:');
    for (const c of changes)
      console.log(`  ${c.username.padEnd(24)} ${toFmt(c.from).padEnd(12)} →  ${c.masa}   [${c.nama}]`);
    console.log('');
  }
  if (notFound.length) {
    console.log('⚠️  TIDAK KETEMU di DB (username beda / belum ke-migrasi). CEK INI:');
    for (const n of notFound) console.log(`  - ${n.username}   [${n.nama}]`);
    console.log('  (kalau SimBill simpan username tanpa @rfnet, coba jalankan ulang dengan --strip-domain)\n');
  }

  if (!COMMIT) {
    console.log('💡 Ini DRY RUN. Kalau sudah yakin, jalankan lagi dengan:  node sync_masa_aktif.js --commit');
    await db.end();
    return;
  }

  // ===== COMMIT =====
  console.log('⚙️  Menjalankan UPDATE dalam transaksi...');
  await db.beginTransaction();
  let ok = 0;
  try {
    for (const c of changes) {
      const val = c.masa + CFG.TIME_SUFFIX;
      const [res] = await db.execute(
        STRIP
          ? `UPDATE \`${CFG.TABLE}\` SET \`${CFG.COL_MASA}\`=? WHERE LOWER(SUBSTRING_INDEX(\`${CFG.COL_USER}\`,'@',1))=?`
          : `UPDATE \`${CFG.TABLE}\` SET \`${CFG.COL_MASA}\`=? WHERE LOWER(\`${CFG.COL_USER}\`)=?`,
        [val, key(c.username)]
      );
      ok += res.affectedRows;
    }
    await db.commit();
    console.log(`\n✅ SELESAI. ${ok} baris ter-update.`);
  } catch (e) {
    await db.rollback();
    console.error('\n❌ ERROR — rollback, tidak ada yang berubah:', e.message);
  }
  await db.end();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
