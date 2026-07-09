// routes/backup.js — Backup & Restore Database
const router   = require('express').Router();
const { pool, query } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const path = require('path');
const fs   = require('fs');

router.use(authMiddleware);

const DB_NAME = process.env.DB_NAME || 'billing_radius';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASS = process.env.DB_PASS || '';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = process.env.DB_PORT || '3306';

// GET /api/backup/tables — daftar semua tabel + jumlah baris
router.get('/tables', async (req, res, next) => {
    try {
        const tables = await query(`
            SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH,
                   CREATE_TIME, UPDATE_TIME
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME
        `, [DB_NAME]);

        // Hitung baris yang akurat untuk tabel penting
        const result = [];
        for (const t of tables) {
            let rowCount = t.TABLE_ROWS || 0;
            try {
                const [r] = await query(`SELECT COUNT(*) AS n FROM \`${t.TABLE_NAME}\``);
                rowCount = r.n;
            } catch(e) { /* skip */ }
            result.push({
                name:        t.TABLE_NAME,
                rows:        rowCount,
                size_kb:     Math.round(((t.DATA_LENGTH || 0) + (t.INDEX_LENGTH || 0)) / 1024),
                created:     t.CREATE_TIME,
                updated:     t.UPDATE_TIME
            });
        }
        res.json(result);
    } catch(e) { next(e); }
});

// POST /api/backup/export — export tabel terpilih sebagai SQL
router.post('/export', requireAdmin, async (req, res, next) => {
    try {
        const { tables: selectedTables } = req.body;

        // Daftar tabel sah dari DB (whitelist) — cegah injeksi via nama tabel
        const tabelSah = new Set((await query(`SHOW TABLES`)).map(r => Object.values(r)[0]));

        // Ambil semua tabel jika tidak ada pilihan; jika ada, saring ke yang sah saja
        let tabelList = selectedTables && selectedTables.length
            ? selectedTables.filter(t => tabelSah.has(t))
            : [...tabelSah];

        if (selectedTables && selectedTables.length && tabelList.length === 0)
            return res.status(400).json({ error: 'Tidak ada nama tabel valid pada pilihan' });

        const tgl  = new Date().toISOString().slice(0,19).replace(/[T:]/g, '-');
        const nama = `simbill-backup-${tgl}.sql`;

        res.setHeader('Content-Type', 'application/sql');
        res.setHeader('Content-Disposition', `attachment; filename="${nama}"`);

        // Header SQL
        res.write(`-- SimBill Database Backup\n`);
        res.write(`-- Generated: ${new Date().toISOString()}\n`);
        res.write(`-- Database: ${DB_NAME}\n`);
        res.write(`-- Tables: ${tabelList.join(', ')}\n\n`);
        res.write(`SET FOREIGN_KEY_CHECKS=0;\n`);
        res.write(`SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n`);
        res.write(`SET NAMES utf8mb4;\n\n`);

        for (const tabel of tabelList) {
            try {
                // CREATE TABLE
                const [createRow] = await query(`SHOW CREATE TABLE \`${tabel}\``);
                const createSQL   = Object.values(createRow)[1];
                res.write(`-- ──────────────────────────────────\n`);
                res.write(`-- Table: ${tabel}\n`);
                res.write(`-- ──────────────────────────────────\n`);
                res.write(`DROP TABLE IF EXISTS \`${tabel}\`;\n`);
                res.write(createSQL + ';\n\n');

                // INSERT DATA
                const rows = await query(`SELECT * FROM \`${tabel}\``);
                if (rows.length) {
                    const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
                    // Batch 500 baris
                    for (let i = 0; i < rows.length; i += 500) {
                        const batch  = rows.slice(i, i + 500);
                        const values = batch.map(row =>
                            '(' + Object.values(row).map(v => {
                                if (v === null) return 'NULL';
                                if (typeof v === 'number') return v;
                                if (v instanceof Date) return `'${v.toISOString().slice(0,19).replace('T',' ')}'`;
                                return `'${String(v).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,'\\r')}'`;
                            }).join(', ') + ')'
                        ).join(',\n');
                        res.write(`INSERT INTO \`${tabel}\` (${cols}) VALUES\n${values};\n`);
                    }
                }
                res.write(`\n`);
            } catch(e) {
                res.write(`-- ERROR tabel ${tabel}: ${e.message}\n\n`);
            }
        }

        res.write(`SET FOREIGN_KEY_CHECKS=1;\n`);
        res.write(`-- End of backup\n`);
        res.end();
    } catch(e) { next(e); }
});

// POST /api/backup/restore — restore dari SQL yang diupload
router.post('/restore', requireAdmin, async (req, res, next) => {
    try {
        const sql = req.body.sql;
        if (!sql || typeof sql !== 'string')
            return res.status(400).json({ error: 'Konten SQL tidak valid' });

        // Parse SQL menjadi statement-statement
        const statements = sql
            .split(/;\s*\n/)
            .map(s => s.trim())
            .filter(s => s && !s.startsWith('--') && !s.startsWith('/*'));

        let sukses = 0, gagal = 0, errors = [];

        const conn = await pool.getConnection();
        try {
            await conn.query('SET FOREIGN_KEY_CHECKS=0');
            await conn.query('SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO"');
            await conn.query('SET NAMES utf8mb4');

            for (const stmt of statements) {
                if (!stmt) continue;
                try {
                    await conn.query(stmt);
                    sukses++;
                } catch(e) {
                    gagal++;
                    if (errors.length < 10)
                        errors.push({ stmt: stmt.slice(0,80) + '...', error: e.message });
                }
            }
            await conn.query('SET FOREIGN_KEY_CHECKS=1');
        } finally {
            conn.release();
        }

        res.json({
            sukses, gagal, errors,
            pesan: `Restore selesai: ${sukses} statement berhasil${gagal ? `, ${gagal} gagal` : ''}`
        });
    } catch(e) { next(e); }
});

module.exports = router;
