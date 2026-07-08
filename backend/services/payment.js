// services/payment.js — Payment Gateway (Midtrans / Xendit / Duitku / Tripay)
const axios  = require('axios');
const crypto = require('crypto');
const { query } = require('../config/db');

// Hasilkan alamat email yang VALID untuk dikirim ke payment gateway.
// - Jika pelanggan punya email valid -> pakai apa adanya.
// - Jika tidak (kosong / tidak valid), buat fallback dari username yang sudah
//   DIBERSIHKAN dari karakter ilegal. Penting: username PPPoE sering memuat '@'
//   (mis. "nafi@rfnet"); tanpa pembersihan, fallback "nafi@rfnet@customer.id"
//   menjadi email ganda-@ yang ditolak gateway ("Invalid Email Address").
function _emailAman(pelanggan, domain = 'customer.id') {
    const e = String((pelanggan && pelanggan.email) || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return e;          // email asli valid
    const u = String((pelanggan && pelanggan.username) || 'cust')
                .replace(/[^a-zA-Z0-9._-]/g, '')                  // buang '@', spasi, dll
                .replace(/^[._-]+|[._-]+$/g, '');                 // rapikan tepi
    return `${u || 'cust'}@${domain}`;
}

// ============================================================
// KONFIGURASI DINAMIS (dibaca dari tabel `setting`, BUKAN .env)
// Sama seperti services/whatsapp.js — di-cache singkat (10 detik) supaya
// tidak query database di setiap transaksi, tapi tetap reflect perubahan
// dari dashboard tanpa perlu restart server.
// ============================================================
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 10_000;
let _lastError = null;
function getLastError() { return _lastError; }

async function getConfig(providerOverride) {
    const now = Date.now();
    if (!providerOverride && _cache && (now - _cacheAt) < CACHE_MS) return _cache;

    const rows = await query(
        `SELECT kunci, nilai FROM setting WHERE kunci IN
         ('pg_provider','pg_sandbox','pg_server_key','pg_client_key',
          'pg_secret_key','pg_webhook_token','pg_merchant_code',
          'pg_merchant_code_duitku','pg_merchant_code_tripay','pg_metode_duitku','pg_metode_aktif_duitku',
          'pg_merchant_code_midtrans','pg_merchant_code_xendit',
          'pg_api_key','pg_api_key_duitku','pg_api_key_tripay',
          'pg_server_key_midtrans','pg_client_key_midtrans',
          'pg_secret_key_xendit','pg_webhook_token_xendit',
          'pg_private_key','pg_private_key_tripay','app_url')`
    );
    const map = {};
    rows.forEach(r => map[r.kunci] = r.nilai);

    const provider = providerOverride || map.pg_provider || 'midtrans';

    const merchantCode = provider === 'duitku'
        ? (map.pg_merchant_code_duitku   || map.pg_merchant_code || '')
        : provider === 'tripay'
        ? (map.pg_merchant_code_tripay   || map.pg_merchant_code || '')
        : provider === 'midtrans'
        ? (map.pg_merchant_code_midtrans || map.pg_merchant_code || '')
        : provider === 'xendit'
        ? (map.pg_merchant_code_xendit   || map.pg_merchant_code || '')
        : (map.pg_merchant_code || '');

    const cfg = {
        provider,
        sandbox:       String(map.pg_sandbox || '').trim() === '1',
        serverKey:     map.pg_server_key_midtrans  || map.pg_server_key    || '',
        clientKey:     map.pg_client_key_midtrans  || map.pg_client_key    || '',
        secretKey:     map.pg_secret_key_xendit    || map.pg_secret_key    || '',
        webhookToken:  map.pg_webhook_token_xendit || map.pg_webhook_token || '',
        merchantCode: String(merchantCode || '').trim(),
        metodeDuitku:  map.pg_metode_duitku || '',
        metodeAktifDuitku: map.pg_metode_aktif_duitku || '',
        apiKey:        String((provider === 'duitku'
                         ? (map.pg_api_key_duitku  || '')
                         : provider === 'tripay'
                         ? (map.pg_api_key_tripay  || '')
                         : '') || '').trim(),
        privateKey:    map.pg_private_key_tripay   || map.pg_private_key   || '',
        appUrl:        map.app_url || process.env.APP_URL || 'http://localhost:3000'
    };
    if (!providerOverride) { _cache = cfg; _cacheAt = now; }
    return cfg;
}

function invalidateCache() {
    _cache = null;
}

// ============================================================
// BUAT TRANSAKSI BARU
// ============================================================
async function buatTransaksi({ order_id, gross_amount, pelanggan, metode, provider }) {
    const cfg = await getConfig(provider);
    _lastError = null;
    try {
        if (!cfg.serverKey && !cfg.secretKey && !cfg.apiKey) {
            _lastError = `Kredensial ${cfg.provider} kosong di Setting > Payment Gateway`;
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
        _lastError = `Provider tidak dikenal: ${cfg.provider}`;
    } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        _lastError = `${cfg.provider}: ${detail}`;
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
            email:      _emailAman(pelanggan)
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
        payer_email:       _emailAman(pelanggan),
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
// Pilih kode metode Duitku untuk link WA (tunggal, fallback inquiry v2).
// Urutan prioritas dari metode yang dicentang admin di halaman "Metode Aktif".
// Setting pg_metode_aktif_duitku bisa berformat CSV atau JSON array kode metode.
// Peta nama/alias metode -> kode resmi Duitku (inquiry v2).
const _DUITKU_KODE = {
    // QRIS
    'QRIS':'SP','qris':'SP','QR':'SP','NQ':'NQ','SP':'SP',
    // E-wallet
    'SHOPEEPAY':'SP','SA':'SP',
    'OVO':'OV','OV':'OV',
    'DANA':'DA','DA':'DA',
    'GOPAY':'SP','gopay':'SP',
    // Virtual Account
    'BRIVA':'BR','BR':'BR','VA BRI':'BR',
    'BCAVA':'BC','BC':'BC','VA BCA':'BC',
    'BNIVA':'B1','B1':'B1','VA BNI':'B1',
    'MANDIRIVA':'M2','M2':'M2','I1':'I1','VA MANDIRI':'M2',
    'PERMATAVA':'BT','BT':'BT',
    'BSIVA':'BV','BV':'BV',
    'ATMBERSAMA':'AG','AG':'AG','ATM BERSAMA':'AG',
    'MAYBANKVA':'VA','VA':'VA',
    // Retail
    'ALFAMART':'A1','LA':'A1','A1':'A1',
    'RETAIL':'FT','FT':'FT','PEGADAIAN':'FT','POS':'FT',
    'INDOMARET':'IR','IR':'IR',
    // Kartu kredit
    'VC':'VC','CC':'VC'
};
function _kodeDuitku(metode) {
    if (!metode) return '';
    const m = String(metode).trim();
    return _DUITKU_KODE[m] || _DUITKU_KODE[m.toUpperCase()] || m;
}

function _pilihMetodeDuitku(cfg) {
    // 1) kalau admin set metode khusus untuk WA, pakai itu
    if (cfg.metodeDuitku) return cfg.metodeDuitku;
    // 2) ambil dari daftar metode aktif (yang dicentang)
    let list = [];
    const raw = (cfg.metodeAktifDuitku || '').trim();
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) list = parsed.map(String);
        } catch (e) {
            list = raw.split(',').map(x => x.trim()).filter(Boolean);
        }
    }
    // 3) prioritas metode e-wallet/QRIS yang umum (lebih mudah dibayar dari link tunggal)
    // konversi semua ke kode Duitku resmi
    list = list.map(_kodeDuitku).filter(Boolean);
    const prioritas = ['SP', 'OV', 'DA', 'NQ', 'BR', 'BC', 'M2', 'I1', 'B1', 'VC'];
    for (const p of prioritas) if (list.includes(p)) return p;
    // 4) kalau ada metode lain di list, pakai yang pertama
    if (list.length) return list[0];
    // 5) default terakhir
    return 'SP';
}

