# CHANGELOG v1.14.7

Rilis gabungan: FIX AKTIVASI LISENSI (aman) + FIX IP POOL per-paket, di atas
basis v1.14.5 (WireGuard, template ONU, UI — sudah dirilis sebelumnya).

## Aktivasi lisensi — install baru tak terkunci, TANPA regresi keamanan

- **BUG #1 (chicken-and-egg) "Token tidak ditemukan".** `routes/license.js`
  memasang `authMiddleware` global -> `/activate` menolak request tanpa token.
  Install baru terkunci (`license_enforce=1`) -> admin belum bisa login ->
  belum punya token -> aktivasi mustahil. FIX: `authMiddleware` global dihapus;
  `/activate`, `/status`, `/hwid` publik; endpoint sensitif (`/extend`,
  `/plans`, `/extend/pay`, `/payment/status`) tetap `authMiddleware +
  requireAdmin`.
- **BUG #2 — aktivasi sukses tapi balik ke gerbang.** `license-guard` cache
  status & refresh tiap 5 menit. Setelah `/activate` sukses, guard masih
  pegang status lama. FIX: guard mengekspos `resetGuard()`; `/activate`
  memanggilnya setelah sukses -> evaluasi ulang seketika.
- **Keamanan dipertahankan (PENTING).** `/activate` TIDAK menerima
  `license_server_url` dari body (cegah pengalihan ke server lisensi palsu)
  dan menghapus override lama. Grace 3 hari untuk "server tak terjangkau"
  tetap (bukan fail-open buta -> cegah bypass via block DNS). Versi ini
  MENGGANTIKAN patch aktivasi mentah yang sempat masuk source (yang membuka
  kembali lubang server-palsu & fail-open).

## IP Pool per-paket — tiap paket dapat pool sendiri

- **BUG: semua pelanggan dapat IP dari satu pool** (pool paket yg terakhir
  diedit). Akar: groupname RADIUS dibuat dari kecepatan
  (`${tipe}-${kecepatan_dn}mbps`). Karena banyak paket punya kecepatan_dn
  sama (mis. semua =1), SEMUA pelanggan menumpuk di 1 group -> Framed-Pool
  saling menimpa. FIX: groupname berbasis ID paket (`${tipe}-paket-${id}`),
  unik per paket -> tiap paket punya group & Framed-Pool sendiri.
  - backend/services/radius.js : _namaGroup() basis id paket.
  - backend/routes/paket.js    : groupname saat edit paket basis id.
  - Migrasi data pelanggan lama: pakai script migrasi-group-per-paket.js
    (TIDAK termasuk rilis; jalankan sekali di server yg sudah terlanjur
    menumpuk di 1 group).

## (Termasuk semua perubahan v1.14.5)
- WireGuard end-to-end (IPv6 allowed_ips, server pubkey auto, script anti-
  error, /ip /24, ip_tunnel, reload fix, private key terbaca), template ONU
  persist, tombol Restart RADIUS.

## Migrasi group RADIUS OTOMATIS (tambahan)
- Migrasi data group-per-paket kini BERJALAN OTOMATIS saat boot (server.js:
  entry migrasi `radusergroup.group_per_paket`). Idempoten via cek
  `groupname REGEXP '-[0-9]+mbps$'` -> setelah termigrasi tak jalan lagi.
  Pelanggan lama yang menumpuk di 1 group otomatis dipindah ke group paket-nya.
  Skrip migrasi-group-per-paket.js tetap disertakan sebagai cadangan/rollback
  (DRY-RUN default), tapi TIDAK wajib dijalankan manual lagi.
