// Vercel serverless function: GET /api/twin-video?id=<job>[&check=1]
// Relays between the page and the avatar server on the Mac mini, so the server's address
// and token never reach the browser.
//   ?id=..&check=1  ->  {"status": "queued" | "working" | "done" | "error" | "unknown"}
//   ?id=..          ->  the finished clip (video/mp4)

export const maxDuration = 30;

const ON = process.env.TWIN_VIDEO_ENABLED === '1' && !!process.env.TWIN_VIDEO_ENDPOINT;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const id = String((req.query && req.query.id) || '');
  if (!/^[0-9a-f]{16}$/.test(id)) return res.status(400).json({ error: 'bad id' });
  if (!ON) return res.status(404).json({ status: 'unknown' });

  const base = process.env.TWIN_VIDEO_ENDPOINT.replace(/\/+$/, '');
  const headers = { 'ngrok-skip-browser-warning': '1' };
  if (process.env.TWIN_VIDEO_TOKEN) headers.authorization = 'Bearer ' + process.env.TWIN_VIDEO_TOKEN;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    if (req.query.check) {
      const r = await fetch(`${base}/jobs/${id}`, { headers, signal: ctl.signal });
      const data = await r.json().catch(() => ({}));
      return res.status(200).json({ status: typeof data.status === 'string' ? data.status : 'unknown' });
    }
    const r = await fetch(`${base}/video/${id}.mp4`, { headers, signal: ctl.signal });
    if (!r.ok) return res.status(404).json({ error: 'not ready' });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'clip too large' });
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Accept-Ranges', 'none');
    return res.status(200).send(buf);
  } catch (e) {
    return res.status(200).json({ status: 'unknown' });
  } finally { clearTimeout(timer); }
}
