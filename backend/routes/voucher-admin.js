// routes/voucher-admin.js — Manajemen voucher di panel admin (perlu JWT)
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const waService = require('../services/whatsapp');
const radiusService = require('../services/radius');

// Cegah CSV/formula injection pada export Excel voucher.
function sf(v) {
    return (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) ? "'" + v : v;
}

router.use(authMiddleware);

// GET /api/voucher — daftar voucher
router.get('/', async (req, res, next) => {
  try {
    // Auto-migrate kolom batch_id jika belum ada
    await query(`ALTER TABLE voucher ADD COLUMN IF NOT EXISTS batch_id VARCHAR(30) DEFAULT NULL`).catch(()=>{});

    // Tandai voucher yang sudah dipakai (dari radacct) jadi 'used'
    await radiusService.syncStatusVoucher().catch(()=>{});

    const { status, paket_id, batch_id, cari, halaman = 1, limit = 30 } = req.query;
    const offset = (parseInt(halaman)-1) * parseInt(limit);

    let where = ['1=1'], params = [];
    if (status)   { where.push('v.status=?');   params.push(status); }
    if (paket_id) { where.push('v.paket_id=?'); params.push(paket_id); }
    if (batch_id) { where.push('v.batch_id=?'); params.push(batch_id); }
    if (cari)     { where.push('(v.username LIKE ? OR v.password LIKE ?)'); params.push(`%${cari}%`, `%${cari}%`); }

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
    if (cari)     { countWhere.push('(username LIKE ? OR password LIKE ?)'); countParams.push(`%${cari}%`, `%${cari}%`); }
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
      LIMIT 10
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
    const prefix   = (req.body.prefix || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
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
        INSERT INTO voucher (username, password, paket_id, status, tgl_expired, batch_id)
        VALUES (?, ?, ?, 'unused', DATE_ADD(NOW(), INTERVAL 365 DAY), ?)
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

    await waService.kirimVoucher({
      no_hp, nama, username: v.username, password: v.password,
      paket: v.nama_paket,
      masa_aktif: `${v.masa_aktif} hari`,
      kecepatan: v.kecepatan_dn ? `${v.kecepatan_dn} Mbps` : '-',
      voucher_list: v.username, quantity: 1
    });

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
  return Array.from({ length: panjang }, () => charset[require('crypto').randomInt(charset.length)]).join('');
}

// ============================================================
// EXPORT BATCH — Excel (.xlsx) & PDF kartu
// ============================================================
const ExcelJS = require('exceljs');
const { renderHtmlToPdf } = require('../services/invoice-pdf');

async function ambilBatch(batchId) {
    return await query(`
        SELECT v.*, p.nama AS nama_paket, p.kecepatan_dn, p.harga, p.masa_aktif, p.satuan_masa
        FROM voucher v LEFT JOIN paket p ON v.paket_id = p.id
        WHERE v.batch_id = ?
        ORDER BY v.id
    `, [batchId]);
}

// GET /api/voucher/batch/:batchId/export-xlsx — unduh daftar voucher batch (Excel)
router.get('/batch/:batchId/export-xlsx', async (req, res, next) => {
    try {
        const rows = await ambilBatch(req.params.batchId);
        if (!rows.length) return res.status(404).json({ error: 'Batch tidak ditemukan' });

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Voucher');
        ws.columns = [
            { header: 'No',       key: 'no',       width: 6  },
            { header: 'Username', key: 'username', width: 18 },
            { header: 'Password', key: 'password', width: 18 },
            { header: 'Paket',    key: 'paket',    width: 24 },
            { header: 'Status',   key: 'status',   width: 12 },
            { header: 'Harga',    key: 'harga',    width: 14 },
            { header: 'Dibuat',   key: 'dibuat',   width: 20 },
        ];
        ws.getRow(1).font = { bold: true };
        rows.forEach((v, i) => ws.addRow({
            no: i + 1, username: sf(v.username), password: sf(v.password),
            paket: sf(v.nama_paket || '-'), status: sf(v.status),
            harga: v.harga ? Number(v.harga) : 0,
            dibuat: v.created_at ? new Date(v.created_at).toLocaleString('id-ID') : ''
        }));
        ws.getColumn('harga').numFmt = '#,##0';

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.batchId}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { next(e); }
});

// GET /api/voucher/batch/:batchId/export-pdf — unduh kartu voucher batch (PDF, pakai template default)
router.get('/batch/:batchId/export-pdf', async (req, res, next) => {
    try {
        const rows = await ambilBatch(req.params.batchId);
        if (!rows.length) return res.status(404).json({ error: 'Batch tidak ditemukan' });

        const tpl = await queryOne(`SELECT * FROM voucher_template WHERE is_default=1 LIMIT 1`)
                 || await queryOne(`SELECT * FROM voucher_template ORDER BY id LIMIT 1`);
        if (!tpl) return res.status(400).json({ error: 'Template voucher belum dikonfigurasi' });

        const isi = (s, v, i) => (s || '')
            .replace(/%username%/g, v.username || '')
            .replace(/%password%/g, v.password || v.username || '')
            .replace(/%profile%/g,  v.nama_paket || '—')
            .replace(/%validity%/g, v.masa_aktif
                ? `${v.masa_aktif} ${v.satuan_masa === 'jam' ? 'Jam' : v.satuan_masa === 'bulan' ? 'Bulan' : 'Hari'}` : '—')
            .replace(/%price%/g,    v.harga ? 'Rp ' + Number(v.harga).toLocaleString('id-ID') : '—')
            .replace(/%no_urut%/g,  String(i + 1).padStart(3, '0'));

        const body   = rows.map((v, i) => isi(tpl.row_html, v, i)).join('');
        // Pertahankan script INLINE (mis. pewarna kartu via window.onload), tapi buang
        // script eksternal (src=...) yang bisa bikin render lambat/menggantung.
        const header = (tpl.header_html || '').replace(/<script[^>]*\ssrc=[^>]*>\s*<\/script>/gi, '');
        const html   = header + body + (tpl.footer_html || '');

        const pdf = await renderHtmlToPdf(html, { margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' } });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.batchId}.pdf"`);
        res.end(pdf);
    } catch (e) { next(e); }
});

// DELETE /api/voucher/batch/:batchId — hapus SELURUH voucher dalam satu batch
router.delete('/batch/:batchId', async (req, res, next) => {
    try {
        const rows = await query('SELECT username FROM voucher WHERE batch_id=?', [req.params.batchId]);
        if (!rows.length) return res.status(404).json({ error: 'Batch tidak ditemukan' });

        const usernames = rows.map(r => r.username);
        const ph = usernames.map(() => '?').join(',');
        // Bersihkan entri RADIUS milik voucher ini (dibatasi ke username voucher batch ini)
        await query(`DELETE FROM radcheck WHERE username IN (${ph})`, usernames).catch(() => {});
        await query(`DELETE FROM radreply WHERE username IN (${ph})`, usernames).catch(() => {});

        const result = await query('DELETE FROM voucher WHERE batch_id=?', [req.params.batchId]);
        res.json({ pesan: `Batch dihapus — ${result.affectedRows} voucher terhapus`, jumlah: result.affectedRows });
    } catch (e) { next(e); }
});

module.exports = router;
