// middleware/perm.js — Penegakan hak akses granular.
// Pemakaian (Fase 2): pasang ke route, mis.
//   const { requirePermission } = require('../middleware/perm');
//   router.post('/', requirePermission('pelanggan.tambah'), handler);
//
// Aturan: superadmin & admin = akses penuh (bypass). Peran lain dicek dari
// kolom admin.permissions (JSON array). authMiddleware harus sudah mengisi req.admin.
const { queryOne } = require('../config/db');

function requirePermission(key) {
    return async (req, res, next) => {
        try {
            const a = req.admin;
            if (!a) return res.status(401).json({ error: 'Tidak terautentikasi' });
            if (a.role === 'superadmin' || a.role === 'admin') return next();

            let perms = a.permissions;
            if (perms === undefined || perms === null) {
                const row = await queryOne('SELECT permissions FROM admin WHERE id=?', [a.id]).catch(() => null);
                try { perms = row && row.permissions ? JSON.parse(row.permissions) : []; } catch (e) { perms = []; }
            }
            if (Array.isArray(perms) && perms.includes(key)) return next();
            return res.status(403).json({ error: 'Akses ditolak: butuh izin ' + key });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    };
}

// Ambil daftar izin milik req.admin (untuk endpoint /me — dipakai frontend sembunyikan menu)
async function getPermissions(req) {
    const a = req.admin;
    if (!a) return [];
    if (a.role === 'superadmin' || a.role === 'admin') return ['*'];
    const row = await queryOne('SELECT permissions FROM admin WHERE id=?', [a.id]).catch(() => null);
    try { return row && row.permissions ? JSON.parse(row.permissions) : []; } catch (e) { return []; }
}

module.exports = { requirePermission, getPermissions };
