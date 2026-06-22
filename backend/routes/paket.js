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
            pool_name, tipe='keduanya', burst_limit, burst_time, deskripsi, rate_limit, izin_voucher,
            harga_reseller } = req.body;

    if (!nama || !kecepatan_up || !kecepatan_dn || !harga)
      return res.status(400).json({ error: 'nama, kecepatan_up, kecepatan_dn, harga wajib diisi' });

    await query(`ALTER TABLE paket ADD COLUMN IF NOT EXISTS rate_limit VARCHAR(128) NULL`).catch(()=>{});
    await query(`ALTER TABLE paket ADD COLUMN IF NOT EXISTS izin_voucher TINYINT(1) NOT NULL DEFAULT 0`).catch(()=>{});
    await query(`ALTER TABLE paket ADD COLUMN IF NOT EXISTS harga_reseller DECIMAL(12,2) NULL`).catch(()=>{});

    const result = await query(`
      INSERT INTO paket (nama, kecepatan_up, kecepatan_dn, harga, masa_aktif, satuan_masa,
        pool_name, tipe, burst_limit, burst_time, deskripsi, rate_limit, izin_voucher, harga_reseller)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [nama, kecepatan_up, kecepatan_dn, harga, masa_aktif || 30, satuan_masa || 'hari',
        pool_name || null, tipe || 'keduanya', burst_limit || null, burst_time || null,
        deskripsi || null, rate_limit || null, izin_voucher ? 1 : 0,
        (harga_reseller === '' || harga_reseller == null) ? null : harga_reseller]);

    // Simpan rate_limit sudah masuk INSERT
    // Sync group RADIUS — gunakan rate_limit jika ada
    try {
      const radiusService = require('../services/radius');
      await radiusService._syncGroupPaketPublic(
        { kecepatan_dn, kecepatan_up, rate_limit, pool_name: pool_name || null, masa_aktif: masa_aktif || 30 }, tipe || 'keduanya'
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
            pool_name, tipe, burst_limit, burst_time, deskripsi, aktif, rate_limit, izin_voucher,
            harga_reseller } = req.body;

    await query(`ALTER TABLE paket ADD COLUMN IF NOT EXISTS rate_limit VARCHAR(128) NULL`).catch(()=>{});
    await query(`ALTER TABLE paket ADD COLUMN IF NOT EXISTS izin_voucher TINYINT(1) NOT NULL DEFAULT 0`).catch(()=>{});
    await query(`ALTER TABLE paket ADD COLUMN IF NOT EXISTS harga_reseller DECIMAL(12,2) NULL`).catch(()=>{});

    await query(`
      UPDATE paket SET nama=?,kecepatan_up=?,kecepatan_dn=?,harga=?,
        masa_aktif=?,satuan_masa=?,pool_name=?,tipe=?,burst_limit=?,burst_time=?,deskripsi=?,aktif=?,rate_limit=?,izin_voucher=?,harga_reseller=?
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
        rate_limit !== undefined ? (rate_limit || null) : (existing.rate_limit || null),
        izin_voucher !== undefined ? (izin_voucher ? 1 : 0) : (existing.izin_voucher || 0),
        harga_reseller !== undefined ? ((harga_reseller === '' || harga_reseller == null) ? null : harga_reseller) : (existing.harga_reseller ?? null),
        req.params.id
    ]);

    // ── Sync kecepatan/pool ke radgroupreply ──
    // Nilai paket setelah update (gabungan body + existing).
    const paketBaru = {
        ...existing,
        kecepatan_dn: kecepatan_dn ?? existing.kecepatan_dn,
        kecepatan_up: kecepatan_up ?? existing.kecepatan_up,
        rate_limit:   rate_limit !== undefined ? (rate_limit || null) : (existing.rate_limit || null),
        burst_limit:  burst_limit !== undefined ? (burst_limit || null) : existing.burst_limit,
        burst_time:   burst_time  !== undefined ? (burst_time  || null) : existing.burst_time,
        pool_name:    pool_name !== undefined ? (pool_name || null) : existing.pool_name,
    };
    const tipeKon = (tipe ?? existing.tipe) === 'hotspot' ? 'hotspot' : 'pppoe';

    // Rate-limit final (sama rumus dgn service): rate_limit manual > burst > up/dn.
    const rl = paketBaru.rate_limit ||
        (paketBaru.burst_limit
            ? `${paketBaru.kecepatan_dn}M/${paketBaru.kecepatan_up}M ${paketBaru.burst_limit}/${paketBaru.burst_limit} ${paketBaru.burst_time || '8'}`
            : `${paketBaru.kecepatan_up}M/${paketBaru.kecepatan_dn}M`);

    try {
        const radiusService = require('../services/radius');
        // 1) Buat/update group sesuai kecepatan BARU (mengisi Mikrotik-Rate-Limit yg benar).
        await radiusService._syncGroupPaketPublic(paketBaru, tipeKon);

        const gBaru = `${tipeKon}-${paketBaru.kecepatan_dn}mbps`;

        // 2) Pindahkan HANYA pelanggan paket ini ke group baru.
        //    Penting: jangan rename group lama secara global — beberapa paket
        //    placeholder bisa berbagi group yg sama (mis. semua 100mbps), jadi
        //    rename global akan ikut menyeret pelanggan paket lain.
        const pelangganPaket = await query(
            `SELECT username FROM pelanggan WHERE paket_id=? AND username IS NOT NULL AND username<>''`,
            [req.params.id]
        );
        for (const p of pelangganPaket) {
            await query(
                `UPDATE radusergroup SET groupname=? WHERE username=?`,
                [gBaru, p.username]
            );
        }

        // 3) Pastikan rate-limit group baru = nilai terbaru (idempotent).
        await query(
            `UPDATE radgroupreply SET value=? WHERE groupname=? AND attribute='Mikrotik-Rate-Limit'`,
            [rl, gBaru]
        );
        // 4) Update pool bila diisi & group punya Framed-Pool.
        if (paketBaru.pool_name) {
            await query(
                `UPDATE radgroupreply SET value=? WHERE groupname=? AND attribute='Framed-Pool'`,
                [paketBaru.pool_name, gBaru]
            );
        }
    } catch (syncErr) {
        console.warn('[paket] sync radgroupreply gagal:', syncErr.message);
    }

    res.json({ pesan: 'Paket diperbarui. Pelanggan aktif perlu reconnect agar kecepatan baru berlaku.' });
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
