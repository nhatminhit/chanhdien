// Mirror a public page and every file it references.
//   node tools/scrape.mjs --url URL --out DIR --max 300
// Fetches only the start host and cdn.jsdelivr.net. Writes manifest.json with status + sha256 per URL.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
const opt = { url: '', out: 'scraped', max: 300 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url') opt.url = argv[++i];
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--max') opt.max = +argv[++i];
}

const START = opt.url ? new URL(opt.url) : (console.error('usage: node tools/scrape.mjs --url URL [--out DIR] [--max N]'), process.exit(2));
const OUT = path.resolve(opt.out);
const ALLOWED = new Set([START.host, 'cdn.jsdelivr.net']);
const TIMEOUT = 20000;
const CONCURRENCY = 6;

const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function targetFile(u) {
  const url = new URL(u);
  let p = decodeURIComponent(url.pathname || '/');
  if (p.endsWith('/')) p += 'index.html';
  const segs = p.split('/').filter(Boolean).map(s => s === '..' ? '_' : s);
  if (url.search) {
    const h = sha(url.search).slice(0, 6);
    segs[segs.length - 1] = (segs[segs.length - 1] || 'index') + '__' + h;
  }
  const file = path.join(OUT, url.host.replace(/[^\w.-]/g, '_'), ...segs);
  return file.startsWith(OUT + path.sep) ? file : null;
}

function extractRefs(text, pageUrl) {
  const refs = new Set();
  let base = new URL(pageUrl);
  const baseM = text.match(/<base[^>]+href\s*=\s*["']([^"']+)["']/i);
  if (baseM) { try { base = new URL(baseM[1], pageUrl); } catch {} }
  const add = r => {
    if (!r) return;
    r = r.trim();
    if (!r || /^(data:|mailto:|javascript:|tel:|blob:|about:|#)/i.test(r)) return;
    try {
      const u = new URL(r, base);
      if (!ALLOWED.has(u.host)) return;
      u.hash = '';
      refs.add(u.href);
    } catch {}
  };
  for (const m of text.matchAll(/<(?:script|img|link|source|audio|video|iframe)[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of text.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(',')) add(part.trim().split(/\s+/)[0]);
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi)) add(m[1]);
  for (const m of text.matchAll(/["'](\/assets\/[^"'\s]+)["']/gi)) add(m[1]);
  for (const m of text.matchAll(/["'](assets\/[^"'\s]+\.(?:png|jpe?g|webp|gif|svg|ico|mp3|mp4|webm|json|css|js))["']/gi)) add(m[1]);
  for (const m of text.matchAll(/["'](https?:\/\/cdn\.jsdelivr\.net\/[^"'\s]+)["']/gi)) add(m[1]);
  return refs;
}

async function fetchOne(u) {
  try {
    const res = await fetch(u, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; mirror/1.0)' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    const file = targetFile(u);
    const rec = {
      url: u,
      final: res.url !== u ? res.url : undefined,
      status: res.status,
      type,
      bytes: buf.length,
      sha256: sha(buf),
      file: null,
    };
    let refs = null;
    if (res.ok && file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      rec.file = path.relative(process.cwd(), file);
    }
    if (res.ok && /html|css|javascript|json|xml/.test(type)) {
      refs = extractRefs(buf.toString('utf8'), res.url || u);
    }
    const tag = res.ok ? 'OK  ' : String(res.status).padEnd(4);
    console.log(`${tag} ${String(buf.length).padStart(9)}  ${type.split(';')[0].padEnd(24)} ${u}`);
    return { rec, refs };
  } catch (e) {
    const rec = { url: u, status: 0, error: String(e?.message || e), bytes: 0 };
    console.log(`ERR  ${String(0).padStart(9)}  ${'network'.padEnd(24)} ${u}  (${rec.error})`);
    return { rec, refs: null };
  }
}

const seen = new Set([START.href]);
const queue = [START.href];
const manifest = [];

while (queue.length && manifest.length < opt.max) {
  const batch = queue.splice(0, CONCURRENCY);
  const results = await Promise.all(batch.map(fetchOne));
  for (const { rec, refs } of results) {
    if (!rec) continue;
    manifest.push(rec);
    if (refs) for (const r of refs) if (!seen.has(r)) { seen.add(r); queue.push(r); }
  }
}

fs.mkdirSync(OUT, { recursive: true });
const manifestPath = path.join(OUT, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify({ start: START.href, fetchedAt: new Date().toISOString(), entries: manifest }, null, 2));

const ok = manifest.filter(r => r.status >= 200 && r.status < 300);
const bad = manifest.filter(r => !(r.status >= 200 && r.status < 300));
const totalBytes = ok.reduce((n, r) => n + r.bytes, 0);
console.log('');
console.log(`Saved   ${ok.length} file(s), ${(totalBytes / 1048576).toFixed(2)} MB → ${path.relative(process.cwd(), OUT)}\\`);
console.log(`Failed  ${bad.length} URL(s)`);
for (const r of bad.slice(0, 40)) console.log(`  ${String(r.status || 'ERR').padEnd(4)} ${r.url}${r.error ? '  (' + r.error + ')' : ''}`);
console.log(`Manifest ${path.relative(process.cwd(), manifestPath)}`);