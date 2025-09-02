// /api/feed.js — embeddable people/things, no captions, resilient (never returns empty unless API/key fails)
export default async function handler(req, res) {
  // CORS for Carrd
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const apiKey = process.env.YT_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing YT_API_KEY' });

  // Seeds biased to phone/normal footage
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

  // Helper utils
  const qs = (obj) => new URLSearchParams(obj).toString();
  const fetchJSON = async (url) => {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  const isoToSeconds = (iso='') => {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return 0;
    const h = parseInt(m[1]||'0',10), min = parseInt(m[2]||'0',10), s = parseInt(m[3]||'0',10);
    return h*3600 + min*60 + s;
  };

  // Brandy/“promo” heuristics
  const BRANDY = /(official|vevo|records|label|tv|news|trailer|promo|advert|ads?|sponsored|brand(ed)?|music\s+video|lyric\s+video|teaser|episode|\bep\b|\bMV\b)/i;

  // “People & things” categories preferred
  const PREFERRED_CATS = new Set(['22','19','15','2','26','28']); // People&Blogs, Travel&Events, Pets, Autos, Howto&Style, Sci&Tech
  const EXCLUDE_CATS   = new Set(['10','24','1','20','25','29','17','23']); // Music, Entertainment, Film&Animation, Gaming, News, Nonprofits, Sports, Comedy

  // Try 2 passes: 1) strict recent window, 2) wider window if too few
  const windows = [48, 7*24]; // hours
  let candidateIds = new Set();

  for (const hours of windows) {
    const publishedAfter = new Date(Date.now() - hours*3600*1000).toISOString();
    const seedA = qParam;
    const seedB = seeds[Math.floor(Math.random()*seeds.length)];
    const seedC = seeds[Math.floor(Math.random()*seeds.length)];

    const buildSearch = (q) => {
      const u = new URL('https://www.googleapis.com/youtube/v3/search');
      u.search = qs({
        key: apiKey,
        part: 'snippet',
        type: 'video',
        order: 'date',
        maxResults: '50',
        q,
        publishedAfter,
        videoEmbeddable: 'true',
        videoSyndicated: 'true',   // can be played outside youtube.com
        videoCaption: 'none',      // <-- NO CAPTIONS
        safeSearch: 'none',
      });
      return u.toString();
    };

    try {
      const results = await Promise.allSettled(
        [seedA, seedB, seedC].map(s => fetchJSON(buildSearch(s)))
      );
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

    if (candidateIds.size >= 10) break; // good enough
  }

  const ids = Array.from(candidateIds).slice(0, 50);
  if (!ids.length) return res.json([]); // key/quota/region might be the issue

  // Get details to filter
  const detailsURL = new URL('https://www.googleapis.com/youtube/v3/videos');
  detailsURL.search = qs({
    key: apiKey,
    part: 'status,statistics,contentDetails,snippet',
    id: ids.join(','),
    maxResults: '50'
  });

  let items = [];
  try {
    const dj = await fetchJSON(detailsURL.toString());
    items = dj.items || [];
  } catch {
    return res.json([]); // API trouble
  }

  // First pass: strict
  let strict = [];
  for (const v of items) {
    const okEmbed = v?.status?.embeddable && v?.status?.uploadStatus === 'processed';
    if (!okEmbed) continue;

    // Still ensure NO captions (defensive check; search already asked for none)
    if (String(v?.contentDetails?.caption || '').toLowerCase() === 'true') continue;

    const durS = isoToSeconds(v?.contentDetails?.duration || '');
    if (durS < 20 || durS > 1200) continue; // 20s–20min

    const views = parseInt(v?.statistics?.viewCount || '0', 10);
    if (isFinite(views) && views >= 5000) continue; // low-ish views

    const cat = String(v?.snippet?.categoryId || '');
    const title = v?.snippet?.title || '';
    const channel = v?.snippet?.channelTitle || '';
    const tags = (v?.snippet?.tags || []).join(' ').toLowerCase();

    // Prefer people/things categories
    if (!PREFERRED_CATS.has(cat)) continue;

    // Brandy heuristics
    if (BRANDY.test(title) || BRANDY.test(channel)) continue;
    if (/(official|promo|trailer|vevo|records|label|lyrics?)/.test(tags)) continue;

    strict.push(v.id);
  }

  // If too few results, relax to: allow other categories except excluded, keep no-captions + embeddable + heuristics
  let relaxed = strict;
  if (relaxed.length < 10) {
    relaxed = [];
    for (const v of items) {
      const okEmbed = v?.status?.embeddable && v?.status?.uploadStatus === 'processed';
      if (!okEmbed) continue;
      if (String(v?.contentDetails?.caption || '').toLowerCase() === 'true') continue;

      const durS = isoToSeconds(v?.contentDetails?.duration || '');
      if (durS < 20 || durS > 1200) continue;

      const views = parseInt(v?.statistics?.viewCount || '0', 10);
      if (isFinite(views) && views >= 5000) continue;

      const cat = String(v?.snippet?.categoryId || '');
      if (EXCLUDE_CATS.has(cat)) continue; // avoid music, entertainment, etc.

      const title = v?.snippet?.title || '';
      const channel = v?.snippet?.channelTitle || '';
      const tags = (v?.snippet?.tags || []).join(' ').toLowerCase();
      if (BRANDY.test(title) || BRANDY.test(channel)) continue;
      if (/(official|promo|trailer|vevo|records|label|lyrics?)/.test(tags)) continue;

      relaxed.push(v.id);
    }
  }

  // Shuffle + return (may still be empty if API/starvation)
  const out = relaxed.length ? relaxed : strict;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  res.json(out.slice(0, 50));
}
