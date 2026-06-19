// routes/auth.js — Login admin
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { queryOne } = require('../config/db');

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password)
            return res.status(400).json({ error: 'Email dan password wajib diisi' });

        const admin = await queryOne(
            'SELECT * FROM admin WHERE email = ? AND aktif = 1', [email]
        );
        if (!admin)
            return res.status(401).json({ error: 'Email atau password salah' });

        const valid = await bcrypt.compare(password, admin.password);
        if (!valid)
            return res.status(401).json({ error: 'Email atau password salah' });

        // Update last_login
        const { query } = require('../config/db');
        await query('UPDATE admin SET last_login = NOW() WHERE id = ?', [admin.id]);

        const token = jwt.sign(
            { id: admin.id, nama: admin.nama, email: admin.email, role: admin.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES || '8h' }
        );

        // Audit log
        const { tulisLog } = require('./log');
        tulisLog({ kategori:'Auth', pelaku: admin.nama || admin.email,
            aksi:'LOGIN', target: admin.nama,
            detail:'User logged in via Web UI',
            ip: req.headers['x-forwarded-for'] || req.ip });

        res.json({
            token,
            admin: { id: admin.id, nama: admin.nama, email: admin.email, role: admin.role }
        });
    } catch (e) { next(e); }
});

// POST /api/auth/ganti-password
const { authMiddleware } = require('../middleware/auth');
router.post('/ganti-password', authMiddleware, async (req, res, next) => {
    try {
        const { password_lama, password_baru } = req.body;
        const { query } = require('../config/db');

        const admin = await queryOne('SELECT * FROM admin WHERE id = ?', [req.admin.id]);
        const valid = await bcrypt.compare(password_lama, admin.password);
        if (!valid) return res.status(400).json({ error: 'Password lama salah' });

        const hash = await bcrypt.hash(password_baru, 12);
        await query('UPDATE admin SET password = ? WHERE id = ?', [hash, req.admin.id]);
        res.json({ pesan: 'Password berhasil diubah' });
    } catch (e) { next(e); }
});

module.exports = router;
