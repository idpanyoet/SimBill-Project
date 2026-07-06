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
    // Kunci khusus enkripsi password RADIUS. Diutamakan RADIUS_ENC_KEY agar
    // rotasi JWT_SECRET (mis. saat dicurigai token bocor) TIDAK membuat semua
    // password tersuspend gagal didekripsi. Fallback ke JWT_SECRET supaya data
    // yang sudah terenkripsi di deployment lama tetap bisa dibuka. Tanpa
    // keduanya → fail-closed (jangan pakai konstanta yang bisa ditebak).
    const secret = process.env.RADIUS_ENC_KEY || process.env.JWT_SECRET;
    if (!secret) throw new Error('RADIUS_ENC_KEY / JWT_SECRET belum diset — kunci enkripsi password RADIUS tidak tersedia.');
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

    // 4b. Terapkan batas Shared Users (Simultaneous-Use) sesuai paket.
    try { await syncSimultaneousUse(username); }
    catch (e) { console.warn(`[RADIUS] sync share ${username}:`, e.message); }

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
    // Paket berganti → batas Shared Users mungkin berubah, terapkan ulang.
    try { await syncSimultaneousUse(username); }
    catch (e) { console.warn(`[RADIUS] sync share ${username}:`, e.message); }
    // Putus sesi aktif supaya pelanggan reconnect & paket/kecepatan baru langsung berlaku
    try { await _putusSesilAktif(username); } catch (e) { console.warn('[RADIUS] putus sesi updatePaket:', e.message); }
    console.log(`[RADIUS] Update paket ${username} → ${groupname}`);
}

// ============================================================
// SUSPEND USER → mode ISOLIR (bukan tolak total).
// User TETAP bisa login PPPoE, tapi diberi Framed-Pool isolir sehingga dapat IP
// dari pool isolir di MikroTik (diarahkan ke halaman tagihan). Nama pool diambil
// dari setting 'isolir_pool' (default 'isolir').
async function suspendUser(username) {
    // Ambil nama pool isolir dari setting (fallback 'isolir')
    let poolIsolir = 'isolir';
    try {
        const s = await queryOne(`SELECT nilai FROM setting WHERE kunci='isolir_pool'`);
        if (s && s.nilai && String(s.nilai).trim()) poolIsolir = String(s.nilai).trim();
    } catch (_) {}

    // Mode isolir berbasis Framed-Pool? cek setting 'isolir_mode' (default 'pool').
    // Jika 'reject', pakai perilaku lama (tolak total).
    let mode = 'pool';
    try {
        const m = await queryOne(`SELECT nilai FROM setting WHERE kunci='isolir_mode'`);
        if (m && m.nilai && String(m.nilai).trim()) mode = String(m.nilai).trim();
    } catch (_) {}

    if (mode === 'reject') {
        // Perilaku lama: tolak total
        await query(`DELETE FROM radcheck WHERE username = ? AND attribute = 'Cleartext-Password'`, [username]);
        await query(`
            INSERT INTO radcheck (username, attribute, op, value)
            VALUES (?, 'Auth-Type', ':=', 'Reject')
            ON DUPLICATE KEY UPDATE value = 'Reject'
        `, [username]);
    } else {
        // Mode ISOLIR: user tetap bisa login, tapi diberi Framed-Pool isolir.
        // Pastikan tidak ada reject attribute yang menghalangi login.
        await _hapusReject(username);
        // Pastikan password masih ada (kalau hilang, pulihkan dari enkripsi)
        await _pastikanPassword(username);
        // Set Framed-Pool = isolir di radreply (timpa jika sudah ada)
        await query(`
            INSERT INTO radreply (username, attribute, op, value)
            VALUES (?, 'Framed-Pool', ':=', ?)
            ON DUPLICATE KEY UPDATE value = ?
        `, [username, poolIsolir, poolIsolir]);
    }

    // Putus sesi aktif via CoA → pelanggan reconnect → dapat IP isolir / ditolak
    await _putusSesilAktif(username);

    console.log(`[RADIUS] Suspend (${mode}): ${username}` + (mode !== 'reject' ? ` → pool ${poolIsolir}` : ''));
}

// Pastikan Cleartext-Password ada (pulihkan dari enkripsi jika hilang)
async function _pastikanPassword(username) {
    const ada = await queryOne(
        `SELECT id FROM radcheck WHERE username=? AND attribute='Cleartext-Password'`, [username]);
    if (ada) return;
    const p = await queryOne('SELECT radius_password_enc FROM pelanggan WHERE username = ?', [username]);
    const plaintext = p?.radius_password_enc ? decryptPassword(p.radius_password_enc) : null;
    if (plaintext) {
        await query(`
            INSERT INTO radcheck (username, attribute, op, value)
            VALUES (?, 'Cleartext-Password', ':=', ?)
            ON DUPLICATE KEY UPDATE value = ?
        `, [username, plaintext, plaintext]);
    }
}

