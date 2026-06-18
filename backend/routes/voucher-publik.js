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
    const rows = await query(`SELECT kunci, nilai FROM setting WHERE kunci IN ('app_name','wa_number','alamat','pg_metode_aktif')`);
    const map = {};
    rows.forEach(r => map[r.kunci] = r.nilai);
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
        WHERE aktif = 1 AND tipe IN ('hotspot','keduanya')
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
          WHERE aktif = 1 AND tipe IN ('hotspot','keduanya')
          ORDER BY harga ASC
        `);
      } else { throw e; }
    }
    res.json(rows);
  } catch (e) { next(e); }
});

// ── POST /voucher/beli ──────────────────────────────────────
router.post('/beli', limitBeli, async (req, res, next) => {
  try {
    const { paket_id, paket_nama, harga: hargaFallback,
            no_hp, nama = 'Pembeli', metode = 'qris' } = req.body;

    if (!no_hp) return res.status(400).json({ error: 'no_hp wajib diisi' });
    if (!paket_id && !paket_nama)
      return res.status(400).json({ error: 'paket_id atau paket_nama wajib diisi' });

    const noHpNormal = no_hp.replace(/[-\s]/g, '').replace(/^0/, '62').replace(/^\+/, '');

    // Lookup paket — utamakan paket_id, fallback ke nama. Paket HARUS berasal
    // dari database (punya id valid) agar harga tidak bisa dimanipulasi dari
    // sisi client — lihat penolakan hargaFallback di bawah.
    let paket;
    if (paket_id && !isNaN(parseInt(paket_id))) {
      paket = await queryOne('SELECT * FROM paket WHERE id = ? AND aktif = 1', [parseInt(paket_id)]);
    }
    if (!paket && paket_nama) {
      paket = await queryOne('SELECT * FROM paket WHERE nama = ? AND aktif = 1', [paket_nama]);
    }
    if (!paket && hargaFallback) {
      // Frontend mengirim harga dari data fallback hardcode (dipakai saat
      // tabel `paket` kosong di database). Harga ini TIDAK divalidasi server
      // sehingga tidak aman dipakai untuk transaksi finansial sungguhan —
      // tolak di sini dengan pesan yang jelas untuk admin.
      console.error('[VOUCHER] Permintaan beli dengan paket fallback (tabel paket kosong/tidak ada yang aktif untuk hotspot). Admin perlu menambah paket di dashboard.');
      return res.status(503).json({
        error: 'Paket voucher belum dikonfigurasi oleh admin. Silakan coba lagi nanti.'
      });
    }
    if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });

    const username = _acakUsername();
    const password = username; // pembelian online pakai mode username=password agar mudah diingat pembeli
    const order_id = `VCR${Date.now().toString(36).toUpperCase()}`;
    const tahun    = new Date().getFullYear();
    const tglJatuh = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Voucher + invoice dibuat dalam SATU transaksi atomik, dengan nomor
    // invoice yang aman dari race condition (banyak pembeli bersamaan).
    // Jika salah satu insert gagal, voucher TIDAK akan tersimpan sendirian
    // tanpa invoice (mencegah voucher "bocor" gratis).
    const hasil = await withTransaction(async (db) => {
      await db.query(`
        INSERT INTO voucher (username, password, paket_id, status, tgl_expired)
        VALUES (?, ?, ?, 'unused', DATE_ADD(NOW(), INTERVAL 365 DAY))
      `, [username, password, paket.id]);

      return generateUniqueInvoiceNo(db, INVOICE_PREFIX, tahun, (noInvoice) =>
        db.query(`
          INSERT INTO invoice
            (no_invoice, pelanggan_id, paket_id, jumlah, tgl_invoice,
             tgl_jatuh_tempo, keterangan, status)
          VALUES (?, NULL, ?, ?, CURDATE(), ?, ?, 'unpaid')
        `, [noInvoice, paket.id, paket.harga, tglJatuh,
            `Voucher ${username} — WA: ${noHpNormal} — Nama: ${nama}`])
      );
    });
    const noInv = hasil.no_invoice;

    // Buat transaksi payment gateway SETELAH invoice tersimpan dengan aman
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

    // Tidak berhasil membuat link bayar (kredensial payment gateway belum
    // diisi/salah, provider down, dsb). PENTING: voucher TIDAK PERNAH
    // diaktifkan otomatis di jalur ini — voucher hanya boleh aktif setelah
    // webhook pembayaran sungguhan diterima (lihat routes/webhook.js ->
    // _prosesKonfirmasiBayar). Hapus voucher+invoice yang baru dibuat supaya
    // tidak ada record "menggantung" tanpa cara dibayar.
    if (!pg?.payment_url) {
      await query('DELETE FROM voucher WHERE username = ? AND status = ?', [username, 'unused']);
      await query('DELETE FROM invoice WHERE no_invoice = ? AND status = ?', [noInv, 'unpaid']);

      console.error(`[VOUCHER] Payment gateway gagal membuat transaksi untuk ${order_id}. Cek konfigurasi Payment Gateway di dashboard admin (menu Payment).`);
      return res.status(503).json({
        error: 'Sistem pembayaran sedang tidak tersedia. Silakan coba beberapa saat lagi atau hubungi admin.'
      });
    }

    // Simpan payment_url ke invoice, lalu arahkan pembeli untuk bayar
    await query(
      `UPDATE invoice SET payment_id=?, payment_url=? WHERE no_invoice=?`,
      [pg.order_id, pg.payment_url, noInv]
    );

    // Sync voucher baru ke radcheck agar siap autentikasi setelah bayar
    radiusService.syncVoucher(username).catch(e => console.warn('[sync]', e.message));

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
    const username = req.query.username || req.query.kode; // 'kode' diterima juga untuk kompatibilitas link lama
    if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

    const v = await queryOne(`
      SELECT v.*, p.nama AS nama_paket, p.kecepatan_dn, p.masa_aktif
      FROM voucher v
      JOIN paket p ON v.paket_id = p.id
      WHERE v.username = ?
    `, [username.trim().toUpperCase()]);

    if (!v) return res.status(404).json({ error: 'Voucher tidak ditemukan' });

    // Auto-expire
    if (v.status === 'unused' && v.tgl_expired && new Date(v.tgl_expired) < new Date()) {
      await query(`UPDATE voucher SET status = 'expired' WHERE username = ?`, [v.username]);
      v.status = 'expired';
    }

    res.json({
      username:      v.username,
      password:      v.password,
      status:        v.status,
      paket:         v.nama_paket,
      kecepatan:     `${v.kecepatan_dn} Mbps`,
      masa_aktif: v.satuan_masa === 'jam' ? `${v.masa_aktif} Jam` : v.satuan_masa === 'bulan' ? `${v.masa_aktif} Bulan` : `${v.masa_aktif} Hari`,
      tgl_expired:   v.tgl_expired,
      tgl_digunakan: v.tgl_digunakan
    });
  } catch (e) { next(e); }
});

// ── PRIVATE: aktifkan voucher setelah bayar ─────────────────
async function _aktivasiVoucher(username, noHp, nama, paket) {
  if (paket.id) {
    await query(`
      UPDATE voucher
      SET status = 'used', digunakan_oleh = ?, tgl_digunakan = NOW()
      WHERE username = ?
    `, [noHp, username]);

    // Sync ke radcheck agar langsung bisa autentikasi di RADIUS
    radiusService.syncVoucher(username).catch(e => console.warn('[sync]', e.message));
  }

  const v = await queryOne('SELECT password FROM voucher WHERE username = ?', [username]);
  const loginInfo = (v && v.password === username)
    ? `🔑 Username/Password: *${username}*`
    : `🔑 Username: *${username}*\n🔒 Password: *${v?.password || username}*`;

  const pesan =
`Halo *${nama}*,

