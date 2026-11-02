// AI readiness check + AI discovery score — Vercel serverless function
// Called by /ai-readiness.html. Keeps the Claude API key server-side.
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY      required
//   TURNSTILE_SECRET_KEY   optional — verifies the Turnstile token if set
//   ASSESS_MODEL           optional — defaults to claude-sonnet-5
//   LEAD_ENDPOINT          optional — Formspree endpoint for lead capture; defaults to your contact form

export const maxDuration = 60; // the discovery probe does live fetches + a web search

const MODEL = process.env.ASSESS_MODEL || 'claude-sonnet-5';
const API = 'https://api.anthropic.com/v1/messages';
const LEAD_ENDPOINT = process.env.LEAD_ENDPOINT || 'https://formspree.io/f/xbdnrkwd';
const HEADERS = () => ({
  'Content-Type': 'application/json',
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01',
});

// ---------- rate limit (best-effort, per instance) ----------
const WINDOW_MS = 60 * 60 * 1000, MAX_PER_WINDOW = 5, hits = new Map();
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
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }),
  });
  return !!(await r.json().catch(() => ({}))).success;
}

// ---------- safe URL handling (no private networks) ----------
function normalizeUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || /^(\d+\.){3}\d+$/.test(h) || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return null;
  u.hash = ''; return u;
}

async function fetchText(url, ms = 6000, max = 400_000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; emreozgurler-readiness-check/1.0)' } });
    const text = (await r.text()).slice(0, max);
    return { ok: r.ok, status: r.status, text, url: r.url };
  } catch { return { ok: false, status: 0, text: '', url }; }
  finally { clearTimeout(t); }
}

// ---------- technical discovery checks ----------
const AI_BOTS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'anthropic-ai', 'OAI-SearchBot', 'Bytespider', 'CCBot'];

function robotsBlocks(robotsTxt) {
  const blocked = [];
  const blocks = robotsTxt.split(/\n(?=user-agent:)/i);
  for (const block of blocks) {
    const agents = [...block.matchAll(/user-agent:\s*([^\n]+)/gi)].map(m => m[1].trim().toLowerCase());
    const disallowAll = /disallow:\s*\/\s*$/im.test(block);
    for (const bot of AI_BOTS) if (agents.includes(bot.toLowerCase()) && disallowAll) blocked.push(bot);
    if (agents.includes('*') && disallowAll) blocked.push('* (everyone)');
  }
  return [...new Set(blocked)];
}

