/**
 * FLYchat — Setup Render.com
 * node setup-render.js
 *
 * Membuka semua halaman yang dibutuhkan dan
 * mengupdate config.js setelah dapat URL backend.
 */
'use strict';
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const readline     = require('readline');

const ROOT = __dirname;
const ENV  = readEnv();

function readEnv() {
  const env = {};
  try {
    fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').forEach(l => {
      const m = l.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) env[m[1].trim()] = m[2].trim();
    });
  } catch {}
  return env;
}

function open(url) {
  try { execSync(`start "" "${url}"`, { stdio: 'ignore' }); } catch {}
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

(async () => {
  console.log('\n🦋  FLYchat — Setup Backend di Render.com\n');
  console.log('══════════════════════════════════════════════\n');

  /* ── Buka Render dashboard ── */
  console.log('📂 Membuka Render.com...\n');
  open('https://dashboard.render.com/new/web');

  console.log('Ikuti langkah berikut di browser:\n');
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  1. Login dengan GitHub                     │');
  console.log('│  2. Klik "New Web Service"                  │');
  console.log('│  3. Connect GitHub → pilih FLYchat-web      │');
  console.log('│  4. Isi settings:                           │');
  console.log('│     Name     : flychat-api                  │');
  console.log('│     Region   : Singapore                    │');
  console.log('│     Branch   : master                       │');
  console.log('│     Runtime  : Node                         │');
  console.log('│     Build    : npm install                  │');
  console.log('│     Start    : node server/index.js         │');
  console.log('│     Plan     : Free                         │');
  console.log('└─────────────────────────────────────────────┘\n');

  console.log('  Klik "Advanced" lalu tambah Environment Variables:\n');
  console.log('  ┌──────────────────┬──────────────────────────────────────────────────────┐');
  console.log(`  │ DATABASE_URL      │ ${ENV.DATABASE_URL?.slice(0,52)}... │`);
  console.log(`  │ JWT_SECRET        │ ${ENV.JWT_SECRET}  │`);
  console.log('  │ PORT             │ 3000                                                 │');
  console.log('  │ NODE_ENV         │ production                                           │');
  console.log('  │ UPLOAD_DIR       │ uploads                                              │');
  console.log('  │ MAX_FILE_SIZE_MB │ 50                                                   │');
  console.log('  └──────────────────┴──────────────────────────────────────────────────────┘\n');

  /* Buka halaman copy env vars lebih mudah */
  console.log('💡 Tip: Kamu bisa copy nilai env vars dari file .env di Kiro.\n');
  console.log('  Klik "Create Web Service" → tunggu ~3 menit → status "Live"\n');

  const url = await ask('  Paste URL Render kamu di sini (contoh: https://flychat-api.onrender.com)\n  > ');

  if (!url || !url.startsWith('https://')) {
    console.log('\n❌ URL tidak valid. Jalankan ulang: node setup-render.js\n');
    process.exit(1);
  }

  const backendUrl = url.replace(/\/$/, '');
  console.log(`\n✅ Backend URL: ${backendUrl}\n`);

  /* ── Update config.js ── */
  const configPath = path.join(ROOT, 'public', 'config.js');
  fs.writeFileSync(configPath, `// FLYchat Runtime Config — AUTO GENERATED\nwindow.__FLYCHAT_API__ = '${backendUrl}';\n`);
  console.log('✅ public/config.js diupdate\n');

  /* ── Commit & push ── */
  try {
    execSync('git add public/config.js', { cwd: ROOT, stdio: 'pipe' });
    execSync(`git commit -m "config: set backend ${backendUrl}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin master', { cwd: ROOT, stdio: 'inherit' });
    console.log('✅ config.js di-push ke GitHub\n');
  } catch (e) {
    console.log('⚠️  Push gagal — update config.js sudah disimpan lokal\n');
  }

  /* ── Buka Vercel untuk redeploy ── */
  console.log('📂 Membuka Vercel untuk redeploy frontend...\n');
  open('https://vercel.com/dashboard');
  console.log('  Di Vercel: pilih project FLYchat → Deployments → Redeploy\n');
  console.log('  Atau buka: https://vercel.com/new untuk deploy baru\n');

  /* ── Test backend ── */
  console.log('🔍 Test koneksi ke backend...\n');
  try {
    const https  = require('https');
    const result = await new Promise((res, rej) => {
      https.get(`${backendUrl}/api/health`, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => res({ status: r.statusCode, body: d }));
      }).on('error', rej);
    });
    if (result.status === 200) {
      console.log(`  ✅ Backend aktif: ${backendUrl}/api/health\n`);
    } else {
      console.log(`  ⚠️  Status ${result.status} — backend mungkin masih deploy\n`);
    }
  } catch {
    console.log('  ⏳ Backend belum aktif — tunggu ~3 menit lagi\n');
  }

  console.log('══════════════════════════════════════════════');
  console.log('🦋  Selesai!\n');
  console.log(`   Backend : ${backendUrl}`);
  console.log('   Frontend: buka URL Vercel kamu\n');
  console.log('   Login dengan akun yang sudah didaftarkan sebelumnya.\n');

})().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