Terima kasih! Pembayaran diterima ✅

Berikut voucher internet Anda:

${loginInfo}
📦 Paket: ${paket.nama}
⏱ Berlaku: ${paket.masa_aktif} ${paket.satuan_masa === 'jam' ? 'Jam' : paket.satuan_masa === 'bulan' ? 'Bulan' : 'Hari'}
🚀 Kecepatan: ${paket.kecepatan_dn} Mbps

Cara pakai:
1️⃣ Sambungkan ke WiFi hotspot
2️⃣ Buka browser
3️⃣ Masuk halaman login hotspot
4️⃣ Masukkan username & password di atas

Selamat menikmati! 🌐`;

  await waService.kirimPesan(noHp, pesan, null, 'otp');
}

function _acakUsername() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa karakter ambigu (0/O, 1/I) untuk pembelian publik
  return Array.from({ length: 10 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// GET /voucher/stats — statistik publik untuk halaman storefront (no auth)
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
        // Jika radacct belum ada, tetap kembalikan pelanggan saja
        try {
            const [pelanggan] = await query(
                `SELECT COUNT(*) AS total FROM pelanggan WHERE status != 'nonaktif'`
            );
            res.json({ total_pelanggan: pelanggan.total || 0, aktif_online: 0 });
        } catch(e2) { next(e2); }
    }
});

module.exports = { router, _aktivasiVoucher };