function stripTags(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
             .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function technicalChecks(u) {
  const origin = u.origin;
  const [home, robots, llms, sitemap] = await Promise.all([
    fetchText(u.href), fetchText(origin + '/robots.txt', 4000, 50_000),
    fetchText(origin + '/llms.txt', 4000, 50_000), fetchText(origin + '/sitemap.xml', 4000, 20_000),
  ]);

  const f = [];
  const add = (points, max, label, detail) => f.push({ points, max, label, detail });

  // 1. Reachable, real HTML text
  const html = home.ok ? home.text : '';
  const text = stripTags(html);
  const words = text ? text.split(' ').length : 0;
  if (!home.ok) add(0, 20, 'Site reachable', `Could not load the homepage (status ${home.status}). Nothing else can be checked until that works.`);
  else if (words < 120) add(6, 20, 'Readable page text', `The homepage serves only ~${words} words of actual text. Most AI crawlers do not run JavaScript, so a JS-rendered site looks nearly empty to them.`);
  else add(20, 20, 'Readable page text', `The homepage serves ~${words} words of real text that a crawler can read without running JavaScript.`);

  // 2. robots.txt
  if (!robots.ok) add(14, 20, 'robots.txt', 'No robots.txt found. Crawlers default to allowed, but you also have no say in who indexes what.');
  else {
    const blocked = robotsBlocks(robots.text);
    if (blocked.length === 0) add(20, 20, 'AI crawlers allowed', 'robots.txt does not block GPTBot, ClaudeBot, PerplexityBot, or Google-Extended.');
    else if (blocked.includes('* (everyone)')) add(0, 20, 'All crawlers blocked', 'robots.txt disallows everything for every bot. AI assistants cannot read the site at all.');
    else add(Math.max(0, 20 - blocked.length * 6), 20, 'Some AI crawlers blocked', `robots.txt blocks: ${blocked.join(', ')}. Those assistants will not read or cite this site.`);
  }

  // 3. Structured data
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const types = new Set();
  for (const block of ld) { try { const j = JSON.parse(block); const arr = Array.isArray(j) ? j : [j]; for (const o of arr) { const t = o['@type']; (Array.isArray(t) ? t : [t]).forEach(x => x && types.add(String(x))); } } catch {} }
  const good = ['Organization', 'LocalBusiness', 'ProfessionalService', 'FAQPage', 'Service', 'Product', 'Person'];
  const hitTypes = [...types].filter(t => good.some(g => t.includes(g)));
  if (hitTypes.length >= 2) add(15, 15, 'Structured data', `Schema.org markup found: ${hitTypes.join(', ')}. This is how machines learn what the business is.`);
  else if (hitTypes.length === 1) add(9, 15, 'Structured data (partial)', `Found ${hitTypes[0]} markup. Adding FAQPage and a full Organization or LocalBusiness block would help.`);
  else add(0, 15, 'No structured data', 'No schema.org JSON-LD on the homepage. AI systems have to guess what the business is from prose alone.');

  // 4. Title + meta description
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) || [])[1]?.trim() || '';
  if (title && desc.length > 50) add(10, 10, 'Title and description', `Title: "${title.slice(0, 70)}". Description present (${desc.length} chars).`);
  else if (title) add(5, 10, 'Missing meta description', `Title present ("${title.slice(0, 70)}") but no usable meta description. That one line is often what an assistant quotes.`);
  else add(0, 10, 'No title or description', 'The homepage has no usable title tag or meta description.');

  // 5. llms.txt
  if (llms.ok && /\S/.test(llms.text) && !/<html/i.test(llms.text)) add(10, 10, 'llms.txt present', 'An llms.txt file gives AI systems a plain-text map of what the site is about.');
  else add(0, 10, 'No llms.txt', 'No llms.txt at the root. It is a five-minute addition that AI crawlers increasingly look for.');

  // 6. Content structure
  const h = (html.match(/<h[1-3][^>]*>/gi) || []).length;
  if (h >= 4 && words >= 300) add(10, 10, 'Content structure', `${h} headings and ~${words} words on the homepage: enough structure for an assistant to summarize accurately.`);
  else if (h >= 2) add(5, 10, 'Thin structure', `Only ${h} headings on the homepage. Assistants summarize what they can parse; give them services, who you serve, and where.`);
  else add(0, 10, 'No clear structure', 'The homepage has almost no headings. An assistant has nothing to anchor a description to.');

  // 7. Sitemap + HTTPS
  add(sitemap.ok && /<urlset|<sitemapindex/i.test(sitemap.text) ? 5 : 0, 5, 'Sitemap', sitemap.ok ? 'sitemap.xml found.' : 'No sitemap.xml found.');
  add(u.protocol === 'https:' && (home.url || '').startsWith('https') ? 5 : 0, 5, 'HTTPS', 'Served over HTTPS.');

  const score = f.reduce((a, x) => a + x.points, 0); // out of 95
  return { findings: f, technical: score, technicalMax: 95 };
}

