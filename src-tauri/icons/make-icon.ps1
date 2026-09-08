# Reproducible Neattttty icon renderer.
# Caveat "N" (OFL, render-use only) on frappe-green rounded tile.
# Two-pass: draft render -> scan true ink bbox -> redraw optically centered.
# Run from the Neattttty project root. Then run build-ico.ps1 for icon.ico.
param([string]$ProjectDir = (Get-Location).Path)
Add-Type -AssemblyName System.Drawing
$pfc = New-Object System.Drawing.Text.PrivateFontCollection
$pfc.AddFontFile("C:\Users\spp_l\AppData\Local\Temp\opencode\Caveat.ttf")
$fam = $pfc.Families[0]
$iconsDir = Join-Path $ProjectDir "src-tauri\icons"

function Draw-Glyph($g, $font, $ink, $rect, $fmt, [bool]$fauxBold) {
  if ($fauxBold) {
    foreach ($o in @(@(0, 0), @(0.5, 0), @(-0.5, 0), @(0, 0.5), @(0, -0.5))) {
      $d = New-Object System.Drawing.RectangleF(($rect.X + $o[0]), ($rect.Y + $o[1]), $rect.Width, $rect.Height)
      $g.DrawString("N", $font, $ink, $d, $fmt)
    }
  } else {
    $g.DrawString("N", $font, $ink, $rect, $fmt)
  }
}

function New-IconTile([int]$size) {
  # Tiered rendering: tiny sizes get bigger, faux-bold, grid-fitted glyphs
  # (crisp taskbar art); large sizes keep the elegant single draw.
  $frac = 0.58; $fauxBold = $false; $gridFit = $false
  if ($size -le 32) { $frac = 0.72; $fauxBold = $true; $gridFit = $true }
  elseif ($size -lt 128) { $frac = 0.68; $fauxBold = $true }
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  if ($gridFit) { $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit }
  else { $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit }
  $green = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml("#A6D189"))
  $ink = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml("#11111B"))
  $r = [Math]::Max(2, [int]($size * 0.24))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
  $path.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
  $path.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $font = New-Object System.Drawing.Font($fam, [float]($size * $frac), [System.Drawing.FontStyle]::Bold)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  # Pass 1: draft, centered by layout box.
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillPath($green, $path)
  $layout = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  Draw-Glyph $g $font $ink $layout $fmt $fauxBold
  # Scan true ink bbox (dark pixels = the glyph incl. antialiased fringe).
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $n = $data.Stride * $data.Height
  $px = New-Object byte[] $n
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $n)
  $bmp.UnlockBits($data)
  # Scan true ink bbox: dark AND opaque (excludes tile green and soft fringe).
  $minX = $size; $minY = $size; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
      $o = $y * $data.Stride + $x * 4
      if ((($px[$o] + $px[$o + 1] + $px[$o + 2]) -lt 300) -and ($px[$o + 3] -gt 200)) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  # Pass 2: shift so the ink bbox is exactly centered, then redraw.
  $dx = ($size / 2) - (($minX + $maxX + 1) / 2)
  $dy = ($size / 2) - (($minY + $maxY + 1) / 2)
  if ($size -eq 512) { Write-Host ("ink x={0}..{1} y={2}..{3} shift dx={4:0.0} dy={5:0.0}" -f $minX, $maxX, $minY, $maxY, $dx, $dy) }
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillPath($green, $path)
  $dest = New-Object System.Drawing.RectangleF($dx, $dy, $size, $size)
  Draw-Glyph $g $font $ink $dest $fmt $fauxBold
  $font.Dispose(); $green.Dispose(); $ink.Dispose(); $path.Dispose(); $g.Dispose()
  return $bmp
}

foreach ($s in @(512, 256, 128, 64, 48, 32, 24, 16)) {
  $b = New-IconTile $s
  if ($s -eq 512) { $b.Save((Join-Path $iconsDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png) }
  elseif ($s -eq 128) { $b.Save((Join-Path $iconsDir "128x128.png"), [System.Drawing.Imaging.ImageFormat]::Png) }
  elseif ($s -eq 32) { $b.Save((Join-Path $iconsDir "32x32.png"), [System.Drawing.Imaging.ImageFormat]::Png) }
  $sizesDir = Join-Path $iconsDir "sizes"
  if (-not (Test-Path -LiteralPath $sizesDir)) { New-Item -ItemType Directory -Path $sizesDir | Out-Null }
  $b.Save((Join-Path $sizesDir ("icon-{0}.png" -f $s)), [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
}

# Check strip: native 16/24/32/48 renders on magenta (transparency proof).
$strip = New-Object System.Drawing.Bitmap(208, 64)
$sg = [System.Drawing.Graphics]::FromImage($strip)
$sg.Clear([System.Drawing.Color]::Magenta)
$x = 8
foreach ($s in @(16, 24, 32, 48)) {
  $t = New-IconTile $s
  $sg.DrawImage($t, $x, [int]((64 - $s) / 2), $s, $s)
  $t.Dispose()
  $x += $s + 12
}
$sg.Dispose()
$strip.Save("C:\Users\spp_l\AppData\Local\Temp\opencode\icon-sizes-check.png", [System.Drawing.Imaging.ImageFormat]::Png)
$strip.Dispose()
$pfc.Dispose()
Write-Host "icon PNGs + size check strip done"
