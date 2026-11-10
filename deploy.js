/**
 * FLYchat — Script Deploy Otomatis
 * Jalankan: node deploy.js
 *
 * Strategi:
 *  1. Push ke GitHub
 *  2. Deploy backend ke Render.com (gratis, always-on, via GitHub)
 *  3. Deploy frontend ke Vercel (via GitHub)
 *  4. Update config.js dengan URL backend
 */
'use strict';

const { execSync }  = require('child_process');
const fs            = require('fs');
const path          = require('path');
const readline      = require('readline');
const { execFile }  = require('child_process');

const ROOT    = __dirname;
const ENV     = readEnv();
const VERCEL  = path.join(ROOT, 'node_modules', 'vercel', 'dist', 'index.js');

/* ── utils ── */
const log  = m => console.log(`\n  ${m}`);
const ok   = m => console.log(`  ✅ ${m}`);
const warn = m => console.log(`  ⚠️  ${m}`);
const info = m => console.log(`  ℹ️  ${m}`);
const hr   = () => console.log('\n' + '─'.repeat(52));

function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: ROOT, encoding: 'utf8',
    stdio: opts.silent ? 'pipe' : 'inherit'
  })?.trim() || '';
}
function runSilent(cmd) {
  try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })?.trim() || ''; }
  catch { return ''; }
}
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
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(`\n  ${q}: `, a => { rl.close(); r(a.trim()); }));
}
function openBrowser(url) {
  try { execSync(`start "" "${url}"`, { stdio: 'ignore' }); } catch {}
}
function writeConfig(apiUrl) {
  const content = `/**
 * FLYchat Runtime Config — AUTO GENERATED
 * Backend: ${apiUrl || 'localhost (dev)'}
 */
window.__FLYCHAT_API__ = '${apiUrl || ''}';
`;
  fs.writeFileSync(path.join(ROOT, 'public', 'config.js'), content);
}

