// routes/voucher-template.js — Voucher Template API
'use strict';
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/voucher-template — list semua template
router.get('/', async (req, res, next) => {
    try {
        const rows = await query('SELECT * FROM voucher_template ORDER BY is_default DESC, id ASC');
        res.json(rows);
    } catch(e) { next(e); }
});

// GET /api/voucher-template/:id
router.get('/:id', async (req, res, next) => {
    try {
        const row = await queryOne('SELECT * FROM voucher_template WHERE id=?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Template tidak ditemukan' });
        res.json(row);
    } catch(e) { next(e); }
});

// POST /api/voucher-template — buat template baru
router.post('/', requireAdmin, async (req, res, next) => {
    try {
        const { nama, header_html, row_html, footer_html, is_default } = req.body;
        if (!nama || !row_html) return res.status(400).json({ error: 'Nama dan Row HTML wajib diisi' });
        if (is_default) await query('UPDATE voucher_template SET is_default=0');
        const result = await query(
            'INSERT INTO voucher_template (nama, header_html, row_html, footer_html, is_default) VALUES (?,?,?,?,?)',
            [nama, header_html||'', row_html, footer_html||'', is_default ? 1 : 0]
        );
        res.status(201).json({ id: result.insertId, pesan: 'Template dibuat' });
    } catch(e) { next(e); }
});

// PUT /api/voucher-template/:id — update template
router.put('/:id', requireAdmin, async (req, res, next) => {
    try {
        const { nama, header_html, row_html, footer_html, is_default } = req.body;
        if (!row_html) return res.status(400).json({ error: 'Row HTML wajib diisi' });
        if (is_default) await query('UPDATE voucher_template SET is_default=0');
        await query(
            'UPDATE voucher_template SET nama=?, header_html=?, row_html=?, footer_html=?, is_default=? WHERE id=?',
            [nama, header_html||'', row_html, footer_html||'', is_default ? 1 : 0, req.params.id]
        );
        res.json({ pesan: 'Template diperbarui' });
    } catch(e) { next(e); }
});

// DELETE /api/voucher-template/:id
router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
        const tpl = await queryOne('SELECT is_default FROM voucher_template WHERE id=?', [req.params.id]);
        if (!tpl) return res.status(404).json({ error: 'Template tidak ditemukan' });
        if (tpl.is_default) return res.status(400).json({ error: 'Template default tidak bisa dihapus' });
        await query('DELETE FROM voucher_template WHERE id=?', [req.params.id]);
        res.json({ pesan: 'Template dihapus' });
    } catch(e) { next(e); }
});

// GET /api/voucher-template/default/get — ambil template default
router.get('/default/get', async (req, res, next) => {
    try {
        const row = await queryOne('SELECT * FROM voucher_template WHERE is_default=1 LIMIT 1')
            || await queryOne('SELECT * FROM voucher_template LIMIT 1');
        res.json(row || null);
    } catch(e) { next(e); }
});

module.exports = router;
