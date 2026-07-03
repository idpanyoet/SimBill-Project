// routes/odcodp.js — Kelola ODC & ODP (node distribusi FTTH)
// Mount: app.use('/api/jaringan', require('./routes/odcodp'));
// Endpoint: /api/jaringan/odc , /api/jaringan/odp
const express = require('express');
const router  = express.Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

router.use(authMiddleware);

// Buat tabel bila belum ada (idempotent)
(async () => {
  try {
    await query(`CREATE TABLE IF NOT EXISTS odc (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      nama       VARCHAR(64) NOT NULL UNIQUE,
      latitude   DECIMAL(10,7) NULL,
      longitude  DECIMAL(10,7) NULL,
      kapasitas  INT NULL,
      catatan    VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await query(`CREATE TABLE IF NOT EXISTS odp (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      nama       VARCHAR(64) NOT NULL UNIQUE,
      odc_id     INT NULL,
      latitude   DECIMAL(10,7) NULL,
      longitude  DECIMAL(10,7) NULL,
      kapasitas  INT NULL,
      catatan    VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_odp_odc (odc_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) { console.warn('[odcodp] init tabel:', e.message); }
})();

const num = (v) => (v === '' || v === undefined || v === null || isNaN(Number(v))) ? null : Number(v);
const str = (v, n = 64) => v ? String(v).trim().slice(0, n) : null;

// ═════════════════════ ODC ═════════════════════
// GET /api/jaringan/odc — daftar + jumlah ODP + jumlah pelanggan terpasang
router.get('/odc', async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT o.*,
        (SELECT COUNT(*) FROM odp d WHERE d.odc_id = o.id)      AS jml_odp,
        (SELECT COUNT(*) FROM pelanggan p WHERE p.odc COLLATE utf8mb4_general_ci = o.nama COLLATE utf8mb4_general_ci) AS jml_pelanggan
      FROM odc o ORDER BY o.nama`);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/odc', requireAdmin, async (req, res, next) => {
  try {
    const nama = str(req.body.nama);
    if (!nama) return res.status(400).json({ error: 'Nama ODC wajib diisi' });
    if (await queryOne('SELECT id FROM odc WHERE nama=?', [nama]))
      return res.status(409).json({ error: 'Nama ODC sudah dipakai' });
    const r = await query(
      'INSERT INTO odc (nama, latitude, longitude, kapasitas, catatan) VALUES (?,?,?,?,?)',
      [nama, num(req.body.latitude), num(req.body.longitude), num(req.body.kapasitas), str(req.body.catatan, 255)]);
    res.json({ id: r.insertId, pesan: `ODC "${nama}" ditambahkan` });
  } catch (e) { next(e); }
});

router.put('/odc/:id', requireAdmin, async (req, res, next) => {
  try {
    const nama = str(req.body.nama);
    if (!nama) return res.status(400).json({ error: 'Nama ODC wajib diisi' });
    const old = await queryOne('SELECT nama FROM odc WHERE id=?', [req.params.id]);
    if (!old) return res.status(404).json({ error: 'ODC tidak ditemukan' });
    if (await queryOne('SELECT id FROM odc WHERE nama=? AND id<>?', [nama, req.params.id]))
      return res.status(409).json({ error: 'Nama ODC sudah dipakai' });
    await query('UPDATE odc SET nama=?, latitude=?, longitude=?, kapasitas=?, catatan=? WHERE id=?',
      [nama, num(req.body.latitude), num(req.body.longitude), num(req.body.kapasitas), str(req.body.catatan, 255), req.params.id]);
    // Jaga konsistensi: rename ikut ke pelanggan yang memakai nama lama
    if (old.nama !== nama) await query('UPDATE pelanggan SET odc=? WHERE odc=?', [nama, old.nama]).catch(() => {});
    res.json({ pesan: 'ODC diperbarui' });
  } catch (e) { next(e); }
});

router.delete('/odc/:id', requireAdmin, async (req, res, next) => {
  try {
    const row = await queryOne('SELECT nama FROM odc WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'ODC tidak ditemukan' });
    await query('UPDATE odp SET odc_id=NULL WHERE odc_id=?', [req.params.id]).catch(() => {});
    await query('DELETE FROM odc WHERE id=?', [req.params.id]);
    res.json({ pesan: `ODC "${row.nama}" dihapus` });
  } catch (e) { next(e); }
});

// ═════════════════════ ODP ═════════════════════
router.get('/odp', async (req, res, next) => {
  try {
    const params = []; let where = '';
    if (req.query.odc_id) { where = 'WHERE d.odc_id = ?'; params.push(req.query.odc_id); }
    const rows = await query(`
      SELECT d.*, o.nama AS odc_nama,
        (SELECT COUNT(*) FROM pelanggan p WHERE p.odp COLLATE utf8mb4_general_ci = d.nama COLLATE utf8mb4_general_ci) AS jml_pelanggan
      FROM odp d LEFT JOIN odc o ON o.id = d.odc_id
      ${where} ORDER BY d.nama`, params);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/odp', requireAdmin, async (req, res, next) => {
  try {
    const nama = str(req.body.nama);
    if (!nama) return res.status(400).json({ error: 'Nama ODP wajib diisi' });
    if (await queryOne('SELECT id FROM odp WHERE nama=?', [nama]))
      return res.status(409).json({ error: 'Nama ODP sudah dipakai' });
    const r = await query(
      'INSERT INTO odp (nama, odc_id, latitude, longitude, kapasitas, catatan) VALUES (?,?,?,?,?,?)',
      [nama, num(req.body.odc_id), num(req.body.latitude), num(req.body.longitude), num(req.body.kapasitas), str(req.body.catatan, 255)]);
    res.json({ id: r.insertId, pesan: `ODP "${nama}" ditambahkan` });
  } catch (e) { next(e); }
});

router.put('/odp/:id', requireAdmin, async (req, res, next) => {
  try {
    const nama = str(req.body.nama);
    if (!nama) return res.status(400).json({ error: 'Nama ODP wajib diisi' });
    const old = await queryOne('SELECT nama FROM odp WHERE id=?', [req.params.id]);
    if (!old) return res.status(404).json({ error: 'ODP tidak ditemukan' });
    if (await queryOne('SELECT id FROM odp WHERE nama=? AND id<>?', [nama, req.params.id]))
      return res.status(409).json({ error: 'Nama ODP sudah dipakai' });
    await query('UPDATE odp SET nama=?, odc_id=?, latitude=?, longitude=?, kapasitas=?, catatan=? WHERE id=?',
      [nama, num(req.body.odc_id), num(req.body.latitude), num(req.body.longitude), num(req.body.kapasitas), str(req.body.catatan, 255), req.params.id]);
    if (old.nama !== nama) await query('UPDATE pelanggan SET odp=? WHERE odp=?', [nama, old.nama]).catch(() => {});
    res.json({ pesan: 'ODP diperbarui' });
  } catch (e) { next(e); }
});

router.delete('/odp/:id', requireAdmin, async (req, res, next) => {
  try {
    const row = await queryOne('SELECT nama FROM odp WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'ODP tidak ditemukan' });
    await query('DELETE FROM odp WHERE id=?', [req.params.id]);
    res.json({ pesan: `ODP "${row.nama}" dihapus` });
  } catch (e) { next(e); }
});

module.exports = router;
