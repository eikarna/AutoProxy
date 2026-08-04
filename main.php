<?php
header("Content-Type: application/x-ns-proxy-autoconfig");

// 1. Ambil data proxy teks langsung dari salah satu source GitHub di JSON Anda
// Contoh mengambil dari TheSpeedX HTTP List (ID nomor 2 di JSON Anda)
$githubUrl = "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt";
$proxyRaw = @file_get_contents($githubUrl);

$proxyString = "";

if ($proxyRaw) {
    // Pisahkan isi teks per baris
    $lines = explode("\n", $proxyRaw);

    // Ambil 5 hingga 10 proxy teratas agar file PAC tidak terlalu berat
    $maxProxies = 5;
    $count = 0;

    foreach ($lines as $line) {
        $line = trim($line);
        if (!empty($line) && $count < $maxProxies) {
            // Format di dalam txt adalah IP:PORT, ubah ke format PAC (PROXY IP:PORT;)
            $proxyString .= "PROXY " . $line . "; ";
            $count++;
        }
    }
}

// Tambahkan fallback jika semua proxy gagal, traffic otomatis DIRECT
$proxyString .= "DIRECT";

// 2. Cetak fungsi PAC JavaScript
?>
function FindProxyForURL(url, host) {
    if (isPlainHostName(host) || shExpMatch(host, "localhost")) {
        return "DIRECT";
    }
    return "<?php echo $proxyString; ?>";
}
