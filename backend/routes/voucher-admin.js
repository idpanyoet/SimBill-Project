// routes/voucher-admin.js — Manajemen voucher di panel admin (perlu JWT)
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const waService = require('../services/whatsapp');
const radiusService = require('../services/radius');

router.use(authMiddleware);

// GET /api/voucher — daftar voucher
router.get('/', async (req, res, next) => {
  try {
    // Auto-migrate kolom batch_id jika belum ada
    await query(`ALTER TABLE voucher ADD COLUMN IF NOT EXISTS batch_id VARCHAR(30) DEFAULT NULL`).catch(()=>{});

    const { status, paket_id, batch_id, halaman = 1, limit = 30 } = req.query;
    const offset = (parseInt(halaman)-1) * parseInt(limit);

    let where = ['1=1'], params = [];
    if (status)   { where.push('v.status=?');   params.push(status); }
    if (paket_id) { where.push('v.paket_id=?'); params.push(paket_id); }
    if (batch_id) { where.push('v.batch_id=?'); params.push(batch_id); }

    const rows = await query(`
      SELECT v.*, p.nama AS nama_paket, p.kecepatan_dn, p.harga
      FROM voucher v LEFT JOIN paket p ON v.paket_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY v.created_at DESC LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    // Jika filter batch_id, kembalikan array langsung (bukan paginasi)
    if (batch_id) return res.json(rows);

    // Count langsung dari tabel voucher tanpa JOIN
    const countWhere = ['1=1'];
    const countParams = [];
    if (status)   { countWhere.push('status=?');   countParams.push(status); }
    if (paket_id) { countWhere.push('paket_id=?'); countParams.push(paket_id); }
    if (batch_id) { countWhere.push('batch_id=?'); countParams.push(batch_id); }
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM voucher WHERE ${countWhere.join(' AND ')}`, countParams
    );
    res.json({ data: rows, total });
  } catch (e) { next(e); }
});

// GET /api/voucher/batch — riwayat batch generate
router.get('/batch', async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT v.batch_id,
             COUNT(*) AS jumlah,
             SUM(CASE WHEN v.status='used' THEN 1 ELSE 0 END) AS terpakai,
             MIN(v.created_at) AS created_at,
             p.nama AS nama_paket
      FROM voucher v
      JOIN paket p ON v.paket_id = p.id
      WHERE v.batch_id IS NOT NULL
      GROUP BY v.batch_id, p.nama
      ORDER BY MIN(v.created_at) DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch(e) { next(e); }
});

// POST /api/voucher/generate — buat voucher batch
router.post('/generate', async (req, res, next) => {
  try {
    const { paket_id } = req.body;
    const jumlah   = parseInt(req.body.jumlah, 10) || 10;
    const mode     = req.body.mode === 'beda' ? 'beda' : 'sama'; // 'sama' = username=password, 'beda' = username+password terpisah
    const panjang  = Math.min(Math.max(parseInt(req.body.panjang, 10) || 6, 4), 20);
    const prefix   = (req.body.prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const charsetKey = req.body.charset || 'angka';

    if (!paket_id) return res.status(400).json({ error: 'paket_id wajib diisi' });
    if (jumlah < 1 || jumlah > 9999)
      return res.status(400).json({ error: 'Jumlah harus antara 1–9999 per batch' });

    const CHARSETS = {
      angka:        '0123456789',
      angka_kecil:  '0123456789abcdefghijklmnopqrstuvwxyz',
      angka_besar:  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    };
    const charset = CHARSETS[charsetKey];
    if (!charset) return res.status(400).json({ error: 'charset tidak valid (angka/angka_kecil/angka_besar)' });

    // Bagian acak harus tetap punya panjang minimal 1 karakter setelah
    // prefix dipotong, supaya tidak ada kemungkinan dua voucher identik
    // hanya karena prefix sudah memenuhi seluruh panjang yang diminta.
    const panjangAcak = Math.max(panjang - prefix.length, 4);

    const paket = await queryOne('SELECT * FROM paket WHERE id=?', [paket_id]);
    if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });

    // Generate batch ID unik untuk kelompok voucher ini
    const batchId = 'BATCH-' + Date.now().toString(36).toUpperCase();

    const hasil = [];
    for (let i = 0; i < jumlah; i++) {
      // Coba sampai dapat username yang belum dipakai (sangat jarang
      // collision dengan charset+panjang yang wajar, tapi dijaga agar
      // tidak gagal insert karena UNIQUE constraint).
      let username, sudahAda = true, percobaan = 0;
      do {
        username = prefix + _acak(charset, panjangAcak);
        sudahAda = await queryOne('SELECT id FROM voucher WHERE username=?', [username]);
        percobaan++;
      } while (sudahAda && percobaan < 10);
      if (sudahAda) {
        return res.status(500).json({ error: 'Gagal membuat username unik, coba perbesar panjang username atau kurangi jumlah voucher.' });
      }

      const password = mode === 'sama' ? username : _acak(charset, panjangAcak);

      await query(`
        INSERT INTO voucher (username, password, paket_id, tgl_expired, batch_id)
        VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 365 DAY), ?)
      `, [username, password, paket_id, batchId]);

      hasil.push({ username, password });
    }

    // Sync semua voucher baru ke radcheck agar langsung bisa autentikasi
    radiusService.syncVoucher().catch(e => console.warn('[sync]', e.message));

    res.status(201).json({
      pesan:    `${hasil.length} voucher berhasil dibuat`,
      paket:    paket.nama,
      mode,
      batch_id: batchId,
      voucher:  hasil
    });
  } catch (e) { next(e); }
});

