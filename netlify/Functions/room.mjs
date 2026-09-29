import { getStore } from "@netlify/blobs";


/* ---------- utilità ---------- */
const store = () => getStore({ name: "karaoke", consistency: "strong" });
const K = (code) => `room:${code}`;
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // niente I/O: si confondono con 1 e 0
const MAX_QUEUE = 150;
const MAX_DONE = 60;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const txt = (s, n = 120) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, n);
const vid = (v) => (/^[\w-]{11}$/.test(String(v ?? "")) ? String(v) : null);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const secret = () => crypto.randomUUID().replace(/-/g, "");
const strip = ({ host, ...rest }) => rest; // il token della regia non esce mai

async function readRoom(code) {
  const res = await store().getWithMetadata(K(code), { type: "json", consistency: "strong" });
  return res ? { room: res.data, etag: res.etag } : null;
}

/**
 * Legge, modifica, riscrive solo se nessun altro ha scritto nel frattempo.
 * Se qualcuno l'ha fatto rilegge e riprova: nessuna canzone va persa.
 */
async function apply(code, hostToken, requireHost, mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const found = await readRoom(code);
    if (!found) return json({ error: "Stanza non trovata." }, 404);

    const { room, etag } = found;
    if (requireHost && room.host !== hostToken) return json({ error: "Questa azione è della regia." }, 403);

    const problem = mutate(room);
    if (problem) return json({ error: problem }, 400);

    room.updated = Date.now();
    if (room.done.length > MAX_DONE) room.done.length = MAX_DONE;

    const written = await store().setJSON(K(code), room, { onlyIfMatch: etag });
    if (written.modified) return json({ room: strip(room) });

    await new Promise((r) => setTimeout(r, 60 + Math.random() * 140));
  }
  return json({ error: "Troppe modifiche insieme. Riprova." }, 503);
}

function song(body) {
  const videoId = vid(body.videoId);
  if (!videoId) return null;
  return {
    id: uid(),
    singer: txt(body.singer, 40) || "Anonimo",
    title: txt(body.title, 140) || "Senza titolo",
    artist: txt(body.artist, 80),
    channel: txt(body.channel, 80),
    videoId,
    addedAt: Date.now(),
  };
}

/* ---------- handler ---------- */
export default async (req) => {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const code = txt(url.searchParams.get("code"), 4).toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return json({ error: "Codice non valido." }, 400);

      const found = await readRoom(code);
      if (!found) return json({ error: "Stanza non trovata." }, 404);

      // Se il client ha già la versione corrente evitiamo di rispedirla
      const since = Number(url.searchParams.get("since") || 0);
      if (since && since === found.room.updated) return json({ unchanged: true });

      return json({ room: strip(found.room) });
    }

    if (req.method !== "POST") return json({ error: "Metodo non ammesso." }, 405);

    const body = await req.json().catch(() => ({}));
    const action = txt(body.action, 20);
    const host = txt(body.host, 40);
    const code = txt(body.code, 4).toUpperCase();

    /* --- apertura serata --- */
    if (action === "create") {
      for (let i = 0; i < 8; i++) {
        const c = Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
        const room = { code: c, host: secret(), created: Date.now(), updated: Date.now(), queue: [], done: [], playing: null };
        const written = await store().setJSON(K(c), room, { onlyIfNew: true });
        if (written.modified) return json({ room: strip(room), host: room.host });
      }
      return json({ error: "Non riesco a creare la stanza. Riprova." }, 503);
    }

    if (!/^[A-Z]{4}$/.test(code)) return json({ error: "Codice non valido." }, 400);

    switch (action) {
      /* --- ospite --- */
      case "add": {
        const entry = song(body);
        if (!entry) return json({ error: "Video YouTube non riconosciuto." }, 400);
        return apply(code, host, false, (r) => {
          if (r.queue.length >= MAX_QUEUE) return "La coda è piena.";
          if (r.queue.some((x) => x.videoId === entry.videoId)) return "Questa canzone è già in coda.";
          r.queue.push(entry);
        });
      }

      case "remove": {
        const id = txt(body.id, 30);
        const singer = txt(body.singer, 40);
        return apply(code, host, false, (r) => {
          const item = r.queue.find((x) => x.id === id);
          if (!item) return "Brano non trovato.";
          // la toglie la regia, oppure chi l'ha messa
          if (r.host !== host && item.singer !== singer) return "Puoi togliere solo le tue canzoni.";
          r.queue = r.queue.filter((x) => x.id !== id);
        });
      }

      /* --- regia --- */
      case "play": {
        const id = txt(body.id, 30);
        return apply(code, host, true, (r) => {
          const i = id ? r.queue.findIndex((x) => x.id === id) : 0;
          if (i < 0 || !r.queue.length) return "Nessun brano da mandare in onda.";
          if (r.playing) r.done.unshift(r.playing);
          r.playing = { ...r.queue.splice(i, 1)[0], startedAt: Date.now() };
        });
      }

      case "finish":
        return apply(code, host, true, (r) => {
          if (r.playing) r.done.unshift(r.playing);
          r.playing = null;
        });

      case "move": {
        const id = txt(body.id, 30);
        const dir = body.dir === "down" ? 1 : -1;
        return apply(code, host, true, (r) => {
          const i = r.queue.findIndex((x) => x.id === id);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= r.queue.length) return "Non si può spostare.";
          [r.queue[i], r.queue[j]] = [r.queue[j], r.queue[i]];
        });
      }

      case "requeue": {
        const id = txt(body.id, 30);
        return apply(code, host, true, (r) => {
          const i = r.done.findIndex((x) => x.id === id);
          if (i < 0) return "Brano non trovato.";
          r.queue.push({ ...r.done.splice(i, 1)[0], id: uid(), addedAt: Date.now() });
        });
      }

      case "clearDone":
        return apply(code, host, true, (r) => {
          r.done = [];
        });

      default:
        return json({ error: "Azione sconosciuta." }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Errore del server." }, 500);
  }
};
