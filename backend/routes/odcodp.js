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
      olt_id     VARCHAR(64) NULL,
      latitude   DECIMAL(10,7) NULL,
      longitude  DECIMAL(10,7) NULL,
      kapasitas  INT NULL,
      catatan    VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await query(`ALTER TABLE odc ADD COLUMN IF NOT EXISTS olt_id VARCHAR(64) NULL`).catch(() => {});
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
    // drop_path: titik belok garis ODP→pelanggan agar mengikuti jalan.
    // Simpan hanya titik TENGAH (bends); endpoint (ODP & pelanggan) diambil dari data.
    await query(`CREATE TABLE IF NOT EXISTS drop_path (
      pelanggan_id INT PRIMARY KEY,
      titik        TEXT NULL,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    // odp_path: titik belok garis ODC→ODP agar mengikuti jalan.
    await query(`CREATE TABLE IF NOT EXISTS odp_path (
      odp_id     INT PRIMARY KEY,
      titik      TEXT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  } catch (e) { console.warn('[odcodp] init tabel:', e.message); }
})();

function _safeJson(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } }

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

// GET /api/jaringan/olt-list — daftar OLT terkonfigurasi (untuk dropdown ODC induk)
router.get('/olt-list', async (req, res, next) => {
  try {
    let list = [];
    try { list = require('../services/olt').listOlts() || []; } catch (e) {}
    res.json(list.map(o => ({ id: o.id, name: o.name || o.id, model: o.model || '' })));
  } catch (e) { next(e); }
});

router.post('/odc', requireAdmin, async (req, res, next) => {
  try {
    const nama = str(req.body.nama);
    if (!nama) return res.status(400).json({ error: 'Nama ODC wajib diisi' });
    if (await queryOne('SELECT id FROM odc WHERE nama=?', [nama]))
      return res.status(409).json({ error: 'Nama ODC sudah dipakai' });
    const r = await query(
      'INSERT INTO odc (nama, olt_id, latitude, longitude, kapasitas, catatan) VALUES (?,?,?,?,?,?)',
      [nama, str(req.body.olt_id), num(req.body.latitude), num(req.body.longitude), num(req.body.kapasitas), str(req.body.catatan, 255)]);
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
    await query('UPDATE odc SET nama=?, olt_id=?, latitude=?, longitude=?, kapasitas=?, catatan=? WHERE id=?',
      [nama, str(req.body.olt_id), num(req.body.latitude), num(req.body.longitude), num(req.body.kapasitas), str(req.body.catatan, 255), req.params.id]);
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

// ── Drop path (penyesuaian garis ODP→pelanggan mengikuti jalan) ──
// GET semua: { pelanggan_id, titik:[[lat,lng],...] }
router.get('/drop-path', async (req, res, next) => {
  try {
    const rows = await query('SELECT pelanggan_id, titik FROM drop_path');
    res.json(rows.map(r => ({ pelanggan_id: r.pelanggan_id, titik: _safeJson(r.titik) })));
  } catch (e) { next(e); }
});
// POST simpan (titik kosong = reset ke garis lurus)
router.post('/drop-path', requireAdmin, async (req, res, next) => {
  try {
    const pid = parseInt(req.body.pelanggan_id, 10);
    if (!pid) return res.status(400).json({ error: 'pelanggan_id wajib' });
    let titik = Array.isArray(req.body.titik) ? req.body.titik : [];
    // sanitasi: hanya pasangan angka [lat,lng] yang valid, maks 50 titik
    titik = titik.filter(t => Array.isArray(t) && t.length === 2 && !isNaN(+t[0]) && !isNaN(+t[1]))
                 .slice(0, 50).map(t => [+(+t[0]).toFixed(7), +(+t[1]).toFixed(7)]);
    if (titik.length === 0) {
      await query('DELETE FROM drop_path WHERE pelanggan_id=?', [pid]);
      return res.json({ ok: true, reset: true });
    }
    await query('INSERT INTO drop_path (pelanggan_id, titik) VALUES (?,?) ON DUPLICATE KEY UPDATE titik=VALUES(titik)',
      [pid, JSON.stringify(titik)]);
    res.json({ ok: true, jumlah: titik.length });
  } catch (e) { next(e); }
});

// ── ODP path (penyesuaian garis ODC→ODP mengikuti jalan) ──
router.get('/odp-path', async (req, res, next) => {
  try {
    const rows = await query('SELECT odp_id, titik FROM odp_path');
    res.json(rows.map(r => ({ odp_id: r.odp_id, titik: _safeJson(r.titik) })));
  } catch (e) { next(e); }
});
router.post('/odp-path', requireAdmin, async (req, res, next) => {
  try {
    const oid = parseInt(req.body.odp_id, 10);
    if (!oid) return res.status(400).json({ error: 'odp_id wajib' });
    let titik = Array.isArray(req.body.titik) ? req.body.titik : [];
    titik = titik.filter(t => Array.isArray(t) && t.length === 2 && !isNaN(+t[0]) && !isNaN(+t[1]))
                 .slice(0, 50).map(t => [+(+t[0]).toFixed(7), +(+t[1]).toFixed(7)]);
    if (titik.length === 0) {
      await query('DELETE FROM odp_path WHERE odp_id=?', [oid]);
      return res.json({ ok: true, reset: true });
    }
    await query('INSERT INTO odp_path (odp_id, titik) VALUES (?,?) ON DUPLICATE KEY UPDATE titik=VALUES(titik)',
      [oid, JSON.stringify(titik)]);
    res.json({ ok: true, jumlah: titik.length });
  } catch (e) { next(e); }
});

module.exports = router;
