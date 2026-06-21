// routes/client.js — Client Portal API
const router      = require('express').Router();
const jwt         = require('jsonwebtoken');
const bcrypt      = require('bcryptjs');
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');
const { query, queryOne } = require('../config/db');
const waService   = require('../services/whatsapp');
const radiusService = require('../services/radius');
const paymentService = require('../services/payment');
const sanitasi    = require('../utils/sanitasi');

const crypto      = require('crypto');
// JWT_SECRET dijamin sudah di-set & cukup panjang oleh validasi di server.js
// saat boot. Tidak ada fallback 'secret' — token client tak boleh bisa diforge.
const JWT_SECRET  = process.env.JWT_SECRET;
const OTP_EXPIRE  = 5 * 60 * 1000; // 5 menit

// ── Upload foto tiket ─────────────────────────────────────────
const uploadDir = path.join(__dirname, '../../frontend/uploads/tiket');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ── Auth middleware client ────────────────────────────────────
function clientAuth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token diperlukan' });
    try {
        req.client = jwt.verify(token, JWT_SECRET + '_client');
        next();
    } catch(e) { res.status(401).json({ error: 'Token tidak valid atau kadaluarsa' }); }
}

// ── POST /api/client/otp/kirim ────────────────────────────────
router.post('/otp/kirim', async (req, res, next) => {
    try {
        const { no_hp } = req.body;
        if (!no_hp) return res.status(400).json({ error: 'Nomor HP wajib diisi' });

        const noHpNormal = no_hp.replace(/\D/g,'').replace(/^0/,'62');

        // Cek apakah pelanggan terdaftar
        const pel = await queryOne(
            `SELECT id, nama FROM pelanggan WHERE REPLACE(REPLACE(no_hp,'-',''),' ','') = ? OR REPLACE(REPLACE(no_hp,'-',''),' ','') = ?`,
            [noHpNormal, '0'+noHpNormal.slice(2)]
        );
        if (!pel) return res.status(404).json({ error: 'Nomor HP tidak terdaftar sebagai pelanggan' });

        // Generate OTP 6 digit (CSPRNG — tidak bisa ditebak seperti Math.random)
        const otp = String(crypto.randomInt(100000, 1000000));

        // Simpan OTP. expired_at dihitung pakai NOW() MySQL (bukan JS Date) agar
        // konsisten dengan pengecekan "expired_at > NOW()" saat verifikasi —
        // tahan terhadap perbedaan timezone server/koneksi.
        await query(`
            INSERT INTO client_otp (no_hp, otp, expired_at, attempts, created_at)
            VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE), 0, NOW())
            ON DUPLICATE KEY UPDATE
                otp=?,
                expired_at=DATE_ADD(NOW(), INTERVAL 5 MINUTE),
                created_at=NOW(),
                attempts=0
        `, [noHpNormal, otp, otp]);

        // Kirim via WhatsApp
        const pesan = `*Kode OTP Login SimBill*\n\nKode Anda: *${otp}*\n\nBerlaku 5 menit. Jangan bagikan ke siapapun.`;
        await waService.kirimPesan(noHpNormal, pesan, pel.id, 'otp');

        res.json({ pesan: 'OTP dikirim ke WhatsApp', nama: pel.nama });
    } catch(e) { next(e); }
});

