// config/db.js — Koneksi MySQL/MariaDB dengan connection pool
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host:            process.env.DB_HOST || '127.0.0.1',
    port:            parseInt(process.env.DB_PORT) || 3306,
    database:        process.env.DB_NAME || 'billing_radius',
    user:            process.env.DB_USER || 'root',
    password:        process.env.DB_PASS || '',
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit:      0,
    timezone:        '+07:00',      // WIB
    charset:         'utf8mb4'
});

// Test koneksi saat startup
pool.getConnection()
    .then(conn => {
        console.log('✅ Database terkoneksi:', process.env.DB_NAME);
        conn.release();
    })
    .catch(err => {
        console.error('❌ Gagal koneksi database:', err.message);
        process.exit(1);
    });

// Safety net: mysql2 melempar error keras "Bind parameters must not contain
// undefined" jika ada SATU SAJA parameter bernilai undefined (biasanya akibat
// field opsional dari req.body yang tidak dikirim client). Daripada
// mengandalkan setiap route menambahkan `|| null` secara manual di setiap
// parameter (mudah terlewat), kita konversi otomatis di titik tunggal ini.
// SQL NULL dan JS undefined punya makna sama dalam konteks ini ("tidak ada
// nilai"), jadi konversi ini aman dan tidak mengubah perilaku yang diinginkan.
//
// Juga mencatat ke console jika ada konversi terjadi, supaya developer bisa
// melacak query/field mana yang sebenarnya mengirim undefined — ini membantu
// memperbaiki akar masalah di kode pemanggil, bukan hanya menutupinya.
function sanitizeParams(sql, params) {
    if (!Array.isArray(params)) {
        console.warn('[DB] Parameter bukan array, dikonversi ke array kosong. SQL:', sql.trim().slice(0, 80));
        return [];
    }
    let adaUndefined = false;
    const hasil = params.map(p => {
        if (p === undefined) { adaUndefined = true; return null; }
        return p;
    });
    if (adaUndefined) {
        console.warn('[DB] ⚠️ Parameter undefined terdeteksi & dikonversi ke NULL.');
        console.warn('     SQL   :', sql.trim().replace(/\s+/g, ' ').slice(0, 150));
        console.warn('     Params:', JSON.stringify(hasil));
    }
    return hasil;
}

// Helper: query dengan parameter
async function query(sql, params = []) {
    const [rows] = await pool.execute(sql, sanitizeParams(sql, params));
    return rows;
}

// Helper: query satu baris
async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows[0] || null;
}

// Generate nomor invoice unik dengan aman terhadap race condition.
// Daripada SELECT MAX lalu +1 (rawan duplikat saat dua request bersamaan),
// fungsi ini mencoba INSERT dengan nomor urut berikutnya di dalam transaksi
// pemanggil; jika terjadi duplicate key (request lain menang), retry dengan
// nomor selanjutnya. `insertFn(no_invoice)` harus melakukan INSERT memakai
// no_invoice yang diberikan dan mengembalikan hasil INSERT.
async function generateUniqueInvoiceNo(db, prefix, tahun, insertFn, maxRetry = 5) {
    for (let attempt = 0; attempt < maxRetry; attempt++) {
        const last = await db.queryOne(
            `SELECT no_invoice FROM invoice WHERE no_invoice LIKE ? ORDER BY id DESC LIMIT 1`,
            [`${prefix}-${tahun}-%`]
        );
        const urutanTerakhir = last ? parseInt(last.no_invoice.split('-')[2] || '0', 10) : 0;
        const noInvoice = `${prefix}-${tahun}-${String(urutanTerakhir + 1 + attempt).padStart(4, '0')}`;

        try {
            const result = await insertFn(noInvoice);
            return { no_invoice: noInvoice, result };
        } catch (err) {
            // ER_DUP_ENTRY — request lain sudah memakai nomor ini, coba lagi
            if (err.code === 'ER_DUP_ENTRY' && attempt < maxRetry - 1) continue;
            throw err;
        }
    }
    throw new Error('Gagal generate nomor invoice unik setelah beberapa percobaan');
}

// Helper: jalankan beberapa query dalam satu transaksi atomik.
// `work` menerima objek { query, queryOne } yang terikat pada SATU koneksi,
// sehingga FOR UPDATE dan COMMIT/ROLLBACK bekerja dengan benar.
async function withTransaction(work) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const txQuery = async (sql, params = []) => {
            const [rows] = await conn.execute(sql, sanitizeParams(sql, params));
            return rows;
        };
        const txQueryOne = async (sql, params = []) => {
            const rows = await txQuery(sql, params);
            return rows[0] || null;
        };

        const result = await work({ query: txQuery, queryOne: txQueryOne });

        await conn.commit();
        return result;
    } catch (err) {
        try { await conn.rollback(); } catch (_) { /* ignore rollback error */ }
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = { pool, query, queryOne, withTransaction, generateUniqueInvoiceNo, hitungExpired, hitungExpiredDari };

/**
 * Hitung tanggal expired dari sekarang berdasarkan masa_aktif + satuan_masa.
 * satuan: 'jam' | 'hari' | 'bulan'
 * Mengembalikan objek dayjs.
 */
function hitungExpired(masa_aktif, satuan_masa = 'hari') {
    const dayjs = require('dayjs');
    const n = Number(masa_aktif) || 30;
    switch (satuan_masa) {
        case 'jam':   return dayjs().add(n, 'hour');
        case 'bulan': return dayjs().add(n, 'month');
        default:      return dayjs().add(n, 'day');
    }
}

/**
 * Hitung tanggal expired untuk PERPANJANGAN, dengan menjaga "hari jatuh tempo".
 * - Jika masa lama (tglLama) masih berlaku (di masa depan), perpanjang DARI tanggal
 *   itu → hari jatuh tempo tetap (mis. selalu tgl 1).
 * - Jika sudah lewat / kosong, mulai dari sekarang.
 * satuan: 'jam' | 'hari' | 'bulan'. Mengembalikan objek dayjs.
 */
function hitungExpiredDari(tglLama, masa_aktif, satuan_masa = 'hari') {
    const dayjs = require('dayjs');
    const n = Number(masa_aktif) || 30;
    const unit = satuan_masa === 'jam' ? 'hour' : (satuan_masa === 'bulan' ? 'month' : 'day');
    let base = dayjs();
    if (tglLama) {
        const exp = dayjs(tglLama);
        if (exp.isValid() && exp.isAfter(dayjs())) base = exp;
    }
    return base.add(n, unit);
}
