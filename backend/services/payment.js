// services/payment.js — Payment Gateway (Midtrans / Xendit / Duitku / Tripay)
const axios  = require('axios');
const crypto = require('crypto');
const { query } = require('../config/db');

// ============================================================
// KONFIGURASI DINAMIS (dibaca dari tabel `setting`, BUKAN .env)
// Sama seperti services/whatsapp.js — di-cache singkat (10 detik) supaya
// tidak query database di setiap transaksi, tapi tetap reflect perubahan
// dari dashboard tanpa perlu restart server.
// ============================================================
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 10_000;

async function getConfig() {
    const now = Date.now();
    if (_cache && (now - _cacheAt) < CACHE_MS) return _cache;

    const rows = await query(
        `SELECT kunci, nilai FROM setting WHERE kunci IN
         ('pg_provider','pg_sandbox','pg_server_key','pg_client_key',
          'pg_secret_key','pg_webhook_token','pg_merchant_code',
          'pg_merchant_code_duitku','pg_merchant_code_tripay',
          'pg_merchant_code_midtrans','pg_merchant_code_xendit',
          'pg_api_key','pg_private_key','app_url')`
    );
    const map = {};
    rows.forEach(r => map[r.kunci] = r.nilai);

    const provider = map.pg_provider || 'midtrans';

    // Merchant code per provider — fallback ke pg_merchant_code lama
    const merchantCode = provider === 'duitku'
        ? (map.pg_merchant_code_duitku  || map.pg_merchant_code || '')
        : provider === 'tripay'
        ? (map.pg_merchant_code_tripay  || map.pg_merchant_code || '')
        : provider === 'midtrans'
        ? (map.pg_merchant_code_midtrans|| map.pg_merchant_code || '')
        : provider === 'xendit'
        ? (map.pg_merchant_code_xendit  || map.pg_merchant_code || '')
        : (map.pg_merchant_code || '');

    _cache = {
        provider,
        sandbox:       map.pg_sandbox       !== '0',
        serverKey:     map.pg_server_key    || '',
        clientKey:     map.pg_client_key    || '',
        secretKey:     map.pg_secret_key    || '',
        webhookToken:  map.pg_webhook_token || '',
        merchantCode,
        apiKey:        map.pg_api_key       || '',
        privateKey:    map.pg_private_key   || '',
        appUrl:        map.app_url          || process.env.APP_URL || 'http://localhost:3000'
    };
    _cacheAt = now;
    return _cache;
}

function invalidateCache() {
    _cache = null;
}

// ============================================================
// BUAT TRANSAKSI BARU
// ============================================================
async function buatTransaksi({ order_id, gross_amount, pelanggan, metode }) {
    const cfg = await getConfig();
    try {
        if (!cfg.serverKey && !cfg.secretKey && !cfg.apiKey) {
            console.warn('[PAYMENT] Kredensial payment gateway belum diisi di Setting > Payment Gateway.');
            return null;
        }
        if (cfg.provider === 'midtrans') {
            return await _midtransBuat(order_id, gross_amount, pelanggan, cfg);
        } else if (cfg.provider === 'xendit') {
            return await _xenditBuat(order_id, gross_amount, pelanggan, cfg);
        } else if (cfg.provider === 'duitku') {
            return await _duitkuBuat(order_id, gross_amount, pelanggan, cfg, metode);
        } else if (cfg.provider === 'tripay') {
            return await _tripayBuat(order_id, gross_amount, pelanggan, cfg, metode);
        }
    } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.error('[PAYMENT] Gagal buat transaksi:', detail);
        // Tidak throw — invoice tetap dibuat meski payment link gagal
        return null;
    }
}

// ============================================================
// VERIFIKASI WEBHOOK SIGNATURE
// ============================================================
async function verifikasiSignatureMidtrans(body) {
    const { order_id, status_code, gross_amount, signature_key } = body;
    const cfg = await getConfig();
    const hash = crypto
        .createHash('sha512')
        .update(`${order_id}${status_code}${gross_amount}${cfg.serverKey}`)
        .digest('hex');
    return hash === signature_key;
}

async function verifikasiSignatureXendit(rawBody, signature) {
    const cfg = await getConfig();
    const computed = crypto
        .createHmac('sha256', cfg.webhookToken)
        .update(rawBody)
        .digest('hex');
    return computed === signature;
}

// ============================================================
// MIDTRANS — Snap / Payment Link
// ============================================================
async function _midtransBuat(order_id, gross_amount, pelanggan, cfg) {
    const baseUrl = cfg.sandbox
        ? 'https://app.sandbox.midtrans.com/snap/v1/transactions'
        : 'https://app.midtrans.com/snap/v1/transactions';

    const auth = Buffer.from(`${cfg.serverKey}:`).toString('base64');

    const payload = {
        transaction_details: {
            order_id,
            gross_amount: Math.round(gross_amount)
        },
        customer_details: {
            first_name: pelanggan.nama,
            phone:      pelanggan.no_hp,
            email:      pelanggan.email || `${pelanggan.username}@customer.id`
        },
        item_details: [{
            id:       `paket-${pelanggan.paket_id}`,
            name:     `Tagihan Internet ${pelanggan.nama_paket || ''}`,
            price:    Math.round(gross_amount),
            quantity: 1
        }],
        callbacks: {
            finish:  `${cfg.appUrl}/pembayaran/selesai`,
            error:   `${cfg.appUrl}/pembayaran/gagal`,
            pending: `${cfg.appUrl}/pembayaran/pending`
        }
    };

    const resp = await axios.post(baseUrl, payload, {
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type':  'application/json'
        }
    });

    return {
        order_id,
        payment_url: resp.data.redirect_url,
        token:       resp.data.token
    };
}

