// services/whatsapp.js — WhatsApp Gateway (Fonnte / Wablas / WA Business / WaNotif / Mandiri)
const axios = require('axios');
const fs = require('fs');
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

// Token untuk provider "Mandiri": UTAMAKAN baca dari .env gateway lokal
// (/opt/wa-gateway/.env) supaya pelanggan TIDAK perlu mengetik/melihat token.
// Fallback ke token dari setting (mis. gateway di server lain). Path di-hardcode
// (tidak menerima input dari user) demi keamanan — tidak ada path traversal.
function getMandiriToken(cfg) {
    try {
        const txt = fs.readFileSync('/opt/wa-gateway/.env', 'utf8');
        const m = txt.match(/^\s*WA_TOKEN\s*=\s*(.+?)\s*$/m);
        if (m && m[1]) return m[1].replace(/^["']|["']$/g, '');
    } catch (e) { /* .env tidak ada / tak terbaca → fallback ke setting */ }
    return (cfg && cfg.token) || '';
}

async function getConfig() {
    const now = Date.now();
    if (_cache && (now - _cacheAt) < CACHE_MS) return _cache;

    const rows = await query(
        `SELECT kunci, nilai FROM setting WHERE kunci IN
         ('wa_provider','wa_token','wa_sender','wa_phone_id',
          'wa_tpl_daftar','wa_tpl_reminder','wa_tpl_suspend',
          'wa_tpl_konfirmasi','wa_tpl_voucher_sukses','wa_tpl_invoice_baru','wa_mandiri_url','app_url')`
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
        wa_tpl_voucher_sukses: map.wa_tpl_voucher_sukses  || '',
        wa_tpl_invoice_baru:   map.wa_tpl_invoice_baru      || '',
        mandiriUrl:            map.wa_mandiri_url         || 'http://127.0.0.1:3200',
        appUrl:                map.app_url                  || process.env.APP_URL || ''
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
// ── ANTRIAN PESAN WA ──────────────────────────────────────
// Semua pesan otomatis masuk antrian, dikirim satu per satu dengan jeda
// acak antara wa_delay_min & wa_delay_max detik (diatur di panel).
// Tujuan: mencegah lonjakan kirim serentak yang berisiko blokir WhatsApp.
const _waQueue = [];
let _waWorkerJalan = false;

// Ambil setting delay (detik) dari DB, fallback 30-60
async function _getDelayAntrian() {
    try {
        const rows = await query(
            `SELECT kunci, nilai FROM setting WHERE kunci IN ('wa_delay_min','wa_delay_max')`);
        const m = {}; rows.forEach(r => m[r.kunci] = parseInt(r.nilai));
        let min = isNaN(m.wa_delay_min) ? 30 : m.wa_delay_min;
        let max = isNaN(m.wa_delay_max) ? 60 : m.wa_delay_max;
        min = Math.min(Math.max(min, 0), 600);
        max = Math.min(Math.max(max, 0), 600);
        if (min > max) { const t = min; min = max; max = t; }
        return { min, max };
    } catch (_) { return { min: 30, max: 60 }; }
}

// Worker: proses antrian satu per satu, tunda tiap pesan dgn jeda acak
async function _prosesAntrian() {
    if (_waWorkerJalan) return;
    _waWorkerJalan = true;
    while (_waQueue.length > 0) {
        const job = _waQueue.shift();
        // Tunda dulu SEBELUM kirim (termasuk pesan pertama/tunggal)
        const { min, max } = await _getDelayAntrian();
        const delay = Math.floor((min + Math.random() * (max - min)) * 1000);
        if (delay > 0) {
            console.log(`[WA Antrian] menunda ${(delay/1000).toFixed(1)}s sebelum kirim (sisa antrian: ${_waQueue.length + 1})`);
            await new Promise(res => setTimeout(res, delay));
        }
        try {
            const r = await _kirimPesanLangsung(job.no_hp, job.pesan, job.pelanggan_id, job.tipe, job.invoice_id);
            if (job.resolve) job.resolve(r);
        } catch (e) {
            if (job.resolve) job.resolve({ sukses: false, error: e.message });
        }
    }
    _waWorkerJalan = false;
}

// kirimPesan: masukkan ke antrian (TIDAK langsung kirim).
// OTP & pesan urgent pakai kirimPesanLangsung agar instan.
async function kirimPesan(no_hp, pesan, pelanggan_id = null, tipe = 'manual', invoice_id = null) {
    // OTP harus instan — jangan masuk antrian (kode bisa kadaluarsa)
    if (tipe === 'otp') {
        return _kirimPesanLangsung(no_hp, pesan, pelanggan_id, tipe, invoice_id);
    }
    return new Promise((resolve) => {
        _waQueue.push({ no_hp, pesan, pelanggan_id, tipe, invoice_id, resolve });
        _prosesAntrian();  // picu worker (kalau belum jalan)
    });
}

// Normalisasi nomor untuk gateway. Hasilkan DIGIT lengkap berkode negara
// TANPA "+" (mis. 628xxx utk ID, 60xxx utk Malaysia). Untuk Fonnte, dikirim
// bersama countryCode:'0' agar filter auto-62 Fonnte DIMATIKAN (kalau tidak,
// 60xxx jadi 6260xxx yang invalid). Nomor asli tetap disimpan apa adanya di wa_log.
function normalizePhoneFonnte(no) {
    let n = String(no || '').trim().replace(/[\s\-()+]/g, '');  // buang spasi, -, (), dan '+'
    if (!n) return n;
    if (n.startsWith('0')) return '62' + n.slice(1);   // 08xx -> 628xx (ID lokal)
    if (n.startsWith('8')) return '62' + n;            // 8xx  -> 628xx (ID tanpa 0)
    return n;                                          // 62xx / 60xx / kode negara lain -> apa adanya
}

// Kirim langsung tanpa antrian (untuk OTP / broadcast yang punya delay sendiri)
async function _kirimPesanLangsung(no_hp, pesan, pelanggan_id = null, tipe = 'manual', invoice_id = null) {
    const cfg = await getConfig();
    // nomor yang dipakai ke gateway (log tetap simpan no_hp asli)
    const no_kirim = normalizePhoneFonnte(no_hp);

    if (!cfg.token && cfg.provider !== 'mandiri') {
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
                target:  no_kirim,
                message: pesan,
                countryCode: '0',   // matikan filter auto-62 Fonnte; target sudah full E.164 (digits). WAJIB utk nomor luar ID (mis. +60).
            }, {
                headers: { Authorization: cfg.token }
            });

        } else if (cfg.provider === 'wablas') {
            response = await axios.post('https://solo.wablas.com/api/send-message', {
                phone:   no_kirim,
                message: pesan,
                isGroup: false
            }, {
                headers: { Authorization: cfg.token }
            });

        } else if (cfg.provider === 'wanotif') {
            response = await axios.post('https://app.wanotif.id/api/v1/send', {
                number:  no_kirim,
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
                    to: no_kirim,
                    type: 'text',
                    text: { body: pesan }
                },
                { headers: { Authorization: `Bearer ${cfg.token}` } }
            );
        } else if (cfg.provider === 'mandiri') {
            // WA Gateway Mandiri (self-hosted, Baileys) — POST ke service lokal.
            // Token diambil OTOMATIS dari /opt/wa-gateway/.env (fallback: field API Token).
            const base = (cfg.mandiriUrl || 'http://127.0.0.1:3200').replace(/\/+$/, '');
            const tok  = getMandiriToken(cfg);
            response = await axios.post(`${base}/send`,
                { to: no_kirim, message: pesan },
                { headers: { Authorization: `Bearer ${tok}` }, timeout: 30000 }
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
async function kirimReminder(opt) {
    const cfg = await getConfig();
    const {
        no_hp, nama, no_invoice, jumlah, tgl_jatuh_tempo, tgl_invoice,
        payment_url, pelanggan_id, invoice_id, nama_paket, metode_bayar
    } = opt || {};

    const fmtTgl = (v) => {
        if (!v) return '-';
        if (typeof v === 'string') { const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`; }
        const d = (v instanceof Date) ? v : new Date(v);
        if (isNaN(d.getTime())) return String(v).split(' ')[0];
        return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', day:'2-digit', month:'2-digit', year:'numeric' }).format(d).replace(/\//g,'-');
    };
    const angka = (v) => Number(v || 0).toLocaleString('id-ID');

    // Pastikan link bayar tersedia (generate kalau belum ada)
    const payUrl = await _pastikanPaymentUrl(
        { no_invoice, jumlah, payment_url, pelanggan_id }, null);

    // info pelanggan tambahan (profile, dll) bila ada pelanggan_id
    let pel = {};
    if (pelanggan_id) {
        try {
            pel = await queryOne(`
                SELECT p.*, pk.nama AS nama_paket, pk.rate_limit, pk.kecepatan_dn, pk.masa_aktif
                FROM pelanggan p LEFT JOIN paket pk ON p.paket_id=pk.id WHERE p.id=?`, [pelanggan_id]) || {};
        } catch(e) {}
    }

    let tpl = (cfg.wa_tpl_reminder || '').trim();
    if (!tpl) {
        tpl = `Halo *{nama}*,\n\nTagihan internet Anda akan segera jatuh tempo.\n\n📄 No. Invoice: *{no_invoice}*\n💰 Jumlah: *Rp {jumlah}*\n📅 Jatuh Tempo: *{tgl_jatuh_tempo}*\n\nBayar sekarang via:\n🔗 {payment_url}\n\nTerima kasih! 🙏`;
    }
    const data = {
        nama: nama || pel.nama || '', fullname: nama || pel.nama || '',
        username: pel.username || '-', uid: pel.username || '-',
        member_id: (pel.id != null ? String(pel.id) : '-'),
        profile: nama_paket || pel.nama_paket || '-', paket: nama_paket || pel.nama_paket || '-',
        phone: no_hp || pel.no_hp || '-', whatsapp: no_hp || pel.no_hp || '-',
        email: pel.email || '-', address: pel.alamat || '-',
        billing_status: 'Belum bayar',
        no_invoice: no_invoice || '-', invoice: no_invoice || '-',
        amount: angka(jumlah), jumlah: angka(jumlah), total: 'Rp ' + angka(jumlah),
        outstanding_amount: angka(jumlah),
        discount: '0', discount_percent: 0, ppn: '0', vat_percent: 0,
        payment_url: payUrl || payment_url || '-',
        payment_method: metode_bayar || '-',
        invoice_date: fmtTgl(tgl_invoice), period: fmtTgl(tgl_invoice),
        due_date: fmtTgl(tgl_jatuh_tempo), tgl_jatuh_tempo: fmtTgl(tgl_jatuh_tempo),
        next_suspend_at: fmtTgl(tgl_jatuh_tempo),
        kecepatan: pel.rate_limit || (pel.kecepatan_dn ? pel.kecepatan_dn + 'M' : '-'),
        masa_aktif: pel.masa_aktif || '-'
    };
    const pesan = _isiTemplate(tpl, data);
    return kirimPesan(no_hp, pesan, pelanggan_id || null, 'reminder', invoice_id || null);
}

// Link pembayaran baru
async function kirimLinkBayar(pelanggan, invoice) {
    const cfg = await getConfig();
    const fmtTgl = (v) => {
        if (!v) return '-';
        if (typeof v === 'string') { const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`; }
        const d = (v instanceof Date) ? v : new Date(v);
        if (isNaN(d.getTime())) return String(v).split(' ')[0];
        return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', day:'2-digit', month:'2-digit', year:'numeric' }).format(d).replace(/\//g,'-');
    };
    const angka = (v) => Number(v || 0).toLocaleString('id-ID');

    // Pastikan link bayar tersedia (generate via gateway bila belum ada)
    const payUrl = await _pastikanPaymentUrl({
        no_invoice: invoice.no_invoice, jumlah: invoice.jumlah,
        payment_url: invoice.payment_url, pelanggan_id: pelanggan.id
    }, pelanggan);

    let tpl = (cfg.wa_tpl_invoice_baru || '').trim();
    if (!tpl) {
        tpl = `Halo *{nama}*,\n\nTagihan internet bulan ini telah dibuat.\n\n📄 Invoice: *{no_invoice}*\n📦 Paket: *{paket}*\n💰 Tagihan: *Rp {jumlah}*\n📅 Jatuh Tempo: *{tgl_jatuh_tempo}*\n\nBayar mudah via QRIS / Transfer:\n🔗 {payment_url}\n\nAbaikan jika sudah membayar. Terima kasih! 🙏`;
    }
    const nama = pelanggan.nama || '';
    const data = {
        nama: nama, fullname: nama,
        username: pelanggan.username || '-', uid: pelanggan.username || '-',
        member_id: (pelanggan.id != null ? String(pelanggan.id) : '-'),
        profile: pelanggan.nama_paket || 'Internet', paket: pelanggan.nama_paket || 'Internet',
        phone: pelanggan.no_hp || '-', whatsapp: pelanggan.no_hp || '-',
        email: pelanggan.email || '-', address: pelanggan.alamat || '-',
        billing_status: 'Belum bayar',
        no_invoice: invoice.no_invoice || '-', invoice: invoice.no_invoice || '-',
        amount: angka(invoice.jumlah), jumlah: angka(invoice.jumlah), total: 'Rp ' + angka(invoice.jumlah),
        outstanding_amount: angka(invoice.jumlah),
        discount: '0', discount_percent: 0, ppn: '0', vat_percent: 0,
        payment_url: payUrl || invoice.payment_url || '-',
        payment_method: invoice.metode_bayar || '-',
        invoice_date: fmtTgl(invoice.tgl_invoice), period: fmtTgl(invoice.tgl_invoice),
        due_date: fmtTgl(invoice.tgl_jatuh_tempo), tgl_jatuh_tempo: fmtTgl(invoice.tgl_jatuh_tempo),
        next_suspend_at: fmtTgl(invoice.tgl_jatuh_tempo)
    };
    const pesan = _isiTemplate(tpl, data);
    return kirimPesan(pelanggan.no_hp, pesan, pelanggan.id, 'reminder', invoice.id);
}

// Ganti placeholder template. Mendukung format {x} DAN [x].
function _isiTemplate(tpl, data) {
    let out = tpl || '';
    for (const [k, v] of Object.entries(data)) {
        const val = (v === undefined || v === null) ? '-' : String(v);
        out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), val)
                 .replace(new RegExp('\\[' + k + '\\]', 'g'), val);
    }
    return out;
}

// Kembalikan link pembayaran untuk dikirim via WA.
// Mengarah ke HALAMAN BAYAR SimBill (/bayar/:no_invoice) yang menampilkan
// SEMUA metode aktif — pelanggan pilih sendiri, lalu diteruskan ke gateway.
// Ini lebih baik daripada link gateway tunggal (1 metode saja).
async function _pastikanPaymentUrl(invoice, pelanggan) {
    try {
        if (!invoice || !invoice.no_invoice) return '';
        const cfg = await getConfig();
        const base = (cfg.appUrl || process.env.APP_URL || '').replace(/\/+$/, '');
        if (!base) return invoice.payment_url || '';
        return `${base}/bayar/${encodeURIComponent(invoice.no_invoice)}`;
    } catch (e) {
        console.warn('[WA] _pastikanPaymentUrl error:', e.message);
        return invoice && invoice.payment_url ? invoice.payment_url : '';
    }
}

// Konfirmasi pembayaran diterima
// Ubah kode metode gateway (mis. Duitku "SP","OV","QR") jadi nama ramah.
// Tidak ketemu → tampilkan apa adanya (sudah pasti tidak kosong).
function _labelMetode(m) {
    if (!m) return m;
    const raw = String(m).trim();
    const up = raw.toUpperCase().replace(/[\s_-]+/g, '');
    const map = {
        SP:'ShopeePay', SL:'ShopeePay', SA:'ShopeePay', SHOPEEPAY:'ShopeePay',
        OV:'OVO', OL:'OVO', OVO:'OVO',
        DA:'DANA', DANA:'DANA',
        LA:'LinkAja', LF:'LinkAja', LINKAJA:'LinkAja',
        GP:'GoPay', GOPAY:'GoPay',
        QR:'QRIS', QRIS:'QRIS', GQ:'QRIS', NQ:'QRIS', SQ:'QRIS',
        VC:'Kartu Kredit', CC:'Kartu Kredit', CREDITCARD:'Kartu Kredit',
        BC:'BCA Virtual Account', M2:'Mandiri Virtual Account',
        I1:'BNI Virtual Account', VA:'BNI Virtual Account',
        BR:'BRI Virtual Account', BRIVA:'BRI Virtual Account',
        B1:'CIMB Niaga VA', BT:'Permata VA', PERMATAVA:'Permata VA',
        DM:'Danamon VA', A1:'ATM Bersama', AG:'Bank Artha Graha',
        NC:'Bank Neo Commerce', S1:'Bank Sahabat Sampoerna',
        BANKTRANSFER:'Transfer Bank', ECHANNEL:'Mandiri Bill',
        FT:'Retail (Alfamart/Indomaret)', IR:'Indomaret', A2:'Alfamart',
        CSTORE:'Retail', AKULAKU:'Akulaku', KREDIVO:'Kredivo',
    };
    return map[up] || raw;
}

async function kirimKonfirmasiBayar(opt) {
    const cfg = await getConfig();
    const {
        no_hp, nama, jumlah, tgl_expired, no_invoice, paket,
        metode_bayar, tgl_invoice, tgl_jatuh_tempo, periode,
        diskon, diskon_persen, ppn, ppn_persen, total
    } = opt || {};

    const angka = (v) => {
        const n = Number(v || 0);
        return n.toLocaleString('id-ID');
    };
    // Format tanggal jadi DD-MM-YYYY (buang jam & 'GMT+0700 (Western Indonesia time)').
    // Pakai timezone Asia/Jakarta agar tanggal tidak mundur/maju sehari di server UTC.
    const tgl = (v) => {
        if (v === undefined || v === null || v === '') return '-';
        // Jika sudah string 'YYYY-MM-DD...' ambil bagian tanggalnya langsung (paling aman).
        if (typeof v === 'string') {
            const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) return `${m[3]}-${m[2]}-${m[1]}`;
        }
        const d = (v instanceof Date) ? v : new Date(v);
        if (isNaN(d.getTime())) return String(v).split(' ')[0];
        // Format di zona Jakarta
        const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta',
            day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
        return f.replace(/\//g, '-'); // en-GB → DD/MM/YYYY → DD-MM-YYYY
    };

    // ── Anti-notif kosong: lengkapi field invoice dari DB bila caller tidak
    //    mengirimnya (mis. metode_bayar belum ter-update saat webhook menembak,
    //    atau caller hanya mengirim data minim). Hanya jika no_invoice diketahui. ──
    let v_no_invoice = no_invoice, v_paket = paket, v_metode = metode_bayar,
        v_tgl_invoice = tgl_invoice, v_tgl_jt = tgl_jatuh_tempo;
    if (v_no_invoice && (!v_paket || !v_metode || !v_tgl_invoice || !v_tgl_jt)) {
        try {
            const _r = await queryOne(
                `SELECT i.metode_bayar, i.tgl_invoice, i.tgl_jatuh_tempo, pk.nama AS nama_paket
                 FROM invoice i LEFT JOIN paket pk ON i.paket_id = pk.id
                 WHERE i.no_invoice = ? LIMIT 1`, [v_no_invoice]);
            if (_r) {
                v_paket       = v_paket       || _r.nama_paket;
                v_metode      = v_metode      || _r.metode_bayar;
                v_tgl_invoice = v_tgl_invoice || _r.tgl_invoice;
                v_tgl_jt      = v_tgl_jt       || _r.tgl_jatuh_tempo;
            }
        } catch (_e) { /* pakai data seadanya */ }
    }
    v_metode = _labelMetode(v_metode);

    const totalFinal = (total !== undefined && total !== null && total !== '')
        ? total : jumlah;

    // Periode layanan = tgl invoice s/d tgl expired (jatuh tempo berikutnya).
    // Kalau tgl_expired tak ada (paket VIP/unlimited), tampilkan tgl invoice saja.
    const _periodeStr = tgl_expired
        ? `${tgl(v_tgl_invoice)} s/d ${tgl(tgl_expired)}`
        : tgl(periode || v_tgl_invoice);
    // Pada konfirmasi pembayaran, "Jatuh Tempo" = tanggal aktif berikutnya
    // (cocok dengan billing/portal pelanggan), BUKAN jatuh tempo invoice lama
    // yang sudah dibayar.
    const _jatuhTempoStr = tgl_expired ? tgl(tgl_expired) : tgl(v_tgl_jt);

    const data = {
        // identitas
        nama: nama, fullname: nama,
        // nominal
        jumlah: angka(jumlah), amount: angka(jumlah),
        total: 'Rp ' + angka(totalFinal),
        diskon: angka(diskon), discount: angka(diskon),
        diskon_persen: (diskon_persen || 0), discount_percent: (diskon_persen || 0),
        ppn: angka(ppn), vat: angka(ppn),
        ppn_persen: (ppn_persen || 0), vat_percent: (ppn_persen || 0),
        // invoice
        no_invoice: v_no_invoice || '-', invoice: v_no_invoice || '-',
        profile: v_paket || '-', paket: v_paket || '-',
        payment_method: v_metode || '-', metode: v_metode || '-',
        invoice_date: tgl(v_tgl_invoice), tgl_invoice: tgl(v_tgl_invoice), tanggal: tgl(v_tgl_invoice),
        period: _periodeStr, periode: _periodeStr,
        // tanggal aktif/expired
        tgl_expired: tgl(tgl_expired), expired: tgl(tgl_expired),
        tgl_aktif: tgl(tgl_expired),
        next_suspend_at: _jatuhTempoStr,
        tgl_jatuh_tempo: _jatuhTempoStr, jatuh_tempo: _jatuhTempoStr
    };
    const tpl = (cfg.wa_tpl_konfirmasi || '').trim();
    const pesan = tpl
        ? _isiTemplate(tpl, data)
        : `Halo *${nama}*,

Pembayaran Anda telah kami terima! ✅

💰 Jumlah: *${formatRp(jumlah)}*
📅 Aktif hingga: *${tgl_expired}*

Internet Anda sudah aktif kembali. Terima kasih telah mempercayai layanan kami! 🙏`;

    return kirimPesan(no_hp, pesan, null, 'konfirmasi_bayar');
}

// Notifikasi suspend
async function kirimSuspend(pelanggan) {
    const cfg = await getConfig();
    const fmtTgl = (v) => {
        if (!v) return '-';
        if (typeof v === 'string') { const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`; }
        const d = (v instanceof Date) ? v : new Date(v);
        if (isNaN(d.getTime())) return String(v).split(' ')[0];
        return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', day:'2-digit', month:'2-digit', year:'numeric' }).format(d).replace(/\//g,'-');
    };
    const angka = (v) => Number(v || 0).toLocaleString('id-ID');

    // Lengkapi data dari DB: paket + invoice unpaid/overdue terbaru (untuk amount/total/payment_url).
    let pel = pelanggan;
    let inv = null;
    try {
        if (pelanggan.id) {
            pel = await queryOne(`
                SELECT p.*, pk.nama AS nama_paket, pk.harga, pk.rate_limit, pk.kecepatan_dn, pk.masa_aktif
                FROM pelanggan p LEFT JOIN paket pk ON p.paket_id = pk.id
                WHERE p.id = ?`, [pelanggan.id]) || pelanggan;
            inv = await queryOne(`
                SELECT no_invoice, jumlah, payment_url, metode_bayar, tgl_invoice, tgl_jatuh_tempo
                FROM invoice
                WHERE pelanggan_id = ? AND status IN ('unpaid','overdue')
                ORDER BY tgl_jatuh_tempo DESC LIMIT 1`, [pelanggan.id]);
        }
    } catch (e) { /* fallback ke data minimal */ }

    // Jika tidak ada invoice unpaid/overdue tapi pelanggan punya paket berbayar,
    // buat invoice baru agar pelanggan bisa langsung bayar dari pesan suspend.
    if (!inv && pel.id && Number(pel.harga) > 0) {
        try {
            const { withTransaction, generateUniqueInvoiceNo } = require('../config/db');
            const dayjs = require('dayjs');
            const prefix = process.env.INVOICE_PREFIX || 'INV';
            const tahun  = dayjs().format('YYYY');
            const tglInv = dayjs().format('YYYY-MM-DD');
            const tglJt  = dayjs().add(7, 'day').format('YYYY-MM-DD');
            const { no_invoice } = await withTransaction(db =>
                generateUniqueInvoiceNo(db, prefix, tahun, (noInv) =>
                    db.query(`INSERT INTO invoice (no_invoice, pelanggan_id, paket_id, jumlah, status, tgl_invoice, tgl_jatuh_tempo)
                              VALUES (?, ?, ?, ?, 'unpaid', ?, ?)`,
                        [noInv, pel.id, pel.paket_id, pel.harga, tglInv, tglJt])));
            inv = { no_invoice, jumlah: pel.harga, payment_url: null,
                    metode_bayar: null, tgl_invoice: tglInv, tgl_jatuh_tempo: tglJt };
        } catch (e) { console.warn('[WA suspend] gagal buat invoice:', e.message); }
    }

    const nama   = pel.nama || pelanggan.nama || '';
    const tagih  = inv ? inv.jumlah : (pel.harga || 0);
    // Pastikan ada link bayar (generate via payment gateway bila invoice belum punya)
    const payUrl = await _pastikanPaymentUrl(inv ? { ...inv, pelanggan_id: pel.id } : null, pel);

    let tpl = (cfg.wa_tpl_suspend || '').trim();
    if (!tpl) {
        tpl = `Halo *{nama}*,\n\nLayanan internet Anda telah *disuspend* karena tagihan belum dibayar.\n\nUntuk mengaktifkan kembali, silakan bayar tagihan Anda dan hubungi kami.\n\n📞 Admin: ${cfg.sender || '-'}`;
    }
    const data = {
        nama: nama, fullname: nama,
        username: pel.username || '-', uid: pel.username || '-',
        member_id: (pel.id != null ? String(pel.id) : '-'),
        profile: pel.nama_paket || '-', paket: pel.nama_paket || '-',
        phone: pel.no_hp || '-', whatsapp: pel.no_hp || '-',
        email: pel.email || '-', address: pel.alamat || '-',
        billing_status: 'Suspend',
        amount: angka(tagih), jumlah: angka(tagih), total: 'Rp ' + angka(tagih),
        outstanding_amount: angka(tagih),
        discount: '0', discount_percent: 0, ppn: '0', vat_percent: 0,
        payment_method: (inv && inv.metode_bayar) || '-',
        payment_url: payUrl || (inv && inv.payment_url) || '-',
        no_invoice: (inv && inv.no_invoice) || '-', invoice: (inv && inv.no_invoice) || '-',
        invoice_date: fmtTgl(inv && inv.tgl_invoice), period: fmtTgl(inv && inv.tgl_invoice),
        due_date: fmtTgl(inv && inv.tgl_jatuh_tempo),
        next_suspend_at: fmtTgl(inv && inv.tgl_jatuh_tempo),
        tgl_jatuh_tempo: fmtTgl(inv && inv.tgl_jatuh_tempo),
        kecepatan: pel.rate_limit || (pel.kecepatan_dn ? pel.kecepatan_dn + 'M' : '-'),
        masa_aktif: pel.masa_aktif || '-'
    };
    const pesan = _isiTemplate(tpl, data);
    return kirimPesan(pel.no_hp || pelanggan.no_hp, pesan, pel.id || pelanggan.id, 'suspend');
}

// Notifikasi pelanggan baru didaftarkan
async function kirimPelangganBaru(opt) {
    const cfg = await getConfig();
    const {
        no_hp, nama, username, password, nama_paket, tgl_expired,
        member_id, no_hp_pel, email, alamat, harga, total, kecepatan, masa_aktif
    } = opt || {};

    const fmtTgl = (v) => {
        if (!v) return '-';
        if (typeof v === 'string') { const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`; }
        const d = (v instanceof Date) ? v : new Date(v);
        if (isNaN(d.getTime())) return String(v).split(' ')[0];
        return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', day:'2-digit', month:'2-digit', year:'numeric' }).format(d).replace(/\//g,'-');
    };
    const angka = (v) => Number(v || 0).toLocaleString('id-ID');
    const totalFinal = (total !== undefined && total !== null && total !== '') ? total : harga;

    let tpl = (cfg.wa_tpl_daftar || '').trim();
    if (!tpl) {
        tpl = `Halo *{nama}*, selamat datang! 🎉\n\nAkun internet Anda telah aktif.\n\n🔑 Username: *{username}*\n🔒 Password: *{password}*\n📦 Paket: *{paket}*\n📅 Aktif hingga: *{tgl_expired}*\n\nSelamat menikmati layanan internet kami! 🌐`;
    }
    const data = {
        nama: nama, fullname: nama,
        username: username, uid: username,
        password: password,
        member_id: (member_id != null ? String(member_id) : '-'),
        profile: nama_paket || '-', paket: nama_paket || '-',
        phone: no_hp_pel || no_hp || '-', whatsapp: no_hp_pel || no_hp || '-',
        email: email || '-', address: alamat || '-',
        billing_status: 'Aktif',
        amount: angka(harga), jumlah: angka(harga), total: 'Rp ' + angka(totalFinal),
        kecepatan: kecepatan || '-', masa_aktif: masa_aktif || '-',
        tgl_expired: fmtTgl(tgl_expired), tgl_aktif: fmtTgl(tgl_expired),
        next_invoice_at: fmtTgl(tgl_expired), next_suspend_at: fmtTgl(tgl_expired),
        due_date: fmtTgl(tgl_expired)
    };
    const pesan = _isiTemplate(tpl, data);
    return kirimPesan(no_hp, pesan, null, 'daftar');
}

// Kirim OTP / kode voucher
async function kirimOTP(no_hp, kode) {
    const pesan = `Kode OTP Anda: *${kode}*\nBerlaku 5 menit. Jangan bagikan ke siapapun.`;
    return kirimPesan(no_hp, pesan, null, 'otp');
}

// Kirim voucher hotspot
async function kirimVoucher(a, b, c, d, e) {
    const cfg = await getConfig();
    // Dukung 2 cara panggil:
    //  - objek: kirimVoucher({ no_hp, nama, username, password, paket, masa_aktif, kecepatan, voucher_list, quantity })
    //  - argumen posisi (lama): kirimVoucher(no_hp, nama, username, password, expired_jam)
    let o;
    if (a && typeof a === 'object') {
        o = a;
    } else {
        o = { no_hp: a, nama: b, username: c, password: d, masa_aktif: e };
    }
    const {
        no_hp, nama, username, password,
        paket, masa_aktif, kecepatan, voucher_list, quantity
    } = o;

    const pw = password || username;
    const loginInfo = (pw === username)
        ? `🔑 Username/Password: *${username}*`
        : `🔑 Username: *${username}*\n🔒 Password: *${pw}*`;

    let tpl = (cfg.wa_tpl_voucher_sukses || '').trim();
    if (!tpl) {
        tpl = `Halo *{nama}*,\n\nBerikut voucher internet Anda:\n\n${loginInfo}\n⏰ Berlaku: *{masa_aktif}*\n\nCara pakai:\n1. Sambungkan ke WiFi hotspot\n2. Buka browser, masuk ke halaman login\n3. Masukkan username & password di atas\n\nSelamat menikmati! 🌐`;
    }
    const data = {
        nama: nama || '', fullname: nama || '',
        username: username || '-', uid: username || '-',
        password: pw || '-',
        paket: paket || '-', profile: paket || '-',
        masa_aktif: masa_aktif || '-',
        kecepatan: kecepatan || '-',
        voucher_list: voucher_list || username || '-',
        quantity: (quantity != null ? String(quantity) : '1'),
        phone: no_hp || '-', whatsapp: no_hp || '-'
    };
    const pesan = _isiTemplate(tpl, data);
    return kirimPesan(no_hp, pesan, null, 'voucher');
}

// Broadcast ke banyak nomor (dengan delay ACAK antara min & max agar natural)
async function broadcast(daftarPelanggan, pesanTemplate, tipe = 'broadcast', delayMinMs = 30000, delayMaxMs = 60000) {
    // Backward-compat: kalau dipanggil dgn satu nilai delay (lama), pakai sbg min=max
    if (delayMaxMs == null) delayMaxMs = delayMinMs;
    if (delayMinMs > delayMaxMs) { const t = delayMinMs; delayMinMs = delayMaxMs; delayMaxMs = t; }

    const hasil = [];
    const total = daftarPelanggan.length;
    let idx = 0;
    for (const p of daftarPelanggan) {
        idx++;
        // Replace variabel template
        let pesan = pesanTemplate
            .replace(/{nama}/g, p.nama)
            .replace(/{no_invoice}/g, p.no_invoice || '-')
            .replace(/{jumlah}/g, p.jumlah ? formatRp(p.jumlah) : '-')
            .replace(/{tgl_jatuh_tempo}/g, p.tgl_jatuh_tempo || '-')
            .replace(/{tgl_expired}/g, p.tgl_expired || '-')
            .replace(/{link_pembayaran}/g, p.payment_url || '-');

        const r = await _kirimPesanLangsung(p.no_hp, pesan, p.id, tipe, p.invoice_id);
        hasil.push({ nama: p.nama, no_hp: p.no_hp, ...r });

        // Delay ACAK antar pesan (kecuali pesan terakhir) — mencegah deteksi spam/blokir WA
        if (idx < total) {
            const delay = Math.floor(delayMinMs + Math.random() * (delayMaxMs - delayMinMs));
            console.log(`[WA Broadcast] ${idx}/${total} terkirim, tunggu ${(delay/1000).toFixed(1)}s`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
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
    getConfig,
    getMandiriToken
};