// ── POST /api/client/otp/verifikasi ──────────────────────────
router.post('/otp/verifikasi', async (req, res, next) => {
    try {
        const { no_hp, otp } = req.body;
        const noHpNormal = no_hp.replace(/\D/g,'').replace(/^0/,'62');
        const MAKS_PERCOBAAN = 5;

        // Ambil baris OTP berdasarkan nomor saja (bukan nomor+otp), supaya bisa
        // menghitung percobaan gagal dan mengunci brute-force.
        const record = await queryOne(
            `SELECT * FROM client_otp WHERE no_hp=? AND expired_at > NOW()`,
            [noHpNormal]
        );
        if (!record)
            return res.status(400).json({ error: 'OTP salah atau sudah kadaluarsa' });

        if (record.attempts >= MAKS_PERCOBAAN) {
            await query('DELETE FROM client_otp WHERE no_hp=?', [noHpNormal]);
            return res.status(429).json({ error: 'Terlalu banyak percobaan. Minta OTP baru.' });
        }

        if (String(record.otp) !== String(otp)) {
            await query('UPDATE client_otp SET attempts = attempts + 1 WHERE no_hp=?', [noHpNormal]);
            const sisa = MAKS_PERCOBAAN - (record.attempts + 1);
            return res.status(400).json({
                error: sisa > 0
                    ? `OTP salah. Sisa percobaan: ${sisa}.`
                    : 'OTP salah. Percobaan habis, minta OTP baru.'
            });
        }

        const pel = await queryOne(
            `SELECT id, nama, username, no_hp, email, alamat, tipe_koneksi, status, paket_id FROM pelanggan
             WHERE REPLACE(REPLACE(no_hp,'-',''),' ','') = ? OR REPLACE(REPLACE(no_hp,'-',''),' ','') = ?`,
            [noHpNormal, '0'+noHpNormal.slice(2)]
        );
        if (!pel) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        // Hapus OTP setelah berhasil
        await query('DELETE FROM client_otp WHERE no_hp=?', [noHpNormal]);

        const token = jwt.sign(
            { id: pel.id, no_hp: noHpNormal, username: pel.username },
            JWT_SECRET + '_client',
            { expiresIn: '24h' }
        );

        res.json({ token, pelanggan: pel });
    } catch(e) { next(e); }
});

// ── GET /api/client/profil ────────────────────────────────────
router.get('/profil', clientAuth, async (req, res, next) => {
    try {
        const pel = await queryOne(`
            SELECT p.id, p.nama, p.username, p.no_hp, p.email, p.alamat,
                   p.tipe_koneksi, p.status, p.tgl_expired,
                   pk.nama AS nama_paket, pk.kecepatan_dn, pk.kecepatan_up,
                   pk.masa_aktif, pk.satuan_masa, pk.harga
            FROM pelanggan p
            LEFT JOIN paket pk ON p.paket_id = pk.id
            WHERE p.id = ?
        `, [req.client.id]);
        if (!pel) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
        res.json(pel);
    } catch(e) { next(e); }
});

// ── GET /api/client/tagihan ───────────────────────────────────
router.get('/tagihan', clientAuth, async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT i.*, pk.nama AS nama_paket
            FROM invoice i
            LEFT JOIN paket pk ON i.paket_id = pk.id
            WHERE i.pelanggan_id = ?
            ORDER BY i.tgl_invoice DESC
            LIMIT 12
        `, [req.client.id]);
        res.json(rows);
    } catch(e) { next(e); }
});

// ── POST /api/client/tagihan/:id/bayar ───────────────────────
router.post('/tagihan/:id/bayar', clientAuth, async (req, res, next) => {
    try {
        const inv = await queryOne(
            `SELECT i.*, p.nama, p.no_hp, pk.nama AS nama_paket
             FROM invoice i
             JOIN pelanggan p ON i.pelanggan_id = p.id
             LEFT JOIN paket pk ON i.paket_id = pk.id
             WHERE i.id = ? AND i.pelanggan_id = ?`,
            [req.params.id, req.client.id]
        );
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
        if (inv.status === 'paid') return res.status(400).json({ error: 'Invoice sudah dibayar' });

        const pg = await paymentService.buatTransaksi({
            order_id:     inv.no_invoice + '_retry_' + Date.now(),
            gross_amount: inv.jumlah,
            pelanggan: {
                nama:       inv.nama,
                no_hp:      inv.no_hp,
                username:   req.client.username || '',
                email:      inv.no_hp + '@client.id',
                paket_id:   inv.paket_id,
                nama_paket: inv.nama_paket
            }
        });

        if (pg && pg.payment_url) {
            await query(`UPDATE invoice SET payment_id=?, payment_url=? WHERE id=?`,
                [pg.order_id, pg.payment_url, inv.id]);
            res.json({ payment_url: pg.payment_url, order_id: pg.order_id });
        } else {
            res.status(503).json({ error: 'Payment gateway tidak tersedia, hubungi admin' });
        }
    } catch(e) { next(e); }
});

// ── POST /api/client/ganti-password ──────────────────────────
router.post('/ganti-password', clientAuth, async (req, res, next) => {
    try {
        const { password_baru } = req.body;
        if (!password_baru || password_baru.length < 6)
            return res.status(400).json({ error: 'Password minimal 6 karakter' });

        const pel = await queryOne('SELECT * FROM pelanggan WHERE id=?', [req.client.id]);
        if (!pel) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        // Update password di DB (hash)
        const hash = await bcrypt.hash(password_baru, 12);
        await query('UPDATE pelanggan SET password=? WHERE id=?', [hash, pel.id]);

        // Update di radcheck (plaintext untuk FreeRADIUS)
        await query(`
            INSERT INTO radcheck (username, attribute, op, value)
            VALUES (?, 'Cleartext-Password', ':=', ?)
            ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, [pel.username, password_baru]);

        // Simpan password terenkripsi untuk sync
        const { encryptPassword } = require('../services/radius');
        await query('UPDATE pelanggan SET radius_password_enc=? WHERE id=?',
            [encryptPassword(password_baru), pel.id]).catch(()=>{});

        res.json({ pesan: 'Password berhasil diganti dan langsung aktif di jaringan' });
    } catch(e) { next(e); }
});

