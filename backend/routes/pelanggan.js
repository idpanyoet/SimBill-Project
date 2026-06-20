// routes/pelanggan.js — Manajemen pelanggan + sinkronisasi RADIUS
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, queryOne, hitungExpired } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const radiusService = require('../services/radius');
const dayjs = require('dayjs');

router.use(authMiddleware);

// GET /api/pelanggan — daftar dengan filter & pagination
router.get('/', async (req, res, next) => {
    try {
        const { status, tipe, cari, halaman = 1, limit = 20 } = req.query;
        const offset = (parseInt(halaman) - 1) * parseInt(limit);

        let where = ['1=1'];
        let params = [];

        if (status) { where.push('p.status = ?'); params.push(status); }
        if (tipe)   { where.push('p.tipe_koneksi = ?'); params.push(tipe); }
        if (cari)   {
            where.push('(p.nama LIKE ? OR p.username LIKE ? OR p.no_hp LIKE ?)');
            params.push(`%${cari}%`, `%${cari}%`, `%${cari}%`);
        }

        const whereStr = where.join(' AND ');

        const [total] = await query(
            `SELECT COUNT(*) AS total FROM pelanggan p WHERE ${whereStr}`, params
        );
        const rows = await query(`
            SELECT p.*, pk.nama AS nama_paket, pk.kecepatan_dn, pk.harga
            FROM pelanggan p
            JOIN paket pk ON p.paket_id = pk.id
            WHERE ${whereStr}
            ORDER BY p.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);

        res.json({ data: rows, total: total.total, halaman, limit });
    } catch (e) { next(e); }
});

// ── POST /api/pelanggan/upload-ktp ───────────────────────────
router.post('/upload-ktp', async (req, res, next) => {
    try {
        const { data, ext = 'jpg', username } = req.body;
        if (!data) return res.status(400).json({ error: 'Data gambar kosong' });
        const fs   = require('fs');
        const path = require('path');
        const dir  = path.join(__dirname, '../../frontend/uploads/ktp');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const base64  = data.replace(/^data:image\/\w+;base64,/, '');
        const safe    = (username || 'ktp').replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeExt = /^(png|jpe?g|webp)$/i.test(ext) ? ext.toLowerCase() : 'jpg';
        const filename = `ktp_${safe}_${Date.now()}.${safeExt}`;
        fs.writeFileSync(path.join(dir, filename), Buffer.from(base64, 'base64'));
        res.json({ url: `/uploads/ktp/${filename}` });
    } catch(e) { next(e); }
});

// ── GET /api/pelanggan/peta — data pelanggan untuk peta ──────
router.get('/peta', async (req, res, next) => {
    try {
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS odc VARCHAR(64) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS odp VARCHAR(64) NULL`).catch(()=>{});

        const rows = await query(`
            SELECT p.id, p.nama, p.username, p.no_hp, p.tipe_koneksi, p.status,
                   p.latitude, p.longitude, p.odc, p.odp, p.alamat,
                   pk.nama AS nama_paket
            FROM pelanggan p
            JOIN paket pk ON p.paket_id = pk.id
            WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
              AND p.status != 'nonaktif'
        `);
        res.json(rows);
    } catch(e) { next(e); }
});


// ── GET /api/pelanggan/export/csv ─────────────────────────────
router.get('/export/csv', async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT p.nama, p.username, p.no_hp, p.email, p.alamat,
                   p.tipe_koneksi, p.status, p.tgl_aktif, p.tgl_expired,
                   p.ip_tetap, p.notes,
                   pk.nama AS nama_paket, pk.id AS paket_id
            FROM pelanggan p
            JOIN paket pk ON p.paket_id = pk.id
            ORDER BY p.created_at DESC
        `);

        const header = ['nama','username','no_hp','email','alamat','tipe_koneksi',
                        'status','tgl_aktif','tgl_expired','ip_tetap','notes',
                        'nama_paket','paket_id'];
        const esc = (v) => {
            if (v == null) return '';
            const s = String(v);
            return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [
            header.join(','),
            ...rows.map(r => header.map(k => esc(r[k])).join(','))
        ].join('\r\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="pelanggan-${new Date().toISOString().slice(0,10)}.csv"`);
        res.send('\uFEFF' + csv); // BOM agar Excel baca UTF-8 dengan benar
    } catch (e) { next(e); }
});

