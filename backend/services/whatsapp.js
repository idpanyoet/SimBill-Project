// services/whatsapp.js — WhatsApp Gateway (Fonnte / Wablas / WA Business / WaNotif)
const axios = require('axios');
const { query, queryOne } = require('../config/db');

// ============================================================
// KONFIGURASI DINAMIS (dibaca dari tabel `setting`, BUKAN .env)
// Di-cache singkat (10 detik) supaya tidak query database di setiap
// pengiriman pesan, tapi tetap reflect perubahan dari dashboard tanpa
// perlu restart server.
// ============================================================
let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 10_000;

async function getConfig() {
    const now = Date.now();
    if (_cache && (now - _cacheAt) < CACHE_MS) return _cache;

    const rows = await query(
        `SELECT kunci, nilai FROM setting WHERE kunci IN
         ('wa_provider','wa_token','wa_sender','wa_phone_id',
          'wa_tpl_daftar','wa_tpl_reminder','wa_tpl_suspend',
          'wa_tpl_konfirmasi','wa_tpl_voucher_sukses')`
    );
    const map = {};
    rows.forEach(r => map[r.kunci] = r.nilai);

    _cache = {
        provider:              map.wa_provider            || 'fonnte',
        token:                 map.wa_token               || '',
        sender:                map.wa_sender              || '',
        phoneId:               map.wa_phone_id            || '',
        wa_tpl_daftar:         map.wa_tpl_daftar          || '',
        wa_tpl_reminder:       map.wa_tpl_reminder        || '',
        wa_tpl_suspend:        map.wa_tpl_suspend         || '',
        wa_tpl_konfirmasi:     map.wa_tpl_konfirmasi      || '',
        wa_tpl_voucher_sukses: map.wa_tpl_voucher_sukses  || ''
    };
    _cacheAt = now;
    return _cache;
}

// Dipanggil setelah admin menyimpan setting baru dari dashboard, agar
// perubahan langsung berlaku tanpa menunggu cache 10 detik habis.
function invalidateCache() {
    _cache = null;
}

// Format angka ke Rupiah
function formatRp(angka) {
    return 'Rp ' + Number(angka).toLocaleString('id-ID');
}

