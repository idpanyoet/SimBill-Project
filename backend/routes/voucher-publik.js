// routes/voucher-publik.js — endpoint PUBLIK tanpa JWT
const router = require('express').Router();
const { query, queryOne, withTransaction, generateUniqueInvoiceNo } = require('../config/db');
const paymentService = require('../services/payment');
const waService      = require('../services/whatsapp');
const radiusService  = require('../services/radius');
const rateLimit      = require('express-rate-limit');

const INVOICE_PREFIX = process.env.INVOICE_PREFIX || 'INV';

const limitBeli = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { error: 'Terlalu banyak permintaan, coba lagi nanti.' }
});

// ── GET /voucher/info ── info publik storefront ──────────────
router.get('/info', async (req, res, next) => {
  try {
    const rows = await query(`SELECT kunci, nilai FROM setting WHERE kunci IN (
      'app_name','app_logo','app_url','wa_number','alamat','pg_provider',
      'pg_metode_aktif',
      'pg_metode_aktif_tripay','pg_metode_aktif_duitku',
      'pg_metode_aktif_midtrans','pg_metode_aktif_xendit'
    )`);
    const map = {};
    rows.forEach(r => map[r.kunci] = r.nilai);
    // Kirim metode aktif sesuai provider yang sedang aktif
    const provider = map.pg_provider || 'tripay';
    const metodeKey = 'pg_metode_aktif_' + provider;
    map.pg_metode_aktif = map[metodeKey] || map.pg_metode_aktif || '';
    res.json(map);
  } catch(e) { next(e); }
});

// ── GET /voucher/paket ──────────────────────────────────────
router.get('/paket', async (req, res, next) => {
  try {
    // Coba query lengkap dengan satuan_masa
    let rows;
    try {
      rows = await query(`
        SELECT id, nama, kecepatan_dn, kecepatan_up, harga, masa_aktif, satuan_masa, deskripsi
        FROM paket
        WHERE aktif = 1 AND tipe IN ('hotspot','keduanya') AND COALESCE(izin_voucher,0) = 1
        ORDER BY harga ASC
      `);
    } catch(e) {
      // Fallback: kolom satuan_masa belum ada — jalankan migration dulu
      if (e.message && e.message.includes('satuan_masa')) {
        console.warn('[voucher/paket] Kolom satuan_masa belum ada, menjalankan migration...');
        await query(`ALTER TABLE paket ADD COLUMN satuan_masa ENUM('jam','hari','bulan') NOT NULL DEFAULT 'hari' AFTER masa_aktif`).catch(()=>{});
        rows = await query(`
          SELECT id, nama, kecepatan_dn, kecepatan_up, harga, masa_aktif, 'hari' AS satuan_masa, deskripsi
          FROM paket
          WHERE aktif = 1 AND tipe IN ('hotspot','keduanya') AND COALESCE(izin_voucher,0) = 1
          ORDER BY harga ASC
        `);
      } else { throw e; }
    }
    res.json(rows);
  } catch (e) { next(e); }
});