// ── POST /api/pelanggan/import/csv ────────────────────────────
router.post('/import/csv', async (req, res, next) => {
    try {
        const { rows } = req.body; // array of objects dari frontend
        if (!Array.isArray(rows) || !rows.length)
            return res.status(400).json({ error: 'Data kosong' });

        let sukses = 0, gagal = 0;
        const errors = [];

        for (const row of rows) {
            try {
                const { nama, username, password, no_hp, tipe_koneksi, paket_id, email, alamat, notes } = row;
                if (!nama || !username || !password || !no_hp || !paket_id)
                    throw new Error('Kolom wajib tidak lengkap');
                if (!['pppoe','hotspot'].includes(tipe_koneksi))
                    throw new Error(`tipe_koneksi tidak valid: ${tipe_koneksi}`);

                const existing = await queryOne('SELECT id FROM pelanggan WHERE username = ?', [username]);
                if (existing) throw new Error(`Username '${username}' sudah ada`);

                const paket = await queryOne('SELECT * FROM paket WHERE id = ?', [parseInt(paket_id)]);
                if (!paket) throw new Error(`Paket id ${paket_id} tidak ditemukan`);

                const tgl_aktif   = dayjs().format('YYYY-MM-DD');
                const tgl_expired = hitungExpired(paket.masa_aktif, paket.satuan_masa).format('YYYY-MM-DD');
                const hash        = await bcrypt.hash(password, 10);

                const result = await query(`
                    INSERT INTO pelanggan (nama, username, password, no_hp, email, alamat,
                        paket_id, tipe_koneksi, tgl_aktif, tgl_expired, notes)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                `, [nama, username, hash, no_hp, email||null, alamat||null,
                    paket.id, tipe_koneksi, tgl_aktif, tgl_expired, notes||null]);

                await radiusService.tambahUser(username, password, paket, tipe_koneksi, null)
                    .catch(e => {
                        query('DELETE FROM pelanggan WHERE id = ?', [result.insertId]).catch(()=>{});
                        throw new Error(`RADIUS gagal: ${e.message}`);
                    });

                sukses++;
            } catch(e) {
                gagal++;
                errors.push({ row: row.username || '?', error: e.message });
            }
        }

        res.json({ sukses, gagal, errors });
    } catch (e) { next(e); }
});