// ============================================================
// AKTIFKAN KEMBALI USER
// ============================================================
async function aktifkanUser(username) {
    // Hapus reject attribute
    await _hapusReject(username);

    // Hapus Framed-Pool isolir agar pelanggan dapat IP normal lagi
    await query(`DELETE FROM radreply WHERE username = ? AND attribute = 'Framed-Pool'`, [username]);

    // Pulihkan password jika hilang
    await _pastikanPassword(username);

    // Terapkan ulang batas Shared Users (Simultaneous-Use) sesuai paket.
    try { await syncSimultaneousUse(username); }
    catch (e) { console.warn(`[RADIUS] sync share ${username}:`, e.message); }

    // Putus sesi isolir aktif → pelanggan reconnect → dapat IP normal
    try { await _putusSesilAktif(username); } catch (e) { console.warn('[RADIUS] putus sesi aktifkan:', e.message); }

    console.log(`[RADIUS] Aktifkan: ${username}`);
}

// Pastikan atribut RADIUS benar (hapus reject/isolir, pulihkan password,
// sync shared users) TANPA memutus sesi aktif. Dipakai saat pelanggan yang
// SUDAH aktif melakukan pembayaran (perpanjang) — sesinya tidak perlu diputus.
async function pulihkanTanpaReconnect(username) {
    try { await _hapusReject(username); } catch (e) {}
    try { await query(`DELETE FROM radreply WHERE username = ? AND attribute = 'Framed-Pool'`, [username]); } catch (e) {}
    try { await _pastikanPassword(username); } catch (e) {}
    try { await syncSimultaneousUse(username); }
    catch (e) { console.warn(`[RADIUS] sync share ${username}:`, e.message); }
    // CATATAN: sengaja TIDAK memanggil _putusSesilAktif → sesi tidak diputus.
    console.log(`[RADIUS] Pulihkan tanpa reconnect: ${username}`);
}

// (versi lama aktifkanUser di bawah dipertahankan sbg referensi, tidak dipakai)
async function _aktifkanUserLama(username) {
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
        SELECT ra.acctsessionid AS id_sesi,
            ra.username,
            ra.framedipaddress AS ip,
            ra.nasipaddress AS nas_ip,
            ra.callingstationid AS mac,
            ra.acctstarttime AS mulai,
            ra.acctupdatetime AS update_terakhir,
            TIMESTAMPDIFF(MINUTE, ra.acctstarttime, NOW()) AS durasi_menit,
            ROUND(ra.acctinputoctets/1048576, 2)  AS total_mb_in,
            ROUND(ra.acctoutputoctets/1048576, 2) AS total_mb_out,
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
        { attribute: 'Mikrotik-Rate-Limit', op: ':=', value: rateLimit },
    ];

    // Khusus HOTSPOT: kurangi keluhan "minta login terus" saat reconnect.
    // - Idle-Timeout 0   = jangan logout walau HP diam lama (idle).
    // Catatan: agar reconnect WiFi tidak minta login ulang, fitur utamanya adalah
    // mac-cookie di profil Hotspot MikroTik (bukan RADIUS).
    // CATATAN PENTING: 'Mikrotik-Keepalive-Timeout' SENGAJA TIDAK dipakai —
    // atribut itu tidak dikenal dictionary FreeRADIUS (3.2.x) sehingga membuat
    // SELURUH auth group gagal (Error retrieving reply pairs) → semua user di
    // paket hotspot tak bisa login. Keepalive diatur di profil MikroTik saja.
    if (tipe_koneksi === 'hotspot') {
        attrs.push({ attribute: 'Idle-Timeout', op: ':=', value: '0' });
        // Bersihkan atribut Keepalive lama yang mungkin sudah terlanjur tersimpan
        await query(`DELETE FROM radgroupreply WHERE groupname=? AND attribute='Mikrotik-Keepalive-Timeout'`, [groupname]);
    } else {
        // Bersihkan atribut hotspot bila group ini bukan hotspot.
        await query(`DELETE FROM radgroupreply WHERE groupname=? AND attribute IN ('Idle-Timeout','Mikrotik-Keepalive-Timeout')`, [groupname]);
    }
    // Framed-Pool HANYA dikirim bila pool_name paket benar-benar diisi.
    // Mengarang 'pool-XXmbps' membuat MikroTik mencari pool yang tak ada →
    // PPPoE auth sukses tapi gagal dapat IP → langsung putus.
    const poolName = (paket.pool_name || '').trim();
    if (poolName) {
        attrs.push({ attribute: 'Framed-Pool', op: ':=', value: poolName });
    } else {
        // Bersihkan Framed-Pool basi bila pool_name dikosongkan.
        await query(`DELETE FROM radgroupreply WHERE groupname=? AND attribute='Framed-Pool'`, [groupname]);
    }

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

