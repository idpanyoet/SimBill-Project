// services/cron.js — Otomasi: reminder, suspend, generate invoice
const cron  = require('node-cron');
const dayjs = require('dayjs');
const { query } = require('../config/db');
const waService     = require('./whatsapp');
const radiusService = require('./radius');

const REMINDER_H = parseInt(process.env.REMINDER_H_MINUS) || 3;
const SUSPEND_H  = parseInt(process.env.SUSPEND_H_PLUS)   || 3;

// Ambil nilai dari tabel setting (runtime). Fallback ke env/default.
// Dipakai agar admin bisa atur lewat halaman Setting tanpa restart/.env.
async function getSetting(kunci, def) {
    try {
        const r = await query(`SELECT nilai FROM setting WHERE kunci=? LIMIT 1`, [kunci]);
        if (r && r[0] && r[0].nilai !== null && String(r[0].nilai).trim() !== '') return r[0].nilai;
    } catch (e) {}
    return def;
}
// True jika otomasi aktif (default aktif bila setting belum ada).
async function otomasiAktif(kunci) {
    const v = await getSetting(kunci, '1');
    return String(v) !== '0';
}
function _hari(v, def) { const n = parseInt(v, 10); return isNaN(n) ? def : n; }

console.log(`[CRON] Scheduler aktif | Reminder H-${REMINDER_H} | Suspend H+${SUSPEND_H}`);

// Tandai voucher 'used' dari radacct + expire voucher habis, setiap 15 menit
cron.schedule('*/15 * * * *', async () => {
    try {
        const n = await radiusService.syncStatusVoucher();
        if (n > 0) console.log(`[CRON] ${n} voucher ditandai used`);
        // Expire voucher yang masa aktifnya habis (dihitung dari login pertama)
        const e = await radiusService.expireVoucherHabis();
        if (e > 0) console.log(`[CRON] ${e} voucher expired (masa aktif habis)`);
    } catch (e) {
        console.error('[CRON] Error sync/expire voucher:', e.message);
    }
});

// Refresh "Session Time Left" voucher used setiap 5 menit (akurasi countdown
// lintas reconnect). Operasi ringan: hanya UPDATE radreply Session-Timeout =
// sisa detik (tgl_digunakan + masa - sekarang).
cron.schedule('*/5 * * * *', async () => {
    try {
        await radiusService.refreshSisaSessionTimeout();
    } catch (e) {
        console.error('[CRON] Error refresh sisa Session-Timeout:', e.message);
    }
});

