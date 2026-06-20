// routes/tiket.js — Manajemen Tiket (sisi admin)
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const waService = require('../services/whatsapp');

let tulisLog = () => {};
try { tulisLog = require('./log').tulisLog || tulisLog; } catch (e) {}

router.use(authMiddleware);

// GET /api/tiket/stats — ringkasan jumlah per status
router.get('/stats', async (req, res, next) => {
    try {
        const [r] = await query(`
            SELECT
              COUNT(*) AS total,
              SUM(status='open')    AS open_,
              SUM(status='proses')  AS proses,
              SUM(status='selesai') AS selesai
            FROM tiket
        `);
        res.json({
            total:   Number(r?.total)   || 0,
            open:    Number(r?.open_)    || 0,
            proses:  Number(r?.proses)  || 0,
            selesai: Number(r?.selesai) || 0
        });
    } catch (e) { next(e); }
});

// GET /api/tiket — daftar semua tiket (filter opsional: status, kategori, cari)
router.get('/', async (req, res, next) => {
    try {
        const { status, kategori, cari } = req.query;
        const cond = []; const params = [];
        if (status && ['open','proses','selesai'].includes(status)) { cond.push('t.status=?'); params.push(status); }
        if (kategori && ['umum','gangguan','billing','lainnya'].includes(kategori)) { cond.push('t.kategori=?'); params.push(kategori); }
        if (cari) { cond.push('(t.judul LIKE ? OR p.nama LIKE ? OR p.username LIKE ?)'); const q=`%${cari}%`; params.push(q,q,q); }
        const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
        const rows = await query(`
            SELECT t.id, t.judul, t.pesan, t.kategori, t.status, t.foto, t.created_at, t.updated_at,
                   p.nama AS nama_pelanggan, p.username, p.no_hp,
                   (SELECT COUNT(*) FROM tiket_reply r WHERE r.tiket_id=t.id) AS jumlah_reply
            FROM tiket t
            LEFT JOIN pelanggan p ON t.pelanggan_id = p.id
            ${where}
            ORDER BY (t.status='open') DESC, t.updated_at DESC
            LIMIT 200
        `, params);
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /api/tiket/:id — detail + percakapan
router.get('/:id', async (req, res, next) => {
    try {
        const tiket = await queryOne(`
            SELECT t.*, p.nama AS nama_pelanggan, p.username, p.no_hp, p.email
            FROM tiket t LEFT JOIN pelanggan p ON t.pelanggan_id=p.id
            WHERE t.id=?
        `, [req.params.id]);
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
        const reply = await query('SELECT * FROM tiket_reply WHERE tiket_id=? ORDER BY created_at ASC', [req.params.id]);
        res.json({ ...tiket, reply });
    } catch (e) { next(e); }
});

// POST /api/tiket/:id/reply — admin membalas tiket
router.post('/:id/reply', async (req, res, next) => {
    try {
        const { pesan } = req.body;
        if (!pesan || !pesan.trim()) return res.status(400).json({ error: 'Pesan wajib diisi' });
        const tiket = await queryOne(`
            SELECT t.*, p.nama, p.no_hp FROM tiket t LEFT JOIN pelanggan p ON t.pelanggan_id=p.id WHERE t.id=?
        `, [req.params.id]);
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });

        await query('INSERT INTO tiket_reply (tiket_id, dari, pesan) VALUES (?,?,?)', [tiket.id, 'admin', pesan.trim()]);
        // Tiket open → otomatis jadi proses saat admin balas
        const statusBaru = tiket.status === 'open' ? 'proses' : tiket.status;
        await query('UPDATE tiket SET status=?, updated_at=NOW() WHERE id=?', [statusBaru, tiket.id]);

        // Best-effort notifikasi WA ke pelanggan
        try {
            if (tiket.no_hp) {
                const setting = await query("SELECT kunci,nilai FROM setting WHERE kunci IN ('app_name')");
                const appName = (setting.find(s=>s.kunci==='app_name')||{}).nilai || 'SimBill';
                const msg = `🎫 *Balasan Tiket - ${appName}*\n\nTiket: ${tiket.judul}\n\n"${pesan.trim()}"\n\nBalas melalui portal pelanggan Anda.`;
                await waService.kirimPesan(tiket.no_hp, msg, tiket.pelanggan_id || null, 'tiket');
            }
        } catch (notifErr) { console.warn('[tiket] notif WA gagal:', notifErr.message); }

        try { tulisLog({ kategori:'Tiket', pelaku:(req.admin&&(req.admin.nama||req.admin.email))||'Admin', aksi:'Balas Tiket', target:`#${tiket.id}`, detail:tiket.judul, ip:req.ip }); } catch(e) {}
        res.json({ pesan: 'Balasan terkirim', status: statusBaru });
    } catch (e) { next(e); }
});

// PUT /api/tiket/:id/status — ubah status tiket
router.put('/:id/status', async (req, res, next) => {
    try {
        const { status } = req.body;
        if (!['open','proses','selesai'].includes(status))
            return res.status(400).json({ error: 'Status tidak valid' });
        const tiket = await queryOne('SELECT id, judul FROM tiket WHERE id=?', [req.params.id]);
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
        await query('UPDATE tiket SET status=?, updated_at=NOW() WHERE id=?', [status, tiket.id]);
        try { tulisLog({ kategori:'Tiket', pelaku:(req.admin&&(req.admin.nama||req.admin.email))||'Admin', aksi:'Ubah Status Tiket', target:`#${tiket.id}`, detail:status, ip:req.ip }); } catch(e) {}
        res.json({ pesan: 'Status diperbarui', status });
    } catch (e) { next(e); }
});

module.exports = router;