// Putus sesi aktif via RADIUS CoA / Disconnect-Message (RFC 5176) memakai
// `radclient` (bawaan FreeRADIUS). Mengirim PoD ke NAS:3799 dengan secret NAS.
// Tidak perlu library/user API — cukup secret RADIUS yang sudah ada.
async function _putusSesilAktif(username) {
    const { execFile } = require('child_process');

    // Jalankan radclient TANPA shell (execFile + argumen array) dan kirim atribut
    // lewat stdin. Ini menutup command-injection: nilai username/secret/nasIp tidak
    // pernah masuk ke shell, jadi `$()`, backtick, `;`, `|`, dst. tidak dieksekusi.
    const radclientDisconnect = (nasIp, secret, payload) => new Promise((resolve, reject) => {
        const child = execFile(
            'radclient',
            ['-t', '5', '-r', '1', `${nasIp}:3799`, 'disconnect', secret],
            { timeout: 8000 },
            (err, stdout, stderr) => {
                const out = (stdout || '') + (stderr || '');
                // radclient keluar dengan kode non-zero saat menerima Disconnect-NAK.
                // Itu BUKAN kegagalan fatal — paling sering berarti sesi sudah tidak
                // ada di NAS (sudah putus duluan), jadi tujuan "putus" tetap tercapai.
                // Kembalikan output agar pemanggil bisa membedakan ACK/NAK, alih-alih
                // melemparnya sebagai error yang bikin log menakutkan.
                if (out && /Disconnect-(ACK|NAK)/i.test(out)) return resolve(out);
                if (err) return reject(new Error(err.stderr || err.message));
                resolve(out);
            }
        );
        // radclient membaca atribut request dari stdin (satu request per blok).
        child.stdin.end(payload + '\n');
    });

    const tandaiStop = async () => {
        await query(
            `UPDATE radacct SET acctstoptime=NOW(), acctterminatecause='Admin-Reset'
             WHERE username=? AND acctstoptime IS NULL`,
            [username]
        );
    };

    try {
        // Ambil sesi aktif user: butuh NAS IP (untuk target & secret) + Framed-IP
        // (atribut yang diterima MikroTik untuk disconnect). Acct-Session-Id MikroTik
        // ditolak sebagai Acct-Session-Id radclient (Error-Cause Unsupported-Extension),
        // jadi tidak dipakai.
        const sesi = await query(
            `SELECT nasipaddress, framedipaddress, acctsessionid FROM radacct
             WHERE username=? AND acctstoptime IS NULL`, [username]);

        if (!sesi.length) {
            // Tidak ada sesi aktif tercatat — tidak ada yang perlu diputus
            console.log(`[CoA] ${username}: tidak ada sesi aktif di radacct (skip disconnect)`);
            return;
        }
        console.log(`[CoA] ${username}: ${sesi.length} sesi aktif ditemukan, mengirim disconnect...`);

        // Ambil secret per NAS
        const ips = [...new Set(sesi.map(s => s.nasipaddress).filter(Boolean))];
        const nasRows = ips.length ? await query(
            `SELECT nasname, secret FROM nas WHERE nasname IN (${ips.map(()=>'?').join(',')})`, ips) : [];
        const secretMap = {};
        nasRows.forEach(n => { secretMap[n.nasname] = n.secret; });

        for (const s of sesi) {
            const nasIp = s.nasipaddress;
            const secret = secretMap[nasIp];
            if (!nasIp || !secret) {
                console.warn(`[CoA] Lewati ${username}: secret/NAS tidak ditemukan untuk ${nasIp}`);
                continue;
            }
            // Tolak nilai yang bisa memecah parsing atribut radclient (newline =
            // request tambahan, koma = atribut tambahan). Username/sessionid sah
            // tidak memuat karakter ini; bila ada, lewati disconnect (tetap di-stop).
            const aman = v => typeof v === 'string' && !/[\r\n,]/.test(v);
            if (!aman(username) || !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(nasIp))) {
                console.warn(`[CoA] Lewati ${username}@${nasIp}: nilai atribut tidak valid`);
                continue;
            }

            // Bangun atribut disconnect.
            // MikroTik menerima disconnect via User-Name + Framed-IP-Address.
            // (Acct-Session-Id MikroTik & NAS-IP-Address DITOLAK → Error-Cause
            // Unsupported-Extension / NAK, jadi sengaja tidak dikirim.)
            const attrs = [`User-Name=${username}`];
            const fip = s.framedipaddress;
            if (fip && /^\d{1,3}(\.\d{1,3}){3}$/.test(String(fip)))
                attrs.push(`Framed-IP-Address=${fip}`);
            const payload = attrs.join(',');

            // radclient: kirim disconnect ke port 3799 NAS (TANPA shell — lihat
            // radclientDisconnect di atas). timeout 8 detik, retry 1.
            try {
                const stdout = await radclientDisconnect(nasIp, secret, payload);
                if (/Disconnect-ACK/i.test(stdout)) {
                    console.log(`[CoA] Sesi ${username} diputus di ${nasIp} (ACK)`);
                } else if (/Disconnect-NAK/i.test(stdout)) {
                    console.warn(`[CoA] ${username} di ${nasIp}: Disconnect-NAK (atribut tidak cocok)`);
                } else {
                    console.log(`[CoA] ${username} di ${nasIp}: terkirim`);
                }
            } catch (e) {
                console.warn(`[CoA] Gagal kirim disconnect ${username} ke ${nasIp}: ${e.message}`);
            }
        }
    } catch (e) {
        console.warn(`[CoA] _putusSesilAktif error: ${e.message}`);
    } finally {
        await tandaiStop();
    }
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
            // Sync satu user voucher spesifik (kecuali yang sudah expired)
            const v = await queryOne(`SELECT username, password, status FROM voucher WHERE username = ?`, [username]);
            if (!v || !v.username) return;
            if (v.status === 'expired') {
                // Voucher expired → pastikan TIDAK ada di radcheck/radreply
                await query(`DELETE FROM radcheck WHERE username = ?`, [v.username]);
                await query(`DELETE FROM radreply WHERE username = ?`, [v.username]);
                return;
            }
            await query(`
                INSERT INTO radcheck (username, attribute, op, value)
                VALUES (?, 'Cleartext-Password', ':=', ?)
                ON DUPLICATE KEY UPDATE value = VALUES(value)
            `, [v.username, v.password]);
            // Terapkan batas Shared Users (Simultaneous-Use) sesuai paket voucher.
            try { await syncSimultaneousUse(v.username); }
            catch (e) { console.warn(`[radcheck] sync share voucher ${v.username}:`, e.message); }
            // Terapkan Session-Timeout (voucher berbasis JAM) → MikroTik "Session Time Left".
            try { await syncSessionTimeout(v.username); }
            catch (e) { console.warn(`[radreply] sync session-timeout ${v.username}:`, e.message); }
            // Terapkan Mikrotik-Rate-Limit (bandwidth diatur dari billing/paket).
            try { await syncVoucherRate(v.username); }
            catch (e) { console.warn(`[radreply] sync rate voucher ${v.username}:`, e.message); }
            console.log(`[radcheck] Synced voucher: ${username}`);
        } else {
            // Sync semua voucher sekaligus (KECUALI yang expired)
            const result = await query(`
                INSERT INTO radcheck (username, attribute, op, value)
                SELECT username, 'Cleartext-Password', ':=', password
                FROM voucher
                WHERE username IS NOT NULL AND username != ''
                AND status != 'expired'
                ON DUPLICATE KEY UPDATE value = VALUES(value)
            `);
            console.log(`[radcheck] Synced ${result.affectedRows} voucher(s) to radcheck`);
            // Bersihkan voucher expired dari radcheck (kalau masih ada)
            await query(`
                DELETE rc FROM radcheck rc
                JOIN voucher v ON v.username = rc.username
                WHERE v.status = 'expired'
            `);
            // ── Session-Timeout massal (SEMUA voucher bermasa-aktif) ──
            // Bersihkan dulu Session-Timeout milik semua voucher, lalu set ulang
            // untuk semua voucher (jam/hari/bulan) yang belum expired, agar
            // MikroTik menampilkan "Session Time Left".
            await query(`
                DELETE rr FROM radreply rr
                JOIN voucher v ON v.username = rr.username
                WHERE rr.attribute = 'Session-Timeout'
            `);
            await query(`
                INSERT INTO radreply (username, attribute, op, value)
                SELECT v.username, 'Session-Timeout', ':=',
                       CAST(
                         CASE WHEN v.tgl_digunakan IS NULL THEN
                                CASE LOWER(pk.satuan_masa)
                                  WHEN 'jam'   THEN pk.masa_aktif * 3600
                                  WHEN 'bulan' THEN pk.masa_aktif * 30 * 86400
                                  ELSE              pk.masa_aktif * 86400
                                END
                              ELSE
                                GREATEST(60, TIMESTAMPDIFF(SECOND, NOW(),
                                  CASE LOWER(pk.satuan_masa)
                                    WHEN 'jam'   THEN v.tgl_digunakan + INTERVAL pk.masa_aktif HOUR
                                    WHEN 'bulan' THEN v.tgl_digunakan + INTERVAL pk.masa_aktif MONTH
                                    ELSE              v.tgl_digunakan + INTERVAL pk.masa_aktif DAY
                                  END))
                         END AS CHAR)
                FROM voucher v JOIN paket pk ON pk.id = v.paket_id
                WHERE v.username IS NOT NULL AND v.username != ''
                  AND v.status != 'expired'
                  AND COALESCE(pk.masa_aktif,0) > 0
            `);
            // ── Mikrotik-Rate-Limit massal (bandwidth diatur billing) ──
            await query(`
                DELETE rr FROM radreply rr
                JOIN voucher v ON v.username = rr.username
                WHERE rr.attribute = 'Mikrotik-Rate-Limit'
            `);
            await query(`
                INSERT INTO radreply (username, attribute, op, value)
                SELECT v.username, 'Mikrotik-Rate-Limit', ':=',
                       COALESCE(NULLIF(TRIM(pk.rate_limit), ''),
                                CONCAT(pk.kecepatan_up, 'M/', pk.kecepatan_dn, 'M'))
                FROM voucher v JOIN paket pk ON pk.id = v.paket_id
                WHERE v.username IS NOT NULL AND v.username != ''
                  AND v.status != 'expired'
                  AND ( NULLIF(TRIM(pk.rate_limit), '') IS NOT NULL
                        OR (pk.kecepatan_up IS NOT NULL AND pk.kecepatan_dn IS NOT NULL) )
            `);
        }
    } catch(e) {
        console.warn('[radcheck] Sync gagal:', e.message);
    }
}

