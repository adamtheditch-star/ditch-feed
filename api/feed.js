// /api/feed.js — people/things, embeddable, no-captions; debug + caching
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Cache at Vercel edge for 2 minutes (dramatically reduces quota use)
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');

  const debug = req.query.debug === '1';
  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) {
    const msg = { error: 'Missing YT_API_KEY' };
    return debug ? res.status(500).json(msg) : res.json([]);
  }

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
  const q = (req.query.q || seeds[Math.floor(Math.random()*seeds.length)]).toString();
  const publishedAfter = new Date(Date.now() - 48*3600*1000).toISOString();

  const qs = (o) => new URLSearchParams(o).toString();

  // ---- 1) ONE search call (keeps quota low) ----
  const searchURL = new URL('https://www.googleapis.com/youtube/v3/search');
  searchURL.search = qs({
    key: apiKey,
    part: 'snippet',
    type: 'video',
    order: 'date',
    maxResults: '50',
    q,
    publishedAfter,
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    videoCaption: 'none',     // no captions
    safeSearch: 'none'
  });

  let searchJson, searchStatus = 200;
  try {
    const sr = await fetch(searchURL, { cache: 'no-store' });
    searchStatus = sr.status;
    searchJson = await sr.json();
    if (!sr.ok) throw new Error(JSON.stringify(searchJson));
  } catch (e) {
    if (debug) return res.status(searchStatus || 500).json({ step:'search', status: searchStatus, error: String(e), body: searchJson });
    return res.json([]);
  }

  const ids = (searchJson.items || [])
    .filter(it => it?.snippet?.liveBroadcastContent === 'none')
    .map(it => it?.id?.videoId)
    .filter(Boolean)
    .slice(0, 50);

  if (!ids.length) return debug ? res.json({ step:'search', status: searchStatus, items: 0 }) : res.json([]);

  // ---- 2) Details filter (cheap) ----
  const detailsURL = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsURL.search = qs({
    key: apiKey,
    part: 'status,statistics,contentDetails,snippet',
    id: ids.join(','),
    maxResults: '50'
  });

  let detailsJson, detailsStatus = 200;
  try {
    const dr = await fetch(detailsURL, { cache: 'no-store' });
    detailsStatus = dr.status;
    detailsJson = await dr.json();
    if (!dr.ok) throw new Error(JSON.stringify(detailsJson));
  } catch (e) {
    if (debug) return res.status(detailsStatus || 500).json({ step:'details', status: detailsStatus, error: String(e), body: detailsJson });
    return res.json([]);
  }

  const BRANDY = /(official|vevo|records|label|tv|news|trailer|promo|advert|ads?|sponsored|brand(ed)?|music\s+video|lyric\s+video|teaser|episode|\bep\b|\bMV\b)/i;
  const PREFERRED_CATS = new Set(['22','19','15','2','26','28']);
  const EXCLUDE_CATS   = new Set(['10','24','1','20','25','29','17','23']);

  const isoToSeconds = (iso='') => {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    const h = parseInt(m[1]||'0',10), min = parseInt(m[2]||'0',10), s = parseInt(m[3]||'0',10);
    return h*3600 + min*60 + s;
  };

  const items = detailsJson.items || [];

  // strict pass
  let out = items.filter(v => {
    const okEmbed = v?.status?.embeddable && v?.status?.uploadStatus === 'processed';
    if (!okEmbed) return false;

    // captions must be false
    if (String(v?.contentDetails?.caption || '').toLowerCase() === 'true') return false;

    const durS = isoToSeconds(v?.contentDetails?.duration || '');
    if (durS < 20 || durS > 1200) return false;

    const views = parseInt(v?.statistics?.viewCount || '0', 10);
    if (isFinite(views) && views >= 5000) return false;

    const cat = String(v?.snippet?.categoryId || '');
    if (!PREFERRED_CATS.has(cat)) return false;

    const title = v?.snippet?.title || '';
    const channel = v?.snippet?.channelTitle || '';
    const tags = (v?.snippet?.tags || []).join(' ').toLowerCase();
    if (BRANDY.test(title) || BRANDY.test(channel)) return false;
    if (/(official|promo|trailer|vevo|records|label|lyrics?)/.test(tags)) return false;

    return true;
  }).map(v => v.id);

  // relaxed if needed
  if (out.length < 8) {
    out = items.filter(v => {
      const okEmbed = v?.status?.embeddable && v?.status?.uploadStatus === 'processed';
      if (!okEmbed) return false;
      if (String(v?.contentDetails?.caption || '').toLowerCase() === 'true') return false;

      const durS = isoToSeconds(v?.contentDetails?.duration || '');
      if (durS < 15 || durS > 1800) return false;

      const views = parseInt(v?.statistics?.viewCount || '0', 10);
      if (isFinite(views) && views >= 15000) return false;

      const cat = String(v?.snippet?.categoryId || '');
      if (EXCLUDE_CATS.has(cat)) return false;

      const title = v?.snippet?.title || '';
      const channel = v?.snippet?.channelTitle || '';
      const tags = (v?.snippet?.tags || []).join(' ').toLowerCase();
      if (BRANDY.test(title) || BRANDY.test(channel)) return false;
      if (/(official|promo|trailer|vevo|records|label|lyrics?)/.test(tags)) return false;

      return true;
    }).map(v => v.id);
  }

  // shuffle
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  if (debug) {
    return res.json({
      debug: true,
      searchStatus, detailsStatus,
      inSearch: ids.length, inDetails: items.length,
      outCount: out.length,
      sample: out.slice(0, 10)
    });
  }

  res.json(out.slice(0, 50));
}