// ============================================================
// PENGIRIMAN PESAN (multi-provider)
// ============================================================
async function kirimPesan(no_hp, pesan, pelanggan_id = null, tipe = 'manual', invoice_id = null) {
    const cfg = await getConfig();

    if (!cfg.token) {
        console.warn('[WA] Token provider belum diisi di Setting > WhatsApp Gateway.');
        return { sukses: false, error: 'Token WhatsApp Gateway belum dikonfigurasi. Buka menu Setting untuk mengisinya.' };
    }

    // Simpan log dulu
    const logResult = await query(`
        INSERT INTO wa_log (pelanggan_id, no_tujuan, pesan, tipe, invoice_id, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
    `, [pelanggan_id, no_hp, pesan, tipe, invoice_id]);
    const logId = logResult.insertId;

    try {
        let response;

        if (cfg.provider === 'fonnte') {
            response = await axios.post('https://api.fonnte.com/send', {
                target:  no_hp,
                message: pesan,
            }, {
                headers: { Authorization: cfg.token }
            });

        } else if (cfg.provider === 'wablas') {
            response = await axios.post('https://solo.wablas.com/api/send-message', {
                phone:   no_hp,
                message: pesan,
                isGroup: false
            }, {
                headers: { Authorization: cfg.token }
            });

        } else if (cfg.provider === 'wanotif') {
            response = await axios.post('https://app.wanotif.id/api/v1/send', {
                number:  no_hp,
                message: pesan
            }, {
                headers: { Authorization: `Bearer ${cfg.token}` }
            });

        } else if (cfg.provider === 'wa_business') {
            // WhatsApp Cloud API (Meta)
            response = await axios.post(
                `https://graph.facebook.com/v18.0/${cfg.phoneId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: no_hp,
                    type: 'text',
                    text: { body: pesan }
                },
                { headers: { Authorization: `Bearer ${cfg.token}` } }
            );
        } else {
            throw new Error(`Provider "${cfg.provider}" tidak dikenali`);
        }

        await query(
            `UPDATE wa_log SET status='sent', response=?, sent_at=NOW() WHERE id=?`,
            [JSON.stringify(response?.data), logId]
        );

        return { sukses: true };

    } catch (err) {
        const errMsg = err.response?.data
            ? JSON.stringify(err.response.data)
            : err.message;

        await query(
            `UPDATE wa_log SET status='failed', response=? WHERE id=?`,
            [errMsg, logId]
        );

        console.error(`[WA] Gagal kirim ke ${no_hp}:`, errMsg);
        return { sukses: false, error: errMsg };
    }
}

// ============================================================
// TEMPLATE PESAN
// ============================================================

// Reminder tagihan H-N
async function kirimReminder({ no_hp, nama, no_invoice, jumlah, tgl_jatuh_tempo, payment_url }) {
    const pesan = `Halo *${nama}*,

Tagihan internet Anda akan segera jatuh tempo.

📄 No. Invoice: *${no_invoice}*
💰 Jumlah: *${formatRp(jumlah)}*
📅 Jatuh Tempo: *${tgl_jatuh_tempo}*

Bayar sekarang via:
🔗 ${payment_url || 'Hubungi admin untuk info pembayaran'}

Terima kasih! 🙏`;

    return kirimPesan(no_hp, pesan, null, 'reminder');
}

// Link pembayaran baru
async function kirimLinkBayar(pelanggan, invoice) {
    const pesan = `Halo *${pelanggan.nama}*,

Tagihan internet bulan ini telah dibuat.

📄 Invoice: *${invoice.no_invoice}*
📦 Paket: *${pelanggan.nama_paket || 'Internet'}*
💰 Tagihan: *${formatRp(invoice.jumlah)}*
📅 Jatuh Tempo: *${invoice.tgl_jatuh_tempo}*

Bayar mudah via QRIS / Transfer:
🔗 ${invoice.payment_url || '-'}

Abaikan jika sudah membayar. Terima kasih! 🙏`;

    return kirimPesan(pelanggan.no_hp, pesan, pelanggan.id, 'reminder', invoice.id);
}

// Konfirmasi pembayaran diterima
async function kirimKonfirmasiBayar({ no_hp, nama, jumlah, tgl_expired }) {
    const pesan = `Halo *${nama}*,

Pembayaran Anda telah kami terima! ✅

💰 Jumlah: *${formatRp(jumlah)}*
📅 Aktif hingga: *${tgl_expired}*

Internet Anda sudah aktif kembali. Terima kasih telah mempercayai layanan kami! 🙏`;

    return kirimPesan(no_hp, pesan, null, 'konfirmasi_bayar');
}

// Notifikasi suspend
async function kirimSuspend(pelanggan) {
    const cfg = await getConfig();
    const pesan = `Halo *${pelanggan.nama}*,

Layanan internet Anda telah *disuspend* karena tagihan belum dibayar.

Untuk mengaktifkan kembali, silakan bayar tagihan Anda dan hubungi kami.

📞 Admin: ${cfg.sender || '-'}`;

    return kirimPesan(pelanggan.no_hp, pesan, pelanggan.id, 'suspend');
}

// Notifikasi pelanggan baru didaftarkan
async function kirimPelangganBaru({ no_hp, nama, username, password, nama_paket, tgl_expired }) {
    const cfg = await getConfig();
    // Gunakan template dari DB jika ada, fallback ke default
    let tpl = cfg.wa_tpl_daftar || '';
    if (!tpl) {
        tpl = `Halo *{nama}*, selamat datang! 🎉\n\nAkun internet Anda telah aktif.\n\n🔑 Username: *{username}*\n🔒 Password: *{password}*\n📦 Paket: *{paket}*\n📅 Aktif hingga: *{tgl_expired}*\n\nSelamat menikmati layanan internet kami! 🌐`;
    }
    const pesan = tpl
        .replace(/{nama}/g, nama)
        .replace(/{username}/g, username)
        .replace(/{password}/g, password)
        .replace(/{paket}/g, nama_paket || '')
        .replace(/{tgl_expired}/g, tgl_expired || '-');
    return kirimPesan(no_hp, pesan, null, 'daftar');
}

// Kirim OTP / kode voucher
async function kirimOTP(no_hp, kode) {
    const pesan = `Kode OTP Anda: *${kode}*\nBerlaku 5 menit. Jangan bagikan ke siapapun.`;
    return kirimPesan(no_hp, pesan, null, 'otp');
}

// Kirim voucher hotspot
async function kirimVoucher(no_hp, nama, username, password, expired_jam) {
    const loginInfo = (username === password)
        ? `🔑 Username/Password: *${username}*`
        : `🔑 Username: *${username}*\n🔒 Password: *${password}*`;

    const pesan = `Halo *${nama}*,

Berikut voucher internet Anda:

${loginInfo}
⏰ Berlaku: *${expired_jam} jam*

Cara pakai:
1. Sambungkan ke WiFi hotspot
2. Buka browser, masuk ke halaman login
3. Masukkan username & password di atas

Selamat menikmati! 🌐`;

    return kirimPesan(no_hp, pesan, null, 'otp');
}

// Broadcast ke banyak nomor (dengan delay agar tidak spam)
async function broadcast(daftarPelanggan, pesanTemplate, tipe = 'broadcast', delayMs = 3000) {
    const hasil = [];
    for (const p of daftarPelanggan) {
        // Replace variabel template
        let pesan = pesanTemplate
            .replace(/{nama}/g, p.nama)
            .replace(/{no_invoice}/g, p.no_invoice || '-')
            .replace(/{jumlah}/g, p.jumlah ? formatRp(p.jumlah) : '-')
            .replace(/{tgl_jatuh_tempo}/g, p.tgl_jatuh_tempo || '-')
            .replace(/{tgl_expired}/g, p.tgl_expired || '-')
            .replace(/{link_pembayaran}/g, p.payment_url || '-');

        const r = await kirimPesan(p.no_hp, pesan, p.id, tipe, p.invoice_id);
        hasil.push({ nama: p.nama, no_hp: p.no_hp, ...r });

        // Delay antar pesan sesuai setting — mencegah rate limit dari provider WA
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return hasil;
}

// ============================================================
// KIRIM DOKUMEN (mis. PDF invoice)
// ============================================================
// Otomatis pilih jalur: jika sesi WhatsApp QR (whatsapp-web.js) tersambung →
// kirim file lokal langsung; selain itu pakai provider API (butuh URL publik
// yang bisa di-fetch provider, jadi app_url harus mengarah ke server publik).
async function kirimDokumen(no_hp, {
    url = null, filePath = null, filename = 'dokumen.pdf', caption = '',
    pelanggan_id = null, invoice_id = null, tipe = 'dokumen'
} = {}) {
    // 1) Coba via mode QR bila tersambung & file lokal tersedia
    try {
        const waqr = require('./whatsapp-qr');
        if (filePath && waqr.getStatus && waqr.getStatus().status === 'connected') {
            return await waqr.kirimDokumenQR(no_hp, { filePath, caption, filename, pelanggan_id, invoice_id, tipe });
        }
    } catch (e) { /* modul QR tidak tersedia — lanjut ke provider */ }

    // 2) Mode provider — banyak paket provider (mis. Fonnte basic) tidak bisa
    //    melampirkan file. Sesuai konfigurasi: kirim sebagai TEKS + link unduh PDF.
    //    File PDF di /uploads sudah dapat diakses publik, jadi pelanggan tinggal klik.
    //    (Provider yang mendukung lampiran — WA Business/Wablas — bisa diubah ke
    //     pengiriman dokumen asli bila diperlukan, tapi default ini paling kompatibel.)
    if (!url)
        return { sukses: false, error: 'URL PDF publik tidak tersedia. Set app_url ke alamat server publik, atau aktifkan mode WhatsApp QR untuk lampiran file.' };

    const pesanLink = (caption ? caption + '\n\n' : '') + '📄 Invoice (PDF): ' + url;
    return await kirimPesan(no_hp, pesanLink, pelanggan_id, tipe, invoice_id);
}

module.exports = {
    kirimPesan,
    kirimDokumen,
    kirimReminder,
    kirimLinkBayar,
    kirimKonfirmasiBayar,
    kirimSuspend,
    kirimPelangganBaru,
    kirimOTP,
    kirimVoucher,
    broadcast,
    invalidateCache,
    getConfig
};
