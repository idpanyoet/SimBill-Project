# CHANGELOG v1.14.8

Menambahkan **fix akar invoice dobel (loop cron)** di atas v1.14.7
(aktivasi lisensi aman + IP pool per-paket) dan v1.14.5 (WireGuard, template
ONU, UI).

## Invoice dobel — akar loop cron DITUTUP

- **BUG SISTEMIK (muncul berulang walau sudah pernah "diperbaiki").** Dua cron
  saling memicu:
    - 06:00 auto-cancel-basi: invoice unpaid/overdue milik pelanggan aktif yg
      tgl_expired melewati tgl_jatuh_tempo -> ditandai 'cancelled'.
    - 07:00 generate: guard bolehBuatInvoice() hanya menghitung status
      paid/unpaid/overdue — MELEWATKAN 'cancelled' -> menganggap belum ada
      invoice -> membuat baru utk jatuh tempo yg SAMA. Besok di-cancel lagi ->
      dibuat lagi -> LOOP HARIAN (contoh nyata: 55% invoice jadi cancelled,
      ~8 duplikat per pelanggan dgn jatuh tempo sama).
- **FIX:** bolehBuatInvoice() kini menolak membuat invoice bila SUDAH ADA
  invoice utk tgl_jatuh_tempo yang SAMA PERSIS — status APA PUN, termasuk
  'cancelled'. Loop terputus: setelah 1 invoice utk jatuh tempo X (walau jadi
  cancelled), tak ada lagi invoice baru utk X. Aturan lama (cek bulan sama utk
  paid/unpaid/overdue + blokir bila ada tunggakan) tetap. Menutup semua jalur
  yg memakai guard terpusat (cron bulanan, generate manual, portal client).
- Pembersihan data lama (invoice cancelled yg sudah menumpuk) dilakukan
  TERPISAH per server dgn tool bersih-invoice-dobel.js (dry-run + backup;
  kasus "bayar 2x" di-skip utk tinjauan manual). TIDAK otomatis — menyangkut
  data keuangan.

## (Termasuk semua perubahan v1.14.7 & v1.14.5)
- Aktivasi lisensi aman (fix chicken-and-egg + resetGuard, keamanan
  license_server_url & grace 3-hari dipertahankan).
- IP pool per-paket (groupname basis id paket).
- WireGuard end-to-end, template ONU persist, tombol Restart RADIUS.

## Migrasi otomatis: pelanggan.periode & pelanggan.siklus (PENTING)

- **BUG SISTEMIK (banyak pelanggan VPS terdampak diam-diam).** Kode SimBill
  (webhook pembayaran Xendit/dll + cron cek masa aktif + cron kalender)
  memakai kolom `pelanggan.periode` & `pelanggan.siklus`, TAPI tidak ada
  migrasi otomatis yang menambah kolom itu. Pelanggan yang DB-nya belum punya
  kolom tersebut mengalami error `Unknown column 'p.periode'` -> webhook
  pembayaran GAGAL (status voucher/invoice tak ter-update otomatis; harus
  dilunasi manual) + cron cek masa aktif error.
- **FIX:** tambah 2 migrasi otomatis di server.js (pola sama dgn migrasi lain):
    pelanggan.siklus  -> ALTER ADD COLUMN siklus  VARCHAR(20) DEFAULT 'postpaid'
    pelanggan.periode -> ALTER ADD COLUMN periode VARCHAR(20) DEFAULT 'tetap'
  Idempoten (cek INFORMATION_SCHEMA dulu; kalau kolom sudah ada -> skip).
  Pelanggan cukup update (git reset + restart) -> kolom ditambah OTOMATIS saat
  boot -> webhook & cron jalan normal. TIDAK perlu ALTER manual per server.
# CHANGELOG v1.14.5

Rilis fokus **WireGuard** (banyak perbaikan alur peer end-to-end),
**persistensi template ONU**, dan perbaikan UI.

## WireGuard — perbaikan menyeluruh alur peer

- **allowed_ips terima IPv6.** Validator `allowedIpsValid` dulu hanya IPv4,
  menolak `::/0` padahal default panel menawarkannya. Kini menerima
  IPv4-CIDR maupun IPv6-CIDR (mis. `0.0.0.0/0,::/0`), tetap menolak input
  ber-newline/karakter direktif (anti-injeksi wg0.conf).
- **Server public key otomatis terisi di script MikroTik.** Sebelumnya
  placeholder `(SERVER-PUBLIC-KEY)` muncul bila WireGuard dipasang lewat
  installer (bukan tombol panel). Kini fallback berjenjang: setting DB ->
  file `/etc/wireguard/server_public.key` -> derive dari `wg0.conf`, lalu
  disinkronkan ke setting.
- **Script MikroTik anti-error paste.** `allowed-address` dirapatkan tanpa
  spasi setelah koma; blok `add peer` ditulis SATU BARIS (tanpa `\`
  line-continuation yang rapuh di RouterOS). Menghilangkan "expected
  allowed-address value" & "syntax error / expected end of command".
- **`/ip address` MikroTik pakai prefix subnet /24** (bukan /32). Dengan /32
  peer tak punya route ke server -> handshake OK tapi ping timeout. /24
  membuat routing tunnel benar.
- **Kolom `vpn_account.ip_tunnel` baru.** IP tunnel peer disimpan terpisah
  dari `allowed_ips` (route), sehingga `/ip address` menulis IP tunnel yang
  benar. Migrasi kolom otomatis saat boot (idempoten).
- **Reload WireGuard otomatis diperbaiki.** Reload lama memakai process
  substitution `<(...)` yang gagal di `/bin/sh` (dash) & ditelan diam-diam,
  sehingga peer baru tak masuk runtime (handshake gagal, perlu reload
  manual). Kini pakai file sementara + `wg syncconf`; deteksi interface via
  `wg show` (bukan status systemd yang tak selalu akurat). Kegagalan reload
  kini dilaporkan, tak lagi senyap.
- **Private key peer terbaca.** Di modal Tambah Peer, private key kini
  tampil dengan warna kontras (tak lagi putih-di-putih yang hanya terlihat
  saat diblok).

## Template registrasi ONU (OLT) — tidak hilang lagi saat update

- Template ONU (`olt-templates.json`) dipindah ke luar folder repo
  (`/opt/simbill-data/`), sehingga `git reset --hard` saat update TIDAK lagi
  menghapus template buatan admin. Template bawaan pindah ke
  `olt-templates.default.json`. Saat boot: file data yg sudah ada tak
  disentuh; bila belum ada, migrasi dari lokasi lama atau seed dari default.

## Perbaikan UI

- Tombol **Restart RADIUS** di halaman Setting kini berfungsi (sebelumnya
  onclick rusak oleh escape tak valid).

## Catatan upgrade

- Migrasi DB (`vpn_account.ip_tunnel`) berjalan otomatis saat start.
- Template ONU: setelah upgrade, `olt-templates.json` di-untrack dari git &
  dimigrasi ke `/opt/simbill-data/` otomatis. Peer WireGuard lama yang sudah
  ada perlu di-set `ip_tunnel`-nya (atau dibuat ulang) agar `/ip address`
  di script benar; peer baru otomatis benar.
