#!/usr/bin/env bash
# Konfigurasi modul SQL FreeRADIUS agar nyambung ke DB SimBill (billing_radius).
# Perintah identik dengan blok FreeRADIUS di installer SimBill (yang ter-skip
# saat install non-interaktif). Aman & minimal — hanya menyentuh FreeRADIUS.
set -e
ENV=/opt/simbill/backend/.env
DB_USER=$(grep -E '^DB_USER=' "$ENV"|cut -d= -f2)
DB_PASS=$(grep -E '^DB_PASS=' "$ENV"|cut -d= -f2-)
DB_NAME=$(grep -E '^DB_NAME=' "$ENV"|cut -d= -f2)
echo "DB: $DB_NAME / user $DB_USER"

RADDIR="$(ls -d /etc/freeradius/*/ 2>/dev/null | head -1)"
SQLMOD="${RADDIR}mods-available/sql"
[ -f "$SQLMOD" ] || { echo "✗ $SQLMOD tak ada"; exit 1; }

systemctl stop freeradius 2>/dev/null || true

# 1) Arahkan modul sql ke DB SimBill (dialect/driver/radius_db + read_clients)
sed -i -E \
  -e 's|^([[:space:]]*)dialect = .*|\1dialect = "mysql"|' \
  -e 's|^([[:space:]]*)driver = "rlm_sql_null"|\1driver = "rlm_sql_mysql"|' \
  -e "s|^([[:space:]]*)radius_db = .*|\1radius_db = \"${DB_NAME}\"|" \
  -e 's|^([[:space:]]*)#?[[:space:]]*read_clients = yes|\1read_clients = yes|' \
  -e 's|^([[:space:]]*)#?[[:space:]]*client_table = .*|\1client_table = "nas"|' \
  "$SQLMOD"

# 1a) JARING PENGAMAN (Python): set server/login/password/radius_db, uncomment baris
#     ber-'#' (default Ubuntu 22/24), aman utk password berkarakter khusus.
#     Hanya occurrence PERTAMA tiap kunci (hindari contoh mongodb/postgresql).
python3 - "$SQLMOD" "$DB_USER" "$DB_PASS" "$DB_NAME" <<'PY'
import sys, re
f, user, pw, db = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
def esc(v): return v.replace('\\', '\\\\').replace('"', '\\"')
want = {'server': '127.0.0.1', 'login': user, 'password': pw, 'radius_db': db}
lines = open(f).read().splitlines()
seen, out = set(), []
for ln in lines:
    m = re.match(r'^(\s*)#?\s*(server|login|password|radius_db)\s*=\s*"[^"]*"\s*$', ln)
    if m and m.group(2) not in seen:
        k = m.group(2); seen.add(k)
        out.append('%s%s = "%s"' % (m.group(1), k, esc(want[k])))
    else:
        out.append(ln)
missing = [k for k in want if k not in seen]
if missing:
    res = []
    for ln in out:
        res.append(ln)
        if re.match(r'^\s*driver\s*=\s*"rlm_sql_mysql"', ln):
            ind = re.match(r'^(\s*)', ln).group(1)
            for k in missing:
                res.append('%s%s = "%s"' % (ind, k, esc(want[k])))
    out = res
open(f, 'w').write('\n'.join(out) + '\n')
PY

# 1b) Buang blok tls{} (brace-aware) — di Ubuntu 24 tls{ca_file=...} nunjuk file
#     tak ada → modul sql gagal instantiate → FreeRADIUS tolak start.
python3 - "$SQLMOD" <<'PY'
import sys, re
f = sys.argv[1]
lines = open(f).read().splitlines()
out, skip, depth = [], False, 0
for ln in lines:
    st = ln.strip().lstrip('#').strip()
    if not skip and re.match(r'tls\s*\{', st):
        skip = True; depth = ln.count('{') - ln.count('}')
        if depth <= 0: skip = False
        continue
    if skip:
        depth += ln.count('{') - ln.count('}')
        if depth <= 0: skip = False
        continue
    out.append(ln)
open(f, 'w').write('\n'.join(out) + '\n')
PY

# 2) Aktifkan modul sql
ln -sf ../mods-available/sql "${RADDIR}mods-enabled/sql"

# 3) Aktifkan sql di sites (uncomment '#sql')
for site in "${RADDIR}sites-enabled/default" "${RADDIR}sites-enabled/inner-tunnel"; do
  [ -f "$site" ] && sed -i 's/^\([[:space:]]*\)#[[:space:]]*sql[[:space:]]*$/\1sql/' "$site"
done

# 3b) Izinkan username ber-realm tanpa titik (mis. user@rfnet).
#     Nonaktifkan blok dot-separator di policy filter (idempotent).
FILTERPOL="${RADDIR}policy.d/filter"
if [ -f "$FILTERPOL" ] && ! grep -q '#SIMBILL-OFF' "$FILTERPOL"; then
  python3 - "$FILTERPOL" <<'PYFILT'
import sys, re
f = sys.argv[1]
lines = open(f).read().splitlines()
out, i, patched = [], 0, 0
while i < len(lines):
    ln = lines[i]
    if re.search(r'User-Name\s*!~\s*/@.*\\\..*/', ln) and '{' in ln:
        depth = ln.count('{') - ln.count('}')
        out.append('#SIMBILL-OFF ' + ln)
        i += 1
        while i < len(lines) and depth > 0:
            depth += lines[i].count('{') - lines[i].count('}')
            out.append('#SIMBILL-OFF ' + lines[i]); i += 1
        patched += 1
        continue
    out.append(ln); i += 1
open(f, 'w').write('\n'.join(out) + '\n')
print('  filter_username dot-separator dinonaktifkan: %d blok' % patched)
PYFILT
fi

# 4) Hak akses
chgrp -h freerad "${RADDIR}mods-enabled/sql" 2>/dev/null || true
chown freerad:freerad "$SQLMOD" 2>/dev/null || true
chmod 640 "$SQLMOD" 2>/dev/null || true

# 5) Cek config & jalankan
echo "=== cek config ==="
if freeradius -XC >/tmp/fr-check.log 2>&1; then
  systemctl enable --now freeradius
  echo "✓ FreeRADIUS aktif → DB '${DB_NAME}', NAS dibaca dari tabel 'nas'"
  grep -E 'dialect|driver|radius_db' "$SQLMOD" | grep -v '#'
else
  echo "✗ Cek config GAGAL. 20 baris terakhir:"
  tail -20 /tmp/fr-check.log
fi