// Set Session-Timeout (detik) di radreply untuk SEMUA voucher bermasa-aktif,
// agar MikroTik menampilkan "Session Time Left" yang AKURAT.
//   - Voucher BELUM dipakai (tgl_digunakan NULL) -> masa penuh:
//       jam = masa*3600, hari = masa*86400, bulan = masa*30*86400.
//   - Voucher SUDAH dipakai -> SISA detik = (tgl_digunakan + masa) - sekarang
//       (di-floor 60 detik). Di-refresh berkala oleh refreshSisaSessionTimeout()
//       supaya tetap akurat walau pelanggan reconnect berkali-kali.
//   - VIP / masa 0 -> tanpa Session-Timeout (tanpa batas).
async function syncSessionTimeout(username) {
    if (!username) return;
    // Selalu bersihkan dulu (mencegah nilai basi bila paket diubah).
    await query(`DELETE FROM radreply WHERE username = ? AND attribute = 'Session-Timeout'`, [username]);
    await query(`
        INSERT INTO radreply (username, attribute, op, value)
        SELECT v.username, 'Session-Timeout', ':=',
               CAST(
                 CASE WHEN v.tgl_digunakan IS NULL THEN
                        CASE LOWER(pk.satuan_masa)
                          WHEN 'jam'   THEN pk.masa_aktif * 3600
                          WHEN 'bulan' THEN pk.masa_aktif * 30 * 86400
                          ELSE              pk.masa_aktif * 86400
                        END
                      ELSE
                        GREATEST(60, TIMESTAMPDIFF(SECOND, NOW(),
                          CASE LOWER(pk.satuan_masa)
                            WHEN 'jam'   THEN v.tgl_digunakan + INTERVAL pk.masa_aktif HOUR
                            WHEN 'bulan' THEN v.tgl_digunakan + INTERVAL pk.masa_aktif MONTH
                            ELSE              v.tgl_digunakan + INTERVAL pk.masa_aktif DAY
                          END))
                 END AS CHAR)
        FROM voucher v JOIN paket pk ON pk.id = v.paket_id
        WHERE v.username = ?
          AND COALESCE(pk.masa_aktif,0) > 0
    `, [username]);
}

