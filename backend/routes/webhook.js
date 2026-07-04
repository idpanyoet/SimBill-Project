// routes/webhook.js — Callback dari payment gateway (tanpa JWT auth)
const router = require('express').Router();
const { query, queryOne, hitungExpired, hitungExpiredDari } = require('../config/db');
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
        // Fail-closed: kalau token webhook belum diset, TOLAK (jangan loloskan).
        if (!cfg.webhookToken) {
            console.warn('[WEBHOOK] Xendit webhook token belum dikonfigurasi — callback ditolak');
            return res.status(401).json({ error: 'Webhook token belum dikonfigurasi' });
        }
        if (signature !== cfg.webhookToken) {
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
        // Verifikasi signature: HMAC-SHA256 atas RAW body, key = private key Tripay.
        // Tanpa ini, siapa pun bisa memalsukan callback "PAID" → invoice lunas / saldo
        // reseller bertambah gratis.
        const cfg = await paymentService.getConfig();
        const privateKey = cfg.privateKey;
        const sigHeader  = req.headers['x-callback-signature'];

        if (!privateKey) {
            console.warn('[WEBHOOK] Tripay private key belum dikonfigurasi — callback ditolak');
            return res.status(401).json({ success: false, error: 'Private key belum dikonfigurasi' });
        }
        const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
        const computed = require('crypto')
            .createHmac('sha256', privateKey)
            .update(raw)
            .digest('hex');

        // Bandingkan konstan-waktu untuk hindari timing attack
        const crypto = require('crypto');
        const a = Buffer.from(String(sigHeader || ''), 'utf8');
        const b = Buffer.from(computed, 'utf8');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            console.warn('[WEBHOOK] Tripay signature tidak valid');
            return res.status(401).json({ success: false, error: 'Signature tidak valid' });
        }

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
    // Normalisasi order_id: buang suffix "_retry_<timestamp>" yang ditambahkan
    // saat pembayaran ULANG dari portal. Tanpa ini, callback pakai order_id
    // "INV-2026-0744_retry_169..." tidak cocok dengan no_invoice "INV-2026-0744"
    // → pembayaran gagal ter-reconcile (pelanggan sudah bayar tapi tetap unpaid).
    order_id = String(order_id || '').split('_retry_')[0];

    // Cek apakah ini topup reseller
    if (sukses && order_id.startsWith('TOP-')) {
        const handled = await prosesTopupWebhook(order_id, payment_type);
        if (handled) { console.log(`[WEBHOOK] ✅ Topup reseller: ${order_id}`); return; }
    }

    // Cari invoice berdasarkan no_invoice
    const inv = await queryOne(`
        SELECT i.*, p.nama, p.no_hp, p.username, p.tgl_expired AS tgl_expired_lama, pk.masa_aktif, pk.satuan_masa, pk.nama AS nama_paket
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

    // Simpan log pembayaran (IDEMPOTEN: cegah baris dobel saat gateway kirim
    // callback berulang / retry untuk order_id + status yang sama)
    const invId = inv?.id || invVoucher?.id;
    const cfgProvider = (await paymentService.getConfig()).provider;
    const statusBaru = sukses ? 'success' : (cancelled ? 'cancelled' : 'pending');
    const logSudahAda = await queryOne(
        `SELECT id FROM payment_log WHERE order_id=? AND status=? LIMIT 1`,
        [order_id, statusBaru]
    );
    if (!logSudahAda) {
        await query(`
            INSERT INTO payment_log (invoice_id, payment_gateway, order_id, transaction_id,
                payment_type, gross_amount, status, raw_response)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [invId, cfgProvider, order_id, rawBody.transaction_id || order_id,
            payment_type, inv?.jumlah || invVoucher?.jumlah,
            statusBaru, JSON.stringify(rawBody)
        ]);
    } else {
        console.log(`[WEBHOOK] payment_log ${order_id} (${statusBaru}) sudah ada — skip insert dobel.`);
    }

    // ========== INVOICE VOUCHER ==========
    if (invVoucher && sukses) {
        const sudahPaid = invVoucher.status === 'paid';
        if (!sudahPaid) {
            await query(`UPDATE invoice SET status='paid', tgl_bayar=NOW(), metode_bayar=? WHERE id=?`,
                [payment_type, invVoucher.id]);
            require('./log').tulisLog({ kategori:'Billing', pelaku: payment_type||'Gateway',
                aksi:'INVOICE_PAID', target: invVoucher.no_invoice,
                detail:`Amount: ${invVoucher.jumlah}, Method: ${payment_type}` });
        }

        // Cek apakah voucher untuk order ini SUDAH dibuat (cegah dobel + tahan webhook 2x)
        const ketSekarang = invVoucher.keterangan || '';
        const sudahDibuat = /VoucherDibuat:/.test(ketSekarang);
        if (sudahDibuat) {
            console.log(`[WEBHOOK] Voucher sudah dibuat sebelumnya untuk ${order_id}, skip.`);
            return;
        }

        // Ambil info pembeli dari keterangan invoice
        // Format: "Voucher PENDING — WA: 628xxx — Nama: Budi — Paket: 5"
        const waMatch  = ketSekarang.match(/WA:\s*(\d+)/);
        const namaMatch= ketSekarang.match(/Nama:\s*([^—]+)/);
        const noHp     = waMatch?.[1];
        const namaBeli = namaMatch?.[1]?.trim() || 'Pelanggan';

        if (!noHp) {
            console.error(`[WEBHOOK] ⚠️ Voucher TIDAK dibuat: nomor WA tidak ditemukan di keterangan invoice ${order_id}. Keterangan: "${ketSekarang}"`);
            return;
        }

        const paket = await queryOne('SELECT * FROM paket WHERE id=?', [invVoucher.paket_id]);
        if (!paket) {
            console.error(`[WEBHOOK] ⚠️ Voucher TIDAK dibuat: paket id ${invVoucher.paket_id} tidak ditemukan (order ${order_id}).`);
            return;
        }

        try {
            const { _acakUsername, _aktivasiVoucher } = require('./voucher-publik');
            const username = _acakUsername();
            await _aktivasiVoucher(username, noHp, namaBeli, paket);
            // Simpan username voucher ke invoice agar halaman sukses bisa menampilkannya
            await query(`UPDATE invoice SET keterangan = CONCAT(COALESCE(keterangan,''), ' — VoucherDibuat: ', ?) WHERE id=?`,
                [username, invVoucher.id]).catch(()=>{});
            console.log(`[WEBHOOK] ✅ Voucher lunas & dibuat: ${order_id} → ${username} (WA ${noHp})`);
        } catch (e) {
            console.error(`[WEBHOOK] ❌ Gagal buat voucher untuk ${order_id}:`, e.message);
        }
        return;
    }

    // ========== INVOICE PELANGGAN BIASA ==========
    if (!inv) return;

    if (sukses && inv.status !== 'paid') {
        const tgl_expired = hitungExpiredDari(inv.tgl_expired_lama, inv.masa_aktif, inv.satuan_masa).format('YYYY-MM-DD HH:mm:ss');

        // Update invoice → paid
        await query(`
            UPDATE invoice
            SET status='paid', tgl_bayar=NOW(), metode_bayar=?
            WHERE id=?
        `, [payment_type, inv.id]);
        require('./log').tulisLog({ kategori:'Billing', pelaku: payment_type||'Gateway',
            aksi:'INVOICE_PAID', target: inv.no_invoice,
            detail:`Amount: ${inv.jumlah}, Method: ${payment_type}` });

        // Aktifkan pelanggan
        await query(`
            UPDATE pelanggan SET status='aktif', tgl_expired=? WHERE id=?
        `, [tgl_expired, inv.pelanggan_id]);

        // Aktifkan di RADIUS
        await radiusService.aktifkanUser(inv.username);

        // Kirim WA konfirmasi
        await waService.kirimKonfirmasiBayar({
            no_hp:           inv.no_hp,
            nama:            inv.nama,
            jumlah:          inv.jumlah,
            total:           inv.jumlah,
            tgl_expired,
            no_invoice:      inv.no_invoice,
            paket:           inv.nama_paket || inv.paket,
            metode_bayar:    payment_type || inv.metode_bayar,
            tgl_invoice:     inv.tgl_invoice,
            tgl_jatuh_tempo: inv.tgl_jatuh_tempo,
            periode:         inv.tgl_invoice
        });

        console.log(`[WEBHOOK] ✅ Bayar lunas: ${order_id} — ${inv.nama}`);

    } else if (cancelled && inv.status === 'unpaid') {
        await query(`UPDATE invoice SET status='cancelled' WHERE id=?`, [inv.id]);
        console.log(`[WEBHOOK] ❌ Invoice dibatalkan: ${order_id}`);
    }
}