async function _duitkuBuat(order_id, gross_amount, pelanggan, cfg, metode) {
    const amount = Math.round(gross_amount);
    const phone  = (pelanggan.no_hp || '').replace(/[^0-9]/g, '') || '08123456789';

    // --- Cara 1: POP createInvoice (dinonaktifkan: endpoint perlu konfigurasi khusus) ---
    const PAKAI_POP = false;  // set true hanya jika akun sudah aktif Duitku POP
    if (PAKAI_POP) try {
        const popUrl = cfg.sandbox
            ? 'https://sandbox.duitku.com/api/merchant/createInvoice'
            : 'https://passport.duitku.com/api/merchant/createInvoice';
        const timestamp = Date.now();
        const sigPop = crypto.createHash('sha256')
            .update(`${cfg.merchantCode}${timestamp}${cfg.apiKey}`)
            .digest('hex');
        const resp = await axios.post(popUrl, {
            paymentAmount: amount,
            merchantOrderId: order_id,
            productDetails: `Tagihan Internet ${pelanggan.nama || ''}`.trim(),
            email:    _emailAman(pelanggan),
            customerVaName: pelanggan.nama || pelanggan.username || 'Pelanggan',
            phoneNumber: phone,
            callbackUrl: `${cfg.appUrl}/webhook/duitku`,
            returnUrl:   `${cfg.appUrl}/pembayaran/selesai`,
            expiryPeriod: 1440
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-duitku-signature': sigPop,
                'x-duitku-timestamp': String(timestamp),
                'x-duitku-merchantcode': cfg.merchantCode
            },
            timeout: 15000
        });
        if (resp.data && resp.data.paymentUrl) {
            return { order_id: resp.data.reference || order_id, payment_url: resp.data.paymentUrl };
        }
        console.warn('[PAYMENT] Duitku POP tanpa paymentUrl, fallback ke inquiry v2');
    } catch (ePop) {
        const msg = ePop.response?.data ? JSON.stringify(ePop.response.data) : ePop.message;
        console.warn('[PAYMENT] Duitku POP gagal, fallback ke inquiry v2:', msg);
    }

    // --- Cara 2: inquiry v2 dengan metode e-wallet spesifik (fallback) ---
    // Kode metode: OVO='OV', DANA='DA', ShopeePay='SP', QRIS='SP'/'QR'.
    // Diambil dari setting pg_metode_duitku (default 'SP' = ShopeePay).
    const baseUrl = cfg.sandbox
        ? 'https://sandbox.duitku.com/webapi/api/merchant/v2/inquiry'
        : 'https://passport.duitku.com/webapi/api/merchant/v2/inquiry';
    const signature = crypto.createHash('md5')
        .update(`${cfg.merchantCode}${order_id}${amount}${cfg.apiKey}`)
        .digest('hex');
    const resp2 = await axios.post(baseUrl, {
        merchantCode: cfg.merchantCode,
        paymentAmount: amount,
        paymentMethod: _kodeDuitku(metode) || _pilihMetodeDuitku(cfg),
        merchantOrderId: order_id,
        productDetails: `Tagihan Internet ${pelanggan.nama || ''}`.trim(),
        email:    _emailAman(pelanggan),
        phoneNumber: phone,
        additionalParam: '',
        merchantUserInfo: pelanggan.username || '',
        customerVaName: pelanggan.nama || 'Pelanggan',
        callbackUrl: `${cfg.appUrl}/webhook/duitku`,
        returnUrl:   `${cfg.appUrl}/pembayaran/selesai`,
        signature,
        expiryPeriod: 1440
    });
    return { order_id, payment_url: resp2.data.paymentUrl };
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
        customer_email:   _emailAman(pelanggan, 'tripay.id'),
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
    getLastError,
    invalidateCache
};