// Refresh Session-Timeout = SISA detik real-time untuk voucher yang SUDAH
// dipakai, agar "Session Time Left" tetap akurat lintas reconnect. Dipanggil
// berkala (via syncStatusVoucher / cron). Voucher unused tidak disentuh (tetap
// masa penuh sampai login pertama).
async function refreshSisaSessionTimeout() {
    try {
        const r = await query(`
            UPDATE radreply rr
            JOIN voucher v ON v.username = rr.username
            JOIN paket pk  ON pk.id = v.paket_id
            SET rr.value = CAST(GREATEST(60, TIMESTAMPDIFF(SECOND, NOW(),
                    CASE LOWER(pk.satuan_masa)
                      WHEN 'jam'   THEN v.tgl_digunakan + INTERVAL pk.masa_aktif HOUR
                      WHEN 'bulan' THEN v.tgl_digunakan + INTERVAL pk.masa_aktif MONTH
                      ELSE              v.tgl_digunakan + INTERVAL pk.masa_aktif DAY
                    END)) AS CHAR)
            WHERE rr.attribute = 'Session-Timeout'
              AND v.status = 'used'
              AND v.tgl_digunakan IS NOT NULL
              AND COALESCE(pk.masa_aktif,0) > 0
        `);
        return r.affectedRows || 0;
    } catch (e) {
        console.warn('[voucher] refreshSisaSessionTimeout gagal:', e.message);
        return 0;
    }
}