// ============================================================
// TELEGRAM WEBHOOK — perintah dari grup (cek redaman ONU dll)
// ============================================================
router.post('/telegram', async (req, res) => {
    res.sendStatus(200); // ACK cepat agar Telegram tidak retry
    try {
        const tg = require('../services/telegram');
        const cfg = await tg.getCfg();
        if (cfg.tg_enabled !== '1') return;
        // Verifikasi secret token (FAIL-CLOSED). Aktivasi webhook selalu
        // membuat tg_webhook_secret; bila kosong, tolak — jangan proses update
        // Telegram palsu yang bisa memicu perintah bot (mis. /redaman) tanpa auth.
        const secret = cfg.tg_webhook_secret || '';
        const diterima = String(req.headers['x-telegram-bot-api-secret-token'] || '');
        if (!secret) return;
        const a = Buffer.from(secret), b = Buffer.from(diterima);
        if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) return;

        const msg = req.body && (req.body.message || req.body.edited_message);
        if (!msg || !msg.text) return;
        const chatId = msg.chat && msg.chat.id;
        const text = String(msg.text).trim();

        // /cekpelanggan <nama> | /cekpel <nama>  — detail lengkap pelanggan
        // (nama boleh mengandung spasi → ambil semua sisa teks setelah perintah)
        const mp = text.match(/^\/?(?:cekpelanggan|cekpel|cek\s*pelanggan)\s+(.+)/i);
        if (mp) {
            if (cfg.tg_ev_redaman !== '1') { await tg.kirim(chatId, '⚠️ Fitur cek pelanggan dinonaktifkan oleh admin.'); return; }
            const teks = await tg.cekPelanggan(mp[1].trim());
            await tg.kirim(chatId, teks);
            return;
        }

        // /redaman <id> | cek redaman <id> | /cek <id>
        const m = text.match(/^\/?(?:redaman|cek\s*redaman|cek)\s+@?([A-Za-z0-9._\-]+)/i);
        if (!m) {
            if (/^\/(start|help|redaman|cek)\b/i.test(text)) {
                await tg.kirim(chatId, '🤖 <b>Bot SimBill</b>\nPerintah:\n<code>/redaman &lt;username|serial&gt;</code> — cek redaman ONU.\n<code>/cekpelanggan &lt;nama&gt;</code> — detail lengkap pelanggan.');
            }
            return;
        }
        if (cfg.tg_ev_redaman !== '1') { await tg.kirim(chatId, '⚠️ Fitur cek redaman dinonaktifkan oleh admin.'); return; }
        const teks = await tg.cekRedaman(m[1]);
        await tg.kirim(chatId, teks);
    } catch (e) { console.warn('[telegram webhook]', e.message); }
});

module.exports = router;
