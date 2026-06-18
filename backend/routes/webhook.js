// routes/webhook.js — Callback dari payment gateway (tanpa JWT auth)
const router = require('express').Router();
const { query, queryOne, hitungExpired } = require('../config/db');
const paymentService = require('../services/payment');
const waService      = require('../services/whatsapp');
const radiusService  = require('../services/radius');
const dayjs = require('dayjs');
const { prosesTopupWebhook } = require('./reseller');

// ============================================================
// MIDTRANS WEBHOOK
// ============================================================
router.post('/midtrans', async (req, res) => {
    try {
        // Verifikasi signature
        if (!(await paymentService.verifikasiSignatureMidtrans(req.body))) {
            console.warn('[WEBHOOK] Midtrans signature tidak valid');
            return res.status(401).json({ error: 'Signature tidak valid' });
        }

        const { order_id, sukses, cancelled, payment_type } =
            await paymentService.handleMidtransWebhook(req.body);

        await _prosesKonfirmasiBayar(order_id, payment_type, sukses, cancelled, req.body);

        res.json({ status: 'ok' });
    } catch (e) {
        console.error('[WEBHOOK Midtrans]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// XENDIT WEBHOOK
// ============================================================
router.post('/xendit', async (req, res) => {
    try {
        const signature = req.headers['x-callback-token'];
        const cfg = await paymentService.getConfig();
        if (cfg.webhookToken && signature !== cfg.webhookToken) {
            console.warn('[WEBHOOK] Xendit callback token tidak valid');
            return res.status(401).json({ error: 'Token tidak valid' });
        }

        const { order_id, sukses, cancelled, payment_type } =
            await paymentService.handleXenditWebhook(req.body);

        await _prosesKonfirmasiBayar(order_id, payment_type, sukses, cancelled, req.body);

        res.json({ status: 'ok' });
    } catch (e) {
        console.error('[WEBHOOK Xendit]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================
// DUITKU WEBHOOK
// ============================================================
router.post('/duitku', async (req, res) => {
    try {
        const { merchantCode, amount, merchantOrderId,
                resultCode, paymentCode, signature } = req.body;

        const cfg = await paymentService.getConfig();
        const computed = require('crypto').createHash('md5')
            .update(`${merchantCode}${amount}${merchantOrderId}${cfg.apiKey}`)
            .digest('hex');

        if (computed !== signature) {
            console.warn('[WEBHOOK] Duitku signature tidak valid');
            return res.status(401).send('Signature tidak valid');
        }

        const sukses    = resultCode === '00';
        const cancelled = resultCode === '01';

        await _prosesKonfirmasiBayar(merchantOrderId, paymentCode, sukses, cancelled, req.body);

        res.send('OK');
    } catch (e) {
        console.error('[WEBHOOK Duitku]', e.message);
        res.status(500).end();
    }
});

// ============================================================
// TRIPAY WEBHOOK
// ============================================================
router.post('/tripay', async (req, res) => {
    try {
        const { merchant_ref, status, payment_method } = req.body;
        const sukses    = status === 'PAID';
        const cancelled = status === 'EXPIRED';

        await _prosesKonfirmasiBayar(merchant_ref, payment_method, sukses, cancelled, req.body);

        res.json({ success: true });
    } catch (e) {
        console.error('[WEBHOOK Tripay]', e.message);
        res.status(500).json({ success: false });
    }
});

// ============================================================
// PROSES KONFIRMASI PEMBAYARAN (shared logic)
// ============================================================
async function _prosesKonfirmasiBayar(order_id, payment_type, sukses, cancelled, rawBody) {
    // Cek apakah ini topup reseller
    if (sukses && order_id.startsWith('TOP-')) {
        const handled = await prosesTopupWebhook(order_id, payment_type);
        if (handled) { console.log(`[WEBHOOK] ✅ Topup reseller: ${order_id}`); return; }
    }

    // Cari invoice berdasarkan no_invoice
    const inv = await queryOne(`
        SELECT i.*, p.nama, p.no_hp, p.username, pk.masa_aktif
        FROM invoice i
        JOIN pelanggan p ON i.pelanggan_id = p.id
        JOIN paket pk ON i.paket_id = pk.id
        WHERE i.no_invoice = ?
    `, [order_id]);

    // Cek apakah ini transaksi voucher (pelanggan_id = NULL)
    const invVoucher = !inv ? await queryOne(
        `SELECT * FROM invoice WHERE no_invoice=? AND pelanggan_id IS NULL`, [order_id]
    ) : null;

    if (!inv && !invVoucher) {
        console.warn(`[WEBHOOK] Invoice tidak ditemukan: ${order_id}`);
        return;
    }

    // Simpan log pembayaran
    const invId = inv?.id || invVoucher?.id;
    const cfgProvider = (await paymentService.getConfig()).provider;
    await query(`
        INSERT INTO payment_log (invoice_id, payment_gateway, order_id, transaction_id,
            payment_type, gross_amount, status, raw_response)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [invId, cfgProvider, order_id, rawBody.transaction_id || order_id,
        payment_type, inv?.jumlah || invVoucher?.jumlah,
        sukses ? 'success' : (cancelled ? 'cancelled' : 'pending'),
        JSON.stringify(rawBody)
    ]);

    // ========== INVOICE VOUCHER ==========
    if (invVoucher && sukses && invVoucher.status !== 'paid') {
        await query(`UPDATE invoice SET status='paid', tgl_bayar=NOW(), metode_bayar=? WHERE id=?`,
            [payment_type, invVoucher.id]);

        // Ambil info dari keterangan invoice: "Voucher USERNAME — WA: 628xxx"
        const ket  = invVoucher.keterangan || '';
        const usernameMatch = ket.match(/Voucher ([\w-]+)/);
        const waMatch       = ket.match(/WA: (\d+)/);
        const username = usernameMatch?.[1];
        const noHp     = waMatch?.[1];

        if (username && noHp) {
            const paket = await queryOne('SELECT * FROM paket WHERE id=?', [invVoucher.paket_id]);
            if (paket) {
                const { _aktivasiVoucher } = require('./voucher-publik');
                await _aktivasiVoucher(username, noHp, 'Pelanggan', paket);
            }
        }
        console.log(`[WEBHOOK] ✅ Voucher lunas: ${order_id}`);
        return;
    }

    // ========== INVOICE PELANGGAN BIASA ==========
    if (!inv) return;

    if (sukses && inv.status !== 'paid') {
        const tgl_expired = hitungExpired(inv.masa_aktif, inv.satuan_masa).format('YYYY-MM-DD HH:mm:ss');

        // Update invoice → paid
        await query(`
            UPDATE invoice
            SET status='paid', tgl_bayar=NOW(), metode_bayar=?
            WHERE id=?
        `, [payment_type, inv.id]);

        // Aktifkan pelanggan
        await query(`
            UPDATE pelanggan SET status='aktif', tgl_expired=? WHERE id=?
        `, [tgl_expired, inv.pelanggan_id]);

        // Aktifkan di RADIUS
        await radiusService.aktifkanUser(inv.username);

        // Kirim WA konfirmasi
        await waService.kirimKonfirmasiBayar({
            no_hp:       inv.no_hp,
            nama:        inv.nama,
            jumlah:      inv.jumlah,
            tgl_expired
        });

        console.log(`[WEBHOOK] ✅ Bayar lunas: ${order_id} — ${inv.nama}`);

    } else if (cancelled && inv.status === 'unpaid') {
        await query(`UPDATE invoice SET status='cancelled' WHERE id=?`, [inv.id]);
        console.log(`[WEBHOOK] ❌ Invoice dibatalkan: ${order_id}`);
    }
}

module.exports = router;