// Set Mikrotik-Rate-Limit di radreply untuk voucher sesuai paketnya, sehingga
// BANDWIDTH voucher diatur dari billing (RADIUS), bukan dari profil hotspot.
// Format mengikuti _syncGroupPaket: pakai paket.rate_limit bila ada, jika tidak
// pakai "<up>M/<dn>M".
async function syncVoucherRate(username) {
    if (!username) return;
    await query(`DELETE FROM radreply WHERE username = ? AND attribute = 'Mikrotik-Rate-Limit'`, [username]);
    const v = await queryOne(`
        SELECT pk.rate_limit, pk.kecepatan_up, pk.kecepatan_dn
        FROM voucher v JOIN paket pk ON pk.id = v.paket_id
        WHERE v.username = ?`, [username]);
    if (!v) return;
    let rate = (v.rate_limit && String(v.rate_limit).trim()) ? String(v.rate_limit).trim() : '';
    if (!rate) {
        if (v.kecepatan_up == null || v.kecepatan_dn == null) return; // data kurang → jangan paksa
        rate = `${v.kecepatan_up}M/${v.kecepatan_dn}M`;
    }
    await query(`
        INSERT INTO radreply (username, attribute, op, value)
        VALUES (?, 'Mikrotik-Rate-Limit', ':=', ?)
    `, [username, rate]);
}

// Tandai voucher 'used' berdasarkan radacct (catatan login FreeRADIUS).
// Voucher yang username-nya pernah muncul di radacct = sudah dipakai login,
// jadi status diubah unused → used + isi tgl_digunakan dari login pertama.
// Dipanggil saat buka daftar voucher & via cron.
async function syncStatusVoucher() {
    try {
        const r = await query(`
            UPDATE voucher v
            JOIN (
                SELECT username, MIN(acctstarttime) AS pertama
                FROM radacct
                WHERE username IS NOT NULL AND username != ''
                GROUP BY username
            ) a ON a.username = v.username
            SET v.status = 'used',
                v.tgl_digunakan = COALESCE(v.tgl_digunakan, a.pertama),
                v.digunakan_oleh = COALESCE(v.digunakan_oleh, v.username)
            WHERE v.status = 'unused'
        `);
        // Backfill: voucher yang SUDAH 'used' tapi tgl_digunakan NULL
        // (mis. di-set used dari tempat lain tanpa isi tgl) — penting agar
        // perhitungan expiry (login pertama + masa_aktif) bisa jalan.
        await query(`
            UPDATE voucher v
            JOIN (
                SELECT username, MIN(acctstarttime) AS pertama
                FROM radacct
                WHERE username IS NOT NULL AND username != ''
                GROUP BY username
            ) a ON a.username = v.username
            SET v.tgl_digunakan = a.pertama
            WHERE v.status = 'used' AND v.tgl_digunakan IS NULL
        `);
        // Refresh "Session Time Left" (sisa detik real-time) untuk voucher used,
        // supaya tampilan tetap akurat lintas reconnect.
        await refreshSisaSessionTimeout();
        if (r.affectedRows > 0) console.log(`[voucher] ${r.affectedRows} voucher ditandai used dari radacct`);
        return r.affectedRows;
    } catch (e) {
        console.warn('[voucher] syncStatusVoucher gagal:', e.message);
        return 0;
    }
}

