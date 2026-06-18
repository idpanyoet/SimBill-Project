// routes/paket.js
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT pk.*, COUNT(p.id) AS jumlah_pelanggan
      FROM paket pk
      LEFT JOIN pelanggan p ON p.paket_id=pk.id AND p.status != 'nonaktif'
      GROUP BY pk.id ORDER BY pk.harga
    `);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { nama, kecepatan_up, kecepatan_dn, harga, masa_aktif=30, satuan_masa='hari',
            pool_name, tipe='keduanya', burst_limit, burst_time, deskripsi } = req.body;

    if (!nama || !kecepatan_up || !kecepatan_dn || !harga)
      return res.status(400).json({ error: 'nama, kecepatan_up, kecepatan_dn, harga wajib diisi' });

    const result = await query(`
      INSERT INTO paket (nama, kecepatan_up, kecepatan_dn, harga, masa_aktif, satuan_masa,
        pool_name, tipe, burst_limit, burst_time, deskripsi)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `, [nama, kecepatan_up, kecepatan_dn, harga, masa_aktif || 30, satuan_masa || 'hari',
        pool_name || null, tipe || 'keduanya', burst_limit || null, burst_time || null, deskripsi || null]);

    // Sync group RADIUS (tanpa membuat user dummy)
    try {
      const radiusService = require('../services/radius');
      await radiusService._syncGroupPaketPublic(
        { kecepatan_dn, kecepatan_up, pool_name: pool_name || null, masa_aktif: masa_aktif || 30 }, tipe || 'keduanya'
      );
    } catch(e) {
      console.warn('[PAKET] Sync RADIUS group gagal (tidak fatal):', e.message);
    }

    res.status(201).json({ pesan: 'Paket ditambahkan', id: result.insertId });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const existing = await queryOne('SELECT * FROM paket WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Paket tidak ditemukan' });

    const { nama, kecepatan_up, kecepatan_dn, harga, masa_aktif, satuan_masa,
            pool_name, tipe, burst_limit, burst_time, deskripsi, aktif } = req.body;

    await query(`
      UPDATE paket SET nama=?,kecepatan_up=?,kecepatan_dn=?,harga=?,
        masa_aktif=?,satuan_masa=?,pool_name=?,tipe=?,burst_limit=?,burst_time=?,deskripsi=?,aktif=?
      WHERE id=?
    `, [
        nama ?? existing.nama,
        kecepatan_up ?? existing.kecepatan_up,
        kecepatan_dn ?? existing.kecepatan_dn,
        harga ?? existing.harga,
        masa_aktif ?? existing.masa_aktif,
        satuan_masa ?? existing.satuan_masa ?? 'hari',
        pool_name !== undefined ? (pool_name || null) : existing.pool_name,
        tipe ?? existing.tipe,
        burst_limit !== undefined ? (burst_limit || null) : existing.burst_limit,
        burst_time !== undefined ? (burst_time || null) : existing.burst_time,
        deskripsi !== undefined ? (deskripsi || null) : existing.deskripsi,
        aktif !== undefined ? (aktif ? 1 : 0) : existing.aktif,
        req.params.id
    ]);

    // Sync perubahan pool dan kecepatan ke radgroupreply
    const newPool    = pool_name !== undefined ? (pool_name || null) : existing.pool_name;
    const newSpeedDn = kecepatan_dn ?? existing.kecepatan_dn;
    const newSpeedUp = kecepatan_up ?? existing.kecepatan_up;
    const burstVal   = burst_limit !== undefined ? (burst_limit || null) : existing.burst_limit;
    const rateLimit  = burstVal
        ? `${newSpeedDn}M/${newSpeedUp}M ${burstVal}/${burstVal} ${burst_time || existing.burst_time || '8'}`
        : `${newSpeedDn}M/${newSpeedUp}M`;
    const oldPool    = existing.pool_name;

    // Cari group yang punya Framed-Pool = pool lama
    const affectedGroups = await query(
        `SELECT DISTINCT groupname FROM radgroupreply WHERE attribute='Framed-Pool' AND value=?`,
        [oldPool]
    );

    for (const g of affectedGroups) {
        const gn = g.groupname;
        // Update rate limit
        await query(
            `UPDATE radgroupreply SET value=? WHERE groupname=? AND attribute='Mikrotik-Rate-Limit'`,
            [rateLimit, gn]
        );
        // Update pool jika berubah
        if (newPool && oldPool && newPool !== oldPool) {
            await query(
                `UPDATE radgroupreply SET value=? WHERE groupname=? AND attribute='Framed-Pool'`,
                [newPool, gn]
            );
        }
    }

    res.json({ pesan: 'Paket diperbarui' });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const ada = await queryOne(
      `SELECT id FROM pelanggan WHERE paket_id=? AND status!='nonaktif' LIMIT 1`,
      [req.params.id]
    );
    if (ada) return res.status(400).json({ error: 'Paket masih digunakan pelanggan aktif' });
    await query('DELETE FROM paket WHERE id=?', [req.params.id]);
    res.json({ pesan: 'Paket dihapus' });
  } catch (e) { next(e); }
});

module.exports = router;