// Handler webhook Midtrans
async function handleMidtransWebhook(body) {
    const { order_id, transaction_status, fraud_status, payment_type } = body;

    // Status sukses: settlement atau capture (non-fraud)
    const sukses =
        transaction_status === 'settlement' ||
        (transaction_status === 'capture' && fraud_status === 'accept');

    const cancelled =
        ['cancel', 'deny', 'expire'].includes(transaction_status);

    return { order_id, sukses, cancelled, payment_type };
}

// ============================================================
// XENDIT — Invoice (link bayar)
// ============================================================
async function _xenditBuat(order_id, gross_amount, pelanggan, cfg) {
    const auth = Buffer.from(`${cfg.secretKey}:`).toString('base64');

    const resp = await axios.post('https://api.xendit.co/v2/invoices', {
        external_id:       order_id,
        amount:            Math.round(gross_amount),
        payer_email:       pelanggan.email || `${pelanggan.username}@customer.id`,
        description:       `Tagihan Internet - ${pelanggan.nama}`,
        customer: {
            given_names: pelanggan.nama,
            mobile_number: pelanggan.no_hp
        },
        success_redirect_url: `${cfg.appUrl}/pembayaran/selesai`,
        failure_redirect_url: `${cfg.appUrl}/pembayaran/gagal`,
        currency: 'IDR',
        payment_methods: ['QRIS', 'BCA', 'BRI', 'BNI', 'MANDIRI', 'OVO', 'DANA', 'LINKAJA']
    }, {
        headers: { 'Authorization': `Basic ${auth}` }
    });

    return {
        order_id,
        payment_url: resp.data.invoice_url,
        xendit_id:   resp.data.id
    };
}

// Handler webhook Xendit
async function handleXenditWebhook(body) {
    const { external_id, status, payment_method } = body;
    return {
        order_id:     external_id,
        sukses:       status === 'PAID',
        cancelled:    status === 'EXPIRED',
        payment_type: payment_method
    };
}

// ============================================================
// DUITKU
// ============================================================
async function _duitkuBuat(order_id, gross_amount, pelanggan, cfg, metode) {
    const baseUrl = cfg.sandbox
        ? 'https://sandbox.duitku.com/webapi/api/merchant/v2/inquiry'
        : 'https://passport.duitku.com/webapi/api/merchant/v2/inquiry';

    const merchantOrderId = order_id;
    const signature = crypto.createHash('md5')
        .update(`${cfg.merchantCode}${merchantOrderId}${Math.round(gross_amount)}${cfg.apiKey}`)
        .digest('hex');

    const resp = await axios.post(baseUrl, {
        merchantCode: cfg.merchantCode,
        paymentAmount: Math.round(gross_amount),
        paymentMethod: metode || 'VC',
        merchantOrderId,
        productDetails: `Tagihan Internet ${pelanggan.nama}`,
        email:    pelanggan.email || `${pelanggan.username}@customer.id`,
        phoneNumber: pelanggan.no_hp,
        additionalParam: '',
        merchantUserInfo: pelanggan.username,
        customerVaName: pelanggan.nama,
        callbackUrl: `${cfg.appUrl}/webhook/duitku`,
        returnUrl:   `${cfg.appUrl}/pembayaran/selesai`,
        signature,
        expiryPeriod: 1440  // 24 jam
    });

    return {
        order_id,
        payment_url: resp.data.paymentUrl
    };
}

// ============================================================
// TRIPAY
// ============================================================
async function _tripayBuat(order_id, gross_amount, pelanggan, cfg, metode) {
    const baseUrl = cfg.sandbox
        ? 'https://tripay.co.id/api-sandbox/transaction/create'
        : 'https://tripay.co.id/api/transaction/create';

    const signature = crypto.createHmac('sha256', cfg.privateKey)
        .update(`${cfg.merchantCode}${order_id}${Math.round(gross_amount)}`)
        .digest('hex');

    const resp = await axios.post(baseUrl, {
        method:           metode || 'QRIS',
        merchant_ref:     order_id,
        amount:           Math.round(gross_amount),
        customer_name:    pelanggan.nama,
        customer_email:   pelanggan.email || `${pelanggan.username}@tripay.id`,
        customer_phone:   pelanggan.no_hp,
        order_items: [{
            sku:      order_id,
            name:     `Tagihan Internet`,
            price:    Math.round(gross_amount),
            quantity: 1
        }],
        signature,
        expired_time: Math.floor(Date.now() / 1000) + 86400
    }, {
        headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json'
        }
    });

    return {
        order_id,
        payment_url: resp.data.data?.checkout_url
    };
}

module.exports = {
    buatTransaksi,
    verifikasiSignatureMidtrans,
    verifikasiSignatureXendit,
    handleMidtransWebhook,
    handleXenditWebhook,
    getConfig,
    invalidateCache
};