// ── POST /voucher/beli ──────────────────────────────────────
// ALUR BARU: Invoice dibuat dulu (tanpa voucher). Voucher baru dibuat
// di webhook setelah pembayaran benar-benar lunas dikonfirmasi PG.
router.post('/beli', limitBeli, async (req, res, next) => {
  try {
    let { paket_id, paket_nama, harga: hargaFallback,
            no_hp, nama = 'Pembeli', metode = 'qris' } = req.body;
    // Pembeli voucher tidak login — buang < > dari nama agar tak menyisipkan
    // tag HTML yang dirender mentah di daftar voucher panel admin.
    nama = String(nama).replace(/[<>]/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 80) || 'Pembeli';

    if (!no_hp) return res.status(400).json({ error: 'no_hp wajib diisi' });
    if (!paket_id && !paket_nama)
      return res.status(400).json({ error: 'paket_id atau paket_nama wajib diisi' });

    const noHpNormal = no_hp.replace(/[-\s]/g, '').replace(/^0/, '62').replace(/^\+/, '');

    // Lookup paket dari DB — harga tidak bisa dimanipulasi client
    let paket;
    if (paket_id && !isNaN(parseInt(paket_id))) {
      paket = await queryOne('SELECT * FROM paket WHERE id = ? AND aktif = 1', [parseInt(paket_id)]);
    }
    if (!paket && paket_nama) {
      paket = await queryOne('SELECT * FROM paket WHERE nama = ? AND aktif = 1', [paket_nama]);
    }
    if (!paket && hargaFallback) {
      console.error('[VOUCHER] Permintaan beli dengan paket fallback (tabel paket kosong).');
      return res.status(503).json({
        error: 'Paket voucher belum dikonfigurasi oleh admin. Silakan coba lagi nanti.'
      });
    }
    if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });

    const order_id = `VCR${Date.now().toString(36).toUpperCase()}`;
    const tahun    = new Date().getFullYear();
    const tglJatuh = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Buat HANYA invoice (tanpa voucher) — invoice menampung info pembeli
    // di kolom keterangan agar webhook bisa buat voucher setelah lunas.
    // PENTING: no_invoice = order_id (VCR...) supaya webhook bisa menemukan
    // invoice ini saat Duitku callback (Duitku mengirim balik order_id).
    const ket = `Voucher PENDING — WA: ${noHpNormal} — Nama: ${nama} — Paket: ${paket.id}`;
    const noInv = order_id;
    await query(`
      INSERT INTO invoice
        (no_invoice, pelanggan_id, paket_id, jumlah, tgl_invoice,
         tgl_jatuh_tempo, keterangan, status)
      VALUES (?, NULL, ?, ?, CURDATE(), ?, ?, 'unpaid')
    `, [noInv, paket.id, paket.harga, tglJatuh, ket]);

    // Buat transaksi payment gateway
    const pg = await paymentService.buatTransaksi({
      order_id,
      gross_amount: paket.harga,
      metode,
      pelanggan: {
        nama, no_hp: noHpNormal,
        username:   `voucher_${Date.now()}`,
        email:      `${noHpNormal}@voucher.id`,
        paket_id:   paket.id,
        nama_paket: paket.nama
      }
    }).catch(err => {
      console.warn(`[VOUCHER] Payment gateway gagal untuk ${order_id}:`, err.message);
      return null;
    });

    // Gagal buat link bayar → hapus invoice agar tidak menggantung
    if (!pg?.payment_url) {
      await query('DELETE FROM invoice WHERE no_invoice = ?', [noInv]);
      console.error(`[VOUCHER] Payment gateway gagal untuk ${order_id}.`);
      return res.status(503).json({
        error: 'Sistem pembayaran sedang tidak tersedia. Silakan coba beberapa saat lagi atau hubungi admin.'
      });
    }

    // Simpan payment_url & order_id ke invoice
    await query(
      `UPDATE invoice SET payment_id=?, payment_url=? WHERE no_invoice=?`,
      [pg.order_id, pg.payment_url, noInv]
    );

    res.json({
      sukses: false, perlu_bayar: true,
      payment_url: pg.payment_url,
      order_id, no_invoice: noInv,
      pesan: 'Selesaikan pembayaran untuk mendapatkan kode voucher'
    });
  } catch (e) { next(e); }
});

// ── GET /voucher/cek?username= ──────────────────────────────
router.get('/cek', async (req, res, next) => {
  try {
    const username = req.query.username || req.query.kode;
    if (!username) return res.status(400).json({ error: 'username wajib' });
    const v = await queryOne(
      `SELECT v.*, p.nama AS nama_paket, p.kecepatan_dn, p.masa_aktif, p.satuan_masa
       FROM voucher v JOIN paket p ON v.paket_id = p.id
       WHERE v.username = ?`, [username]
    );
    if (!v) return res.status(404).json({ error: 'Voucher tidak ditemukan' });
    res.json(v);
  } catch(e) { next(e); }
});

// GET /voucher/stats
router.get('/stats', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    try {
        const [pelanggan] = await query(
            `SELECT COUNT(*) AS total FROM pelanggan WHERE status != 'nonaktif'`
        );
        const [online] = await query(
            `SELECT COUNT(DISTINCT username) AS total FROM radacct WHERE acctstoptime IS NULL`
        );
        res.json({
            total_pelanggan: pelanggan.total || 0,
            aktif_online:    online.total    || 0
        });
    } catch(e) {
        try {
            const [pelanggan] = await query(
                `SELECT COUNT(*) AS total FROM pelanggan WHERE status != 'nonaktif'`
            );
            res.json({ total_pelanggan: pelanggan.total || 0, aktif_online: 0 });
        } catch(e2) { next(e2); }
    }
});

