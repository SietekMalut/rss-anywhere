# Membuat shortcut desktop untuk RSS Anywhere + ikon khusus (.ico)
# Jalankan sekali: powershell -ExecutionPolicy Bypass -File make-shortcut.ps1

Add-Type -AssemblyName System.Drawing

$siteUrl   = 'https://sietekmalut.github.io/rss-anywhere/'
$desktop   = [Environment]::GetFolderPath('Desktop')
$iconDir   = Join-Path $env:LOCALAPPDATA 'RSS Anywhere'
$iconPath  = Join-Path $iconDir 'rss-anywhere-v2.ico'
$pngPath   = Join-Path $iconDir 'rss-anywhere-256.png'
$lnkPath   = Join-Path $desktop 'RSS Anywhere.lnk'

New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

# ---------- 1. Gambar ikon 256x256 ----------
$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# latar kotak membulat gelap
$radius = 56
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()
$bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 8, 11, 16))
$g.FillPath($bg, $path)

# cincin luar tipis
$edge = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(90, 255, 122, 24), 3)
$g.DrawPath($edge, $path)

# simbol RSS: titik + dua busur, dipusatkan dalam kotak 150x150 di tengah kanvas
$orange = [System.Drawing.Color]::FromArgb(255, 255, 122, 24)
$cx = 75; $cy = 181; $dotR = 22; $bigR = 128; $midR = 64
$stroke = 26

$dot = New-Object System.Drawing.SolidBrush($orange)
$g.FillEllipse($dot, $cx - $dotR, $cy - $dotR, $dotR * 2, $dotR * 2)

foreach ($row in @(@($bigR, $stroke), @($midR, [int]($stroke * 0.86)))) {
  $r = $row[0]; $w = $row[1]
  $pen = New-Object System.Drawing.Pen($orange, $w)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($pen, $cx - $r, $cy - $r, $r * 2, $r * 2, 270, 90)
  $pen.Dispose()
}

$g.Dispose()
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# ---------- 2. Bungkus PNG menjadi .ico ----------
$png = [System.IO.File]::ReadAllBytes($pngPath)
$fs = [System.IO.File]::Create($iconPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)          # reserved
$bw.Write([UInt16]1)          # type = icon
$bw.Write([UInt16]1)          # jumlah gambar
$bw.Write([Byte]0)            # lebar 256
$bw.Write([Byte]0)            # tinggi 256
$bw.Write([Byte]0)            # warna palet
$bw.Write([Byte]0)            # reserved
$bw.Write([UInt16]1)          # planes
$bw.Write([UInt16]32)         # bit depth
$bw.Write([UInt32]$png.Length)# ukuran data
$bw.Write([UInt32]22)         # offset data
$bw.Write($png)
$bw.Close(); $fs.Close()

# ---------- 3. Buat shortcut ----------
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $siteUrl
$lnk.IconLocation = "$iconPath,0"
$lnk.Description = 'RSS Anywhere - ubah website apa pun jadi link feed RSS publik'
$lnk.WorkingDirectory = $desktop
$lnk.Save()

if (Test-Path $lnkPath) {
  "OK  $lnkPath"
  "    target : " + $shell.CreateShortcut($lnkPath).TargetPath
  "    ikon   : $iconPath"
} else {
  "GAGAL membuat shortcut"
}