// ============================================================
// EXPIRE VOUCHER yang masa berlakunya habis (dihitung dari LOGIN PERTAMA).
// voucher.tgl_digunakan = login pertama; paket.masa_aktif + satuan_masa = durasi.
// Voucher yang (tgl_digunakan + durasi) < NOW() → expired:
//   - status voucher → 'expired'
//   - hapus dari radcheck (tidak bisa login lagi)
//   - putus sesi aktif (CoA)
// ============================================================
async function expireVoucherHabis() {
    try {
        // Cari voucher used yang sudah lewat masa aktif (dari login pertama).
        // Paket masa_aktif 0 = TANPA BATAS (VIP) → tidak pernah di-expire.
        const habis = await query(`
            SELECT v.username, v.tgl_digunakan, pk.masa_aktif, pk.satuan_masa
            FROM voucher v
            JOIN paket pk ON v.paket_id = pk.id
            WHERE v.status = 'used'
              AND v.tgl_digunakan IS NOT NULL
              AND COALESCE(pk.masa_aktif,0) > 0
              AND (
                    (pk.satuan_masa = 'jam'   AND v.tgl_digunakan + INTERVAL pk.masa_aktif HOUR  < NOW())
                 OR (pk.satuan_masa = 'bulan' AND v.tgl_digunakan + INTERVAL pk.masa_aktif MONTH < NOW())
                 OR (pk.satuan_masa NOT IN ('jam','bulan') AND v.tgl_digunakan + INTERVAL pk.masa_aktif DAY < NOW())
              )
        `);

        let n = 0;
        for (const v of habis) {
            try {
                // tandai expired + set masa simpan 90 hari (batas auto-hapus)
                await query(`UPDATE voucher SET status='expired', tgl_expired=DATE_ADD(NOW(), INTERVAL 90 DAY) WHERE username=?`, [v.username]);
                // hapus dari radcheck → tidak bisa login lagi
                await query(`DELETE FROM radcheck WHERE username=?`, [v.username]);
                // hapus Session-Timeout di radreply (tidak relevan lagi)
                await query(`DELETE FROM radreply WHERE username=? AND attribute='Session-Timeout'`, [v.username]);
                // putus sesi aktif (CoA)
                await _putusSesilAktif(v.username);
                n++;
            } catch (e) {
                console.warn(`[voucher] gagal expire ${v.username}: ${e.message}`);
            }
        }
        if (n > 0) console.log(`[voucher] ${n} voucher expired (masa aktif habis dari login pertama)`);
        return n;
    } catch (e) {
        console.warn('[voucher] expireVoucherHabis gagal:', e.message);
        return 0;
    }
}

// ============================================================
// HAPUS voucher expired yang sudah melewati masa simpan (90 hari).
// Saat di-expire, voucher diberi tgl_expired = NOW + 90 hari sebagai batas
// simpan. Setelah lewat, baris voucher + radcheck dihapus permanen agar
// tabel tidak menumpuk voucher mati.
// ============================================================
async function hapusVoucherExpiredLama() {
    try {
        const lama = await query(`
            SELECT username FROM voucher
            WHERE status = 'expired'
              AND tgl_expired IS NOT NULL
              AND tgl_expired < NOW()
        `);
        let n = 0;
        for (const v of lama) {
            try {
                await query(`DELETE FROM radcheck WHERE username=?`, [v.username]);
                await query(`DELETE FROM radreply WHERE username=?`, [v.username]);
                await query(`DELETE FROM voucher  WHERE username=?`, [v.username]);
                n++;
            } catch (e) {
                console.warn(`[voucher] gagal hapus expired lama ${v.username}: ${e.message}`);
            }
        }
        if (n > 0) console.log(`[voucher] ${n} voucher expired lama (>90 hari) dihapus`);
        return n;
    } catch (e) {
        console.warn('[voucher] hapusVoucherExpiredLama gagal:', e.message);
        return 0;
    }
}
// Ditulis per-user di radcheck (`Simultaneous-Use := N`) berdasarkan
// kolom paket.share_users. FreeRADIUS menolak login ke-(N+1) selama N sesi
// masih aktif (butuh pengecekan simultaneous-use SQL aktif di server —
// mekanisme yang sama dipakai fitur single-session). radcheck TIDAK punya
// unique key (username,attribute) → selalu DELETE dulu baru INSERT.
// ============================================================
function _clampShare(v) { return Math.max(1, parseInt(v, 10) || 1); }

