#!/usr/bin/env node
/**
 * bersih-invoice-dobel.js
 * ------------------------------------------------------------------
 * Membersihkan invoice DOBEL akibat loop cron (auto-cancel-basi 06:00 vs
 * generate 07:00). Gejala: 1 pelanggan punya banyak invoice 'cancelled'
 * dengan tgl_jatuh_tempo SAMA (mis. 8 cancelled/pelanggan).
 *
 * ATURAN HAPUS (KONSERVATIF — hanya yang jelas sampah):
 *   Kelompokkan invoice per (pelanggan_id, tgl_jatuh_tempo).
 *   Untuk tiap grup yang jml > 1:
 *     - Kalau ada invoice PAID  -> simpan yang PAID (semua), hapus 'cancelled' saja.
 *     - Kalau tidak ada paid    -> simpan 1 invoice AKTIF terbaru
 *                                  (unpaid/overdue) kalau ada; kalau semua
 *                                  cancelled, simpan 1 cancelled TERBARU,
 *                                  hapus cancelled lainnya.
 *   HANYA menghapus baris berstatus 'cancelled'. TIDAK PERNAH menghapus
 *   paid / unpaid / overdue.
 *
 * PENGAMAN:
 *   - DRY-RUN default. --commit untuk eksekusi.
 *   - ⚠️ Grup dgn >=2 PAID (indikasi bayar 2x) DILEWATI + dilaporkan
 *     (perlu tinjauan manual: refund/kredit, JANGAN hapus).
 *   - Backup WAJIB sebelum --commit (lihat langkah di BACA-DULU).
 *
 * Jalankan DI SERVER:
 *   cd /opt/simbill/backend
 *   node bersih-invoice-dobel.js            # dry-run (lihat rencana)
 *   node bersih-invoice-dobel.js --commit   # eksekusi
 * ------------------------------------------------------------------
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const COMMIT = process.argv.includes('--commit');

(async () => {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'billing_radius',
    });
    const q = async (sql, p) => { const [r] = await db.execute(sql, p || []); return r; };

    console.log(`\n=== BERSIH INVOICE DOBEL (loop cron) ===`);
    console.log(`MODE: ${COMMIT ? '🔴 COMMIT (menghapus)' : '🟢 DRY-RUN (tidak menghapus)'}\n`);

    // Ambil grup dobel per (pelanggan, jatuh tempo)
    const grup = await q(`
        SELECT pelanggan_id, tgl_jatuh_tempo, COUNT(*) jml,
               SUM(status='paid') paid, SUM(status='cancelled') cancelled,
               SUM(status IN ('unpaid','overdue')) aktif
        FROM invoice
        WHERE pelanggan_id IS NOT NULL
        GROUP BY pelanggan_id, tgl_jatuh_tempo
        HAVING jml > 1
    `);

    let totalHapus = 0, grupDiproses = 0, grupBayar2x = 0;
    const idHapus = [];
    const bayar2xDetail = [];

    for (const g of grup) {
        // ⚠️ bayar 2x -> lewati, laporkan
        if (g.paid >= 2) {
            grupBayar2x++;
            bayar2xDetail.push(`pel:${g.pelanggan_id} jt:${g.tgl_jatuh_tempo} paid:${g.paid}`);
            continue;
        }

        const rows = await q(`
            SELECT id, no_invoice, status, created_at
            FROM invoice
            WHERE pelanggan_id=? AND tgl_jatuh_tempo=?
            ORDER BY created_at DESC
        `, [g.pelanggan_id, g.tgl_jatuh_tempo]);

        const paid   = rows.filter(r => r.status === 'paid');
        const aktif  = rows.filter(r => r.status === 'unpaid' || r.status === 'overdue');
        const cancel = rows.filter(r => r.status === 'cancelled');

        // Tentukan yang DISIMPAN
        let simpanIds = new Set();
        if (paid.length) {
            paid.forEach(r => simpanIds.add(r.id));          // simpan semua paid
        } else if (aktif.length) {
            simpanIds.add(aktif[0].id);                       // simpan 1 aktif terbaru
        } else if (cancel.length) {
            simpanIds.add(cancel[0].id);                      // semua cancelled -> simpan 1 terbaru
        }

        // HANYA hapus baris 'cancelled' yang TIDAK disimpan
        for (const r of cancel) {
            if (!simpanIds.has(r.id)) { idHapus.push(r.id); totalHapus++; }
        }
        grupDiproses++;
    }

    console.log(`Grup dobel diperiksa      : ${grup.length}`);
    console.log(`Grup diproses             : ${grupDiproses}`);
    console.log(`⚠️  Grup bayar-2x (SKIP)   : ${grupBayar2x}`);
    console.log(`Invoice cancelled ${COMMIT ? 'DIHAPUS' : 'akan dihapus'} : ${totalHapus}`);
    if (bayar2xDetail.length) {
        console.log(`\n⚠️  TINJAU MANUAL (bayar 2x, TIDAK disentuh):`);
        bayar2xDetail.forEach(d => console.log('   ' + d));
    }

    if (COMMIT && idHapus.length) {
        // hapus batch
        const CHUNK = 500;
        for (let i = 0; i < idHapus.length; i += CHUNK) {
            const batch = idHapus.slice(i, i + CHUNK);
            const ph = batch.map(() => '?').join(',');
            await q(`DELETE FROM invoice WHERE id IN (${ph}) AND status='cancelled'`, batch);
        }
        console.log(`\n✅ ${idHapus.length} invoice cancelled dihapus.`);
        console.log(`Verifikasi: jalankan lagi TANPA --commit -> "akan dihapus" harus jauh berkurang/0.`);
    } else if (!COMMIT && idHapus.length) {
        console.log(`\n➡️  DRY-RUN. Contoh 10 id yg akan dihapus: ${idHapus.slice(0,10).join(', ')}`);
        console.log(`Eksekusi: node bersih-invoice-dobel.js --commit`);
    }

    await db.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
