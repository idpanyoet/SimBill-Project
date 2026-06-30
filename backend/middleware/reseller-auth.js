// middleware/reseller-auth.js
const jwt = require('jsonwebtoken');

function resellerAuth(req, res, next) {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer '))
        return res.status(401).json({ error: 'Token reseller tidak ditemukan' });

    const token = header.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET + '_reseller');
        if (decoded.role !== 'reseller')
            return res.status(403).json({ error: 'Akses ditolak' });
        req.reseller = decoded;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Token tidak valid atau kadaluarsa' });
    }
}

module.exports = { resellerAuth };
