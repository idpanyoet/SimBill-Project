# RUNBOOK RILIS v1.6.0 — SimBill

## 0. Daftar file yang berubah (taruh ke /opt/simbill-source)

**Backend**
- backend/routes/wa-command.js      (BARU — bot perintah WA)
- backend/routes/tiket.js           (buat tiket + info-koneksi ACS)
- backend/routes/whatsapp.js        (endpoint cmd-config + generate token)
- backend/routes/client.js          (login-mode + login-sandi)
- backend/routes/pengguna.js        (kolom permissions + simpan/load)
- backend/routes/odcodp.js          (endpoint /status-acs peta)
- backend/routes/laporan.js         (pengeluaran + upload bukti + kolom bukti)
- backend/routes/sistem.js          (Reset DB Opsi A — bila belum di source)
- backend/services/whatsapp.js      (fix token + export kirimPesanLangsung)
- backend/middleware/perm.js        (BARU — requirePermission)
- backend/server.js                 (mount webhook /webhook/wa)

**Frontend**
- frontend/admin.html
- frontend/client.html

> CATATAN: services/whatsapp.js & wa-command.js sempat diedit LANGSUNG di produksi.
> Pastikan versi yang masuk source == versi produksi (ambil dari /opt/simbill bila ragu).

## 1. Verifikasi sebelum commit
```bash
cd /opt/simbill-source
for f in routes/wa-command.js routes/tiket.js routes/whatsapp.js routes/client.js \
         routes/pengguna.js routes/odcodp.js routes/laporan.js routes/sistem.js \
         services/whatsapp.js middleware/perm.js server.js; do
  node --check "backend/$f" || echo "FAIL $f"
done; echo "syntax done"

grep -c "webhook/wa" backend/server.js                       # 1
grep -c "kirimPesanLangsung" backend/services/whatsapp.js    # >=2
grep -c "status-acs" backend/routes/odcodp.js                # 1
grep -c "login-sandi" backend/routes/client.js               # >=1
grep -c "permissions" backend/routes/pengguna.js             # >=3
grep -c "upload-bukti" backend/routes/laporan.js             # 1
grep -c "Bot Perintah WhatsApp" frontend/admin.html          # 1
grep -c "petaSyncAcs\|PERM_DEFS\|m-tiket-baru" frontend/admin.html   # >=3
```

## 2. Bump versi
```bash
echo 'v1.6.0' > VERSION
(cd backend && npm pkg set version=1.6.0)
sed -i 's#badge/versi-v[0-9.]*-BA7517#badge/versi-v1.6.0-BA7517#' README.md
```

## 3. CHANGELOG (tempel CHANGELOG-v1.6.0.md di atas CHANGELOG.md)
```bash
cat CHANGELOG-v1.6.0.md CHANGELOG.md > /tmp/cl && mv /tmp/cl CHANGELOG.md
```

## 4. Commit + push + obfuscate + release
```bash
git add -A
git status     # PASTIKAN .env, backend/backups/, *.zip, frontend/uploads/ TIDAK ikut
git commit -m "v1.6.0: Bot WA, Tiket+InfoKoneksi ACS, Peta live ACS, RBAC, Portal login 2-metode, Keuangan"
git push origin master
SRC=/opt/simbill-source /opt/obf-tool/release.sh v1.6.0
# lalu publish GitHub Release v1.6.0 (isi CHANGELOG) via web
```

## 5. Verifikasi publik (anti-cache)
```bash
wget -qO- "https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/backend/routes/wa-command.js?$(date +%s)" | grep -c handleCommand   # >=1
wget -qO- "https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/frontend/admin.html?$(date +%s)" | grep -c "Bot Perintah WhatsApp"   # 1
```

## 6. Pastikan folder upload bisa ditulis (produksi)
```bash
mkdir -p /opt/simbill/frontend/uploads/pengeluaran && chmod 755 /opt/simbill/frontend/uploads/pengeluaran
```

---

## ⚠️ PENDING (belum tuntas — jangan diklaim selesai)
1. **Foto depan rumah** — UI sudah ada di admin.html & mengirim `foto_rumah`, TAPI backend
   `routes/pelanggan.js` belum: (a) kolom `foto_rumah`, (b) upload-ktp belum bedakan `type=rumah`
   → RISIKO: upload rumah bisa MENIMPA file KTP (nama file sama). Selesaikan pelanggan.js dulu
   sebelum fitur ini dipakai penuh.
2. **RBAC Fase 2 (enforcement)** — pasang `requirePermission('...')` ke endpoint satu per satu,
   + endpoint `/me` mengembalikan izin user login agar sidebar auto-sembunyi. Bertahap.