function _acakUsername() {
  // Format voucher pembelian online: 'VX' + 8 karakter acak (huruf besar + angka)
  // Total 10 digit. Contoh: VXA7K2M9P3
  // Charset tanpa karakter ambigu (tanpa I,O,0,1) agar mudah dibaca.
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const acak = Array.from({ length: 8 }, () => c[require('crypto').randomInt(c.length)]).join('');
  return 'VX' + acak;
}

async function _aktivasiVoucher(username, noHp, nama, paket) {
  const existing = await queryOne('SELECT id FROM voucher WHERE username = ?', [username]);
  if (!existing) {
    // Voucher hasil pembelian dibuat berstatus 'unused'.
    // Status berubah 'used' otomatis saat pelanggan login (via syncStatusVoucher
    // yang membaca radacct).
    await query(`
      INSERT INTO voucher (username, password, paket_id, status)
      VALUES (?, ?, ?, 'unused')
    `, [username, username, paket.id]);
  }
  // Jika voucher sudah ada, JANGAN paksa jadi used — biarkan status apa adanya.

  radiusService.syncVoucher(username).catch(e => console.warn('[sync]', e.message));

  const v = await queryOne('SELECT password FROM voucher WHERE username = ?', [username]);
  const satuan    = paket.satuan_masa === 'jam' ? 'Jam' : paket.satuan_masa === 'bulan' ? 'Bulan' : 'Hari';
  const masaAktif = `${paket.masa_aktif} ${satuan}`;
  const kecepatan = `${paket.kecepatan_dn} Mbps`;
  const displayPw = (v && v.password !== username) ? v.password : username;

  // Kirim lewat fungsi terpusat (baca template wa_tpl_voucher_sukses + placeholder lengkap)
  await waService.kirimVoucher({
    no_hp: noHp, nama,
    username, password: displayPw,
    paket: paket.nama,
    masa_aktif: masaAktif,
    kecepatan,
    voucher_list: username, quantity: 1
  });
}

// ── GET /voucher/isolir-info ── info tagihan untuk halaman isolir ──────
// Deteksi pelanggan dari IP isolir (radacct framedipaddress) atau ?username=
router.get('/isolir-info', async (req, res, next) => {
  try {
    const brand = await query(`SELECT kunci,nilai FROM setting WHERE kunci IN ('app_name','app_logo')`);
    const bmap = {}; brand.forEach(r => bmap[r.kunci] = r.nilai);

    let pelanggan = null;
    const username = (req.query.username || '').trim();

    if (username) {
      // Cari berdasarkan username ATAU nama (LIKE, ambil yang paling cocok)
      pelanggan = await queryOne(
        `SELECT id, nama, username, no_hp, status, tgl_expired FROM pelanggan
         WHERE username = ? OR nama = ?
         ORDER BY (username = ?) DESC LIMIT 1`,
        [username, username, username]);
      // Kalau tidak ada yang persis, coba pencarian LIKE (nama/username)
      if (!pelanggan) {
        const like = `%${username}%`;
        pelanggan = await queryOne(
          `SELECT id, nama, username, no_hp, status, tgl_expired FROM pelanggan
           WHERE username LIKE ? OR nama LIKE ?
           ORDER BY (status='suspended') DESC LIMIT 1`,
          [like, like]);
      }
    } else {
      // Deteksi dari IP klien (yang dilihat server) — cocokkan ke sesi radacct aktif
      let ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (ip.startsWith('::ffff:')) ip = ip.slice(7);
      if (ip) {
        pelanggan = await queryOne(`
          SELECT p.id, p.nama, p.username, p.no_hp, p.status, p.tgl_expired
          FROM radacct r
          JOIN pelanggan p ON p.username = r.username
          WHERE r.framedipaddress = ? AND r.acctstoptime IS NULL
          ORDER BY r.radacctid DESC LIMIT 1`, [ip]);
      }
    }

    if (!pelanggan) {
      return res.json({
        ditemukan: false,
        app_name: bmap.app_name || 'SimBill',
        app_logo: bmap.app_logo || ''
      });
    }

    // Cari invoice tertunggak (unpaid/pending) milik pelanggan ini
    const tagihan = await query(`
      SELECT i.no_invoice, i.jumlah, i.status, i.tgl_jatuh_tempo, pk.nama AS nama_paket
      FROM invoice i
      LEFT JOIN paket pk ON i.paket_id = pk.id
      WHERE i.pelanggan_id = ? AND i.status IN ('unpaid','pending')
      ORDER BY i.tgl_jatuh_tempo ASC`, [pelanggan.id]);

    res.json({
      ditemukan: true,
      app_name: bmap.app_name || 'SimBill',
      app_logo: bmap.app_logo || '',
      pelanggan: {
        nama: pelanggan.nama,
        username: pelanggan.username,
        status: pelanggan.status,
        tgl_expired: pelanggan.tgl_expired
      },
      tagihan
    });
  } catch (e) { next(e); }
});

