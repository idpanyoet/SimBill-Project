#!/usr/bin/env bash
# ============================================================================
#  update-prod.sh — Update billing PRODUKSI dari SimBill-Source (plain).
#  Aman & terkontrol: backup dulu -> pull -> npm install -> pm2 restart.
#  Cocok untuk VPS produksimu sendiri (origin = SimBill-Source).
#  JANGAN dipakai di server pelanggan (mereka pakai SimBill-Project public).
# ============================================================================
set -e
APP="/opt/simbill"
PM2_NAME="billing-radius"
cd "$APP"

# 0) Pastikan origin = SimBill-Source (cegah salah tarik repo customer)
ORIGIN="$(git remote get-url origin)"
case "$ORIGIN" in
  *SimBill-Source*) : ;;
  *) echo "✗ origin bukan SimBill-Source ($ORIGIN). Batal demi keamanan."; exit 1 ;;
esac

# 1) Backup kode (jaga-jaga rollback)
STAMP="$(date +%Y%m%d-%H%M)"
tar czf "/opt/simbill-backup-${STAMP}.tar.gz" \
  --exclude=node_modules --exclude=_backup --exclude=.git \
  --exclude=frontend/uploads -C "$APP" . && echo "✓ backup: /opt/simbill-backup-${STAMP}.tar.gz"

# 2) Ambil & terapkan versi terbaru dari SimBill-Source
git fetch origin master
BEFORE="$(git rev-parse --short HEAD)"
# Tampilkan apa yang akan masuk
echo "=== commit baru yang akan masuk ==="
git log --oneline HEAD..origin/master || true
git reset --hard origin/master
AFTER="$(git rev-parse --short HEAD)"
echo "✓ kode: ${BEFORE} -> ${AFTER}"

# 3) Install dependensi bila package.json berubah (aman dijalankan selalu)
if [ -f backend/package.json ]; then
  ( cd backend && npm install --no-audit --no-fund ) && echo "✓ dependensi siap"
fi

# 4) Restart app
pm2 restart "$PM2_NAME" && echo "✓ ${PM2_NAME} di-restart"

echo "✅ Update produksi dari SimBill-Source selesai (${BEFORE} -> ${AFTER})."
echo "   Rollback bila perlu: cd $APP && tar xzf /opt/simbill-backup-${STAMP}.tar.gz && pm2 restart $PM2_NAME"
