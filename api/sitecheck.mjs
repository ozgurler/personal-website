// Website & AI visibility check — Vercel serverless function
// Called by /website-check.html. Companion to api/assess.mjs; self-contained on purpose.
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY      required
//   PSI_API_KEY            recommended — Google PageSpeed Insights key (free); without it the performance
//                          section is skipped because Google rate-limits keyless calls
//   TURNSTILE_SECRET_KEY   optional
//   LEAD_ENDPOINT          optional — Formspree endpoint; defaults to the contact form
//   ASSESS_MODEL           optional — defaults to claude-sonnet-5

export const maxDuration = 60;

const MODEL = process.env.ASSESS_MODEL || 'claude-sonnet-5';
const API = 'https://api.anthropic.com/v1/messages';
const LEAD_ENDPOINT = process.env.LEAD_ENDPOINT || 'https://formspree.io/f/xbdnrkwd';
const HEADERS = () => ({ 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' });

// ---------- rate limit (best-effort, per instance) ----------
const WINDOW_MS = 60 * 60 * 1000, MAX_PER_WINDOW = 4, hits = new Map();
function limited(ip) {
  const now = Date.now(), rec = hits.get(ip) || { count: 0, start: now };
  if (now - rec.start > WINDOW_MS) { rec.count = 0; rec.start = now; }
  rec.count += 1; hits.set(ip, rec);
  return rec.count > MAX_PER_WINDOW;
}
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }) });
  return !!(await r.json().catch(() => ({}))).success;
}

// ---------- URL + fetch helpers ----------
function normalizeUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim(); if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || /^(\d+\.){3}\d+$/.test(h) || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return null;
  u.hash = ''; return u;
}
async function fetchText(url, ms = 7000, max = 500_000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; emreozgurler-site-check/1.0)' } });
    return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, max), url: r.url };
  } catch { return { ok: false, status: 0, text: '', url }; }
  finally { clearTimeout(t); }
}
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const attr = (tag, name) => (tag.match(new RegExp(name + `=["']([^"']*)["']`, 'i')) || [])[1] || '';

// ---------- technical SEO + crawlability ----------
const AI_BOTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot', 'anthropic-ai'];
function robotsBlocks(txt) {
  const blocked = [];
  for (const block of txt.split(/\n(?=user-agent:)/i)) {
    const agents = [...block.matchAll(/user-agent:\s*([^\n]+)/gi)].map(m => m[1].trim().toLowerCase());
    const all = /disallow:\s*\/\s*$/im.test(block);
    for (const b of AI_BOTS) if (agents.includes(b.toLowerCase()) && all) blocked.push(b);
    if (agents.includes('*') && all) blocked.push('* (everyone)');
  }
  return [...new Set(blocked)];
}

