# RSS Anywhere

Ubah website apa pun menjadi **link feed RSS publik** — dibuat otomatis oleh GitHub Actions, disajikan GitHub Pages. Komputer Anda tidak perlu menyala, tidak ada server yang harus dijaga.

**Situs live:** <https://sietekmalut.github.io/rss-anywhere/>

Contoh link feed yang sudah aktif:

```
https://sietekmalut.github.io/rss-anywhere/feeds/kompas-com-c667a3.xml
https://sietekmalut.github.io/rss-anywhere/feeds/terbitmalut-com-859a30.xml
```

- **Gratis**, tanpa server, tanpa database.
- **Permanen** — ID feed dihitung dari URL, jadi linknya tidak berubah.
- **Diperbarui otomatis** tiap 30 menit oleh GitHub Actions.
- **Dua format**: RSS 2.0 (`feeds/<id>.xml`) dan JSON Feed 1.1 (`feeds/<id>.json`).
- **Tanpa dependensi runtime** — mesinnya hanya memakai Web API standar (`fetch`, `TextDecoder`, `AbortController`).

---

## 1. Menambah feed baru

1. Buka <https://sietekmalut.github.io/rss-anywhere/>
2. Tempel URL halaman (beranda, kategori, atau blog) → klik **Buat link feed**
3. GitHub terbuka dengan issue yang sudah terisi → klik **Submit new issue**
4. Tunggu ±1 menit. Bot akan mengomentari issue dengan link feed lalu menutupnya

Hanya issue dari **pemilik repo** yang diproses (repo publik, tapi penambahan feed dibatasi agar tidak jadi alat penyalahgunaan).

### Lewat file `sources.json`

Tambahkan objek ke `sources.json`, lalu push — workflow otomatis berjalan:

```json
{
  "url": "https://contoh.com/berita",
  "limit": 20,
  "filter": "",
  "mode": "auto"
}
```

| Field | Isi |
|---|---|
| `url` | wajib — halaman atau feed |
| `limit` | 1–100, default 20 (diabaikan untuk feed asli) |
| `filter` | opsional — hanya item yang URL/judulnya mengandung teks ini |
| `mode` | `auto` / `html` / `feed` |

ID feed dibuat dari host + path + hash URL, jadi URL yang sama selalu menghasilkan file yang sama.

---

## 2. Cara kerjanya

```
sources.json
    │  GitHub Actions (cron */30, workflow_dispatch, issue baru, push sources.json)
    ▼
src/feed.js  ──  fetch halaman, deteksi feed, ekstraksi HTML, sitemap
    │
    ▼
feeds/<id>.xml + feeds/<id>.json + feeds.json   (di-commit ke repo)
    │
    ▼
dist/  ──►  artefak GitHub Pages  ──►  https://sietekmalut.github.io/rss-anywhere/
```

Urutan deteksi per sumber:

1. **Feed asli** lewat `<link rel="alternate" type="application/rss+xml">` → XML diteruskan apa adanya (RSS/Atom utuh).
2. **Path umum** — `/feed`, `/rss`, `/rss.xml`, `/atom.xml`, `/feed.xml`, `/index.xml`, …
3. **Ekstraksi HTML** — `<article>`, daftar berulang, gugus anchor, tanggal, gambar, JSON-LD.
4. **`sitemap.xml`** sebagai jalan terakhir.

Pengaman: SSRF guard (localhost/IP privat/endpoint metadata ditolak, redirect divalidasi), batas ukuran 3 MB, timeout 10 detik per pengambilan.

Kalau satu sumber gagal diambil, file lamanya **tidak dihapus** — feed tetap bisa dibaca dan `feeds.json` menandainya dengan pesan error.

---

## 3. Struktur proyek

```
sources.json            daftar URL yang dijadikan feed
feeds/                  hasil build (tidak di-commit): <id>.xml + <id>.json
feeds.json              daftar feed untuk UI (judul, jumlah item, link)
pages/                  UI statis yang disajikan GitHub Pages
dist/                   hasil build siap-deploy (tidak di-commit)
.github/workflows/      feed builder + deploy Pages
src/                    mesin: parser, ekstraksi, renderer, core
scripts/                build, tes, benchmark, simulator
api/ + public/          opsi mode server (Vercel) — lihat bagian 6
```

---

## 4. Menjalankan / membangun di lokal

Butuh Node.js 18+. Tidak perlu `npm install` untuk mode Pages.

```powershell
cd "C:\Users\LENOVO\Documents\Default Project\rss-anywhere"

node scripts/build-static.mjs    # bangun semua feed + dist/
node scripts/serve-dist.mjs      # lihat hasil build di http://localhost:8790
node scripts/unit-test.mjs       # 14 tes parser & renderer
node scripts/bench.mjs           # kecepatan parse
```

