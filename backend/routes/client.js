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
                   pk.nama AS nama_paket, pk.kecepatan_dn, pk.kecepatan_up
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

// ── POST /api/client/perpanjang — self-service perpanjang (prabayar) ──
// Buat/gunakan invoice perpanjangan, balikin link bayar. order_id = no_invoice
// (BUKAN retry-suffix) agar webhook bisa mencocokkan & memperpanjang tgl_expired.
router.post('/perpanjang', clientAuth, async (req, res, next) => {
    try {
        const dayjs = require('dayjs');
        const { withTransaction, generateUniqueInvoiceNo } = require('../config/db');
        const INVOICE_PREFIX = process.env.INVOICE_PREFIX || 'INV';

        const p = await queryOne(`
            SELECT pl.*, pk.id AS paket_id, pk.nama AS nama_paket, pk.harga
            FROM pelanggan pl JOIN paket pk ON pl.paket_id = pk.id
            WHERE pl.id = ?`, [req.client.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
        if (!p.harga || Number(p.harga) <= 0)
            return res.status(400).json({ error: 'Paket belum memiliki harga. Hubungi admin.' });

        // Sudah ada invoice belum lunas → pakai itu (cegah tagihan dobel).
        let inv = await queryOne(`
            SELECT id, no_invoice, jumlah, payment_url FROM invoice
            WHERE pelanggan_id = ? AND status IN ('unpaid','overdue')
            ORDER BY tgl_jatuh_tempo DESC LIMIT 1`, [req.client.id]);

        // Invoice lama sudah punya link bayar aktif → langsung pakai (hindari
        // duplikat order_id di gateway).
        if (inv && inv.payment_url)
            return res.json({ payment_url: inv.payment_url, no_invoice: inv.no_invoice, jumlah: inv.jumlah, reused: true });

        // Belum ada invoice → buat baru (anti-reuse numbering).
        if (!inv) {
            const tahun = dayjs().format('YYYY');
            const tglJatuh = dayjs().format('YYYY-MM-DD');
            const r = await withTransaction(db =>
                generateUniqueInvoiceNo(db, INVOICE_PREFIX, tahun, (noInv) =>
                    db.query(`
                        INSERT INTO invoice (no_invoice, pelanggan_id, paket_id, jumlah,
                            tgl_invoice, tgl_jatuh_tempo, keterangan)
                        VALUES (?,?,?,?,CURDATE(),?, 'Perpanjangan prabayar (portal)')
                    `, [noInv, req.client.id, p.paket_id, p.harga, tglJatuh])
                )
            );
            inv = { id: r.result.insertId, no_invoice: r.no_invoice, jumlah: p.harga };
        }

        // Buat link bayar — order_id = no_invoice (agar webhook cocok).
        const pg = await paymentService.buatTransaksi({
            order_id:     inv.no_invoice,
            gross_amount: inv.jumlah,
            pelanggan: {
                nama: p.nama, no_hp: p.no_hp, username: p.username,
                email: p.email || (p.no_hp + '@client.id'),
                paket_id: p.paket_id, nama_paket: p.nama_paket
            }
        });
        if (pg && pg.payment_url) {
            await query(`UPDATE invoice SET payment_id=?, payment_url=? WHERE id=?`,
                [pg.order_id, pg.payment_url, inv.id]);
            return res.json({ payment_url: pg.payment_url, no_invoice: inv.no_invoice, jumlah: inv.jumlah });
        }
        res.status(503).json({ error: 'Payment gateway tidak tersedia, hubungi admin.' });
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

// ── GET /api/client/acs-device — cek router pelanggan di ACS (GenieACS/ACS Lite) ──
router.get('/acs-device', clientAuth, async (req, res, next) => {
    try {
        const dev = await cariDeviceACS(req.client.id);
        if (!dev) return res.json(null);
        const li = dev.last_inform || dev.last_inform_time || null;
        let online = false;
        if (li) { const _m = (Date.now() - new Date(li).getTime()) / 60000; online = _m >= -5 && _m <= 30; }
        res.json({
            serial_number:    dev.serial_number,
            manufacturer:     dev.manufacturer,
            product_class:    dev.model || dev.product_class || '',
            ip_address:       dev.ip_address,
            software_version: dev.software_version,
            ssid:             dev.ssid || '',
            status:           online ? 'online' : 'offline',   // dihitung dari last_inform (≤30 mnt)
            last_inform:      li,
            genie_id:         dev.genie_id || null,
            source:           dev.source || 'genieacs'
        });
    } catch(e) { next(e); }
});

// ── POST /api/client/wifi — ganti password WiFi via ACS ───────
router.post('/wifi', clientAuth, async (req, res, next) => {
    try {
        const { ssid, password } = req.body;
        if (!password || password.length < 8)
            return res.status(400).json({ error: 'Password minimal 8 karakter' });

        // Cari device pelanggan di ACS (GenieACS + ACS Lite, pilih yang teraktif).
        // Prioritas match: link manual (acs_link) > auto-match username PPPoE.
        const pel = await queryOne('SELECT nama, no_hp, username FROM pelanggan WHERE id=?', [req.client.id]);
        const genie = require('../services/genieacs');
        const dev = await cariDeviceACS(req.client.id);

        // ACS Lite → SetParameterValues langsung ke GoACS
        if (dev && dev.source === 'acslite' && (dev.ssid_path || dev.pass_path)) {
            const axios = require('axios');
            const cfg = await _acsliteCfg();
            const parameters = {};
            if (dev.ssid_path && ssid)     parameters[dev.ssid_path] = ssid;
            if (dev.pass_path && password) parameters[dev.pass_path] = password;
            if (Object.keys(parameters).length) {
                await axios.post(`${cfg.url}/api/tasks`, { name: 'SetParameterValues', payload: { parameters } }, {
                    headers: { 'Content-Type': 'application/json', ...(cfg.key ? { 'X-API-Key': cfg.key } : {}) },
                    params: { sn: dev.serial_number }, timeout: 12000
                });
                return res.json({
                    sukses: true,
                    via: 'acslite',
                    pesan: 'Perintah dikirim ke router via ACS Lite. Password akan berubah dalam beberapa menit (saat router polling ke ACS).'
                });
            }
        }

        if (dev && dev.genie_id) {
            // Kirim via GenieACS (TR-069)
            await genie.setWifi(dev.genie_id, { ssid, password });
            return res.json({
                sukses: true,
                via: 'genieacs',
                pesan: 'Perintah dikirim ke router via GenieACS. Password akan berubah dalam beberapa menit (saat router polling ke ACS).'
            });
        }

        // Fallback: device tak ketemu di GenieACS → buat tiket untuk admin
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
            pesan: 'Router Anda belum terdeteksi di GenieACS. Permintaan sudah diteruskan ke admin dan akan diproses segera.'
        });
    } catch(e) { next(e); }
});

// ── GET /api/client/wifi-tasks — riwayat task WiFi pelanggan ──
router.get('/wifi-tasks', clientAuth, async (req, res, next) => {
    try {
        const tikets = await query(
            `SELECT id, judul, status, created_at FROM tiket WHERE pelanggan_id=? AND judul LIKE '%Password WiFi%' ORDER BY created_at DESC LIMIT 5`,
            [req.client.id]
        );
        res.json({ via: 'tiket', items: tikets });
    } catch(e) { next(e); }
});

// ── POST /api/client/ganti-akun — ganti username & sandi (HOTSPOT) ──
// Khusus pelanggan hotspot: mereka login captive-portal pakai username +
// password RADIUS. (PPPoE TIDAK boleh ganti via sini: username/sandi PPPoE
// tersimpan di ONU, kalau diubah di RADIUS saja koneksi malah putus.)
router.post('/ganti-akun', clientAuth, async (req, res, next) => {
    try {
        const p = await queryOne('SELECT id, username, tipe_koneksi FROM pelanggan WHERE id=?', [req.client.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
        if (p.tipe_koneksi !== 'hotspot')
            return res.status(400).json({ error: 'Fitur ganti username/sandi ini khusus pelanggan hotspot' });

        let usernameBaru = (req.body.username_baru || '').trim();
        let passwordBaru = (req.body.password_baru || '').trim();
        if (!usernameBaru && !passwordBaru)
            return res.status(400).json({ error: 'Isi username baru dan/atau password baru' });

        const usernameLama = p.username;
        let usernameFinal  = usernameLama;

        // ── Validasi & siapkan ganti username ──
        if (usernameBaru && usernameBaru !== usernameLama) {
            if (!/^[A-Za-z0-9._-]{3,32}$/.test(usernameBaru))
                return res.status(400).json({ error: 'Username 3-32 karakter (huruf, angka, titik, garis bawah, strip)' });
            const cek = await queryOne('SELECT id FROM pelanggan WHERE username=? AND id!=?', [usernameBaru, p.id]);
            if (cek) return res.status(400).json({ error: 'Username sudah dipakai pelanggan lain' });
            usernameFinal = usernameBaru;
        }

        if (passwordBaru && passwordBaru.length < 4)
            return res.status(400).json({ error: 'Password minimal 4 karakter' });

        // ── Terapkan rename username di tabel RADIUS + pelanggan ──
        // (mirror logika admin: hapus dulu baris milik username BARU agar
        //  UPDATE tak bentrok UNIQUE KEY, lalu pindahkan dari username lama)
        if (usernameFinal !== usernameLama) {
            await query('DELETE FROM radcheck    WHERE username=?', [usernameFinal]);
            await query('DELETE FROM radreply     WHERE username=?', [usernameFinal]);
            await query('DELETE FROM radusergroup WHERE username=?', [usernameFinal]);
            await query('UPDATE radcheck    SET username=? WHERE username=?', [usernameFinal, usernameLama]);
            await query('UPDATE radreply     SET username=? WHERE username=?', [usernameFinal, usernameLama]);
            await query('UPDATE radusergroup SET username=? WHERE username=?', [usernameFinal, usernameLama]);
            await query('UPDATE pelanggan SET username=? WHERE id=?', [usernameFinal, p.id]);
        }

        // ── Terapkan password baru (Cleartext-Password + enc untuk restore) ──
        if (passwordBaru) {
            await query(`
                INSERT INTO radcheck (username, attribute, op, value)
                VALUES (?, 'Cleartext-Password', ':=', ?)
                ON DUPLICATE KEY UPDATE value = VALUES(value)
            `, [usernameFinal, passwordBaru]);
            try {
                const enc  = radiusService.encryptPassword(passwordBaru);
                const hash = await bcrypt.hash(passwordBaru, 12);
                await query('UPDATE pelanggan SET radius_password_enc=?, password=? WHERE id=?', [enc, hash, p.id]);
            } catch(e) { console.warn('[client] simpan enc/hash gagal:', e.message); }
        }

        // Putus sesi aktif agar kredensial baru langsung berlaku saat login ulang
        try { await radiusService.putusKoneksi(usernameLama); } catch(e) {}
        if (usernameFinal !== usernameLama) { try { await radiusService.putusKoneksi(usernameFinal); } catch(e) {} }

        res.json({
            sukses: true,
            username: usernameFinal,
            pesan: 'Akun hotspot berhasil diperbarui. Sambungkan ulang ke hotspot dan login dengan kredensial baru.'
        });
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
// ── Cari device GenieACS milik seorang pelanggan ─────────────
// Prioritas: link manual (acs_link by serial) > auto-match username PPPoE.
// Mengembalikan device hasil normalizeDevice (punya genie_id, status, dll) / null.
async function cariDeviceGenie(pelangganId) {
    const genie = require('../services/genieacs');
    let devices = [];
    try { devices = await genie.listDevices({ limit: 5000 }); } catch (e) { return null; }
    let dev = null;
    try {
        const link = await queryOne('SELECT serial_number FROM acs_link WHERE pelanggan_id=? LIMIT 1', [pelangganId]);
        if (link && link.serial_number) {
            const ln = String(link.serial_number).toLowerCase();
            dev = devices.find(d => d.serial_number && String(d.serial_number).toLowerCase() === ln);
        }
    } catch (e) {}
    if (!dev) {
        const pel = await queryOne('SELECT username FROM pelanggan WHERE id=?', [pelangganId]);
        if (pel && pel.username) {
            const un = String(pel.username).toLowerCase();
            dev = devices.find(d => d.pppoe_username && String(d.pppoe_username).toLowerCase() === un);
        }
    }
    return dev || null;
}

// ── ACS Lite (GoACS): baca konfigurasi + cari device pelanggan ──────────────
function _acsliteKey() {
    try {
        const t = fs.readFileSync('/opt/acs/.env', 'utf8');
        const m = t.match(/^\s*API_KEY\s*=\s*(.+?)\s*$/m);
        if (m && m[1]) return m[1].replace(/^["']|["']$/g, '');
    } catch (e) {}
    return '';
}
async function _acsliteCfg() {
    const rows = await query("SELECT kunci, nilai FROM setting WHERE kunci IN ('acslite_url','acslite_api_key')").catch(() => []);
    const m = {}; (rows || []).forEach(r => { m[r.kunci] = r.nilai; });
    return {
        url: (m.acslite_url || 'http://127.0.0.1:7547').replace(/\/+$/, ''),
        key: _acsliteKey() || (m.acslite_api_key || ''),
    };
}
function _acsPPPoE(d) {
    if (d && d.wan_services && d.parameters) for (const k in d.wan_services) {
        const w = d.wan_services[k];
        if (w && w.username_path && d.parameters[w.username_path]) return String(d.parameters[w.username_path]);
    }
    return '';
}
function _acsSSID(d) {
    if (d && d.wifi_services && d.parameters) for (const k in d.wifi_services) {
        const w = d.wifi_services[k];
        if (w && w.ssid_path && d.parameters[w.ssid_path]) return String(d.parameters[w.ssid_path]);
    }
    return '';
}
function _acsWifiPaths(d) {
    if (d && d.wifi_services) for (const k in d.wifi_services) {
        const w = d.wifi_services[k];
        if (w && w.ssid_path) return { ssid_path: w.ssid_path, pass_path: w.password_path || null };
    }
    return { ssid_path: null, pass_path: null };
}
// IP router: ip_address → parameters[ip_path] → parse dari connection_request_url.
function _acsIP(d) {
    if (d.ip_address) return d.ip_address;
    if (d.ip_path && d.parameters && d.parameters[d.ip_path]) return String(d.parameters[d.ip_path]);
    if (d.connection_request_url) {
        const m = String(d.connection_request_url).match(/https?:\/\/([0-9.]+)/);
        if (m) return m[1];
    }
    return '';
}
async function cariDeviceAcslite(pelangganId) {
    const axios = require('axios');
    const cfg = await _acsliteCfg();
    let list = [];
    try {
        const r = await axios.get(`${cfg.url}/api/devices`, {
            headers: cfg.key ? { 'X-API-Key': cfg.key } : {}, params: { per_page: 500 }, timeout: 8000
        });
        const raw = r.data; list = Array.isArray(raw) ? raw : (raw && raw.data ? raw.data : []);
    } catch (e) { return null; }

    let dev = null;
    try {
        const link = await queryOne('SELECT serial_number FROM acs_link WHERE pelanggan_id=? LIMIT 1', [pelangganId]);
        if (link && link.serial_number) {
            const ln = String(link.serial_number).toLowerCase();
            dev = list.find(d => d.serial_number && String(d.serial_number).toLowerCase() === ln);
        }
    } catch (e) {}
    if (!dev) {
        const pel = await queryOne('SELECT username FROM pelanggan WHERE id=?', [pelangganId]);
        if (pel && pel.username) {
            const un = String(pel.username).toLowerCase();
            dev = list.find(d => _acsPPPoE(d).toLowerCase() === un);
        }
    }
    if (!dev) return null;
    const wp = _acsWifiPaths(dev);
    const _p = dev.parameters || {};
    const _sw = _p['InternetGatewayDevice.DeviceInfo.SoftwareVersion']
             || _p['Device.DeviceInfo.SoftwareVersion']
             || _p['VirtualParameters.SoftwareVersion'] || '';
    return {
        serial_number: dev.serial_number, manufacturer: dev.manufacturer,
        product_class: dev.product_class || '', ip_address: _acsIP(dev),
        software_version: _sw,
        ssid: _acsSSID(dev), last_inform: dev.last_inform_time || null,
        rx_power: dev.rx_power, source: 'acslite',
        ssid_path: wp.ssid_path, pass_path: wp.pass_path,
    };
}
// Lookup gabungan: cek GenieACS + ACS Lite, pilih yang PALING BARU inform.
// (ONU yang sudah dipindah ke ACS Lite akan basi/offline di GenieACS.)
async function cariDeviceACS(pelangganId) {
    const [g, a] = await Promise.all([
        cariDeviceGenie(pelangganId).catch(() => null),
        cariDeviceAcslite(pelangganId).catch(() => null),
    ]);
    if (g && !g.source) g.source = 'genieacs';
    const ts = (x) => {
        if (!x) return 0;
        const t = x.last_inform || x.last_inform_time;
        const v = t ? new Date(t).getTime() : 0;
        return isNaN(v) ? 0 : v;
    };
    if (g && a) return ts(a) >= ts(g) ? a : g;
    return a || g || null;
}

// ── Parse daftar perangkat terhubung (Hosts.Host) dari tree GenieACS ──
// Dukung TR-098 (InternetGatewayDevice.LANDevice.1.Hosts) & TR-181 (Device.Hosts).
function parseHostsGenie(raw) {
    if (!raw || typeof raw !== 'object') return [];
    const leaf = (n) => (n && typeof n === 'object') ? ('_value' in n ? n._value : null) : n;
    const tr098 = ((((raw.InternetGatewayDevice || {}).LANDevice || {})['1'] || {}).Hosts || {}).Host;
    const tr181 = ((raw.Device || {}).Hosts || {}).Host;
    const hostsRoot = tr098 || tr181 || {};
    const out = [];
    for (const i of Object.keys(hostsRoot)) {
        if (i[0] === '_') continue;
        const h = hostsRoot[i] || {};
        const mac = leaf(h.MACAddress) || leaf(h.PhysAddress) || '';
        const item = {
            hostname: leaf(h.HostName) || '',
            ip:       leaf(h.IPAddress) || '',
            mac:      String(mac).toUpperCase(),
            active:   /^(1|true)$/i.test(String(leaf(h.Active) == null ? '' : leaf(h.Active))),
            iface:    leaf(h.InterfaceType) || '',
            sumber:   leaf(h.AddressSource) || ''
        };
        if (item.mac || item.ip || item.hostname) out.push(item);
    }
    return out;
}

router.get('/perangkat-wifi', clientAuth, async (req, res, next) => {
    try {
        const dev = await cariDeviceGenie(req.client.id);
        if (!dev) return res.json({ device: false, perangkat: [], last_inform: null });

        const genie = require('../services/genieacs');
        let raw = null;
        try { raw = await genie.getDevice(dev.genie_id); } catch (e) { raw = null; }
        let perangkat = parseHostsGenie(raw);
        perangkat.sort((a, b) => (b.active - a.active) || ((a.hostname || a.ip || '').localeCompare(b.hostname || b.ip || '')));

        // Hanya saat user menekan ⟳ (manual=1): minta GenieACS tarik ulang subtree
        // dari device (connection request). Hindari spam pada load biasa.
        if (req.query.manual === '1') {
            try { await genie.refreshDevice(dev.genie_id); } catch (e) {}
        }

        res.json({ device: true, last_inform: dev.last_inform, perangkat });
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
