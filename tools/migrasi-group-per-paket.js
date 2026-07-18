#!/usr/bin/env node
/**
 * migrasi-group-per-paket.js
 * ------------------------------------------------------------------
 * Perbaiki bug "semua pelanggan dapat IP pool sama": groupname RADIUS dulu
 * berbasis kecepatan (`pppoe-${dn}mbps`). Karena banyak paket punya
 * kecepatan_dn sama (mis. semua =1), SEMUA pelanggan menumpuk di 1 group
 * (`pppoe-1mbps`) -> Framed-Pool paket terakhir yg diedit menimpa semua.
 *
 * Fix kode (radius.js _namaGroup + paket.js) mengubah basis group ke ID
 * paket (`pppoe-paket-${id}`). Script INI memigrasi DATA lama:
 *   1. Untuk tiap paket -> _syncGroupPaket() membuat group `tipe-paket-id`
 *      dgn Mikrotik-Rate-Limit + Framed-Pool (pool_name paket) yg BENAR.
 *   2. Tiap pelanggan dipindah dari group lama ke group paket-nya
 *      (berdasarkan pelanggan.paket_id).
 *   3. Laporan: berapa pindah, group tujuan, pool per group.
 *
 * PENGAMAN:
 *   - DRY-RUN default. --commit untuk eksekusi.
 *   - TIDAK menghapus group lama (biar bisa rollback). Setelah yakin, group
 *     lama `pppoe-1mbps` bisa dibersihkan manual.
 *   - Membaca tipe koneksi per pelanggan (bukan asumsi semua pppoe).
 *
 * Jalankan DI SERVER:
 *   cd /opt/simbill/backend
 *   node migrasi-group-per-paket.js            # dry-run
 *   node migrasi-group-per-paket.js --commit   # eksekusi
 * ------------------------------------------------------------------
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const COMMIT = process.argv.includes('--commit');

function namaGroup(paket, tipe) {
    if (paket && paket.id !== undefined && paket.id !== null) return `${tipe}-paket-${paket.id}`;
    return `${tipe}-${paket.kecepatan_dn}mbps`;
}

(async () => {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'billing_radius',
    });

    console.log(`\n=== MIGRASI GROUP RADIUS -> BASIS ID PAKET ===`);
    console.log(`MODE: ${COMMIT ? '🔴 COMMIT' : '🟢 DRY-RUN (tak menulis)'}\n`);

    const paket = await db.execute('SELECT * FROM paket').then(r => r[0]);
    const paketById = {}; paket.forEach(p => paketById[p.id] = p);

    // 1) Buat/isi group per paket (rate-limit + pool). Idempotent.
    let groupDibuat = 0;
    for (const p of paket) {
        const tipe = (p.tipe === 'hotspot') ? 'hotspot' : 'pppoe';
        const gname = namaGroup(p, tipe);
        const rate = p.rate_limit || `${p.kecepatan_up}M/${p.kecepatan_dn}M`;
        const pool = (p.pool_name || '').trim();

        if (COMMIT) {
            // Mikrotik-Rate-Limit
            const adaRate = await db.execute(
                `SELECT id FROM radgroupreply WHERE groupname=? AND attribute='Mikrotik-Rate-Limit'`, [gname]).then(r=>r[0]);
            if (adaRate.length)
                await db.execute(`UPDATE radgroupreply SET value=? WHERE groupname=? AND attribute='Mikrotik-Rate-Limit'`, [rate, gname]);
            else
                await db.execute(`INSERT INTO radgroupreply (groupname,attribute,op,value) VALUES (?,'Mikrotik-Rate-Limit',':=',?)`, [gname, rate]);
            // Framed-Pool
            if (pool) {
                const adaPool = await db.execute(
                    `SELECT id FROM radgroupreply WHERE groupname=? AND attribute='Framed-Pool'`, [gname]).then(r=>r[0]);
                if (adaPool.length)
                    await db.execute(`UPDATE radgroupreply SET value=? WHERE groupname=? AND attribute='Framed-Pool'`, [pool, gname]);
                else
                    await db.execute(`INSERT INTO radgroupreply (groupname,attribute,op,value) VALUES (?,'Framed-Pool',':=',?)`, [gname, pool]);
            }
            // Hotspot: Idle-Timeout 0
            if (tipe === 'hotspot') {
                const adaIdle = await db.execute(
                    `SELECT id FROM radgroupreply WHERE groupname=? AND attribute='Idle-Timeout'`, [gname]).then(r=>r[0]);
                if (!adaIdle.length)
                    await db.execute(`INSERT INTO radgroupreply (groupname,attribute,op,value) VALUES (?,'Idle-Timeout',':=','0')`, [gname]);
            }
        }
        console.log(`  group ${gname.padEnd(20)} rate=${rate.padEnd(12)} pool=${pool || '(none)'}`);
        groupDibuat++;
    }

    // 2) Pindahkan pelanggan ke group paket-nya
    const pelanggan = await db.execute(
        `SELECT p.username, p.paket_id, p.tipe_koneksi
         FROM pelanggan p WHERE p.username IS NOT NULL AND p.username<>''`).then(r => r[0]);

    const perGroup = {}; let pindah = 0, tanpaP = 0;
    for (const pel of pelanggan) {
        const pk = paketById[pel.paket_id];
        if (!pk) { tanpaP++; continue; }
        const tipe = pel.tipe_koneksi === 'hotspot' ? 'hotspot'
                   : (pk.tipe === 'hotspot' ? 'hotspot' : 'pppoe');
        const gname = namaGroup(pk, tipe);
        perGroup[gname] = (perGroup[gname] || 0) + 1;

        if (COMMIT) {
            await db.execute(`DELETE FROM radusergroup WHERE username=?`, [pel.username]);
            await db.execute(`INSERT INTO radusergroup (username,groupname,priority) VALUES (?,?,1)`, [pel.username, gname]);
        }
        pindah++;
    }

    console.log(`\n=== RINGKASAN ===`);
    console.log(`Paket diproses          : ${groupDibuat}`);
    console.log(`Pelanggan ${COMMIT?'DIPINDAH':'akan dipindah'} : ${pindah}`);
    console.log(`Pelanggan tanpa paket   : ${tanpaP}`);
    console.log(`\nDistribusi ke group tujuan:`);
    for (const [g, n] of Object.entries(perGroup).sort()) {
        const pk = paket.find(p => namaGroup(p, p.tipe==='hotspot'?'hotspot':'pppoe') === g);
        console.log(`  ${g.padEnd(20)} : ${String(n).padStart(4)} pelanggan  -> pool ${pk?.pool_name || '(none)'}`);
    }

    if (!COMMIT) console.log(`\n➡️  DRY-RUN. Eksekusi: node migrasi-group-per-paket.js --commit`);
    else console.log(`\n✅ Selesai. Verifikasi: SELECT groupname,COUNT(*) FROM radusergroup GROUP BY groupname;`);

    await db.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
