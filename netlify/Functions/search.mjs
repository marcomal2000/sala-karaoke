import { getStore } from "@netlify/blobs";


const CACHE_DAYS = 30;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// La YouTube API restituisce i titoli con le entità HTML
const decode = (s) =>
  String(s ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

export default async (req) => {
  const q = (new URL(req.url).searchParams.get("q") || "").trim().slice(0, 90);
  if (q.length < 2) return json({ error: "Scrivi almeno il titolo della canzone." }, 400);

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return json({ error: "Ricerca non configurata: manca la variabile YOUTUBE_API_KEY." }, 500);
  }

  const store = getStore({ name: "karaoke" });
  const cacheKey = "search:" + q.toLowerCase().replace(/\s+/g, " ");

  // Ogni ricerca costa 100 unità della quota giornaliera: la stessa query non si paga due volte
  try {
    const hit = await store.get(cacheKey, { type: "json" });
    if (hit && Date.now() - hit.at < CACHE_DAYS * 864e5) {
      return json({ results: hit.results, cached: true });
    }
  } catch (e) {
    /* cache assente: si prosegue */
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("maxResults", "8");
  url.searchParams.set("q", /karaoke/i.test(q) ? q : `${q} karaoke`);
  url.searchParams.set("key", apiKey);

  let data;
  try {
    const res = await fetch(url);
    data = await res.json();
    if (!res.ok) {
      const reason = data?.error?.errors?.[0]?.reason || "";
      if (reason === "quotaExceeded") {
        return json({ error: "Quota YouTube esaurita per oggi. Incolla il link del video." }, 429);
      }
      return json({ error: "YouTube ha rifiutato la ricerca: " + (data?.error?.message || res.status) }, 502);
    }
  } catch (e) {
    return json({ error: "Non riesco a raggiungere YouTube." }, 502);
  }

  const results = (data.items || [])
    .filter((it) => it.id?.videoId)
    .map((it) => ({
      videoId: it.id.videoId,
      title: decode(it.snippet?.title),
      channel: decode(it.snippet?.channelTitle),
      thumb: it.snippet?.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${it.id.videoId}/mqdefault.jpg`,
    }));

  if (results.length) {
    store.setJSON(cacheKey, { at: Date.now(), results }).catch(() => {});
  }

  return json({ results });
};
