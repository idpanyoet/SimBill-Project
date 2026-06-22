#!/usr/bin/env node
/**
 * restore-radcheck.js — Pulihkan Cleartext-Password yang hilang di radcheck
 * untuk pelanggan PPPoE/hotspot yang status='aktif', dengan men-decrypt
 * radius_password_enc (lewat aktifkanUser yang sudah ada).
 *
 * Pakai:
 *   cd /opt/simbill/backend && node restore-radcheck.js          # jalankan
 *   cd /opt/simbill/backend && node restore-radcheck.js --dry    # cek saja
 *
 * Aman diulang (idempotent): user yang radcheck-nya sudah ada akan dilewati.
 */
require('dotenv').config();
const { query } = require('./config/db');
const radius = require('./services/radius');

const DRY = process.argv.includes('--dry');

(async () => {
    // Pelanggan AKTIF yang TIDAK punya Cleartext-Password di radcheck
    const korban = await query(`
        SELECT p.username,
               (p.radius_password_enc IS NOT NULL) AS ada_enc
        FROM pelanggan p
        WHERE p.status='aktif'
          AND p.username IS NOT NULL AND p.username<>''
          AND NOT EXISTS (
              SELECT 1 FROM radcheck r
              WHERE r.username=p.username AND r.attribute='Cleartext-Password'
          )
        ORDER BY p.username
    `);

    if (!korban.length) {
        console.log('✔ Semua pelanggan aktif sudah punya password di radcheck. Tidak ada yang perlu dipulihkan.');
        process.exit(0);
    }

    const bisa  = korban.filter(k => k.ada_enc);
    const gagal = korban.filter(k => !k.ada_enc);

    console.log(`Ditemukan ${korban.length} pelanggan aktif tanpa Cleartext-Password:`);
    console.log(`  • bisa dipulihkan (punya enc): ${bisa.length}`);
    console.log(`  • TIDAK bisa (enc kosong)    : ${gagal.length}`);
    if (gagal.length) {
        console.log('    → perlu reset password manual:', gagal.map(g => g.username).join(', '));
    }

    if (DRY) {
        console.log('\n[DRY RUN] Tidak ada perubahan ditulis. Jalankan tanpa --dry untuk memulihkan.');
        process.exit(0);
    }

    let ok = 0, err = 0;
    for (const k of bisa) {
        try {
            await radius.aktifkanUser(k.username);   // decrypt enc → isi radcheck
            ok++;
        } catch (e) {
            err++;
            console.error(`  ✘ gagal ${k.username}: ${e.message}`);
        }
    }
    console.log(`\n✔ Selesai. Dipulihkan: ${ok}. Gagal: ${err}. Tak bisa (enc kosong): ${gagal.length}.`);
    process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
