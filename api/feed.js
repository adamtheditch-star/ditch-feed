// /api/feed.js  (Vercel Serverless Function – FREE tier)
export default async function handler(req, res) {
  // CORS so Carrd can fetch it
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing YT_API_KEY' });

  // seed queries (phone-like, non-live)
  const seeds = [
    'iphone vertical vlog', 'walking tour today',
    'city street night b-roll', 'home video 2025',
    'camcorder raw footage', 'dashcam night', 'travel diary 2025'
  ];
  const q = (req.query.q || seeds[Math.floor(Math.random()*seeds.length)]).toString();

  const publishedAfter = new Date(Date.now() - 36*3600*1000).toISOString();

  // 1) newest, embeddable, not live
  const searchURL = new URL('https://www.googleapis.com/youtube/v3/search');
  searchURL.search = new URLSearchParams({
    key: apiKey,
    part: 'snippet',
    type: 'video',
    order: 'date',
    maxResults: '50',
    q,
    publishedAfter,
    videoEmbeddable: 'true',
    safeSearch: 'none',
  }).toString();

  let ids = [];
  try {
    const sr = await fetch(searchURL, { cache: 'no-store' });
    const sj = await sr.json();
    ids = (sj.items || [])
      .filter(it => it?.snippet?.liveBroadcastContent === 'none')
      .map(it => it.id?.videoId)
      .filter(Boolean);
  } catch {}

  if (!ids.length) return res.json([]);

  // 2) keep only embeddable + processed + low views; avoid ultra-short (Shorts)
  const detailsURL = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsURL.search = new URLSearchParams({
    key: apiKey,
    part: 'status,statistics,contentDetails',
    id: ids.join(','),
    maxResults: '50',
  }).toString();

  function isoToSeconds(iso='') {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    const h = parseInt(m[1]||'0',10), min = parseInt(m[2]||'0',10), s = parseInt(m[3]||'0',10);
    return h*3600 + min*60 + s;
  }

  let filtered = [];
  try {
    const dr = await fetch(detailsURL, { cache: 'no-store' });
    const dj = await dr.json();
    filtered = (dj.items || []).filter(v => {
      const okEmbed = v?.status?.embeddable && v?.status?.uploadStatus === 'processed';
      const views = parseInt(v?.statistics?.viewCount || '0', 10);
      const durS = isoToSeconds(v?.contentDetails?.duration || '');
      const notUltraShort = durS >= 20;     // avoid Shorts-like ultra short
      const notTooLong    = durS <= 1200;   // ≤ 20 min
      return okEmbed && views < 1000 && notUltraShort && notTooLong;
    }).map(v => v.id);
  } catch {}

  // shuffle
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }

  res.json(filtered.slice(0, 50));
}