// ---------- live probe: does an AI actually find them? ----------
async function visibilityProbe(business, u, city) {
  const name = business || (u ? u.hostname.replace(/^www\./, '') : '');
  if (!name) return null;
  const q = `${name}${city ? ' ' + city : ''}`;
  const r = await fetch(API, {
    method: 'POST', headers: HEADERS(),
    body: JSON.stringify({
      model: MODEL, max_tokens: 600,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
      system: 'You are checking whether a small business is discoverable by AI assistants. Search for the business once or twice, then answer ONLY with compact JSON: {"found": true|false, "site_found": true|false, "summary": "one sentence on what the web says this business does, or empty if not found", "sources": ["domain", ...]}. No prose outside the JSON.',
      messages: [{ role: 'user', content: `Business: "${q}". Their website is ${u ? u.hostname : 'unknown'}. Search and report.` }],
    }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------- lead capture → Formspree (never fails the user's request) ----------
async function sendLead(a, brief, disc) {
  const hours = Array.isArray(a.hours) ? a.hours.join('; ') : (a.hours || '');
  const fields = {
    _subject: `AI readiness check: ${a.business || a.name || 'new lead'}${disc ? ` (discovery ${disc.score}/100)` : ''}`,
    name: a.name || '', email: a.email || '', business: a.business || '', city: a.city || '', website: a.website || '',
    company_size: a.size || '', industry: a.industry || '', hours_go_to: hours, systems: a.tools || '',
    data_lives: a.data || '', ai_use_so_far: a.ai_use || '', goal_90_days: a.goal || '',
    discovery_score: disc ? `${disc.score}/100` : 'no website given',
    discovery_findings: disc ? disc.findings.map(f => `${f.points}/${f.max} ${f.label}: ${f.detail}`).join('\n') : '',
    ai_probe: disc && disc.probe ? (disc.probe.found ? `Found. Described as: ${disc.probe.summary}. Own site among sources: ${disc.probe.site_found ? 'yes' : 'no'}` : 'Not found by search') : '',
    brief_sent: brief,
  };
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(LEAD_ENDPOINT, { method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(fields) });
    if (!r.ok) console.error('lead capture', r.status, (await r.text().catch(() => '')).slice(0, 200));
  } catch (e) { console.error('lead capture', e.message); }
  finally { clearTimeout(t); }
}

// ---------- the brief ----------
const SYSTEM = `You are writing a short, candid AI-readiness brief for a small or mid-sized business owner who just answered an intake form. The author voice is Emre Ozgurler, an electronics engineer turned sales professional who builds go-to-market systems and AI workflows for small businesses. He is practical and allergic to hype.

Write in plain, direct prose. No headers, no bullet points, no numbered lists, no bold. Four short paragraphs, 220 to 300 words total:

1. Where they stand: one honest read of their situation. Name the specific thing that makes them more or less ready than average.
2. The first automation worth trying: ONE concrete workflow from what they described (not a category), what it replaces, why it is right for them specifically.
3. What to fix before that works: one thing about their data, tools, or process, specific to their answers.
4. One caution: the mistake someone in their position most often makes.

If AI discovery results are provided, add a fifth paragraph (60 to 90 words) that reads the discovery score plainly: what AI assistants currently see when asked about them, and the single highest-impact fix from the findings. Do not list all findings; the page shows them.

Rules: never invent facts they did not give you. No vendor or product names. Do not mention Emre by name or pitch his services. Vary sentence length. No em dashes. Address the reader as "you".`;

function buildPrompt(a, disc) {
  const hours = Array.isArray(a.hours) ? a.hours.join(', ') : (a.hours || 'not specified');
  let s = `Intake answers:
- Business name: ${a.business || 'not given'}
- Company size: ${a.size || 'not specified'}
- Industry: ${a.industry || 'not specified'}
- Where the team's hours go: ${hours}
- Systems they run on: ${a.tools || 'not specified'}
- Where documents and data live: ${a.data || 'not specified'}
- AI use so far: ${a.ai_use || 'not specified'}
- What they most want to change in 90 days, in their words: "${(a.goal || '').toString().slice(0, 600) || 'not specified'}"`;
  if (disc) {
    s += `\n\nAI discovery results for ${disc.hostname}:
- Score: ${disc.score}/100
- Technical findings: ${disc.findings.map(f => `${f.label} (${f.points}/${f.max}): ${f.detail}`).join(' | ')}
- Live probe (an AI assistant searched for them): ${disc.probe ? (disc.probe.found ? `found; it describes the business as: "${disc.probe.summary}"; their own site ${disc.probe.site_found ? 'was' : 'was NOT'} among the sources` : 'did not find the business at all') : 'not run'}`;
  }
  return s + '\n\nWrite the brief.';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'Too many requests. Try again in an hour.' });

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } } body = body || {};
  if (body.website_hp) return res.status(200).json({ brief: '' }); // honeypot
  if (!(await verifyTurnstile(body.turnstile_token, ip))) return res.status(400).json({ error: 'Verification failed. Reload and try again.' });
  const name = String(body.name || '').trim().slice(0, 100);
  const email = String(body.email || '').trim().slice(0, 160);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please add your name and a valid email.' });
  body.name = name; body.email = email;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server not configured.' });

  try {
    let disc = null;
    const u = normalizeUrl(body.website);
    if (u) {
      const tech = await technicalChecks(u);
      let probe = null;
      try { probe = await visibilityProbe(body.business, u, body.city); } catch (e) { console.error('probe', e); }
      let visPts = 0;
      if (probe) { if (probe.found) visPts += 2; if (probe.site_found) visPts += 3; }
      disc = { hostname: u.hostname.replace(/^www\./, ''), score: Math.round(tech.technical + visPts), findings: tech.findings, probe,
               visibility: { points: visPts, max: 5, ran: !!probe } };
    }

    const r = await fetch(API, { method: 'POST', headers: HEADERS(), body: JSON.stringify({
      model: MODEL, max_tokens: 1100, system: SYSTEM, messages: [{ role: 'user', content: buildPrompt(body, disc) }] }) });
    if (!r.ok) { console.error('Anthropic', r.status, (await r.text().catch(() => '')).slice(0, 300)); return res.status(502).json({ error: 'The assessment service is unavailable right now.' }); }
    const data = await r.json();
    const brief = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    await sendLead(body, brief, disc);
    res.status(200).json({ brief, discovery: disc });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong generating the brief.' });
  }
}