async function technical(u) {
  const o = u.origin;
  const [home, robots, llms, sitemap] = await Promise.all([fetchText(u.href), fetchText(o + '/robots.txt', 4000, 50_000), fetchText(o + '/llms.txt', 4000, 50_000), fetchText(o + '/sitemap.xml', 4000, 30_000)]);
  const html = home.ok ? home.text : '', text = strip(html), words = text ? text.split(' ').length : 0;
  const head = html.slice(0, 60_000);
  const F = []; const add = (points, max, label, detail, group) => F.push({ points, max, label, detail, group });

  // Crawlability
  if (!home.ok) add(0, 15, 'Site reachable', `Homepage returned status ${home.status}.`, 'crawl');
  else if (words < 120) add(4, 15, 'Readable text', `Only ~${words} words of real text; most crawlers do not run JavaScript, so the page looks nearly empty to them.`, 'crawl');
  else add(15, 15, 'Readable text', `~${words} words of crawlable text on the homepage.`, 'crawl');
  if (!robots.ok) add(8, 10, 'robots.txt', 'None found. Crawlers default to allowed; you just have no control.', 'crawl');
  else { const b = robotsBlocks(robots.text); if (!b.length) add(10, 10, 'AI crawlers allowed', 'GPTBot, ClaudeBot, PerplexityBot and Google-Extended are not blocked.', 'crawl');
         else if (b.includes('* (everyone)')) add(0, 10, 'All crawlers blocked', 'robots.txt disallows everything.', 'crawl');
         else add(Math.max(0, 10 - b.length * 3), 10, 'Some AI crawlers blocked', `Blocked: ${b.join(', ')}.`, 'crawl'); }
  add(sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.text) ? 5 : 0, 5, 'Sitemap', sitemap.ok ? 'sitemap.xml found.' : 'No sitemap.xml.', 'crawl');
  add(u.protocol === 'https:' && (home.url || '').startsWith('https') ? 5 : 0, 5, 'HTTPS', 'Served over HTTPS.', 'crawl');

  // On-page SEO
  const title = (head.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
  const metaTags = head.match(/<meta[^>]+>/gi) || [];
  const desc = metaTags.map(t => (/name=["']description["']/i.test(t) ? attr(t, 'content') : '')).find(Boolean) || '';
  if (!title) add(0, 10, 'Title tag', 'No <title>. This is the headline in every search result.', 'onpage');
  else if (title.length < 20 || title.length > 70) add(6, 10, 'Title length', `Title is ${title.length} characters ("${title.slice(0, 60)}"). Aim for 30 to 60.`, 'onpage');
  else add(10, 10, 'Title tag', `"${title.slice(0, 60)}" (${title.length} chars).`, 'onpage');
  if (!desc) add(0, 8, 'Meta description', 'None. Search engines and assistants write their own, usually worse.', 'onpage');
  else if (desc.length < 70 || desc.length > 165) add(5, 8, 'Meta description length', `${desc.length} characters. Aim for 110 to 160.`, 'onpage');
  else add(8, 8, 'Meta description', `Present, ${desc.length} characters.`, 'onpage');
  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  add(h1s === 1 ? 6 : h1s === 0 ? 0 : 3, 6, 'H1 heading', h1s === 1 ? 'Exactly one H1.' : h1s === 0 ? 'No H1 on the homepage.' : `${h1s} H1s; use one per page.`, 'onpage');
  const canon = head.match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
  add(canon ? 5 : 0, 5, 'Canonical tag', canon ? 'Present.' : 'Missing. Duplicate URLs (www vs non-www, trailing slashes) split your ranking signal.', 'onpage');
  const ogTitle = metaTags.some(t => /property=["']og:title["']/i.test(t)), ogImg = metaTags.some(t => /property=["']og:image["']/i.test(t));
  add(ogTitle && ogImg ? 5 : ogTitle ? 3 : 0, 5, 'Social preview tags', ogTitle && ogImg ? 'Open Graph title and image present.' : ogTitle ? 'Open Graph title but no image; shares show a blank card.' : 'No Open Graph tags; links shared on LinkedIn or Slack render without a preview.', 'onpage');
  const viewport = metaTags.some(t => /name=["']viewport["']/i.test(t));
  add(viewport ? 4 : 0, 4, 'Mobile viewport', viewport ? 'Viewport meta present.' : 'No viewport meta; the page will not scale on phones.', 'onpage');
  const imgs = html.match(/<img[^>]*>/gi) || [];
  const noAlt = imgs.filter(t => !/\balt=["'][^"']+["']/i.test(t)).length;
  if (imgs.length === 0) add(4, 4, 'Image alt text', 'No images on the homepage to check.', 'onpage');
  else { const pct = Math.round(100 * (imgs.length - noAlt) / imgs.length); add(pct >= 90 ? 4 : pct >= 50 ? 2 : 0, 4, 'Image alt text', `${pct}% of ${imgs.length} images have alt text.`, 'onpage'); }
  const links = html.match(/<a[^>]+href=["'][^"']+["']/gi) || [];
  const internal = links.filter(t => { const h = attr(t, 'href').trim(); if (!h || h.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(h)) return false; if (/^https?:\/\//i.test(h)) return h.includes(u.hostname.replace(/^www\./, '')); return true; }).length;
  add(internal >= 8 ? 4 : internal >= 3 ? 2 : 0, 4, 'Internal links', `${internal} internal links on the homepage.`, 'onpage');

  // Structured data + AI readability
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const types = new Set();
  for (const b of ld) { try { const j = JSON.parse(b); const arr = Array.isArray(j) ? j : (j['@graph'] || [j]); for (const o of arr) { const t = o['@type']; (Array.isArray(t) ? t : [t]).forEach(x => x && types.add(String(x))); } } catch {} }
  const good = [...types].filter(t => ['Organization', 'LocalBusiness', 'ProfessionalService', 'FAQPage', 'Service', 'Product', 'Person', 'WebSite', 'Article'].some(g => t.includes(g)));
  add(good.length >= 2 ? 10 : good.length === 1 ? 6 : 0, 10, 'Structured data', good.length ? `Schema.org types: ${good.join(', ')}.` : 'No schema.org JSON-LD. Machines have to guess what the business is.', 'ai');
  add(llms.ok && /\S/.test(llms.text) && !/<html/i.test(llms.text) ? 5 : 0, 5, 'llms.txt', llms.ok ? 'Present.' : 'Missing. A plain-text map of the site that AI crawlers increasingly read.', 'ai');

  const total = F.reduce((a, f) => a + f.points, 0), max = F.reduce((a, f) => a + f.max, 0);
  return { findings: F, score: Math.round(100 * total / max), title, desc, excerpt: text.slice(0, 800) };
}

// ---------- PageSpeed Insights (mobile) ----------
async function pagespeed(u) {
  const key = process.env.PSI_API_KEY;
  if (!key) return { skipped: 'no API key configured' };
  const q = new URLSearchParams({ url: u.href, strategy: 'mobile', key });
  for (const c of ['performance', 'seo']) q.append('category', c);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 40_000);
  try {
    const r = await fetch('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + q, { signal: ctrl.signal });
    if (!r.ok) return { skipped: `PageSpeed returned ${r.status}` };
    const d = await r.json(); const lr = d.lighthouseResult || {}, cat = lr.categories || {}, a = lr.audits || {};
    const pct = (x) => x && x.score != null ? Math.round(x.score * 100) : null;
    const field = (d.loadingExperience || {}).metrics || {};
    return {
      performance: pct(cat.performance), seo: pct(cat.seo),
      lcp: a['largest-contentful-paint']?.displayValue || null, cls: a['cumulative-layout-shift']?.displayValue || null,
      tbt: a['total-blocking-time']?.displayValue || null, fcp: a['first-contentful-paint']?.displayValue || null,
      fieldOverall: (d.loadingExperience || {}).overall_category || null,
      fieldLcp: field.LARGEST_CONTENTFUL_PAINT_MS?.category || null, fieldInp: field.INTERACTION_TO_NEXT_PAINT?.category || null, fieldCls: field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category || null,
      opportunities: Object.values(a).filter(x => x.details?.type === 'opportunity' && x.score != null && x.score < 0.9 && x.details?.overallSavingsMs > 150)
        .sort((x, y) => (y.details.overallSavingsMs || 0) - (x.details.overallSavingsMs || 0)).slice(0, 3).map(x => `${x.title} (~${Math.round(x.details.overallSavingsMs / 100) / 10}s)`),
    };
  } catch (e) { return { skipped: 'PageSpeed timed out' }; }
  finally { clearTimeout(t); }
}

// ---------- GEO / AI visibility probe ----------
async function geoProbe(business, u, city) {
  const name = business || u.hostname.replace(/^www\./, '');
  const r = await fetch(API, { method: 'POST', headers: HEADERS(), body: JSON.stringify({
    model: MODEL, max_tokens: 700, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    system: 'You are measuring how visible a business is to AI assistants. Search for it by name (and city if given), then once more with the name plus "reviews OR reddit OR linkedin". Answer ONLY with compact JSON: {"found": bool, "site_found": bool, "summary": "one sentence on what the web says it does, or empty", "platforms": ["list of these that mention the business: own site, Google Business, LinkedIn, Reddit, YouTube, Wikipedia, review sites, news, directories"], "competitors_named": ["up to 3 competitor names that appeared instead of or alongside it, or empty"]}. No prose outside the JSON.',
    messages: [{ role: 'user', content: `Business: "${name}"${city ? ' in ' + city : ''}. Website: ${u.hostname}. Search and report.` }] }) });
  if (!r.ok) return null;
  const d = await r.json(); const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = txt.match(/\{[\s\S]*\}/); if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
function geoScore(p) {
  if (!p) return null;
  let s = 0; if (p.found) s += 35; if (p.site_found) s += 25;
  const plats = (p.platforms || []).map(x => String(x).toLowerCase()).filter(x => !x.includes('own site'));
  s += Math.min(40, plats.length * 10);
  return Math.min(100, s);
}

// ---------- the written report ----------
const SYSTEM = `You are writing a short website and AI-visibility report for a small business owner who just ran a free check. The author voice is Emre Ozgurler: an engineer turned sales professional who builds websites and go-to-market systems for small businesses. Practical, direct, no hype, no jargon left unexplained.

Write plain prose. No headers, bullets, numbered lists, or bold. 230 to 300 words in four paragraphs:
1. The honest headline: what the three scores say together, in one or two sentences, and the one thing that is quietly costing them the most.
2. Fix number one, specifically: what to change, why it matters for search AND for AI assistants, and how they will know it worked.
3. Fix number two, same shape.
4. One sentence on what is already fine and should be left alone, then one sentence on the GEO result: what an assistant finds (or doesn't) when asked about them and which platform gap matters most.

Rules: only use facts from the data provided. Treat the probe's description as what the web currently says, not something to judge as wrong. No vendor or tool names. Do not mention Emre by name or pitch services. Vary sentence length. No em dashes. Address the reader as "you".`;

function prompt(a, tech, psi, geo, gScore) {
  const f = tech.findings.map(x => `[${x.group}] ${x.label} ${x.points}/${x.max}: ${x.detail}`).join('\n');
  const perf = psi.skipped ? `Performance: not measured (${psi.skipped}).` :
    `Performance (mobile): Lighthouse performance ${psi.performance}/100, Lighthouse SEO ${psi.seo}/100. LCP ${psi.lcp}, CLS ${psi.cls}, blocking time ${psi.tbt}. Real-user data: ${psi.fieldOverall || 'not enough traffic for field data'}. Top opportunities: ${psi.opportunities?.join('; ') || 'none significant'}.`;
  const g = geo ? `AI visibility probe: ${geo.found ? 'found' : 'NOT found'}; own site ${geo.site_found ? 'was' : 'was not'} among sources; web describes it as: "${geo.summary || ''}"; platforms mentioning it: ${(geo.platforms || []).join(', ') || 'none'}; competitors surfacing instead: ${(geo.competitors_named || []).join(', ') || 'none'}. AI visibility score ${gScore}/100.` : 'AI visibility probe: did not run.';
  return `Site: ${a.hostname}${a.business ? ` (business: ${a.business})` : ''}${a.city ? `, ${a.city}` : ''}
Technical SEO and crawlability score: ${tech.score}/100
Findings:
${f}
${perf}
${g}
Homepage title: "${tech.title}". Excerpt of page text: "${tech.excerpt.slice(0, 400)}"

Write the report.`;
}

// ---------- lead capture ----------
async function sendLead(a, report, tech, psi, geo, gScore) {
  const fields = {
    _subject: `Website check: ${a.business || a.hostname} (SEO ${tech.score}, perf ${psi.performance ?? 'n/a'}, AI ${gScore ?? 'n/a'})`,
    name: a.name, email: a.email, business: a.business || '', city: a.city || '', website: a.hostname,
    seo_score: `${tech.score}/100`, performance: psi.skipped ? psi.skipped : `${psi.performance}/100 perf, ${psi.seo}/100 SEO, LCP ${psi.lcp}, CLS ${psi.cls}`,
    ai_visibility: gScore == null ? 'probe did not run' : `${gScore}/100`,
    findings: tech.findings.map(x => `${x.points}/${x.max} ${x.label}: ${x.detail}`).join('\n'),
    geo_probe: geo ? JSON.stringify(geo) : '', report_sent: report,
  };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
  try { const r = await fetch(LEAD_ENDPOINT, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(fields) });
        if (!r.ok) console.error('lead', r.status); } catch (e) { console.error('lead', e.message); } finally { clearTimeout(t); }
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'Too many checks from this connection. Try again in an hour.' });
  let b = req.body; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } } b = b || {};
  if (b.website_hp) return res.status(200).json({ report: '' });
  if (!(await verifyTurnstile(b.turnstile_token, ip))) return res.status(400).json({ error: 'Verification failed. Reload and try again.' });
  const name = String(b.name || '').trim().slice(0, 100), email = String(b.email || '').trim().slice(0, 160);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please add your name and a valid email.' });
  const u = normalizeUrl(b.website);
  if (!u) return res.status(400).json({ error: 'Please enter a valid public website address.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server not configured.' });

  try {
    const a = { name, email, business: String(b.business || '').trim().slice(0, 120), city: String(b.city || '').trim().slice(0, 80), hostname: u.hostname.replace(/^www\./, '') };
    const [tech, psi, geo] = await Promise.all([technical(u), pagespeed(u), geoProbe(a.business, u, a.city).catch(() => null)]);
    const gScore = geoScore(geo);
    const r = await fetch(API, { method: 'POST', headers: HEADERS(), body: JSON.stringify({ model: MODEL, max_tokens: 1000, system: SYSTEM, messages: [{ role: 'user', content: prompt(a, tech, psi, geo, gScore) }] }) });
    if (!r.ok) { console.error('anthropic', r.status); return res.status(502).json({ error: 'The report service is unavailable right now.' }); }
    const d = await r.json(); const report = (d.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
    await sendLead(a, report, tech, psi, geo, gScore);
    res.status(200).json({ report, hostname: a.hostname, seo: { score: tech.score, findings: tech.findings }, performance: psi, ai: { score: gScore, probe: geo } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong running the check.' }); }
}