// Sinkron satu username (cek voucher dulu, lalu pelanggan).
async function syncSimultaneousUse(username) {
    if (!username) return;
    let share = null;
    const v = await queryOne(
        `SELECT pk.share_users FROM voucher v JOIN paket pk ON pk.id = v.paket_id WHERE v.username = ?`,
        [username]);
    if (v && v.share_users != null) share = v.share_users;
    else {
        const p = await queryOne(
            `SELECT pk.share_users FROM pelanggan pl JOIN paket pk ON pk.id = pl.paket_id WHERE pl.username = ?`,
            [username]);
        if (p && p.share_users != null) share = p.share_users;
    }
    await query(`DELETE FROM radcheck WHERE username=? AND attribute='Simultaneous-Use'`, [username]);
    if (share == null) return; // paket user tak diketahui → jangan paksa batas
    await query(
        `INSERT INTO radcheck (username, attribute, op, value) VALUES (?, 'Simultaneous-Use', ':=', ?)
         ON DUPLICATE KEY UPDATE value=VALUES(value)`,
        [username, String(_clampShare(share))]);
}

// Sinkron seluruh user pada satu paket (dipakai saat share_users paket diubah).
async function syncSimultaneousUsePaket(paketId) {
    const pk = await queryOne(`SELECT share_users FROM paket WHERE id=?`, [paketId]);
    if (!pk) return;
    const n = String(_clampShare(pk.share_users));
    // Bersihkan atribut lama untuk user paket ini (voucher + pelanggan)
    await query(`DELETE rc FROM radcheck rc JOIN voucher v   ON v.username=rc.username
                 WHERE rc.attribute='Simultaneous-Use' AND v.paket_id=?`, [paketId]);
    await query(`DELETE rc FROM radcheck rc JOIN pelanggan pl ON pl.username=rc.username
                 WHERE rc.attribute='Simultaneous-Use' AND pl.paket_id=?`, [paketId]);
    // Tulis ulang sesuai share_users terbaru
    await query(`INSERT INTO radcheck (username, attribute, op, value)
                 SELECT username, 'Simultaneous-Use', ':=', ?
                 FROM voucher WHERE paket_id=? AND status<>'expired'
                   AND username IS NOT NULL AND username<>''
                 ON DUPLICATE KEY UPDATE value=VALUES(value)`, [n, paketId]);
    await query(`INSERT INTO radcheck (username, attribute, op, value)
                 SELECT username, 'Simultaneous-Use', ':=', ?
                 FROM pelanggan WHERE paket_id=? AND status='aktif'
                   AND username IS NOT NULL AND username<>''
                 ON DUPLICATE KEY UPDATE value=VALUES(value)`, [n, paketId]);
}

// Sinkron SEMUA user (voucher non-expired + pelanggan aktif) sesuai paketnya.
// Dipakai untuk resync massal & saat single-session dimatikan (kembalikan ke
// batas per-paket, bukan tanpa batas).
async function syncSimultaneousUseSemua() {
    await query(`DELETE FROM radcheck WHERE attribute='Simultaneous-Use'`);
    await query(`INSERT INTO radcheck (username, attribute, op, value)
                 SELECT v.username, 'Simultaneous-Use', ':=', GREATEST(1, pk.share_users)
                 FROM voucher v JOIN paket pk ON pk.id=v.paket_id
                 WHERE v.status<>'expired' AND v.username IS NOT NULL AND v.username<>''
                 ON DUPLICATE KEY UPDATE value=VALUES(value)`);
    await query(`INSERT INTO radcheck (username, attribute, op, value)
                 SELECT pl.username, 'Simultaneous-Use', ':=', GREATEST(1, pk.share_users)
                 FROM pelanggan pl JOIN paket pk ON pk.id=pl.paket_id
                 WHERE pl.status='aktif' AND pl.username IS NOT NULL AND pl.username<>''
                 ON DUPLICATE KEY UPDATE value=VALUES(value)`);
}

module.exports = {
    tambahUser,
    updatePaket,
    suspendUser,
    aktifkanUser,
    pulihkanTanpaReconnect,
    hapusUser,
    getSesi,
    semuaSesiAktif,
    putusKoneksi,
    _syncGroupPaketPublic,
    encryptPassword,
    decryptPassword,
    syncVoucher,
    syncStatusVoucher,
    syncSimultaneousUse,
    syncSimultaneousUsePaket,
    syncSimultaneousUseSemua,
    syncSessionTimeout,
    refreshSisaSessionTimeout,
    syncVoucherRate,
    expireVoucherHabis,
    hapusVoucherExpiredLama
};