// Hapus voucher expired yang sudah melewati masa simpan 90 hari — harian 03:00
cron.schedule('0 3 * * *', async () => {
    console.log('[CRON] Bersihkan voucher expired lama (>90 hari)...');
    try {
        const h = await radiusService.hapusVoucherExpiredLama();
        if (h > 0) console.log(`[CRON] ${h} voucher expired lama dihapus`);
    } catch (e) {
        console.error('[CRON] Error hapus voucher expired lama:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

// ============================================================
// 1. KIRIM REMINDER TAGIHAN (setiap hari jam 08:00 WIB)
// ============================================================
cron.schedule('0 8 * * *', async () => {
    if (!(await otomasiAktif('auto_reminder'))) return;
    console.log('[CRON] Mulai kirim reminder tagihan...');
    try {
        const H = _hari(await getSetting('reminder_h', REMINDER_H), REMINDER_H);
        const targetDate = dayjs().add(H, 'day').format('YYYY-MM-DD');

        const invoices = await query(`
            SELECT i.id AS invoice_id, i.no_invoice, i.jumlah, i.tgl_jatuh_tempo, i.payment_url,
                p.nama, p.no_hp, p.id AS pelanggan_id
            FROM invoice i
            JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE i.status = 'unpaid'
            AND i.tgl_jatuh_tempo = ?
            AND (p.tgl_expired IS NULL OR DATE(p.tgl_expired) <= i.tgl_jatuh_tempo)
        `, [targetDate]);

        let terkirim = 0;
        for (const inv of invoices) {
            await waService.kirimReminder(inv);
            terkirim++;
            await _delay(1000);
        }

        console.log(`[CRON] Reminder terkirim: ${terkirim} pesan`);
    } catch (e) {
        console.error('[CRON] Error reminder:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

// ============================================================
// 2. AUTO-SUSPEND PELANGGAN TELAT BAYAR (setiap hari jam 09:00)
// ============================================================
cron.schedule('0 9 * * *', async () => {
    if (!(await otomasiAktif('auto_suspend'))) return;
    console.log('[CRON] Cek auto-suspend...');
    try {
        const H = _hari(await getSetting('suspend_h', SUSPEND_H), SUSPEND_H);
        const batasDate = dayjs().subtract(H, 'day').format('YYYY-MM-DD');

        // Update status invoice ke overdue
        await query(`
            UPDATE invoice SET status = 'overdue'
            WHERE status = 'unpaid' AND tgl_jatuh_tempo < CURDATE()
        `);

        // Cari pelanggan yang invoice-nya sudah lewat H+N.
        // GATE: hanya suspend yang BENAR-BENAR sudah lewat masa aktif
        // (tgl_expired < hari ini). Pelanggan yang tgl_expired-nya masih di masa
        // depan (mis. sudah bayar periode berikutnya, invoice lama "basi") TIDAK
        // ikut tersuspend. VIP (tgl_expired NULL) juga aman.
        const pelanggan = await query(`
            SELECT DISTINCT p.id, p.username, p.nama, p.no_hp
            FROM invoice i
            JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE i.status = 'overdue'
            AND i.tgl_jatuh_tempo <= ?
            AND p.status = 'aktif'
            AND DATE(p.tgl_expired) < CURDATE()
            AND (p.periode IS NULL OR p.periode <> 'kalender')
        `, [batasDate]);

        let suspended = 0;
        for (const p of pelanggan) {
            try {
                await query(`UPDATE pelanggan SET status='suspended' WHERE id=?`, [p.id]);
                await radiusService.suspendUser(p.username);
                await waService.kirimSuspend(p);
                suspended++;
                await _delay(1500);
            } catch (err) {
                console.error(`[CRON] Gagal suspend ${p.username}:`, err.message);
            }
        }

        console.log(`[CRON] Auto-suspend: ${suspended} pelanggan`);
    } catch (e) {
        console.error('[CRON] Error suspend:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

// ============================================================
// 1b. AUTO-SUSPEND BERDASARKAN MASA AKTIF (tgl_expired lewat)
//     Setiap jam — pelanggan yang tgl_expired-nya sudah lewat → suspend/isolir,
//     tidak peduli ada invoice atau tidak. Ini enforcement masa aktif.
// ============================================================
cron.schedule('5 * * * *', async () => {
    if (!(await otomasiAktif('auto_suspend'))) return;
    console.log('[CRON] Cek masa aktif (tgl_expired)...');
    try {
        // Pelanggan AKTIF yang tgl_expired sudah lewat (< hari ini)
        const expired = await query(`
            SELECT id, username, nama, no_hp
            FROM pelanggan
            WHERE status = 'aktif'
            AND tgl_expired IS NOT NULL
            AND tgl_expired < CURDATE()
            AND (periode IS NULL OR periode <> 'kalender')
        `);

        let n = 0;
        for (const p of expired) {
            try {
                await query(`UPDATE pelanggan SET status='suspended' WHERE id=?`, [p.id]);
                await radiusService.suspendUser(p.username);
                try { await waService.kirimSuspend(p); } catch (_) {}
                n++;
                await _delay(1500);
            } catch (err) {
                console.error(`[CRON] Gagal suspend (expired) ${p.username}:`, err.message);
            }
        }
        if (n > 0) console.log(`[CRON] Suspend masa aktif lewat: ${n} pelanggan`);
    } catch (e) {
        console.error('[CRON] Error cek masa aktif:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

// ============================================================
// 3. GENERATE INVOICE — H-3 SEBELUM tgl_expired tiap pelanggan
//    (setiap hari jam 07:00). Jatuh tempo invoice = tgl_expired pelanggan.
//    Ini menggantikan generate "tanggal 1 + akhir bulan" agar tagihan sinkron
//    dengan masa aktif masing-masing pelanggan.
// ============================================================
const INVOICE_GEN_H = parseInt(process.env.INVOICE_GEN_H_MINUS) || 3;

cron.schedule('0 7 * * *', async () => {
    if (!(await otomasiAktif('auto_generate_invoice'))) return;
    const H = _hari(await getSetting('invoice_gen_h', INVOICE_GEN_H), INVOICE_GEN_H);
    console.log(`[CRON] Generate invoice H-${H} sebelum expired...`);
    try {
        await _generateInvoiceJelangExpired(H);
    } catch (e) {
        console.error('[CRON] Error generate invoice (expired):', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

// Generate invoice untuk pelanggan yang tgl_expired-nya = hari ini + H
// (mis. H=3 → yang akan expired 3 hari lagi). Jatuh tempo = tgl_expired.
async function _generateInvoiceJelangExpired(Hparam) {
    const paymentService = require('./payment');
    const { queryOne, withTransaction, generateUniqueInvoiceNo } = require('../config/db');
    const dayjs = require('dayjs');
    const INVOICE_PREFIX = process.env.INVOICE_PREFIX || 'INV';
    const H = (typeof Hparam === 'number') ? Hparam : INVOICE_GEN_H;

    const tahun = dayjs().format('YYYY');
    // Target: pelanggan aktif yang tgl_expired-nya dalam <= H hari ke depan
    // (>= hari ini), supaya yang terlewat (mis. cron sempat mati) tetap kebuat.
    const batasAtas = dayjs().add(H, 'day').format('YYYY-MM-DD');

    const pelanggan = await query(`
        SELECT pl.*, pk.harga, pk.id AS paket_id, pk.nama AS nama_paket, pk.masa_aktif, pk.satuan_masa
        FROM pelanggan pl
        JOIN paket pk ON pl.paket_id = pk.id
        WHERE pl.status = 'aktif'
          AND pl.tgl_expired IS NOT NULL
          AND DATE(pl.tgl_expired) >= CURDATE()
          AND DATE(pl.tgl_expired) <= ?
          AND (pl.siklus IS NULL OR pl.siklus <> 'prepaid')
          AND (pl.periode IS NULL OR pl.periode <> 'kalender')
    `, [batasAtas]);

    let berhasil = 0;
    for (const p of pelanggan) {
        try {
            // Paket gratis (harga 0, mis. VIP) tidak ditagih.
            if (!p.harga || Number(p.harga) <= 0) continue;

            const tglJatuh = dayjs(p.tgl_expired).format('YYYY-MM-DD');

            // Cegah duplikat tagihan.
            // - Paket BULANAN: cukup ada 1 invoice belum-lunas dalam BULAN yang sama
            //   (mencegah dobel walau tgl_expired bergeser beberapa hari dalam bulan itu).
            // - Paket harian/jam: tetap cek tanggal persis (siklus pendek, boleh >1/bulan).
            let ada;
            if (String(p.satuan_masa || '').toLowerCase() === 'bulan') {
                // Paket bulanan: JANGAN buat tagihan periode baru selama pelanggan
                // masih punya invoice unpaid/overdue (periode mana pun). Mencegah
                // tagihan menumpuk / invoice "basi" saat tgl_expired bergeser.
                ada = await queryOne(`
                    SELECT id FROM invoice
                    WHERE pelanggan_id = ?
                      AND status IN ('unpaid','overdue')
                    LIMIT 1
                `, [p.id]);
            } else {
                ada = await queryOne(`
                    SELECT id FROM invoice
                    WHERE pelanggan_id = ?
                      AND status IN ('unpaid','overdue')
                      AND DATE(tgl_jatuh_tempo) = ?
                    LIMIT 1
                `, [p.id, tglJatuh]);
            }
            if (ada) continue;

            const { no_invoice, result } = await withTransaction(db =>
                generateUniqueInvoiceNo(db, INVOICE_PREFIX, tahun, (noInv) =>
                    db.query(`
                        INSERT INTO invoice (no_invoice, pelanggan_id, paket_id, jumlah,
                            tgl_invoice, tgl_jatuh_tempo)
                        VALUES (?,?,?,?,CURDATE(),?)
                    `, [noInv, p.id, p.paket_id, p.harga, tglJatuh])
                )
            );

            const pg = await paymentService.buatTransaksi({
                order_id: no_invoice, gross_amount: p.harga, pelanggan: p
            }).catch(err => {
                console.warn(`[CRON] Payment gateway gagal untuk ${no_invoice}:`, err.message);
                return null;
            });

            if (pg?.payment_url) {
                await query(`UPDATE invoice SET payment_id=?, payment_url=? WHERE id=?`,
                    [pg.order_id, pg.payment_url, result.insertId]);
            }

            berhasil++;

            try {
                await waService.kirimLinkBayar(p, {
                    no_invoice, jumlah: p.harga,
                    tgl_jatuh_tempo: tglJatuh, payment_url: pg?.payment_url
                });
            } catch (waErr) {
                console.warn(`[CRON] Kirim WA gagal untuk ${p.username}:`, waErr.message);
            }

            await _delay(1000);
        } catch (err) {
            console.error(`[CRON] Invoice gagal ${p.username}:`, err.message);
        }
    }

    console.log(`[CRON] Invoice jelang expired (H-${H}) dibuat: ${berhasil} dari ${pelanggan.length}`);
}

// ============================================================
// 3b. MODE KALENDER (siklus billing per bulan)
//     Pelanggan periode='kalender': invoice dibuat pada TANGGAL yang diatur ISP
//     (setting billing_tgl_invoice), jatuh tempo = TANGGAL ISOLIR (billing_tgl_isolir).
//     Belum bayar sampai tgl isolir -> di-suspend. Terpisah dari alur "tetap".
// ============================================================
async function _generateInvoiceKalender() {
    const paymentService = require('./payment');
    const { queryOne, withTransaction, generateUniqueInvoiceNo } = require('../config/db');
    const dayjs = require('dayjs');
    const INVOICE_PREFIX = process.env.INVOICE_PREFIX || 'INV';
    const tahun = dayjs().format('YYYY');
    const bulanIni = dayjs().format('YYYY-MM');
    const tglIsolir = _hari(await getSetting('billing_tgl_isolir', 5), 5);
    const akhirBln = dayjs().endOf('month').date();
    const tglJatuh = dayjs().date(Math.min(tglIsolir, akhirBln)).format('YYYY-MM-DD');

    const pelanggan = await query(`
        SELECT pl.*, pk.harga, pk.id AS paket_id, pk.nama AS nama_paket
        FROM pelanggan pl JOIN paket pk ON pl.paket_id = pk.id
        WHERE pl.status IN ('aktif','suspended')
          AND pl.periode = 'kalender'
          AND (pl.siklus IS NULL OR pl.siklus <> 'prepaid')
    `);

    let berhasil = 0;
    for (const p of pelanggan) {
        try {
            if (!p.harga || Number(p.harga) <= 0) continue;   // paket gratis/VIP tak ditagih
            // Cegah dobel: sudah ada invoice untuk BULAN ini?
            const ada = await queryOne(`
                SELECT id FROM invoice
                WHERE pelanggan_id = ? AND DATE_FORMAT(tgl_invoice,'%Y-%m') = ?
                LIMIT 1
            `, [p.id, bulanIni]);
            if (ada) continue;

            const { no_invoice, result } = await withTransaction(db =>
                generateUniqueInvoiceNo(db, INVOICE_PREFIX, tahun, (noInv) =>
                    db.query(`
                        INSERT INTO invoice (no_invoice, pelanggan_id, paket_id, jumlah,
                            tgl_invoice, tgl_jatuh_tempo)
                        VALUES (?,?,?,?,CURDATE(),?)
                    `, [noInv, p.id, p.paket_id, p.harga, tglJatuh])
                )
            );

            const pg = await paymentService.buatTransaksi({
                order_id: no_invoice, gross_amount: p.harga, pelanggan: p
            }).catch(err => { console.warn(`[CRON] PG gagal ${no_invoice}:`, err.message); return null; });
            if (pg?.payment_url) {
                await query(`UPDATE invoice SET payment_id=?, payment_url=? WHERE id=?`,
                    [pg.order_id, pg.payment_url, result.insertId]);
            }
            berhasil++;
            try {
                await waService.kirimLinkBayar(p, { no_invoice, jumlah: p.harga, tgl_jatuh_tempo: tglJatuh, payment_url: pg?.payment_url });
            } catch (waErr) { console.warn(`[CRON] WA kalender gagal ${p.username}:`, waErr.message); }
            await _delay(1000);
        } catch (err) {
            console.error(`[CRON] Invoice kalender gagal ${p.username}:`, err.message);
        }
    }
    console.log(`[CRON] Invoice KALENDER dibuat: ${berhasil} dari ${pelanggan.length}`);
}

// Isolir pelanggan kalender yang invoice bulan ini belum lunas & lewat jatuh tempo.
async function _isolirKalender() {
    await query(`UPDATE invoice SET status='overdue' WHERE status='unpaid' AND tgl_jatuh_tempo < CURDATE()`);
    const pelanggan = await query(`
        SELECT DISTINCT p.id, p.username, p.nama, p.no_hp
        FROM invoice i JOIN pelanggan p ON i.pelanggan_id = p.id
        WHERE p.periode = 'kalender' AND p.status = 'aktif'
          AND i.status IN ('unpaid','overdue')
          AND i.tgl_jatuh_tempo < CURDATE()
    `);
    let n = 0;
    for (const p of pelanggan) {
        try {
            await query(`UPDATE pelanggan SET status='suspended' WHERE id=?`, [p.id]);
            await radiusService.suspendUser(p.username);
            try { await waService.kirimSuspend(p); } catch (_) {}
            n++; await _delay(1500);
        } catch (err) { console.error(`[CRON] Gagal isolir kalender ${p.username}:`, err.message); }
    }
    if (n > 0) console.log(`[CRON] Isolir KALENDER: ${n} pelanggan`);
}

// Cron: generate invoice kalender pada tanggal yang diatur ISP (harian jam 07:10)
cron.schedule('10 7 * * *', async () => {
    if (!(await otomasiAktif('auto_generate_invoice'))) return;
    try {
        const dayjs = require('dayjs');
        const tglGen = _hari(await getSetting('billing_tgl_invoice', 1), 1);
        const akhir = dayjs().endOf('month').date();
        if (dayjs().date() !== Math.min(tglGen, akhir)) return;   // hanya di tanggal invoice
        console.log('[CRON] Generate invoice KALENDER (tgl invoice)...');
        await _generateInvoiceKalender();
    } catch (e) { console.error('[CRON] Error invoice kalender:', e.message); }
}, { timezone: 'Asia/Jakarta' });

// Cron: isolir kalender (harian jam 09:10) — jalan tiap hari, efektif mulai tgl isolir
cron.schedule('10 9 * * *', async () => {
    if (!(await otomasiAktif('auto_suspend'))) return;
    try { await _isolirKalender(); }
    catch (e) { console.error('[CRON] Error isolir kalender:', e.message); }
}, { timezone: 'Asia/Jakarta' });

// ============================================================
// 4. HAPUS LOG WA LAMA (setiap minggu Minggu jam 02:00)
// ============================================================
cron.schedule('0 2 * * 0', async () => {
    try {
        const result = await query(
            `DELETE FROM wa_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`
        );
        console.log(`[CRON] Hapus log WA lama: ${result.affectedRows} baris`);

        // Bersihkan file PDF invoice lama (>7 hari) — privasi & hemat disk
        try {
            const n = require('./invoice-pdf').bersihkanPdfLama(7);
            if (n > 0) console.log(`[CRON] Hapus ${n} PDF invoice lama`);
        } catch (e) { /* modul/folder belum ada — abaikan */ }
    } catch (e) {
        console.error('[CRON] Error hapus log:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

// ============================================================
// 4b. AUTO-CANCEL INVOICE BASI (setiap hari 06:00 WIB)
//     Invoice unpaid/overdue milik pelanggan AKTIF yang tgl_expired-nya
//     sudah MELEWATI tgl_jatuh_tempo invoice tsb = periode invoice itu sudah
//     dilewati (pelanggan sudah diperpanjang melampaui jatuh tempo) -> invoice
//     "basi". Ditandai 'cancelled' supaya:
//       - tidak lagi ikut reminder / menumpuk sebagai "belum lunas"
//       - tidak memblok generate invoice periode baru (dedup unpaid/overdue)
//     Dijalankan SEBELUM cron reminder (08:00) agar data bersih lebih dulu.
//     Dikawal setting 'auto_cancel_basi' (default AKTIF; set '0' utk matikan).
//     Catatan: syarat > (bukan >=) jadi invoice yg jatuh tempo TEPAT di
//     tgl_expired (mis. tagihan siklus berjalan) TIDAK ikut di-cancel.
// ============================================================
cron.schedule('0 6 * * *', async () => {
    if (!(await otomasiAktif('auto_cancel_basi'))) return;
    try {
        const basi = await query(`
            SELECT i.id, i.no_invoice, i.pelanggan_id, i.tgl_jatuh_tempo,
                   p.nama, p.tgl_expired
            FROM invoice i
            JOIN pelanggan p ON p.id = i.pelanggan_id
            WHERE i.status IN ('unpaid','overdue')
              AND p.status = 'aktif'
              AND p.tgl_expired IS NOT NULL
              AND DATE(p.tgl_expired) > DATE(i.tgl_jatuh_tempo)
        `);
        if (!basi.length) return;

        const ids = basi.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(',');
        await query(`UPDATE invoice SET status='cancelled' WHERE id IN (${placeholders})`, ids);

        const detail = basi
            .map((r) => `${r.no_invoice} (pel:${r.pelanggan_id} ${r.nama}, jt:${dayjs(r.tgl_jatuh_tempo).format('YYYY-MM-DD')}, exp:${dayjs(r.tgl_expired).format('YYYY-MM-DD')})`)
            .join('; ');
        try {
            await query(
                `INSERT INTO admin_log (kategori, pelaku, aksi, target, detail) VALUES (?,?,?,?,?)`,
                ['System', 'CRON', 'auto_cancel_invoice_basi', `${ids.length} invoice`, detail.slice(0, 60000)]
            );
        } catch (e) { /* tabel admin_log belum ada — abaikan */ }

        console.log(`[CRON] Auto-cancel invoice basi: ${ids.length} invoice -> cancelled`);
    } catch (e) {
        console.error('[CRON] Error auto-cancel invoice basi:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

// ============================================================
// 5. CRON H-1: REMINDER TERAKHIR (jam 10:00)
// ============================================================
cron.schedule('0 10 * * *', async () => {
    if (!(await otomasiAktif('auto_reminder'))) return;
    try {
        const besok = dayjs().add(1, 'day').format('YYYY-MM-DD');
        const invoices = await query(`
            SELECT i.no_invoice, i.jumlah, i.tgl_jatuh_tempo, i.payment_url,
                p.nama, p.no_hp
            FROM invoice i JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE i.status='unpaid' AND i.tgl_jatuh_tempo = ?
        `, [besok]);

        for (const inv of invoices) {
            await waService.kirimReminder({ ...inv, isH1: true });
            await _delay(1000);
        }

        if (invoices.length > 0)
            console.log(`[CRON] Reminder H-1 terkirim: ${invoices.length}`);
    } catch (e) {
        console.error('[CRON] Error reminder H-1:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {};