// POST /api/voucher/:username/kirim-wa — kirim voucher ke WA
router.post('/:username/kirim-wa', async (req, res, next) => {
  try {
    const { no_hp, nama = 'Pelanggan' } = req.body;
    if (!no_hp) return res.status(400).json({ error: 'no_hp wajib diisi' });

    const v = await queryOne(`
      SELECT v.*, p.nama AS nama_paket, p.kecepatan_dn, p.masa_aktif
      FROM voucher v JOIN paket p ON v.paket_id=p.id WHERE v.username=?
    `, [req.params.username]);

    if (!v) return res.status(404).json({ error: 'Voucher tidak ditemukan' });
    if (v.status !== 'unused')
      return res.status(400).json({ error: `Voucher sudah berstatus ${v.status}, tidak bisa dikirim ulang` });

    await waService.kirimVoucher(no_hp, nama, v.username, v.password,
      `${v.masa_aktif * 24} jam (${v.masa_aktif} hari)`);

    res.json({ pesan: `Voucher ${v.username} terkirim ke ${no_hp}` });
  } catch (e) { next(e); }
});

// DELETE /api/voucher/:username — hapus voucher unused
router.delete('/:username', async (req, res, next) => {
  try {
    const v = await queryOne('SELECT * FROM voucher WHERE username=?', [req.params.username]);
    if (!v) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (v.status === 'used') return res.status(400).json({ error: 'Voucher sudah dipakai' });
    await query('DELETE FROM voucher WHERE username=?', [req.params.username]);
    res.json({ pesan: 'Voucher dihapus' });
  } catch (e) { next(e); }
});

// POST /api/voucher/bulk-hapus — hapus banyak voucher sekaligus (termasuk yang sudah 'used')
router.post('/bulk-hapus', async (req, res, next) => {
  try {
    const usernames = Array.isArray(req.body.usernames) ? req.body.usernames : [];
    if (!usernames.length) return res.status(400).json({ error: 'Tidak ada voucher yang dipilih' });

    const result = await query(
      `DELETE FROM voucher WHERE username IN (${usernames.map(() => '?').join(',')})`,
      usernames
    );
    res.json({ pesan: `${result.affectedRows} voucher berhasil dihapus` });
  } catch (e) { next(e); }
});

// POST /api/voucher/bulk-status — ubah status banyak voucher sekaligus
// status='unused' (Aktifkan) atau status='expired' (Nonaktifkan).
// Voucher yang sudah 'used' (sudah dipakai pelanggan) dilewati — tidak masuk
// akal mengaktifkan/menonaktifkan voucher yang sudah benar-benar terpakai.
router.post('/bulk-status', async (req, res, next) => {
  try {
    const usernames = Array.isArray(req.body.usernames) ? req.body.usernames : [];
    const status = req.body.status;
    if (!usernames.length) return res.status(400).json({ error: 'Tidak ada voucher yang dipilih' });
    if (!['unused', 'expired'].includes(status))
      return res.status(400).json({ error: "status harus 'unused' atau 'expired'" });

    const result = await query(
      `UPDATE voucher SET status=? WHERE username IN (${usernames.map(() => '?').join(',')}) AND status != 'used'`,
      [status, ...usernames]
    );
    res.json({ pesan: `${result.affectedRows} voucher berhasil di${status === 'unused' ? 'aktifkan' : 'nonaktifkan'}` });
  } catch (e) { next(e); }
});

// GET /api/voucher/statistik
router.get('/statistik', async (req, res, next) => {
  try {
    const stats = await query(`
      SELECT
        v.status,
        COUNT(*) AS jumlah,
        p.nama AS nama_paket,
        p.harga
      FROM voucher v JOIN paket p ON v.paket_id=p.id
      GROUP BY v.status, p.id
    `);

    const total_pendapatan = await query(`
      SELECT SUM(p.harga) AS total
      FROM voucher v JOIN paket p ON v.paket_id=p.id
      WHERE v.status='used'
    `);

    res.json({ stats, total_pendapatan: total_pendapatan[0]?.total || 0 });
  } catch (e) { next(e); }
});

function _acak(charset, panjang) {
  return Array.from({ length: panjang }, () => charset[Math.floor(Math.random() * charset.length)]).join('');
}

module.exports = router;