/* ════════════════════════════════════════
   MAIN
════════════════════════════════════════ */
(async () => {
  console.clear();
  console.log('');
  console.log('  🦋  FLYchat — Deploy ke Internet');
  console.log('  ' + '─'.repeat(50));

  /* ── 0. Cek git ── */
  if (!runSilent('git --version')) {
    warn('Git tidak ditemukan. Install dari: https://git-scm.com');
    process.exit(1);
  }

  /* ══════════════════════════════════════
     STEP 1 — GitHub
  ══════════════════════════════════════ */
  hr();
  log('STEP 1 — Push kode ke GitHub\n');

  let remote = runSilent('git remote get-url origin');

  if (!remote) {
    info('Belum ada remote GitHub.');
    info('Membuka GitHub untuk buat repo baru...');
    openBrowser('https://github.com/new');
    console.log('');
    console.log('  Di GitHub:');
    console.log('  • Repository name: flychat');
    console.log('  • Visibility: Public');
    console.log('  • JANGAN centang "Initialize with README"');
    console.log('  • Klik Create repository');
    console.log('');
    remote = await ask('Paste URL repo GitHub kamu\n  (contoh: https://github.com/username/flychat.git)');
    if (!remote.includes('github.com')) { warn('URL tidak valid'); process.exit(1); }
    run(`git remote add origin ${remote}`);
    ok('Remote GitHub ditambahkan');
  } else {
    ok(`GitHub remote: ${remote}`);
  }

  // Push
  info('Push kode ke GitHub...');
  const branch = runSilent('git rev-parse --abbrev-ref HEAD') || 'master';
  try {
    run(`git push -u origin ${branch}`);
    ok('Push berhasil!');
  } catch {
    warn('Push gagal. Pastikan sudah login GitHub.');
    info('Kalau minta password, gunakan Personal Access Token dari:');
    info('https://github.com/settings/tokens/new (centang scope: repo)');
    openBrowser('https://github.com/settings/tokens/new?scopes=repo&description=flychat-deploy');
    const retry = await ask('Sudah buat token? Tekan Enter untuk retry push, atau ketik "skip" untuk lanjut');
    if (retry !== 'skip') {
      try { run(`git push -u origin ${branch}`); ok('Push berhasil!'); }
      catch { warn('Push masih gagal — lanjut tanpa push'); }
    }
  }

  /* ══════════════════════════════════════
     STEP 2 — Deploy Backend ke Render
  ══════════════════════════════════════ */
  hr();
  log('STEP 2 — Deploy Backend ke Render.com (gratis, always-on)\n');

  info('Membuka Render.com...');
  openBrowser('https://dashboard.render.com/new/web');

  console.log('');
  console.log('  Di Render.com:');
  console.log('  1. Login/daftar dengan GitHub');
  console.log('  2. Klik "New Web Service"');
  console.log('  3. Connect repo: flychat');
  console.log('  4. Settings (ISI PERSIS SEPERTI INI):');
  console.log('');
  console.log('     Name        : flychat-api');
  console.log('     Region      : Singapore (asia)');
  console.log('     Branch      : ' + branch);
  console.log('     Runtime     : Node');
  console.log('     Build Cmd   : npm install');
  console.log('     Start Cmd   : node server/index.js');
  console.log('     Plan        : Free');
  console.log('');
  console.log('  5. Klik "Advanced" → tambah Environment Variables:');
  console.log('');
  console.log(`     DATABASE_URL     = ${ENV.DATABASE_URL}`);
  console.log(`     JWT_SECRET       = ${ENV.JWT_SECRET}`);
  console.log('     PORT             = 3000');
  console.log('     NODE_ENV         = production');
  console.log('     UPLOAD_DIR       = uploads');
  console.log('     MAX_FILE_SIZE_MB = 50');
  console.log('');
  console.log('  6. Klik "Create Web Service"');
  console.log('  7. Tunggu deploy (~2-3 menit) → status "Live"');
  console.log('  8. Salin URL dari dashboard (contoh: https://flychat-api.onrender.com)');
  console.log('');

  const renderUrl = await ask(
    'Paste URL Render.com kamu setelah deploy selesai\n  (contoh: https://flychat-api.onrender.com)\n  Atau ketik "skip" untuk lanjut dulu'
  );

  let backendUrl = '';
  if (renderUrl && renderUrl !== 'skip' && renderUrl.startsWith('https://')) {
    backendUrl = renderUrl.replace(/\/$/, '');
    ok(`Backend URL: ${backendUrl}`);

    // Update config.js
    writeConfig(backendUrl);
    ok('config.js diupdate dengan backend URL');

    // Commit
    run('git add public/config.js');
    runSilent(`git commit -m "chore: set backend URL to ${backendUrl}"`);
    runSilent(`git push origin ${branch}`);
    ok('config.js di-commit dan di-push');
  } else {
    warn('Backend URL dilewati. Kamu bisa update manual nanti di public/config.js');
  }

  /* ══════════════════════════════════════
     STEP 3 — Deploy Frontend ke Vercel
  ══════════════════════════════════════ */
  hr();
  log('STEP 3 — Deploy Frontend ke Vercel\n');

  if (!fs.existsSync(VERCEL)) {
    warn(`Vercel CLI tidak ditemukan di: ${VERCEL}`);
    info('Membuka Vercel web...');
    openBrowser('https://vercel.com/new');
    console.log('');
    console.log('  Di Vercel:');
    console.log('  1. Login dengan GitHub');
    console.log('  2. Import repo: flychat');
    console.log('  3. Settings:');
    console.log('     - Framework Preset : Other');
    console.log('     - Root Directory   : . (default)');
    console.log('     - Output Directory : public');
    console.log('     - Build Command    : (kosongkan)');
    console.log('     - Install Command  : (kosongkan)');
    console.log('  4. Klik Deploy');
  } else {
    info('Deploy ke Vercel via CLI...');
    try {
      run(`node "${VERCEL}" login`);
      run(`node "${VERCEL}" --prod --yes`);
      ok('Deploy Vercel berhasil!');
    } catch (e) {
      warn('Vercel CLI gagal: ' + e.message);
      info('Membuka Vercel web sebagai alternatif...');
      openBrowser('https://vercel.com/new');
    }
  }

  const vercelUrl = await ask(
    'Paste URL Vercel kamu setelah deploy\n  (contoh: https://flychat.vercel.app)\n  Atau Enter untuk skip'
  );

  /* ══════════════════════════════════════
     STEP 4 — Sambungkan Vercel ↔ Render
  ══════════════════════════════════════ */
  if (vercelUrl && vercelUrl.startsWith('https://') && backendUrl) {
    hr();
    log('STEP 4 — Sambungkan Vercel dengan Render\n');

    info('Tambahkan FRONTEND_URL di Render:');
    openBrowser('https://dashboard.render.com');
    console.log('');
    console.log('  Di Render dashboard:');
    console.log('  1. Pilih service: flychat-api');
    console.log('  2. Tab: Environment');
    console.log('  3. Add Variable:');
    console.log(`     FRONTEND_URL = ${vercelUrl}`);
    console.log('  4. Save Changes → Render otomatis redeploy');
    console.log('');
    await ask('Tekan Enter setelah menambahkan FRONTEND_URL di Render');
    ok('CORS dikonfigurasi untuk Vercel domain');
  }

  /* ══════════════════════════════════════
     RINGKASAN
  ══════════════════════════════════════ */
  hr();
  console.log('\n  🦋 Deploy Selesai!\n');

  if (backendUrl) console.log(`  🔗 Backend (Render): ${backendUrl}`);
  if (vercelUrl)  console.log(`  🌐 Frontend (Vercel): ${vercelUrl}`);
  if (!backendUrl && !vercelUrl) {
    console.log('  Belum ada URL yang diset.');
    console.log('  Jalankan lagi: node deploy.js');
  }

  console.log('');
  if (vercelUrl) {
    console.log(`  Buka sekarang: ${vercelUrl}`);
  } else {
    console.log('  Setelah deploy, buka URL Vercel kamu di browser.');
  }
  console.log('');

})().catch(e => {
  console.error('\n  ❌ Error:', e.message);
  process.exit(1);
});
