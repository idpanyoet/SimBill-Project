// services/cron.js — Otomasi: reminder, suspend, generate invoice
const cron  = require('node-cron');
const dayjs = require('dayjs');
const { query } = require('../config/db');
const waService     = require('./whatsapp');
const radiusService = require('./radius');

const REMINDER_H = parseInt(process.env.REMINDER_H_MINUS) || 3;
const SUSPEND_H  = parseInt(process.env.SUSPEND_H_PLUS)   || 3;

console.log(`[CRON] Scheduler aktif | Reminder H-${REMINDER_H} | Suspend H+${SUSPEND_H}`);

// ============================================================
// 1. KIRIM REMINDER TAGIHAN (setiap hari jam 08:00 WIB)
// ============================================================
cron.schedule('0 8 * * *', async () => {
    console.log('[CRON] Mulai kirim reminder tagihan...');
    try {
        const targetDate = dayjs().add(REMINDER_H, 'day').format('YYYY-MM-DD');

        const invoices = await query(`
            SELECT i.id AS invoice_id, i.no_invoice, i.jumlah, i.tgl_jatuh_tempo, i.payment_url,
                p.nama, p.no_hp, p.id AS pelanggan_id
            FROM invoice i
            JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE i.status = 'unpaid'
            AND i.tgl_jatuh_tempo = ?
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
    console.log('[CRON] Cek auto-suspend...');
    try {
        const batasDate = dayjs().subtract(SUSPEND_H, 'day').format('YYYY-MM-DD');

        // Update status invoice ke overdue
        await query(`
            UPDATE invoice SET status = 'overdue'
            WHERE status = 'unpaid' AND tgl_jatuh_tempo < CURDATE()
        `);

        // Cari pelanggan yang invoice-nya sudah lewat H+N
        const pelanggan = await query(`
            SELECT DISTINCT p.id, p.username, p.nama, p.no_hp
            FROM invoice i
            JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE i.status = 'overdue'
            AND i.tgl_jatuh_tempo <= ?
            AND p.status = 'aktif'
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
// 3. GENERATE INVOICE BULANAN (tanggal 1 setiap bulan jam 07:00)
// ============================================================
cron.schedule('0 7 1 * *', async () => {
    console.log('[CRON] Generate invoice bulanan...');
    try {
        await _generateInvoiceBulanan();
    } catch (e) {
        console.error('[CRON] Error generate invoice:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

async function _generateInvoiceBulanan() {
    const paymentService = require('./payment');
    const { queryOne, withTransaction, generateUniqueInvoiceNo } = require('../config/db');
    const dayjs = require('dayjs');
    const INVOICE_PREFIX = process.env.INVOICE_PREFIX || 'INV';

    const pelanggan = await query(`
        SELECT pl.*, pk.harga, pk.id AS paket_id, pk.nama AS nama_paket, pk.masa_aktif
        FROM pelanggan pl
        JOIN paket pk ON pl.paket_id = pk.id
        WHERE pl.status = 'aktif'
    `);

    const tahun     = dayjs().format('YYYY');
    const tgl_jatuh = dayjs().endOf('month').format('YYYY-MM-DD');
    let berhasil = 0;

    for (const p of pelanggan) {
        try {
            const ada = await queryOne(`
                SELECT id FROM invoice
                WHERE pelanggan_id = ?
                AND MONTH(tgl_invoice) = MONTH(NOW())
                AND YEAR(tgl_invoice) = YEAR(NOW())
            `, [p.id]);
            if (ada) continue;

            // Insert invoice dengan nomor yang aman dari race condition
            // (cron ini bisa saja berjalan bersamaan dengan trigger manual admin)
            const { no_invoice, result } = await withTransaction(db =>
                generateUniqueInvoiceNo(db, INVOICE_PREFIX, tahun, (noInv) =>
                    db.query(`
                        INSERT INTO invoice (no_invoice, pelanggan_id, paket_id, jumlah,
                            tgl_invoice, tgl_jatuh_tempo)
                        VALUES (?,?,?,?,CURDATE(),?)
                    `, [noInv, p.id, p.paket_id, p.harga, tgl_jatuh])
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
                    tgl_jatuh_tempo: tgl_jatuh, payment_url: pg?.payment_url
                });
            } catch (waErr) {
                console.warn(`[CRON] Kirim WA gagal untuk ${p.username}:`, waErr.message);
            }

            await _delay(1000);
        } catch (err) {
            console.error(`[CRON] Invoice gagal ${p.username}:`, err.message);
        }
    }

    console.log(`[CRON] Invoice bulanan dibuat: ${berhasil} dari ${pelanggan.length}`);
}

// ============================================================
// 4. HAPUS LOG WA LAMA (setiap minggu Minggu jam 02:00)
// ============================================================
cron.schedule('0 2 * * 0', async () => {
    try {
        const result = await query(
            `DELETE FROM wa_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`
        );
        console.log(`[CRON] Hapus log WA lama: ${result.affectedRows} baris`);
    } catch (e) {
        console.error('[CRON] Error hapus log:', e.message);
    }
}, { timezone: 'Asia/Jakarta' });

// ============================================================
// 5. CRON H-1: REMINDER TERAKHIR (jam 10:00)
// ============================================================
cron.schedule('0 10 * * *', async () => {
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