// ── GET /api/client/tiket ─────────────────────────────────────
router.get('/tiket', clientAuth, async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT t.*, COUNT(r.id) AS jumlah_reply
            FROM tiket t
            LEFT JOIN tiket_reply r ON t.id = r.tiket_id
            WHERE t.pelanggan_id = ?
            GROUP BY t.id
            ORDER BY t.created_at DESC
        `, [req.client.id]);
        res.json(rows);
    } catch(e) { next(e); }
});

// ── GET /api/client/acs-device — cek router pelanggan di ACS ──
router.get('/acs-device', clientAuth, async (req, res, next) => {
    try {
        const device = await queryOne(
            'SELECT id, serial_number, manufacturer, product_class, ip_address, software_version, status, last_inform FROM acs_device WHERE pelanggan_id=? ORDER BY last_inform DESC LIMIT 1',
            [req.client.id]
        );
        res.json(device || null);
    } catch(e) { next(e); }
});

// ── POST /api/client/wifi — ganti password WiFi via ACS ───────
router.post('/wifi', clientAuth, async (req, res, next) => {
    try {
        const { ssid, password } = req.body;
        if (!password || password.length < 8)
            return res.status(400).json({ error: 'Password minimal 8 karakter' });

        // Cek apakah pelanggan punya device ACS
        const device = await queryOne(
            'SELECT * FROM acs_device WHERE pelanggan_id=? ORDER BY last_inform DESC LIMIT 1',
            [req.client.id]
        );

        if (device) {
            // Kirim via ACS TR-069
            const { getWifiParams } = require('../services/acs');
            const wifiParams = getWifiParams(device.manufacturer);
            const pairs = [];
            if (ssid) pairs.push({ name: wifiParams.ssid, value: ssid });
            pairs.push({ name: wifiParams.password, value: password });

            await query('INSERT INTO acs_task (device_id, type, params, status, created_by) VALUES (?,?,?,?,?)',
                [device.id, 'SetParameterValues', JSON.stringify(pairs), 'pending', 'pelanggan']);

            res.json({
                sukses: true,
                via: 'acs',
                pesan: 'Perintah dikirim ke router. Password akan berubah dalam beberapa menit (saat router polling ke ACS).'
            });
        } else {
            // Fallback: buat tiket
            const pel = await queryOne('SELECT nama, no_hp, username FROM pelanggan WHERE id=?', [req.client.id]);
            const pesanTiket = `Pelanggan meminta ganti password WiFi.\n\nSSID baru: ${ssid || '(tidak diganti)'}\nPassword baru: ${password}`;
            const result = await query(
                `INSERT INTO tiket (pelanggan_id, judul, pesan, kategori, status) VALUES (?, 'Ganti Password WiFi', ?, 'lainnya', 'open')`,
                [req.client.id, pesanTiket]
            );

            // Notif admin
            try {
                const cfg = await query("SELECT kunci, nilai FROM setting WHERE kunci IN ('admin_no_hp','app_name')");
                const map = {};
                cfg.forEach(c => map[c.kunci] = c.nilai);
                if (map.admin_no_hp) {
                    const notif = `🔑 *Request Ganti Password WiFi*\n\nDari: ${pel.nama} (${pel.username})\nSSID: ${ssid || '-'}\nPassword: ${password}\n\nSegera proses di dashboard admin.`;
                    await waService.kirimPesan(map.admin_no_hp, notif, req.client.id, 'tiket');
                }
            } catch(e) {}

            res.json({
                sukses: true,
                via: 'tiket',
                tiket_id: result.insertId,
                pesan: 'Router Anda belum terhubung ke ACS. Permintaan sudah diteruskan ke admin dan akan diproses segera.'
            });
        }
    } catch(e) { next(e); }
});

// ── GET /api/client/wifi-tasks — riwayat task WiFi pelanggan ──
router.get('/wifi-tasks', clientAuth, async (req, res, next) => {
    try {
        const device = await queryOne('SELECT id FROM acs_device WHERE pelanggan_id=? ORDER BY last_inform DESC LIMIT 1', [req.client.id]);
        if (!device) {
            // Ambil dari tiket
            const tikets = await query(
                `SELECT id, judul, status, created_at FROM tiket WHERE pelanggan_id=? AND judul LIKE '%Password WiFi%' ORDER BY created_at DESC LIMIT 5`,
                [req.client.id]
            );
            return res.json({ via: 'tiket', items: tikets });
        }
        const tasks = await query(
            `SELECT * FROM acs_task WHERE device_id=? AND type='SetParameterValues' ORDER BY id DESC LIMIT 5`,
            [device.id]
        );
        res.json({ via: 'acs', items: tasks });
    } catch(e) { next(e); }
});

// ── POST /api/client/tiket ────────────────────────────────────
router.post('/tiket', clientAuth, upload.single('foto'), async (req, res, next) => {
    try {
        let { judul, pesan, kategori } = req.body;
        if (!judul || !pesan) return res.status(400).json({ error: 'Judul dan pesan wajib diisi' });
        // Lapis kedua: pelanggan menulis ini → admin membacanya. Buang karakter
        // kontrol & batasi panjang (cegah write ekstrem / log injection).
        judul   = sanitasi.teksSatuBaris(judul, 150);
        pesan   = sanitasi.teksMultiBaris(pesan, 4000);
        kategori = sanitasi.teksSatuBaris(kategori || 'umum', 30) || 'umum';
        if (!judul || !pesan) return res.status(400).json({ error: 'Judul dan pesan tidak boleh kosong' });

        const foto = req.file ? '/uploads/tiket/' + req.file.filename : null;
        const result = await query(`
            INSERT INTO tiket (pelanggan_id, judul, pesan, kategori, foto, status)
            VALUES (?, ?, ?, ?, ?, 'open')
        `, [req.client.id, judul, pesan, kategori || 'umum', foto]);

        // Kirim notif WA ke admin
        try {
            const pel = await queryOne('SELECT nama, no_hp, username FROM pelanggan WHERE id=?', [req.client.id]);
            const cfg = await query("SELECT kunci, nilai FROM setting WHERE kunci IN ('admin_no_hp','app_name')");
            const map = {};
            cfg.forEach(c => map[c.kunci] = c.nilai);
            if (map.admin_no_hp) {
                const notif = `🎫 *Tiket Baru - ${map.app_name || 'SimBill'}*\n\nDari: ${pel.nama} (${pel.username})\nKategori: ${kategori || 'umum'}\nJudul: ${judul}\n\nSegera cek dashboard admin.`;
                await waService.kirimPesan(map.admin_no_hp, notif, pel.id || null, 'tiket');
            }
        } catch(notifErr) { console.warn('[tiket] Notif WA gagal:', notifErr.message); }

        // Notif Telegram ke teknisi
        try {
            const pel = await queryOne('SELECT nama, username, no_hp FROM pelanggan WHERE id=?', [req.client.id]);
            const katLabel = { umum:'Umum', gangguan:'Gangguan', billing:'Billing', lainnya:'Lainnya' }[kategori] || 'Umum';
            const teks = `🎫 <b>Tiket Baru Masuk</b>\n\n` +
                `👤 ${pel?.nama || '-'} (${pel?.username || '-'})\n` +
                `📁 Kategori: <b>${katLabel}</b>\n` +
                `📝 ${judul}\n\n` +
                `${(pesan || '').slice(0, 300)}\n\n` +
                (pel?.no_hp ? `📞 ${pel.no_hp}` : '');
            await require('../services/telegram').notif('tiket', teks);
        } catch(tgErr) { console.warn('[tiket] Notif TG gagal:', tgErr.message); }

        res.status(201).json({ id: result.insertId, pesan: 'Tiket berhasil dibuat' });
    } catch(e) { next(e); }
});

// ── GET /api/client/tiket/:id ─────────────────────────────────
router.get('/tiket/:id', clientAuth, async (req, res, next) => {
    try {
        const tiket = await queryOne(
            'SELECT * FROM tiket WHERE id=? AND pelanggan_id=?',
            [req.params.id, req.client.id]
        );
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });

        const reply = await query(
            'SELECT * FROM tiket_reply WHERE tiket_id=? ORDER BY created_at ASC',
            [req.params.id]
        );
        res.json({ ...tiket, reply });
    } catch(e) { next(e); }
});

// ── GET /api/client/sesi ──────────────────────────────────────
router.get('/sesi', clientAuth, async (req, res, next) => {
    try {
        const pel = await queryOne('SELECT username FROM pelanggan WHERE id=?', [req.client.id]);
        if (!pel) return res.json([]);
        const rows = await query(`
            SELECT nasipaddress, framedipaddress, acctstarttime,
                   TIMESTAMPDIFF(MINUTE, acctstarttime, NOW()) AS durasi_menit,
                   ROUND((acctinputoctets+acctoutputoctets)/1048576,2) AS total_mb
            FROM radacct
            WHERE username=? AND acctstoptime IS NULL
            ORDER BY acctstarttime DESC
        `, [pel.username]);
        res.json(rows);
    } catch(e) { next(e); }
});

// ── GET /api/client/perangkat-wifi — perangkat terhubung (dari ACS Hosts) ──
function parseHostsFromCache(cache) {
    const map = {};
    const re = /Hosts\.Host\.(\d+)\.(HostName|IPAddress|MACAddress|Active|AddressSource|InterfaceType|LeaseTimeRemaining)$/i;
    for (const k in cache) {
        const m = k.match(re);
        if (!m) continue;
        const idx = m[1], field = m[2].toLowerCase();
        (map[idx] = map[idx] || {})[field] = cache[k];
    }
    return Object.keys(map).map(i => ({
        hostname: map[i].hostname || '',
        ip:       map[i].ipaddress || '',
        mac:      (map[i].macaddress || '').toUpperCase(),
        active:   /^(1|true)$/i.test(map[i].active || ''),
        iface:    map[i].interfacetype || '',
        sumber:   map[i].addresssource || ''
    })).filter(h => h.mac || h.ip || h.hostname);
}

router.get('/perangkat-wifi', clientAuth, async (req, res, next) => {
    try {
        const device = await queryOne(
            'SELECT id, param_cache, manufacturer, last_inform FROM acs_device WHERE pelanggan_id=? ORDER BY last_inform DESC LIMIT 1',
            [req.client.id]
        );
        if (!device) return res.json({ device: false, perangkat: [], last_inform: null });

        let cache = {};
        try { cache = JSON.parse(device.param_cache || '{}'); } catch(e) {}
        let perangkat = parseHostsFromCache(cache);
        // perangkat aktif dulu, lalu urut nama
        perangkat.sort((a, b) => (b.active - a.active) || (a.hostname || a.ip).localeCompare(b.hostname || b.ip));

        // Antri refresh (sekali saja kalau belum ada task pending/running)
        try {
            const ada = await queryOne(
                'SELECT id FROM acs_task WHERE device_id=? AND type="GetParameterValues" AND status IN ("pending","running") LIMIT 1',
                [device.id]
            );
            if (!ada) {
                await query(
                    'INSERT INTO acs_task (device_id, type, status, created_by) VALUES (?,?,?,?)',
                    [device.id, 'GetParameterValues', 'pending', 'client']
                );
            }
        } catch(e) {}

        res.json({ device: true, last_inform: device.last_inform, perangkat });
    } catch(e) { next(e); }
});

// ── PUT /api/client/profil — update profil sendiri (kecuali username & paket) ──
router.put('/profil', clientAuth, async (req, res, next) => {
    try {
        let { nama, no_hp, email, alamat } = req.body;
        // Buang < > agar nama/alamat tak bisa menyisipkan tag HTML yang
        // dirender di panel admin (pertahanan stored-XSS di sumber).
        const tanpaTag = s => (s || '').replace(/[<>]/g, '');
        nama   = sanitasi.teksSatuBaris(tanpaTag(nama), 100);
        no_hp  = (no_hp || '').trim();
        email  = (email || '').trim();
        alamat = sanitasi.teksSatuBaris(tanpaTag(alamat), 200);
        if (!nama) return res.status(400).json({ error: 'Nama wajib diisi' });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
            return res.status(400).json({ error: 'Format email tidak valid' });
        if (no_hp && !/^[0-9+]{8,16}$/.test(no_hp))
            return res.status(400).json({ error: 'Nomor HP tidak valid' });

        await query(
            'UPDATE pelanggan SET nama=?, no_hp=?, email=?, alamat=? WHERE id=?',
            [nama, no_hp || null, email || null, alamat || null, req.client.id]
        );
        res.json({ pesan: 'Profil berhasil diperbarui' });
    } catch(e) { next(e); }
});

// ── GET /api/client/invoice/:id/pdf — download PDF invoice milik sendiri ──
router.get('/invoice/:id/pdf', clientAuth, async (req, res, next) => {
    try {
        const inv = await queryOne(
            'SELECT id, no_invoice FROM invoice WHERE id=? AND pelanggan_id=?',
            [req.params.id, req.client.id]
        );
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
        const invoicePdf = require('../services/invoice-pdf');
        const { filePath, no_invoice } = await invoicePdf.buatInvoicePDF(inv.id);
        res.download(filePath, `${no_invoice || inv.no_invoice || 'invoice'}.pdf`);
    } catch(e) {
        console.warn('[client invoice pdf]', e.message);
        if (!res.headersSent) res.status(500).json({ error: 'Gagal membuat PDF invoice' });
    }
});

// ── GET /api/client/pemakaian — total unduh/unggah bulan berjalan ──
router.get('/pemakaian', clientAuth, async (req, res, next) => {
    try {
        const pel = await queryOne('SELECT username FROM pelanggan WHERE id=?', [req.client.id]);
        if (!pel) return res.json({ download_bytes: 0, upload_bytes: 0 });
        const rows = await query(`
            SELECT COALESCE(SUM(acctoutputoctets),0) AS download_bytes,
                   COALESCE(SUM(acctinputoctets),0)  AS upload_bytes
            FROM radacct
            WHERE username=?
              AND (acctstarttime >= DATE_FORMAT(NOW(),'%Y-%m-01') OR acctstoptime IS NULL)
        `, [pel.username]);
        const r = rows[0] || {};
        res.json({
            download_bytes: Number(r.download_bytes) || 0,
            upload_bytes:   Number(r.upload_bytes)   || 0
        });
    } catch(e) { next(e); }
});

module.exports = router;

// ── POST /api/client/tiket/:id/reply ─────────────────────────
router.post('/tiket/:id/reply', clientAuth, async (req, res, next) => {
    try {
        let { pesan, dari } = req.body;
        if (!pesan) return res.status(400).json({ error: 'Pesan wajib diisi' });
        pesan = sanitasi.teksMultiBaris(pesan, 4000);
        if (!pesan) return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
        const tiket = await queryOne('SELECT * FROM tiket WHERE id=? AND pelanggan_id=?',
            [req.params.id, req.client.id]);
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
        await query(`INSERT INTO tiket_reply (tiket_id, dari, pesan) VALUES (?,?,?)`,
            [req.params.id, dari || 'pelanggan', pesan]);
        await query(`UPDATE tiket SET updated_at=NOW() WHERE id=?`, [req.params.id]);
        res.json({ pesan: 'Balasan terkirim' });
    } catch(e) { next(e); }
});
