// /api/feed.js  — returns only embeddable "people & things" clips, no captions, low views
export default async function handler(req, res) {
  // CORS for Carrd
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing YT_API_KEY' });

  // Seeds bias toward normal phone/camera footage
  const seeds = [
    'walking vlog today',
    'iphone vertical vlog',
    'city street night b roll',
    'home video 2025 camera',
    'camcorder raw footage',
    'travel diary 2025',
    'dog walk park vlog',
    'garage workshop project',
    'backyard cooking vlog',
    'dashcam evening drive'
  ];
  const qParam = (req.query.q || seeds[Math.floor(Math.random()*seeds.length)]).toString();

  // Last 48h to widen results if your location has few uploads
  const publishedAfter = new Date(Date.now() - 48*3600*1000).toISOString();

  // Helper
  const qs = (obj) => new URLSearchParams(obj).toString();
  const fetchJSON = async (url) => {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };

  // 1) Search (twice, with two seeds) to build a candidate pool
  const seedA = qParam;
  const seedB = seeds[Math.floor(Math.random()*seeds.length)];
  const searchURLs = [seedA, seedB].map(q => {
    const u = new URL('https://www.googleapis.com/youtube/v3/search');
    u.search = qs({
      key: apiKey,
      part: 'snippet',
      type: 'video',
      order: 'date',
      maxResults: '50',
      q,                         // YouTube API generally honors minus terms too
      publishedAfter,
      videoEmbeddable: 'true',
      safeSearch: 'none',
      regionCode: req.query.region || '' // optional
    });
    return u.toString();
  });

  let candidateIds = new Set();
  try {
    const results = await Promise.allSettled(searchURLs.map(fetchJSON));
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const items = r.value.items || [];
      for (const it of items) {
        if (it?.snippet?.liveBroadcastContent !== 'none') continue; // no live
        const id = it?.id?.videoId;
        if (id) candidateIds.add(id);
      }
    }
  } catch {}

  const ids = Array.from(candidateIds).slice(0, 50);
  if (!ids.length) return res.json([]); // nothing found (front-end will just ask again soon)

  // 2) Details filter
  // We need: status (embeddable/processed), statistics (views), contentDetails (duration+captions), snippet (categoryId/title/channel/tags)
  const detailsURL = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsURL.search = qs({
    key: apiKey,
    part: 'status,statistics,contentDetails,snippet',
    id: ids.join(','),
    maxResults: '50'
  });

  const BRANDY = /(official|vevo|records|label|tv|news|trailer|promo|advert|ad\b|sponsored|brand(ed)?|music\s+video|lyric\s+video|teaser|episode|ep\.|\bMV\b)/i;

  const ALLOWED_CATEGORIES = new Set([
    '22', // People & Blogs
    '19', // Travel & Events
    '15', // Pets & Animals
    '2',  // Autos & Vehicles
    '26', // Howto & Style
    '28'  // Science & Technology
  ]);

  const isoToSeconds = (iso='') => {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    const h = parseInt(m[1]||'0',10), min = parseInt(m[2]||'0',10), s = parseInt(m[3]||'0',10);
    return h*3600 + min*60 + s;
  };

  let filtered = [];
  try {
    const dj = await fetchJSON(detailsURL.toString());
    for (const v of (dj.items || [])) {
      const okEmbed = v?.status?.embeddable && v?.status?.uploadStatus === 'processed';
      if (!okEmbed) continue;

      // No closed captions (approx. proxy for non-branded / raw uploads)
      if (String(v?.contentDetails?.caption || '').toLowerCase() === 'true') continue;

      // Duration between 20s and 20min
      const durS = isoToSeconds(v?.contentDetails?.duration || '');
      if (durS < 20 || durS > 1200) continue;

      // Low-ish views
      const views = parseInt(v?.statistics?.viewCount || '0', 10);
      if (isFinite(views) && views >= 10000) continue;

      // Category whitelist (people/things)
      const cat = v?.snippet?.categoryId;
      if (!ALLOWED_CATEGORIES.has(String(cat))) continue;

      // Title/channel brandy heuristics
      const title = (v?.snippet?.title || '');
      const channel = (v?.snippet?.channelTitle || '');
      if (BRANDY.test(title) || BRANDY.test(channel)) continue;

      // Tags heuristics (if present)
      const tags = (v?.snippet?.tags || []).join(' ').toLowerCase();
      if (/(official|promo|trailer|vevo|records|label|lyrics?)/.test(tags)) continue;

      filtered.push(v.id);
    }
  } catch {
    // ignore, return whatever we have
  }

  // Shuffle + return up to 50
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }
  res.json(filtered.slice(0, 50));
}