// ── GET /voucher/invoice/:no ── info tagihan untuk halaman bayar ──────
// Publik (tanpa login) — dipakai halaman /bayar/:no_invoice yang link-nya
// dikirim via WA. Hanya mengembalikan data minimal yang aman ditampilkan.
router.get('/invoice/:no', async (req, res, next) => {
  try {
    const inv = await queryOne(`
      SELECT i.no_invoice, i.jumlah, i.status, i.tgl_jatuh_tempo, i.payment_url,
             p.nama AS nama_pelanggan, pk.nama AS nama_paket
      FROM invoice i
      LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
      LEFT JOIN paket pk ON i.paket_id = pk.id
      WHERE i.no_invoice = ?`, [req.params.no]);
    if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });

    // metode aktif sesuai provider
    const rows = await query(`SELECT kunci,nilai FROM setting WHERE kunci IN
      ('app_name','app_logo','pg_provider','pg_metode_aktif',
       'pg_metode_aktif_tripay','pg_metode_aktif_duitku',
       'pg_metode_aktif_midtrans','pg_metode_aktif_xendit')`);
    const map = {}; rows.forEach(r => map[r.kunci] = r.nilai);
    const provider = map.pg_provider || 'duitku';
    const metode_aktif = map['pg_metode_aktif_' + provider] || map.pg_metode_aktif || '';

    res.json({
      no_invoice: inv.no_invoice,
      jumlah:     inv.jumlah,
      status:     inv.status,
      tgl_jatuh_tempo: inv.tgl_jatuh_tempo,
      nama_pelanggan:  inv.nama_pelanggan,
      nama_paket:      inv.nama_paket,
      sudah_bayar:     inv.status === 'paid',
      app_name:   map.app_name || 'SimBill',
      app_logo:   map.app_logo || '',
      metode_aktif
    });
  } catch (e) { next(e); }
});

// ── POST /voucher/invoice/:no/bayar ── buat link bayar metode pilihan ──
const limitBayar = rateLimit({ windowMs: 10 * 60 * 1000, max: 15,
  message: { error: 'Terlalu banyak percupaan, coba lagi nanti.' } });

router.post('/invoice/:no/bayar', limitBayar, async (req, res, next) => {
  try {
    const { metode } = req.body;
    const inv = await queryOne(`
      SELECT i.*, p.nama, p.no_hp, p.username, p.email
      FROM invoice i LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
      WHERE i.no_invoice = ?`, [req.params.no]);
    if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
    if (inv.status === 'paid') return res.status(400).json({ error: 'Invoice sudah dibayar' });

    const pg = await paymentService.buatTransaksi({
      order_id:     inv.no_invoice,
      gross_amount: Number(inv.jumlah),
      metode:       metode || undefined,
      pelanggan: {
        nama:     inv.nama || 'Pelanggan',
        no_hp:    inv.no_hp || '',
        username: inv.username || 'cust',
        email:    inv.email || ''
      }
    }).catch(err => {
      console.warn(`[BAYAR] PG gagal untuk ${inv.no_invoice}:`, err.message);
      return null;
    });

    if (pg && pg.payment_url) {
      await query('UPDATE invoice SET payment_id=?, payment_url=? WHERE id=?',
        [pg.order_id || null, pg.payment_url, inv.id]).catch(()=>{});
      return res.json({ payment_url: pg.payment_url });
    }
    return res.status(502).json({ error: 'Gagal membuat link pembayaran. Coba metode lain atau hubungi admin.' });
  } catch (e) { next(e); }
});

