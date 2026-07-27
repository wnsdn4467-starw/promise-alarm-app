$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://192.168.35.162:8080/")
$listener.Prefixes.Add("http://127.0.0.1:8080/")
try {
    $listener.Start()
    Write-Host "Server started successfully on http://192.168.35.162:8080/"
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response
        
        $relPath = $req.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($relPath)) { $relPath = "index.html" }
        
        $filePath = Join-Path "C:\Users\A\.gemini\antigravity\scratch\promise-alarm-app" $relPath
        
        if (Test-Path $filePath -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $res.ContentLength64 = $bytes.Length
            
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            switch ($ext) {
                ".html" { $res.ContentType = "text/html; charset=utf-8" }
                ".css"  { $res.ContentType = "text/css; charset=utf-8" }
                ".js"   { $res.ContentType = "application/javascript; charset=utf-8" }
                ".json" { $res.ContentType = "application/json; charset=utf-8" }
                ".jpg"  { $res.ContentType = "image/jpeg" }
                ".png"  { $res.ContentType = "image/png" }
                Default { $res.ContentType = "application/octet-stream" }
            }
            
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
        }
        $res.Close()
    }
} catch {
    Write-Host "Server Exception: $_"
}
