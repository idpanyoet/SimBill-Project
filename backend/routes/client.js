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

const JWT_SECRET  = process.env.JWT_SECRET || 'secret';
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

        // Generate OTP 6 digit
        const otp     = String(Math.floor(100000 + Math.random() * 900000));
        const expired = new Date(Date.now() + OTP_EXPIRE);

        // Simpan OTP
        await query(`
            INSERT INTO client_otp (no_hp, otp, expired_at)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE otp=?, expired_at=?, created_at=NOW()
        `, [noHpNormal, otp, expired, otp, expired]);

        // Kirim via WhatsApp
        const pesan = `*Kode OTP Login NetBilling*\n\nKode Anda: *${otp}*\n\nBerlaku 5 menit. Jangan bagikan ke siapapun.`;
        await waService.kirimPesan(noHpNormal, pesan, pel.id, 'otp');

        res.json({ pesan: 'OTP dikirim ke WhatsApp', nama: pel.nama });
    } catch(e) { next(e); }
});

// ── POST /api/client/otp/verifikasi ──────────────────────────
router.post('/otp/verifikasi', async (req, res, next) => {
    try {
        const { no_hp, otp } = req.body;
        const noHpNormal = no_hp.replace(/\D/g,'').replace(/^0/,'62');

        const record = await queryOne(
            `SELECT * FROM client_otp WHERE no_hp=? AND otp=? AND expired_at > NOW()`,
            [noHpNormal, otp]
        );
        if (!record) return res.status(400).json({ error: 'OTP salah atau sudah kadaluarsa' });

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

// ── POST /api/client/tiket ────────────────────────────────────
router.post('/tiket', clientAuth, upload.single('foto'), async (req, res, next) => {
    try {
        const { judul, pesan, kategori } = req.body;
        if (!judul || !pesan) return res.status(400).json({ error: 'Judul dan pesan wajib diisi' });

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
                const notif = `🎫 *Tiket Baru - ${map.app_name || 'NetBilling'}*\n\nDari: ${pel.nama} (${pel.username})\nKategori: ${kategori || 'umum'}\nJudul: ${judul}\n\nSegera cek dashboard admin.`;
                await waService.kirimPesan(map.admin_no_hp, notif, pel.id || null, 'tiket');
            }
        } catch(notifErr) { console.warn('[tiket] Notif WA gagal:', notifErr.message); }

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

module.exports = router;

// ── POST /api/client/tiket/:id/reply ─────────────────────────
router.post('/tiket/:id/reply', clientAuth, async (req, res, next) => {
    try {
        const { pesan, dari } = req.body;
        if (!pesan) return res.status(400).json({ error: 'Pesan wajib diisi' });
        const tiket = await queryOne('SELECT * FROM tiket WHERE id=? AND pelanggan_id=?',
            [req.params.id, req.client.id]);
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
        await query(`INSERT INTO tiket_reply (tiket_id, dari, pesan) VALUES (?,?,?)`,
            [req.params.id, dari || 'pelanggan', pesan]);
        await query(`UPDATE tiket SET updated_at=NOW() WHERE id=?`, [req.params.id]);
        res.json({ pesan: 'Balasan terkirim' });
    } catch(e) { next(e); }
});