Untuk mencoba alur issue tanpa menunggu GitHub:

```powershell
$env:ISSUE_TITLE="[feed] https://contoh.com"; $env:ISSUE_BODY="URL: https://contoh.com"
$env:ISSUE_AUTHOR="SietekMalut"; $env:REPO_OWNER="SietekMalut"
node scripts/issue-to-source.mjs
```

---

## 5. Merawat deployment

```powershell
# jalankan build sekarang (tanpa menunggu jadwal)
gh workflow run feeds.yml --repo SietekMalut/rss-anywhere

# lihat status / log
gh run list --repo SietekMalut/rss-anywhere --limit 5
gh run watch <RUN_ID> --repo SietekMalut/rss-anywhere

# buka situsnya
Start-Process https://sietekmalut.github.io/rss-anywhere/
```

- **Jadwal:** `cron: '*/30 * * * *'`. GitHub bisa menunda 5–15 menit saat sibuk; itu normal.
- **Repo harus tetap aktif.** GitHub menonaktifkan workflow terjadwal setelah 60 hari tanpa aktivitas — commit otomatis tiap 30 menit membuat repo selalu aktif.
- **Kuota gratis:** repo publik = menit Actions tanpa batas, bandwidth Pages 100 GB/bulan.
- **Ganti nama repo?** Ubah `SITE_BASE` di `.github/workflows/feeds.yml` dan fallback `REPO_FALLBACK` di `pages/app.js`.

### Shortcut desktop

Untuk membuka situs tanpa mengetik URL, jalankan sekali:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
```

Skrip itu membuat `RSS Anywhere.lnk` di Desktop beserta ikon khusus
(`%LOCALAPPDATA%\RSS Anywhere\rss-anywhere-v2.ico`). Shortcut mengarah ke situs live,
jadi selalu terbuka di browser default dan tidak butuh server lokal.

---

## 6. Opsi: menjalankan sebagai server sendiri

Kalau butuh **link instan untuk URL apa pun** (tanpa menunggu build), proyek ini juga punya mode server dengan mesin yang sama:

| | GitHub Pages (aktif) | Mode server (Vercel/Cloudflare) |
|---|---|---|
| Link untuk URL baru | ±1 menit (lewat build) | langsung |
| Perawatan | nol | deploy + akun host |
| Biaya | gratis | gratis (Vercel Hobby) |

- **Vercel:** `deploy-vercel.cmd` atau `npx vercel deploy --prod`. `vercel.json` + `api/*.js` sudah siap, `maxDuration: 30`.
- **Cloudflare Workers:** `deploy-cloudflare.cmd` atau `npx wrangler deploy`. Catatan: paket gratis membatasi **10 ms CPU per request** — halaman besar bisa gagal dengan `Error 1102`, jadi Vercel lebih aman.
- **Lokal:** `node src/server.js` → UI mode server + `/feed?url=…` (hanya untuk pengembangan).

Endpoint mode server: `/feed?url=…` (RSS), `/feed.json?url=…`, `/api/preview`, `/api/discover`, `/healthz`. Parameter: `url`, `limit`, `ttl`, `filter`, `mode`, `nocache`.

---

## 7. Batasan

- **Bukan real-time**: isi feed diperbarui tiap 30 menit.
- **Menambah feed butuh GitHub**: hanya pemilik repo yang issue-nya diproses.
- Konten di balik login atau yang dirender JavaScript tidak bisa diambil.
- Situs dengan proteksi bot bisa menolak (403/405/429). Feed lama tetap tersedia.
- Feed asli yang dipassthrough tidak terkena `limit`/`filter`.
- Pakai untuk konten publik; hormati `robots.txt` dan syarat layanan situs.

---

## 8. Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| Issue tidak dibalas | Issue bukan dari pemilik repo, atau tidak ada URL `http(s)` di judul/isi |
| Feed 0 item | Halaman tidak punya daftar artikel. Coba URL kategori/beranda lain, atau set `mode: html` |
| `badge gagal` di UI | Sumber menolak permintaan. File lama tetap dipakai; coba lagi nanti |
| Feed tidak berubah | Cek `gh run list`; jalankan `gh workflow run feeds.yml` |
| Halaman 404 di Pages | Pastikan **Settings → Pages → Source = GitHub Actions** dan deploy terakhir sukses |
| Link tidak bisa dibuka | Link harus lengkap `https://sietekmalut.github.io/rss-anywhere/feeds/<id>.xml` |

---

## 9. Lisensi

Bebas dipakai dan diubah untuk keperluan pribadi maupun komersial.