// ── GET /voucher/hasil/:order ── ambil voucher hasil pembelian ──────
// Dipakai halaman /pembayaran/selesai untuk menampilkan kode voucher.
// order = no_invoice voucher (mis. VCRMQPAWMOJ). Voucher dibuat di webhook,
// username-nya disimpan di keterangan invoice "— VoucherDibuat: XXXX".
router.get('/hasil/:order', async (req, res, next) => {
  try {
    const inv = await queryOne(
      `SELECT keterangan, status FROM invoice WHERE no_invoice=? AND pelanggan_id IS NULL`,
      [req.params.order]
    );
    if (!inv) return res.json({ ada: false });
    if (inv.status !== 'paid') return res.json({ ada: false, pending: true });

    const m = (inv.keterangan || '').match(/VoucherDibuat:\s*([A-Za-z0-9]+)/);
    if (m) {
      const v = await queryOne(
        `SELECT v.username, v.password, p.nama AS nama_paket
         FROM voucher v LEFT JOIN paket p ON v.paket_id=p.id
         WHERE v.username=?`, [m[1]]
      );
      if (v) {
        return res.json({
          ada: true,
          username: v.username,
          password: (v.password && v.password !== v.username) ? v.password : v.username,
          nama_paket: v.nama_paket || ''
        });
      }
    }

    // FALLBACK (order lama tanpa tag): cari voucher dari nomor WA pembeli.
    // Keterangan format "Voucher PENDING — WA: 628xxx — Nama: ... — Paket: N"
    const waMatch    = (inv.keterangan || '').match(/WA:\s*(\d+)/);
    const paketMatch = (inv.keterangan || '').match(/Paket:\s*(\d+)/);
    if (waMatch) {
      const noHp = waMatch[1];
      // voucher 'used' dgn digunakan_oleh = WA pembeli, paket cocok, dibuat dekat waktu invoice
      const params = [noHp];
      let sql = `SELECT v.username, v.password, p.nama AS nama_paket
                 FROM voucher v LEFT JOIN paket p ON v.paket_id=p.id
                 WHERE v.digunakan_oleh = ?`;
      if (paketMatch) { sql += ` AND v.paket_id = ?`; params.push(parseInt(paketMatch[1])); }
      sql += ` ORDER BY v.tgl_digunakan DESC LIMIT 1`;
      const v = await queryOne(sql, params);
      if (v) {
        return res.json({
          ada: true,
          username: v.username,
          password: (v.password && v.password !== v.username) ? v.password : v.username,
          nama_paket: v.nama_paket || ''
        });
      }
    }

    return res.json({ ada: false, pending: true });
  } catch (e) { next(e); }
});

module.exports = { router, _aktivasiVoucher, _acakUsername, buatVoucherDariInvoice };

// Buat voucher untuk sebuah invoice voucher online (VCR, pelanggan_id NULL)
// berdasarkan keterangan ("WA: xxx — Nama: xxx — Paket: id"). Idempotent:
// kalau keterangan sudah ada "VoucherDibuat:", langsung kembalikan kode itu.
// Dipakai oleh webhook (via _aktivasiVoucher) DAN saat Lunasi manual.
// Mengembalikan { username, created } atau null bila gagal.
async function buatVoucherDariInvoice(invId) {
    const inv = await queryOne('SELECT * FROM invoice WHERE id=? AND pelanggan_id IS NULL', [invId]);
    if (!inv) return null;
    const ket = inv.keterangan || '';
    const sudah = ket.match(/VoucherDibuat:\s*([A-Za-z0-9_-]+)/i);
    if (sudah) return { username: sudah[1], created: false };

    const waMatch   = ket.match(/WA:\s*(\d+)/);
    const namaMatch = ket.match(/Nama:\s*([^—]+)/);
    const noHp     = waMatch?.[1];
    const namaBeli = namaMatch?.[1]?.trim() || 'Pelanggan';
    if (!noHp) { console.warn(`[VOUCHER] buatVoucherDariInvoice: WA tidak ada di keterangan inv ${invId}`); }

    const paket = await queryOne('SELECT * FROM paket WHERE id=?', [inv.paket_id]);
    if (!paket) { console.warn(`[VOUCHER] buatVoucherDariInvoice: paket ${inv.paket_id} tak ada`); return null; }

    const username = _acakUsername();
    // Buat voucher + kirim WA (kalau noHp ada). _aktivasiVoucher aman dipanggil
    // walau noHp kosong (WA-nya saja yang gagal, voucher tetap dibuat).
    await _aktivasiVoucher(username, noHp || '', namaBeli, paket);
    await query(`UPDATE invoice SET keterangan = CONCAT(COALESCE(keterangan,''), ' — VoucherDibuat: ', ?) WHERE id=?`,
        [username, invId]).catch(()=>{});
    console.log(`[VOUCHER] Voucher dibuat dari invoice ${inv.no_invoice} → ${username}`);
    return { username, created: true };
}
