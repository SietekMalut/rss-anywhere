# RSS Anywhere

Ubah website apa pun menjadi **link feed RSS** — linknya hidup di internet, bukan di komputer Anda.

Tempel satu URL di halaman aplikasi, dapatkan link seperti:

```
https://rss-anywhere-anda.vercel.app/feed?url=https://www.detik.com
```

Link itu bisa dibuka dari HP, laptop lain, atau dimasukkan ke Feedly / Inoreader / FreshRSS / Thunderbird kapan saja. Komputer Anda tidak perlu menyala.

- **Gratis** — jalan di paket gratis Vercel (utama) atau Cloudflare Workers.
- **Tanpa database** — tidak ada akun, tidak ada data yang disimpan.
- **Tanpa dependensi runtime** — hanya Web API standar (`fetch`, `TextDecoder`, `AbortController`), jadi kode yang sama jalan di Vercel, Cloudflare, Deno, dan Node 18+.

---

## 1. Coba dulu di lokal

Butuh [Node.js 18+](https://nodejs.org). Tidak perlu `npm install` untuk mode lokal.

```powershell
cd "C:\Users\LENOVO\Documents\Default Project\rss-anywhere"
node src/server.js
```

Buka <http://localhost:8787>. Atau klik dua kali **`jalankan-lokal.cmd`**.

Uji cepat:

```powershell
node scripts/unit-test.mjs                        # 14 tes parser & renderer
node scripts/api-test.mjs                         # 17 tes kontrak HTTP (server harus jalan)
node scripts/smoke-test.mjs                       # uji ke situs asli
```

Server lokal hanya untuk mengembangkan. **Link yang dihasilkan dari localhost tidak bisa diakses orang lain** — untuk itu lanjut ke langkah 2.

---

## 2. Deploy ke Vercel (disarankan, gratis)

Kenapa Vercel: paket gratisnya tidak membatasi CPU per request, dan fungsi serverless di sini boleh berjalan sampai 30 detik (`maxDuration: 30` di `vercel.json`). Ekstraksi HTML butuh sekitar 4–20 ms CPU; di Cloudflare Workers gratis batasnya hanya 10 ms (lihat bagian 3).

### Cara termudah

1. Klik dua kali **`deploy-vercel.cmd`**.
2. Ikuti instruksi di browser: login (GitHub/Google/email), lalu konfirmasi.
3. Selesai — terminal menampilkan URL produksi, misalnya `https://rss-anywhere.vercel.app`.

### Cara manual (PowerShell)

```powershell
cd "C:\Users\LENOVO\Documents\Default Project\rss-anywhere"
npx vercel login          # sekali saja
npx vercel deploy --prod  # setiap kali ingin merilis versi baru
```

Saat pertama kali jalan, `npx vercel` akan bertanya:

| Pertanyaan | Jawab |
|---|---|
| Set up and deploy? | `Y` |
| Which scope? | pilih akun Anda |
| Link to existing project? | `N` |
| Project name? | `rss-anywhere` (atau nama lain, harus unik) |
| In which directory is your code located? | `./` |
| Want to modify these settings? | `N` |

Struktur proyek sudah disiapkan untuk Vercel:

- `public/` → halaman UI (disajikan otomatis sebagai file statis)
- `api/feed.js`, `api/feed-json.js`, `api/preview.js`, `api/discover.js`, `api/healthz.js` → fungsi serverless
- `vercel.json` → rewrite `/feed` → `api/feed`, `/feed.json` → `api/feed-json`, dan seterusnya

Setelah deploy, cek:

```
https://NAMA-PROYEK.vercel.app/healthz
```

Harus muncul `{"ok": true, ...}`.

### Nama domain

- URL `*.vercel.app` gratis dan permanen selama proyeknya tidak dihapus.
- Punya domain sendiri? Di dashboard Vercel: **Project → Settings → Domains → Add**, lalu arahkan DNS sesuai instruksi. Tidak ada biaya dari Vercel.

---

## 3. Deploy ke Cloudflare Workers (alternatif, gratis)

```powershell
cd "C:\Users\LENOVO\Documents\Default Project\rss-anywhere"
npm install            # sekali saja, memasang wrangler
npx wrangler login     # sekali saja, buka browser
npx wrangler deploy
```

Atau klik dua kali **`deploy-cloudflare.cmd`**.

Hasilnya: `https://rss-anywhere.<subdomain-anda>.workers.dev`.

> ### ⚠️ Batas CPU paket gratis Cloudflare
> Paket gratis Workers memberi **10 ms CPU per request** (bukan waktu tunggu jaringan, tapi CPU yang benar-benar dipakai). Halaman besar bisa melewati batas ini dan request gagal dengan **Error 1102 (Worker exceeded CPU time limit)**.
>
> Parser di proyek ini sudah dioptimalkan (halaman 1 MB ≈ 14 ms parse di mesin biasa; di edge lebih cepat), jadi banyak situs tetap aman. Tapi kalau Anda sering memakai situs berat, **pakai Vercel**. Cloudflare Workers Paid ($5/bulan) menaikkan batas CPU ke 30 detik, tapi itu sudah tidak gratis.

Kalau `npm install` tidak diinginkan, `npx wrangler deploy` juga bisa — npx akan mengunduh wrangler sementara.

---

## 4. Endpoint

Ganti `BASE` dengan URL deploy Anda.

| Endpoint | Isi |
|---|---|
| `GET /` | Halaman UI |
| `GET /feed?url=…` | RSS 2.0 (default) |
| `GET /rss`, `/feed.xml`, `/rss.xml` | Sama dengan `/feed` |
| `GET /feed.json?url=…` | JSON Feed 1.1 |
| `GET /api/preview?url=…` | JSON pratinjau item (dipakai UI) |
| `GET /api/discover?url=…` | JSON metadata + kandidat feed asli |
| `GET /healthz` | Cek server hidup |

Contoh:

```
https://BASE/feed?url=https://www.kompas.com
https://BASE/feed?url=https://github.blog&limit=5
https://BASE/feed?url=https://www.detik.com&filter=bola
https://BASE/feed.json?url=https://nextjs.org/blog
```

### Parameter

| Parameter | Nilai | Keterangan |
|---|---|---|
| `url` (alias `u`, `q`) | wajib | Halaman atau feed yang mau diubah |
| `limit` | 1–100, default 20 | Jumlah item. **Diabaikan untuk feed asli** (dipassthrough apa adanya) |
| `ttl` | 60–86400, default 900 | Detik hasil disimpan di cache |
| `filter` | teks | Hanya item yang URL/judulnya mengandung teks ini |
| `mode` | `auto` / `html` / `feed` | `html` = paksa ekstraksi HTML, `feed` = wajib feed asli |
| `nocache` | `1` | Lewati cache (berguna saat menyetel `filter`) |

Respons feed menyertakan header diagnostik:

- `x-feed-source` → `native`, `path`, `html`, atau `sitemap`
- `x-feed-items` → jumlah item
- `x-feed-ms` → waktu proses di server
- `x-cache` → `HIT` kalau diambil dari cache

---

## 5. Cara kerjanya

Server mengambil halaman dari sisi server (jadi bebas dari batasan CORS), lalu mencoba berurutan:

1. **Feed asli** — baca `<link rel="alternate" type="application/rss+xml">` di `<head>`.
2. **Path umum** — `/feed`, `/rss`, `/rss.xml`, `/atom.xml`, `/feed.xml`, `/index.xml`, …
3. **Ekstraksi HTML** — `<article>`, daftar berulang (`<ul>`/`<div>` dengan struktur sama), gugus anchor, tanggal, gambar, JSON-LD.
4. **Sitemap** — kalau ketiganya gagal, `sitemap.xml` dipakai sebagai jalan terakhir.

Kalau situsnya sudah punya feed asli, XML-nya **diteruskan apa adanya** (termasuk Atom, lengkap dengan `<content>`), sehingga tidak ada detail yang hilang. Feed hasil ekstraksi dirender sebagai RSS 2.0 yang valid.

Pengaman yang sudah ada:

- **SSRF guard**: `localhost`, IP privat, dan endpoint metadata cloud ditolak; redirect divalidasi manual di setiap lompatan.
- **Batas ukuran**: halaman di atas 3 MB tidak diproses.
- **Timeout**: 10 detik per pengambilan, dengan batas total sebelum jatuh ke sitemap.
- **Cache**: di edge (Vercel CDN / Cloudflare Cache API), plus cache memori per instance.

---

## 6. Batasan yang perlu diketahui

- **Situs dengan proteksi bot** bisa menolak (403/405/429) atau mengembalikan halaman kosong. Beberapa situs (mis. arstechnica.com saat diuji dari jaringan tertentu) menolak permintaan non-browser. Ini bukan bug aplikasi.
- **Konten di balik login / JavaScript-only** tidak bisa diambil. Aplikasi ini tidak menjalankan browser.
- **Feed asli tidak difilter**: `limit` dan `filter` tidak berlaku karena XML sumber diteruskan utuh. Pakai `mode=html` kalau ingin item dipotong/difilter ulang.
- **Bukan scraper penuh**: halaman yang tidak punya daftar artikel (mis. halaman produk tunggal) akan menghasilkan feed kosong yang tetap valid.
- **Etika & hukum**: pakai untuk konten publik, hormati `robots.txt` dan syarat layanan situs. Jangan jadikan alat untuk membebani server orang lain.

---

## 7. Kalau ada masalah

| Gejala | Penyebab & solusi |
|---|---|
| `Error 1102` di Cloudflare | Batas CPU 10 ms terlampaui → deploy ke Vercel |
| `x-feed-items: 0` | Halaman tidak punya daftar artikel, atau strukturnya tidak dikenali. Coba `mode=html`, atau ubah `filter` |
| HTTP 405 / 429 dari situs sumber | Situs menolak permintaan server. Coba lagi nanti, atau pakai URL kategori/beranda lain |
| `fetch failed` / timeout | Situs lambat atau memblokir. Naikkan `ttl` agar hasil lama tetap terpakai |
| UI bilang "URL tidak valid" | Sertakan `https://`. Alamat tanpa skema otomatis dicoba dengan `https://` |
| Perubahan kode tidak muncul di lokal | Hentikan server (`Ctrl+C`) dan jalankan ulang — modul ESM di-cache |
| Port 8787 dipakai | `$env:PORT=9000; node src/server.js` |
| Ingin meniru Vercel di lokal | `node scripts/vercel-dev.mjs` → <http://localhost:8788> |

Cek cepat setelah deploy:

```powershell
curl.exe "https://BASE/feed?url=https://example.com" -I
curl.exe "https://BASE/healthz"
```

---

## 8. Struktur proyek

```
rss-anywhere/
├─ src/
│  ├─ html.js      parser HTML/XML tanpa dependensi, ekstraksi artikel
│  ├─ feed.js      jaringan, SSRF guard, deteksi feed, sitemap
│  ├─ render.js    RSS 2.0 + JSON Feed 1.1
│  ├─ core.js      router & pembentuk respons
│  ├─ worker.js    entry Cloudflare Workers
│  └─ server.js    server lokal (Node 18+)
├─ api/            fungsi serverless Vercel
├─ public/         UI (index.html, app.js, style.css)
├─ scripts/        tes, benchmark, simulator Vercel
├─ wrangler.jsonc  konfigurasi Cloudflare
├─ vercel.json     konfigurasi Vercel
└─ package.json
```

## 9. Lisensi

Bebas dipakai dan diubah untuk keperluan pribadi maupun komersial.