// GET /api/pelanggan/:id
router.get('/:id', async (req, res, next) => {
    try {
        const p = await queryOne(`
            SELECT p.*, pk.nama AS nama_paket, pk.kecepatan_dn, pk.kecepatan_up, pk.harga, pk.pool_name
            FROM pelanggan p JOIN paket pk ON p.paket_id = pk.id
            WHERE p.id = ?
        `, [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
        res.json(p);
    } catch (e) { next(e); }
});

// POST /api/pelanggan — tambah pelanggan baru
router.post('/', async (req, res, next) => {
    let step = 'validasi';
    try {
        const { nama, username, password, no_hp, email, alamat,
                paket_id, tipe_koneksi, ip_tetap, notes,
                latitude, longitude, odc, odp,
                no_ktp, tgl_lahir, ktp_url, reseller_id } = req.body;

        if (!nama || !username || !password || !no_hp || !paket_id)
            return res.status(400).json({ error: 'nama, username, password, no_hp, paket_id wajib diisi' });
        if (!['pppoe', 'hotspot'].includes(tipe_koneksi))
            return res.status(400).json({ error: 'tipe_koneksi harus pppoe atau hotspot' });

        step = 'cek_username';
        const existing = await queryOne('SELECT id FROM pelanggan WHERE username = ?', [username]);
        if (existing) return res.status(400).json({ error: 'Username sudah digunakan' });

        step = 'ambil_paket';
        const paket = await queryOne('SELECT * FROM paket WHERE id = ?', [paket_id]);
        if (!paket) return res.status(400).json({ error: 'Paket tidak ditemukan' });

        // Auto-migrate kolom peta jika belum ada
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS odc VARCHAR(64) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS odp VARCHAR(64) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS no_ktp VARCHAR(20) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS tgl_lahir DATE NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS ktp_url VARCHAR(255) NULL`).catch(()=>{});

        step = 'siapkan_data';
        const tgl_aktif    = dayjs().format('YYYY-MM-DD');
        const tgl_expired  = hitungExpired(paket.masa_aktif, paket.satuan_masa).format('YYYY-MM-DD');
        const hash         = await bcrypt.hash(password, 12);

        step = 'insert_pelanggan';
        const result = await query(`
            INSERT INTO pelanggan (nama, username, password, no_hp, email, alamat,
                paket_id, tipe_koneksi, tgl_aktif, tgl_expired, ip_tetap, notes,
                latitude, longitude, odc, odp, no_ktp, tgl_lahir, ktp_url, reseller_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [nama, username, hash, no_hp, email || null, alamat || null,
            paket_id, tipe_koneksi, tgl_aktif, tgl_expired, ip_tetap || null, notes || null,
            latitude || null, longitude || null, odc || null, odp || null,
            no_ktp || null, tgl_lahir || null, ktp_url || null, reseller_id || null]);

        step = 'sync_radius';
        // Sync ke FreeRADIUS — jika gagal, hapus dulu baris pelanggan agar tidak ada data
        // pelanggan "hantu" yang tidak punya akses internet sama sekali.
        try {
            await radiusService.tambahUser(username, password, paket, tipe_koneksi, ip_tetap);
        } catch (radiusErr) {
            step = 'rollback_setelah_radius_gagal';
            await query('DELETE FROM pelanggan WHERE id = ?', [result.insertId]);
            throw new Error(`Gagal sinkronisasi RADIUS: ${radiusErr.message}`);
        }

        // Kirim WA notifikasi pelanggan baru (non-blocking)
        const waService = require('../services/whatsapp');
        waService.kirimPelangganBaru({
            no_hp:      no_hp,
            nama:       nama,
            username:   username,
            password:   password,
            nama_paket: paket.nama,
            tgl_expired: tgl_expired
        }).catch(e => console.warn('[WA] kirimPelangganBaru gagal:', e.message));

        const { tulisLog } = require('./log');
        tulisLog({ kategori:'Pelanggan', pelaku: req.admin?.nama || 'Admin',
            aksi:'PELANGGAN_TAMBAH', target: username,
            detail:`Nama: ${nama}, Paket: ${paket.nama}, Tipe: ${tipe_koneksi}`, ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip });

        res.status(201).json({
            pesan: 'Pelanggan berhasil ditambahkan',
            id: result.insertId
        });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY')
            return res.status(400).json({ error: 'Username sudah digunakan' });
        // Sertakan info langkah yang gagal agar mudah didiagnosis dari log server,
        // tanpa membocorkan detail teknis ke response client.
        console.error(`[PELANGGAN] Gagal pada langkah '${step}':`, e.message);
        e.message = `[${step}] ${e.message}`;
        next(e);
    }
});

// PUT /api/pelanggan/:id — edit pelanggan
router.put('/:id', async (req, res, next) => {
    try {
        const { nama, no_hp, email, alamat, paket_id, tipe_koneksi, notes, username, password } = req.body;
        if (!nama || !no_hp)
            return res.status(400).json({ error: 'nama dan no_hp wajib diisi' });

        const p = await queryOne('SELECT * FROM pelanggan WHERE id = ?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        // Auto-migrate kolom KTP jika belum ada
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS no_ktp VARCHAR(20) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS tgl_lahir DATE NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS ktp_url VARCHAR(255) NULL`).catch(()=>{});

        const paketIdBaru = paket_id !== undefined && paket_id !== null && paket_id !== ''
            ? parseInt(paket_id) : p.paket_id;
        const tipeBaru    = tipe_koneksi || p.tipe_koneksi;
        const usernameBaru = username || p.username;

        // Ubah password di RADIUS jika password baru diberikan
        if (password) {
            const hash = await bcrypt.hash(password, 12);
            await query('UPDATE pelanggan SET password=? WHERE id=?', [hash, req.params.id]);
            // Update radcheck
            await query(`
                INSERT INTO radcheck (username, attribute, op, value)
                VALUES (?, 'Cleartext-Password', ':=', ?)
                ON DUPLICATE KEY UPDATE value = VALUES(value)
            `, [usernameBaru, password]);
        }

        // Ubah username di RADIUS jika username berubah
        if (usernameBaru !== p.username) {
            // Cek duplikat
            const cek = await queryOne('SELECT id FROM pelanggan WHERE username=? AND id!=?', [usernameBaru, p.id]);
            if (cek) return res.status(400).json({ error: 'Username sudah digunakan pelanggan lain' });
            // Update radcheck — rename username
            await query('UPDATE radcheck SET username=? WHERE username=?', [usernameBaru, p.username]);
            await query('UPDATE radreply SET username=? WHERE username=?', [usernameBaru, p.username]);
            await query('UPDATE radusergroup SET username=? WHERE username=?', [usernameBaru, p.username]);
        }

        await query(`
            UPDATE pelanggan SET nama=?, no_hp=?, email=?, alamat=?,
                paket_id=?, tipe_koneksi=?, notes=?, username=?,
                latitude=?, longitude=?, odc=?, odp=?,
                no_ktp=?, tgl_lahir=?, reseller_id=?
                ${req.body.ktp_url ? ', ktp_url=?' : ''}
            WHERE id = ?
        `, [nama, no_hp, email || null, alamat || null, paketIdBaru, tipeBaru,
            notes || null, usernameBaru,
            req.body.latitude || null, req.body.longitude || null,
            req.body.odc || null, req.body.odp || null,
            req.body.no_ktp || null, req.body.tgl_lahir || null,
            (req.body.reseller_id === '' || req.body.reseller_id == null) ? null : req.body.reseller_id,
            ...(req.body.ktp_url ? [req.body.ktp_url] : []),
            req.params.id]);

        // Update atribut RADIUS jika paket berubah
        if (paketIdBaru !== p.paket_id) {
            const paket = await queryOne('SELECT * FROM paket WHERE id = ?', [paketIdBaru]);
            if (!paket) return res.status(400).json({ error: 'Paket baru tidak ditemukan' });
            await radiusService.updatePaket(usernameBaru, paket, tipeBaru);
        }

        res.json({ pesan: 'Data pelanggan diperbarui' });
    } catch (e) { next(e); }
});

// POST /api/pelanggan/:id/suspend — suspend pelanggan
router.post('/:id/suspend', async (req, res, next) => {
    try {
        const p = await queryOne('SELECT * FROM pelanggan WHERE id = ?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        await query('UPDATE pelanggan SET status = ? WHERE id = ?', ['suspended', req.params.id]);
        await radiusService.suspendUser(p.username);

        // Kirim WA notifikasi suspend
        const waService = require('../services/whatsapp');
        await waService.kirimSuspend(p);

        res.json({ pesan: `${p.nama} berhasil disuspend` });
        require('./log').tulisLog({ kategori:'Pelanggan', pelaku: req.admin?.nama||'Admin',
            aksi:'PELANGGAN_SUSPEND', target: p.username, detail:`Nama: ${p.nama}`, ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip });
    } catch (e) { next(e); }
});

// POST /api/pelanggan/:id/aktifkan — reaktivasi
router.post('/:id/aktifkan', async (req, res, next) => {
    try {
        const p = await queryOne(`
            SELECT pl.*, pk.* FROM pelanggan pl
            JOIN paket pk ON pl.paket_id = pk.id WHERE pl.id = ?
        `, [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        const tgl_expired = hitungExpired(p.masa_aktif, p.satuan_masa).format('YYYY-MM-DD HH:mm:ss');
        await query('UPDATE pelanggan SET status = ?, tgl_expired = ? WHERE id = ?',
            ['aktif', tgl_expired, req.params.id]);
        await radiusService.aktifkanUser(p.username);

        res.json({ pesan: `${p.nama} berhasil diaktifkan` });
        require('./log').tulisLog({ kategori:'Pelanggan', pelaku: req.admin?.nama||'Admin',
            aksi:'PELANGGAN_AKTIFKAN', target: p.username, detail:`Nama: ${p.nama}`, ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip });
    } catch (e) { next(e); }
});

// GET /api/pelanggan/:id/sesi — sesi RADIUS aktif
router.get('/:id/sesi', async (req, res, next) => {
    try {
        const p = await queryOne('SELECT username FROM pelanggan WHERE id = ?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Tidak ditemukan' });
        const sesi = await radiusService.getSesi(p.username);
        res.json(sesi);
    } catch (e) { next(e); }
});

// DELETE /api/pelanggan/:id — hapus pelanggan
router.delete('/:id', async (req, res, next) => {
    try {
        const p = await queryOne('SELECT * FROM pelanggan WHERE id = ?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Tidak ditemukan' });

        await radiusService.hapusUser(p.username);
        await query('DELETE FROM pelanggan WHERE id = ?', [req.params.id]);

        res.json({ pesan: 'Pelanggan dihapus' });
    } catch (e) { next(e); }
});

module.exports = router;
