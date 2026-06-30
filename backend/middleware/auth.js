// middleware/auth.js — Verifikasi JWT token
const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token tidak ditemukan' });
    }

    const token = header.split(' ')[1];
    try {
        req.admin = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Token tidak valid atau sudah kadaluarsa' });
    }
}

// Middleware khusus superadmin/admin
function requireAdmin(req, res, next) {
    if (!['superadmin', 'admin'].includes(req.admin?.role)) {
        return res.status(403).json({ error: 'Akses ditolak' });
    }
    next();
}

module.exports = { authMiddleware, requireAdmin };
