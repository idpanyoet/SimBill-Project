// services/radius.js — Manajemen user di FreeRADIUS via database
// FreeRADIUS membaca langsung dari tabel radcheck/radreply/radusergroup
const crypto = require('crypto');
const { query, queryOne } = require('../config/db');

// ============================================================
// ENKRIPSI PASSWORD RADIUS (reversible, AES-256-GCM)
// Diperlukan karena password aplikasi disimpan sebagai bcrypt hash
// (satu arah, tidak bisa dibalik), sementara FreeRADIUS butuh
// Cleartext-Password yang harus bisa dipulihkan saat suspend → aktif.
// ============================================================
function _getEncKey() {
    const secret = process.env.JWT_SECRET || 'fallback_key_ganti_di_env';
    return crypto.createHash('sha256').update(secret).digest(); // 32 byte key
}

function encryptPassword(plaintext) {
    const iv     = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', _getEncKey(), iv);
    const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    // Format: iv:tag:ciphertext, semua base64
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptPassword(encoded) {
    if (!encoded) return null;
    const [ivB64, tagB64, dataB64] = encoded.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    try {
        const iv     = Buffer.from(ivB64, 'base64');
        const tag    = Buffer.from(tagB64, 'base64');
        const data   = Buffer.from(dataB64, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', _getEncKey(), iv);
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([decipher.update(data), decipher.final()]);
        return dec.toString('utf8');
    } catch (err) {
        console.error('[RADIUS] Gagal dekripsi password:', err.message);
        return null;
    }
}

// ============================================================
// TAMBAH USER BARU KE RADIUS
// ============================================================
async function tambahUser(username, password, paket, tipe_koneksi, ip_tetap = null) {
    // Validasi defensif: pastikan field penting dari objek paket benar-benar ada.
    // Jika salah satu undefined (misal akibat query SELECT yang salah alias kolom),
    // lempar error yang jelas di sini daripada membiarkan mysql2 melempar error
    // generik "Bind parameters must not contain undefined" di langkah berikutnya.
    if (!paket || typeof paket !== 'object')
        throw new Error('Data paket tidak valid (kosong atau bukan objek)');
    if (paket.kecepatan_dn === undefined || paket.kecepatan_up === undefined)
        throw new Error(`Data paket "${paket.nama || paket.id}" tidak lengkap: kecepatan_dn/kecepatan_up kosong`);

    // 1. Set password di radcheck
    await query(`
        INSERT INTO radcheck (username, attribute, op, value)
        VALUES (?, 'Cleartext-Password', ':=', ?)
        ON DUPLICATE KEY UPDATE value = ?
    `, [username, password, password]);

    // 1b. Simpan password terenkripsi di tabel pelanggan agar bisa dipulihkan
    //     saat aktifkanUser() dipanggil setelah suspend (radcheck dihapus saat suspend).
    try {
        const encrypted = encryptPassword(password);
        await query(
            'UPDATE pelanggan SET radius_password_enc = ? WHERE username = ?',
            [encrypted, username]
        );
    } catch (err) {
        console.warn(`[RADIUS] Gagal simpan password terenkripsi untuk ${username}:`, err.message);
    }

    // 2. Set status aktif (tidak di-reject)
    await _hapusReject(username);

    // 3. Assign ke group paket
    const groupname = _namaGroup(paket, tipe_koneksi);
    await _setGroup(username, groupname);

    // 4. Pastikan group radreply ada
    await _syncGroupPaket(paket, tipe_koneksi);

    // 5. IP tetap jika ada
    if (ip_tetap) {
        await _setIpTetap(username, ip_tetap, tipe_koneksi);
    }

    console.log(`[RADIUS] Tambah user: ${username} → group: ${groupname}`);
}

// ============================================================
// UPDATE PAKET USER (saat ganti paket)
// ============================================================
async function updatePaket(username, paketBaru, tipe_koneksi) {
    await _syncGroupPaket(paketBaru, tipe_koneksi);
    const groupname = _namaGroup(paketBaru, tipe_koneksi);
    await _setGroup(username, groupname);
    console.log(`[RADIUS] Update paket ${username} → ${groupname}`);
}

// ============================================================
// SUSPEND USER (tolak koneksi)
// ============================================================
async function suspendUser(username) {
    // Hapus password → user tidak bisa auth
    await query(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Cleartext-Password'`, [username]);

    // Tambah attribute Auth-Type := Reject
    await query(`
        INSERT INTO radcheck (username, attribute, op, value)
        VALUES (?, 'Auth-Type', ':=', 'Reject')
        ON DUPLICATE KEY UPDATE value = 'Reject'
    `, [username]);

    // Putus sesi aktif (kirim CoA/Disconnect via mikrotik API atau RADIUS CoA)
    await _putusSesilAktif(username);

    console.log(`[RADIUS] Suspend: ${username}`);
}

// ============================================================
// AKTIFKAN KEMBALI USER
// ============================================================
async function aktifkanUser(username) {
    // Hapus reject attribute
    await _hapusReject(username);

    // Cek apakah Cleartext-Password masih ada di radcheck (kasus: tidak pernah
    // disuspend, atau sudah ada). Jika tidak ada (dihapus saat suspend), restore
    // dari password terenkripsi yang disimpan saat user pertama kali dibuat.
    const adaPassword = await queryOne(
        `SELECT id FROM radcheck WHERE username=? AND attribute='Cleartext-Password'`,
        [username]
    );

    if (!adaPassword) {
        const p = await queryOne(
            'SELECT radius_password_enc FROM pelanggan WHERE username = ?',
            [username]
        );
        const plaintext = p?.radius_password_enc ? decryptPassword(p.radius_password_enc) : null;

        if (plaintext) {
            await query(`
                INSERT INTO radcheck (username, attribute, op, value)
                VALUES (?, 'Cleartext-Password', ':=', ?)
                ON DUPLICATE KEY UPDATE value = ?
            `, [username, plaintext, plaintext]);
            console.log(`[RADIUS] Password dipulihkan untuk: ${username}`);
        } else {
            console.error(`[RADIUS] ⚠️ Password tidak dapat dipulihkan untuk ${username} — user TIDAK BISA LOGIN. Reset password manual diperlukan.`);
        }
    }

    console.log(`[RADIUS] Aktifkan: ${username}`);
}

// ============================================================
// HAPUS USER
// ============================================================
async function hapusUser(username) {
    await query('DELETE FROM radcheck WHERE username = ?', [username]);
    await query('DELETE FROM radreply WHERE username = ?', [username]);
    await query('DELETE FROM radusergroup WHERE username = ?', [username]);
    console.log(`[RADIUS] Hapus: ${username}`);
}

// ============================================================
// GET SESI AKTIF USER
// ============================================================
async function getSesi(username) {
    return query(`
        SELECT username, framedipaddress AS ip, nasipaddress AS nas,
            acctstarttime AS mulai,
            TIMESTAMPDIFF(MINUTE, acctstarttime, NOW()) AS durasi_menit,
            ROUND((acctinputoctets+acctoutputoctets)/1048576, 2) AS total_mb
        FROM radacct
        WHERE username = ? AND acctstoptime IS NULL
        ORDER BY acctstarttime DESC
    `, [username]);
}

// GET semua sesi aktif
async function semuaSesiAktif() {
    return query(`
        SELECT ra.username, ra.framedipaddress AS ip,
            ra.nasipaddress AS nas_ip,
            ra.acctstarttime AS mulai,
            TIMESTAMPDIFF(MINUTE, ra.acctstarttime, NOW()) AS durasi_menit,
            ROUND(ra.acctinputoctets/1048576, 4)  AS total_mb_in,
            ROUND(ra.acctoutputoctets/1048576, 4) AS total_mb_out,
            ROUND((ra.acctinputoctets+ra.acctoutputoctets)/1048576, 2) AS total_mb,
            ra.nasporttype,
            n.shortname AS nas_name,
            n.type AS nas_type,
            p.nama AS nama_pelanggan,
            p.tipe_koneksi AS pelanggan_tipe
        FROM radacct ra
        LEFT JOIN nas n ON ra.nasipaddress = n.nasname
        LEFT JOIN pelanggan p ON ra.username = p.username
        WHERE ra.acctstoptime IS NULL
        ORDER BY ra.acctstarttime DESC
    `);
}

// PUTUS SESI user tertentu (disconnect via RADIUS CoA)
async function putusKoneksi(username) {
    await _putusSesilAktif(username);
    return { pesan: `Sesi ${username} diputus` };
}

// ============================================================
// PRIVATE HELPERS
// ============================================================

function _namaGroup(paket, tipe_koneksi) {
    // Format: pppoe-20mbps atau hotspot-10mbps
    const dn = paket.kecepatan_dn;
    return `${tipe_koneksi}-${dn}mbps`;
}

async function _setGroup(username, groupname) {
    await query('DELETE FROM radusergroup WHERE username = ?', [username]);
    await query(`
        INSERT INTO radusergroup (username, groupname, priority) VALUES (?, ?, 1)
    `, [username, groupname]);
}

async function _hapusReject(username) {
    await query(
        `DELETE FROM radcheck WHERE username = ? AND attribute = 'Auth-Type'`,
        [username]
    );
}

async function _setIpTetap(username, ip, tipe_koneksi) {
    const attr = tipe_koneksi === 'pppoe'
        ? 'Framed-IP-Address'
        : 'Framed-IP-Address';

    await query(`
        INSERT INTO radreply (username, attribute, op, value)
        VALUES (?, ?, ':=', ?)
        ON DUPLICATE KEY UPDATE value = ?
    `, [username, attr, ip, ip]);
}

// Pastikan group radgroupreply ada untuk paket ini
async function _syncGroupPaket(paket, tipe_koneksi) {
    const groupname = _namaGroup(paket, tipe_koneksi);
    const speedDn   = `${paket.kecepatan_dn}M`;
    const speedUp   = `${paket.kecepatan_up}M`;
    // Gunakan rate_limit dari paket jika ada (format MikroTik lengkap)
    const rateLimit = paket.rate_limit || `${speedUp}/${speedDn}`;

    // MikroTik menggunakan Mikrotik-Rate-Limit untuk speed
    const attrs = [
        { attribute: 'Mikrotik-Rate-Limit', op: ':=',
          value: rateLimit },
        { attribute: 'Framed-Pool',         op: ':=',
          value: paket.pool_name || `pool-${paket.kecepatan_dn}mbps` },
    ];

    for (const a of attrs) {
        const ada = await queryOne(
            `SELECT id FROM radgroupreply WHERE groupname=? AND attribute=?`,
            [groupname, a.attribute]
        );
        if (!ada) {
            await query(`
                INSERT INTO radgroupreply (groupname, attribute, op, value)
                VALUES (?, ?, ?, ?)
            `, [groupname, a.attribute, a.op, a.value]);
        } else {
            await query(
                `UPDATE radgroupreply SET value=? WHERE groupname=? AND attribute=?`,
                [a.value, groupname, a.attribute]
            );
        }
    }
}

// Putus sesi aktif via RADIUS Disconnect-Message (CoA)
// Memerlukan NAS support RFC 3576 / CoA
async function _putusSesilAktif(username) {
    // Implementasi CoA tergantung NAS — MikroTik mendukung CoA via port 3799
    // Untuk sekarang: cukup hapus dari radacct (sesi akan putus saat NAS re-auth)
    await query(
        `UPDATE radacct SET acctstoptime=NOW(), acctterminatecause='Admin-Reset'
         WHERE username=? AND acctstoptime IS NULL`,
        [username]
    );
    // TODO: Implementasi kirim CoA packet ke NAS menggunakan library node-radius
}

async function _syncGroupPaketPublic(paket, tipe_koneksi) {
    await _syncGroupPaket(paket, tipe_koneksi);
}

// ============================================================
// SYNC VOUCHER → RADCHECK
// Pastikan semua voucher yang aktif (unused/used) terdaftar
// di radcheck agar FreeRADIUS bisa autentikasi.
// Dipanggil setiap kali voucher dibuat, dipakai, atau status berubah.
// ============================================================
async function syncVoucher(username = null) {
    try {
        if (username) {
            // Sync satu user voucher spesifik
            const v = await queryOne(`SELECT username, password FROM voucher WHERE username = ?`, [username]);
            if (!v || !v.username) return;
            await query(`
                INSERT INTO radcheck (username, attribute, op, value)
                VALUES (?, 'Cleartext-Password', ':=', ?)
                ON DUPLICATE KEY UPDATE value = VALUES(value)
            `, [v.username, v.password]);
            console.log(`[radcheck] Synced voucher: ${username}`);
        } else {
            // Sync semua voucher sekaligus
            const result = await query(`
                INSERT INTO radcheck (username, attribute, op, value)
                SELECT username, 'Cleartext-Password', ':=', password
                FROM voucher
                WHERE username IS NOT NULL AND username != ''
                ON DUPLICATE KEY UPDATE value = VALUES(value)
            `);
            console.log(`[radcheck] Synced ${result.affectedRows} voucher(s) to radcheck`);
        }
    } catch(e) {
        console.warn('[radcheck] Sync gagal:', e.message);
    }
}

module.exports = {
    tambahUser,
    updatePaket,
    suspendUser,
    aktifkanUser,
    hapusUser,
    getSesi,
    semuaSesiAktif,
    putusKoneksi,
    _syncGroupPaketPublic,
    encryptPassword,
    decryptPassword,
    syncVoucher
};
