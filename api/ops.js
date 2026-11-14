// Zentrale für „Die Flucht 3D“ auf Vercel: Spielerzahlen, Spiele-Zähler und Postfach (Bug-Meldungen)
// Pfad im GitHub-Projekt: api/ops.js   ·   Speicher: Upstash Redis (Vercel → Storage → Upstash, Gratis-Plan)
// Vercel trägt KV_REST_API_URL und KV_REST_API_TOKEN automatisch ein. Optional: ADMIN_KEY (Standard: 1709).
import { randomBytes } from "node:crypto";
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_KEY = process.env.ADMIN_KEY || "1709";

const ONLINE_MS = 150 * 1000;   // so lange zählt ein Spieler nach seinem letzten Lebenszeichen als online
const MAX_REPORTS = 150;        // älteste Meldungen werden automatisch gelöscht
const CATS = ["bug", "wand", "lag", "sonst", "meinung"];
const MODES = ["menu", "solo", "mp", "p2"];
const ID_RE = /^r-\d{15}-[a-z0-9]+$/;
const RES_NAMES = new Set(["entwickler (op)", "entwickler", "keshynr", "admin", "administrator", "moon games", "op"]);   // diese Namen gehören den Sonderkonten
const nkeyL = (n, l) => String(n == null ? "" : n).replace(/[\u0000-\u001f<>&"'\\]/g, "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, l);
const nkey = (n) => nkeyL(n, 14);
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 32 Zeichen ohne I, O, 0, 1
const newCode = (n) => { const r = randomBytes(n); let c = ""; for (let i = 0; i < n; i++) c += CODE_ABC[r[i] & 31]; return c; };   // echte Zufallszeichen (32 teilt 256, also ohne Verzerrung)

async function db(cmds) {       // mehrere Redis-Befehle in einem Aufruf
  const r = await fetch(DB_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + DB_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("Datenbank antwortet mit " + r.status);
  const j = await r.json();
  return j.map((x) => { if (x && x.error) throw new Error(x.error); return x ? x.result : null; });
}
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").slice(0, n);
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const dayKey = (t) => { try { return new Date(t).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }); } catch (e) { return new Date(t).toISOString().slice(0, 10); } };
const pairs = (arr) => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; };

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");            // erlaubt dem Bug-Scanner, die Meldungen zu laden (Admin-Schlüssel nötig)
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  const send = (obj, status = 200) => res.status(status).json(obj);
  if (req.method !== "POST") return send({ error: "method" }, 405);
  if (!DB_URL || !DB_TOKEN) return send({ error: "nodb" }, 503);
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b.a !== "string") return send({ error: "bad" }, 400);
  const now = Date.now();
  const sid = str(b.sid, 64);
  try {
    switch (b.a) {
      case "hb": {                                    // Lebenszeichen (jede Minute)
        if (!sid) return send({ error: "sid" }, 400);
        const m = MODES.includes(b.m) ? b.m : "menu";
        const [, , , n, pk] = await db([["ZADD", "df:on", now, sid], ["HSET", "df:mode", sid, m], ["ZREMRANGEBYSCORE", "df:on", "-inf", now - ONLINE_MS], ["ZCARD", "df:on"], ["GET", "df:peak"]]);
        const peak = pk ? JSON.parse(pk) : { n: 0, t: 0 };
        if (n > peak.n) await db([["SET", "df:peak", JSON.stringify({ n, t: now })]]);
        return send({ ok: true, online: n });
      }
      case "bye": {
        if (sid) await db([["ZREM", "df:on", sid], ["HDEL", "df:mode", sid]]);
        return send({ ok: true });
      }
      case "visit": {                                 // ein Besuch der Seite (einmal pro Öffnen)
        const vid = str(b.vid, 64);
        if (!vid) return send({ error: "vid" }, 400);
        const day = dayKey(now);
        await db([["SADD", "df:vis", vid], ["INCR", "df:visits"], ["SADD", "df:vd:" + day, vid], ["EXPIRE", "df:vd:" + day, 3456000], ["HINCRBY", "df:vdays", day, 1]]);
        return send({ ok: true });
      }
      case "legacy": {                                // Zahlen der alten Webseite (vom Admin eingetragen)
        if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
        const n = (v) => Math.max(0, Math.min(1e7, Math.floor(+v || 0)));
        await db([["HSET", "df:legacy", "players", n(b.players), "visits", n(b.visits), "games", n(b.games)]]);
        return send({ ok: true });
      }
      case "score": {                                 // Siegerzeit einreichen (Bestenliste)
        const mode = String(b.mode || ""), diff = String(b.diff || "").toLowerCase();
        if (!["solo", "p2", "mp"].includes(mode) || !/^[a-zäöü]{3,10}$/.test(diff)) return send({ error: "bad" }, 400);
        const t = Math.round(+b.t * 10) / 10, ch = b.cheat ? 1 : 0;   // mit Cheat-Menü gespielt: zählt auch, wird mit ⚙ markiert
        if (!(t >= (ch ? 3 : mode === "mp" ? 20 : 90) && t <= 14400)) return send({ error: "time" }, 400);
        const name = str(b.name, 14).replace(/[<>&"'\\]/g, "").trim() || "Spieler";
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rls:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 3600]]);
        if (cnt > 40) return send({ error: "limit" }, 429);
        const key = "df:lb:" + mode + ":" + diff, hk = "df:lbv:" + mode + ":" + diff;
        const who = mode === "mp" ? "n:" + name.toLowerCase() : "v:" + str(b.vid || sid, 64);   // pro Gerät bzw. Name nur die beste Zeit
        const [old] = await db([["HGET", hk, who]]);
        let oldT = null, oldRank = null;
        if (old) { const [sc, rk] = await db([["ZSCORE", key, old], ["ZRANK", key, old]]); oldT = sc == null ? null : +sc; oldRank = rk == null ? null : +rk; }
        const improved = oldT == null || t < oldT;
        let member = old;
        if (improved) {
          member = JSON.stringify(Object.assign({ n: name, d: dayKey(now), i: Math.random().toString(36).slice(2, 6) }, ch ? { c: 1 } : {}));
          const cmds = [];
          if (old) cmds.push(["ZREM", key, old]);
          cmds.push(["ZADD", key, t, member], ["HSET", hk, who, member], ["ZREMRANGEBYRANK", key, 100, -1]);
          await db(cmds);
        }
        const [rank, count, top] = await db([["ZRANK", key, member], ["ZCARD", key], ["ZRANGE", key, 0, 0, "WITHSCORES"]]);
        let best = null;
        try { if (top && top.length) best = Object.assign(JSON.parse(top[0]), { t: +top[1] }); } catch (e) {}
        const newRank = rank == null ? null : +rank + 1;
        // beat = wie viele Zeiten du mit diesem Ergebnis überholt hast (für die Rang-Coins im Spiel)
        let beat = 0;
        if (improved && newRank != null) beat = oldRank != null ? Math.max(0, oldRank + 1 - newRank) : Math.max(0, +count - newRank);
        return send({ ok: true, rank: newRank, count: +count, best, improved, mine: improved ? t : oldT, beat });
      }
      case "board": {                                 // Bestenliste lesen (öffentlich)
        const mode = String(b.mode || ""), diff = String(b.diff || "").toLowerCase();
        if (!["solo", "p2", "mp"].includes(mode) || !/^[a-zäöü]{3,10}$/.test(diff)) return send({ error: "bad" }, 400);
        const key = "df:lb:" + mode + ":" + diff;
        const [flat, count] = await db([["ZRANGE", key, 0, 9, "WITHSCORES"], ["ZCARD", key]]);
        const list = [];
        for (let i = 0; flat && i + 1 < flat.length; i += 2) { try { list.push(Object.assign(JSON.parse(flat[i]), { t: +flat[i + 1] })); } catch (e) {} }
        return send({ ok: true, list, count: +count });
      }
      case "recset": {                                // Admin: Rekordzeit eintragen (Cheat-Rekord, wird mit ⚙ markiert)
        if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
        const mode = String(b.mode || ""), diff = String(b.diff || "").toLowerCase();
        if (!["solo", "p2", "mp"].includes(mode) || !/^[a-zäöü]{3,10}$/.test(diff)) return send({ error: "bad" }, 400);
        const t = Math.round(+b.t * 10) / 10;
        if (!(t >= 1 && t <= 14400)) return send({ error: "time" }, 400);
        const name = str(b.name, 14).replace(/[<>&"'\\]/g, "").trim() || "Spieler";
        const key = "df:lb:" + mode + ":" + diff, hk = "df:lbv:" + mode + ":" + diff, who = "a:" + name.toLowerCase();
        const [old] = await db([["HGET", hk, who]]);
        const member = JSON.stringify({ n: name, d: dayKey(now), i: Math.random().toString(36).slice(2, 6), c: 1, a: 1 });
        const cmds = [];
        if (old) cmds.push(["ZREM", key, old]);
        cmds.push(["ZADD", key, t, member], ["HSET", hk, who, member], ["ZREMRANGEBYRANK", key, 100, -1]);
        await db(cmds);
        const [rank, count] = await db([["ZRANK", key, member], ["ZCARD", key]]);
        return send({ ok: true, rank: rank == null ? null : +rank + 1, count: +count, t });
      }
      case "recdel": {                                // Admin: eigenen Cheat-Rekord wieder löschen (nur Admin-/Cheat-Einträge dieses Namens)
        if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
        const mode = String(b.mode || ""), diff = String(b.diff || "").toLowerCase();
        if (!["solo", "p2", "mp"].includes(mode) || !/^[a-zäöü]{3,10}$/.test(diff)) return send({ error: "bad" }, 400);
        const name = str(b.name, 14).replace(/[<>&"'\\]/g, "").trim().toLowerCase();
        if (!name) return send({ error: "bad" }, 400);
        const key = "df:lb:" + mode + ":" + diff, hk = "df:lbv:" + mode + ":" + diff;
        const [all] = await db([["ZRANGE", key, 0, -1]]);
        const kill = [];
        for (const m of all || []) { try { const o = JSON.parse(m); if (String(o.n || "").toLowerCase() === name && (o.c || o.a)) kill.push(m); } catch (e) {} }
        const cmds = [];
        if (kill.length) cmds.push(["ZREM", key, ...kill]);
        cmds.push(["HDEL", hk, "a:" + name]);
        await db(cmds);
        return send({ ok: true, removed: kill.length });
      }
      case "tag": {                                   // Account-Code-Anteil (Tag) für einen neuen Account reservieren: jeder Tag gehört genau einem Account
        const tag = String(b.tag || "").toUpperCase();
        const sec = str(b.sec, 40);
        if (!/^[A-HJ-NP-Z2-9]{4}$/.test(tag) || sec.length < 8) return send({ error: "bad" }, 400);
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rlt:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 3600]]);
        if (cnt > 300) return send({ error: "limit" }, 429);
        const h = hash(sec + "|" + tag) + hash(tag + "|" + sec);
        const [won] = await db([["HSETNX", "df:tags", tag, h]]);   // atomar: nur der Erste bekommt den Tag
        const tnm = str(b.name, 14).replace(/[<>&"'\\]/g, "").trim();
        if (+won === 1) { if (tnm.length >= 2) await db([["HSET", "df:tagn", tag, tnm]]); return send({ ok: true }); }
        const [old] = await db([["HGET", "df:tags", tag]]);
        return old === h ? send({ ok: true }) : send({ ok: false, taken: true });
      }
      case "tagq": {                                  // Wer gehört zu diesem Code-Anteil? (nur der Name; wer den Code hat, gehört zum selben Account)
        const tag = String(b.tag || "").toUpperCase();
        if (!/^[A-HJ-NP-Z2-9]{4}$/.test(tag)) return send({ error: "bad" }, 400);
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rlq:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 3600]]);
        if (cnt > 120) return send({ error: "limit" }, 429);
        const [nm] = await db([["HGET", "df:tagn", tag]]);
        return send({ ok: true, name: nm || "" });
      }
      case "name": {                                  // Spielernamen reservieren: jeder Name gehört genau einem Account (Groß-/Kleinschreibung egal)
        const nm = str(b.name, 14).replace(/[<>&"'\\]/g, "").trim().replace(/\s+/g, " "), key = nkey(nm), sec = str(b.sec, 40);
        if (key.length < 2 || sec.length < 8) return send({ error: "bad" }, 400);
        if (RES_NAMES.has(key) || RES_NAMES.has(nkeyL(b.name, 30))) return send({ ok: false, taken: true });
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rln:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 3600]]);
        if (cnt > 300) return send({ error: "limit" }, 429);
        const h = hash(sec + "|n|" + key) + hash(key + "|n|" + sec);
        const [mine] = await db([["HGET", "df:nm", key]]);
        if (mine) return mine === h ? send({ ok: true }) : send({ ok: false, taken: true });
        if (!b.legacy) { const [seen] = await db([["HGET", "df:names", key]]); if (seen) return send({ ok: false, taken: true }); }   // alter Name ohne Besitzer: bleibt für den alten Account reserviert
        const [won] = await db([["HSETNX", "df:nm", key, h]]);                 // atomar: nur der Erste bekommt den Namen
        if (+won !== 1) { const [o] = await db([["HGET", "df:nm", key]]); return o === h ? send({ ok: true }) : send({ ok: false, taken: true }); }
        await db([["HSET", "df:names", key, nm + "|" + now]]);
        return send({ ok: true });
      }
      case "accput": {                                // Account-Code melden (damit der Entwickler alle Accounts sehen und öffnen kann)
        const tag = String(b.tag || "").toUpperCase(), code = String(b.code || "").toUpperCase();
        if (!/^[A-HJ-NP-Z2-9]{4}$/.test(tag) || !/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return send({ error: "bad" }, 400);
        if (code.split("").filter((_, i) => i % 2 === 0).join("") !== tag) return send({ error: "bad" }, 400);
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rlap:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 3600]]);
        if (cnt > 200) return send({ error: "limit" }, 429);
        const [known] = await db([["HEXISTS", "df:tags", tag]]);
        if (!+known) return send({ ok: false, unknown: true });
        const nm = str(b.name, 14).replace(/[<>&"'\\]/g, "").trim();
        await db([["HSET", "df:accs", tag, JSON.stringify({ n: nm, c: code, t: now })]]);
        if (b.data && typeof b.data === "object") {       // kompletter Spielstand (für den Entwickler-Zugriff)
          const clean = {}; for (const k of Object.keys(b.data).slice(0, 60)) clean[str(k, 30)] = str(b.data[k], 20000);
          const js = JSON.stringify(clean);
          if (js.length <= 120000) await db([["HSET", "df:accd", tag, js]]);
        }
        return send({ ok: true });
      }
      case "accget": {                                // Admin: kompletten Spielstand eines Accounts holen
        if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
        const tag = String(b.tag || "").toUpperCase();
        if (!/^[A-HJ-NP-Z2-9]{4}$/.test(tag)) return send({ error: "bad" }, 400);
        const [d, a] = await db([["HGET", "df:accd", tag], ["HGET", "df:accs", tag]]);
        if (!d) return send({ ok: false, none: true });
        let o = {}; try { o = JSON.parse(a || "{}"); } catch (e) {}
        return send({ ok: true, data: JSON.parse(d), name: o.n || "" });
      }
      case "acclist": {                               // Admin: alle bekannten Accounts (Name + Code)
        if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
        const [acc, tn] = await db([["HGETALL", "df:accs"], ["HGETALL", "df:tagn"]]);
        const A = pairs(acc), N = pairs(tn), list = [];
        for (const tag of Object.keys(A)) { try { const o = JSON.parse(A[tag]); list.push({ tag, name: o.n || N[tag] || "?", code: o.c, t: o.t }); } catch (e) {} }
        for (const tag of Object.keys(N)) if (!A[tag]) list.push({ tag, name: N[tag], code: "", t: 0 });
        list.sort((x, y) => y.t - x.t);
        return send({ ok: true, list: list.slice(0, 2000), known: Object.keys(A).length });
      }
      case "reg": {                                   // Spielername anmelden (damit Geschenke nur an echte Spieler gehen)
        const nm = str(b.name, 14).replace(/[<>&"'\\]/g, "").trim();
        if (nm.length < 2) return send({ error: "bad" }, 400);
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rlr:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 3600]]);
        if (cnt > 120) return send({ error: "limit" }, 429);
        await db([["HSET", "df:names", nkey(nm), nm + "|" + now]]);
        return send({ ok: true });
      }
      case "gift": {                                  // Skin verschenken: nur an Spielernamen, die es gibt. Der Schenker bekommt einen zufälligen Geschenk-Code
        const clean = (v, n) => str(v, n).replace(/[<>&"'\\]/g, "").trim();
        const to = nkey(b.to), from = clean(b.from, 14) || "Jemand", skin = String(b.skin || "");
        if (to.length < 2) return send({ error: "bad" }, 400);
        if (skin === "*") { if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401); }
        else if (!/^[a-z0-9]{2,12}$/.test(skin)) return send({ error: "bad" }, 400);
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rlg:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 3600]]);
        if (cnt > 40) return send({ error: "limit" }, 429);
        const [known] = await db([["HGET", "df:names", to]]);
        if (!known) return send({ error: "noname" }, 404);
        const id = "g-" + now + "-" + Math.random().toString(36).slice(2, 6), gk = "df:gift:" + to, code = newCode(12);
        const gsec = str(b.gsec, 60), gh = gsec.length >= 8 ? hash(gsec + "|g|" + id) + hash(id + "|g|" + gsec) : "";   // Geheimnis des Schenkers: nur er (oder der Admin) kann das Geschenk zurücknehmen
        await db([["RPUSH", gk, JSON.stringify({ id, s: skin, f: from, t: now })], ["LTRIM", gk, -300, -1], ["EXPIRE", gk, 5184000],
                  ["SET", "df:gc:" + code, JSON.stringify({ s: skin, f: from, to, t: now, id })], ["EXPIRE", "df:gc:" + code, 5184000],
                  ["SET", "df:gm:" + id, JSON.stringify({ to, s: skin, gh, code, t: now })], ["EXPIRE", "df:gm:" + id, 5184000]]);
        return send({ ok: true, id, code });
      }
      case "redeem": {                                // Geschenk-Code einlösen (einmalig)
        const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (code.length !== 12) return send({ error: "nocode" }, 404);
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rlc:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 600]]);
        if (cnt > 20) return send({ error: "limit" }, 429);
        const [v] = await db([["GET", "df:gc:" + code]]);
        if (!v) return send({ error: "nocode" }, 404);
        await db([["DEL", "df:gc:" + code]]);
        let g = {}; try { g = JSON.parse(v); } catch (e) {}
        return send({ ok: true, s: g.s, f: g.f || "Jemand", id: g.id || "" });
      }
      case "gifts": {                                 // Geschenke für einen Namen lesen (bleiben 60 Tage); zurückgenommene fehlen, die Antwort nennt außerdem, welche der angegebenen IDs zurückgenommen wurden
        const to = nkey(b.name);
        if (to.length < 2) return send({ error: "bad" }, 400);
        const [arr] = await db([["LRANGE", "df:gift:" + to, -100, -1]]);
        let list = [];
        for (const m of arr || []) { try { list.push(JSON.parse(m)); } catch (e) {} }
        const chk = Array.isArray(b.ids) ? b.ids.map((x) => str(x, 40)).filter((x) => /^g-\d+-[a-z0-9]+$/.test(x)).slice(0, 200) : [];
        const all = Array.from(new Set(list.map((g) => g.id).concat(chk)));
        const rv = [];
        if (all.length) { const [vals] = await db([["MGET", ...all.map((i) => "df:gr:" + i)]]); (vals || []).forEach((v, i) => { if (v) rv.push(all[i]); }); }
        list = list.filter((g) => !rv.includes(g.id));
        const [stv] = await db([["GET", "df:strip:" + to]]);
        return send({ ok: true, list, rv: rv.filter((i) => chk.includes(i)), strip: +stv || 0 });
      }
      case "strip": {                                 // Admin: alle Skins eines Spielers entfernen, außer den selbst gekauften (der Spieler führt es beim nächsten Abruf aus)
        if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
        const to = nkey(b.to);
        if (to.length < 2) return send({ error: "bad" }, 400);
        const [seen] = await db([["HGET", "df:names", to]]);
        if (!seen) return send({ error: "noname" }, 404);
        await db([["SET", "df:strip:" + to, String(now)]]);
        return send({ ok: true });
      }
      case "giftrev": {                               // Geschenk zurücknehmen: der Schenker mit seinem Geheimnis oder der Admin
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rlv:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 3600]]);
        if (cnt > 60) return send({ error: "limit" }, 429);
        const revoke = async (id, meta) => { await db([["SET", "df:gr:" + id, String(now)], ["EXPIRE", "df:gr:" + id, 5184000]]); if (meta && meta.code) await db([["DEL", "df:gc:" + meta.code]]); };
        if (b.key !== undefined) {                      // Admin: alle Geschenke eines Spielers (einzelner Skin oder „*“ = alle)
          if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
          const to = nkey(b.to), skin = String(b.skin || "*");
          if (to.length < 2) return send({ error: "bad" }, 400);
          const [arr] = await db([["LRANGE", "df:gift:" + to, 0, -1]]);
          let n = 0;
          for (const m of arr || []) { try { const g = JSON.parse(m); if (skin !== "*" && g.s !== skin) continue; const [done] = await db([["GET", "df:gr:" + g.id]]); if (done) continue; const [mm] = await db([["GET", "df:gm:" + g.id]]); let meta = null; try { meta = mm ? JSON.parse(mm) : null; } catch (e) {} await revoke(g.id, meta); n++; } catch (e) {} }
          return send({ ok: true, n });
        }
        const id = str(b.id, 40), gsec = str(b.gsec, 60);
        if (!/^g-\d+-[a-z0-9]+$/.test(id) || gsec.length < 8) return send({ error: "bad" }, 400);
        const [mm, done] = await db([["GET", "df:gm:" + id], ["GET", "df:gr:" + id]]);
        if (!mm) return send({ error: "nogift" }, 404);
        let meta = {}; try { meta = JSON.parse(mm); } catch (e) {}
        if (!meta.gh || meta.gh !== hash(gsec + "|g|" + id) + hash(id + "|g|" + gsec)) return send({ error: "auth" }, 401);
        if (done) return send({ ok: true, already: true });
        await revoke(id, meta);
        return send({ ok: true });
      }
      case "game": {                                  // ein Spiel wurde gestartet
        const m = ["solo", "mp", "p2"].includes(b.m) ? b.m : "solo";
        const cmds = [["HINCRBY", "df:total", "all", 1], ["HINCRBY", "df:total", m, 1], ["HINCRBY", "df:days", dayKey(now), 1]];
        if (sid) cmds.push(["HSET", "df:mode", sid, m]);
        await db(cmds);
        return send({ ok: true });
      }
      case "report": {                                // Meldung eines Spielers
        const text = str(b.text, 1200).trim();
        if (text.length < 5) return send({ error: "short" }, 400);
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
        const rk = "df:rl:" + hash(ip || sid || "x");
        const [cnt] = await db([["INCR", rk]]);
        if (cnt === 1) await db([["EXPIRE", rk, 3600]]);
        if (cnt > 8) return send({ error: "limit" }, 429);
        const id = "r-" + String(now).padStart(15, "0") + "-" + Math.random().toString(36).slice(2, 6);
        let ctx = {};
        try { ctx = JSON.parse(JSON.stringify(b.ctx || {})); } catch (e) {}
        if (JSON.stringify(ctx).length > 1800) ctx = { note: "zu groß" };
        const hasShot = typeof b.shot === "string" && b.shot.startsWith("data:image/jpeg;base64,") && b.shot.length < 340000;
        const rep = { id, t: now, name: str(b.name, 20) || "Spieler", cat: CATS.includes(b.cat) ? b.cat : "bug", text, ctx, hasShot };
        const cmds = [["SET", "df:r:" + id, JSON.stringify(rep)], ["ZADD", "df:rep", now, id]];
        if (hasShot) cmds.push(["SET", "df:s:" + id, b.shot]);
        cmds.push(["ZCARD", "df:rep"]);
        const out = await db(cmds);
        const total = out[out.length - 1];
        if (total > MAX_REPORTS) {
          const [old] = await db([["ZRANGE", "df:rep", 0, total - MAX_REPORTS - 1]]);
          if (old && old.length) await db([["ZREM", "df:rep", ...old], ["DEL", ...old.map((k) => "df:r:" + k), ...old.map((k) => "df:s:" + k)]]);
        }
        return send({ ok: true, id });
      }
      case "admin": {                                 // Zahlen + Meldungen für den Administrator
        if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
        const [, on, modeArr, pk, totArr, dayArr, ids, visU, visN, visToday, legArr, vdayArr] = await db([["ZREMRANGEBYSCORE", "df:on", "-inf", now - ONLINE_MS], ["ZRANGE", "df:on", 0, -1], ["HGETALL", "df:mode"], ["GET", "df:peak"], ["HGETALL", "df:total"], ["HGETALL", "df:days"], ["ZREVRANGE", "df:rep", 0, 99], ["SCARD", "df:vis"], ["GET", "df:visits"], ["SCARD", "df:vd:" + dayKey(now)], ["HGETALL", "df:legacy"], ["HGETALL", "df:vdays"]]);
        const modes = pairs(modeArr), tot = pairs(totArr), days = pairs(dayArr);
        const online = on || [];
        const stale = Object.keys(modes).filter((k) => !online.includes(k));
        const oldDays = Object.keys(days).sort().slice(0, -30);
        const clean = [];
        if (stale.length) clean.push(["HDEL", "df:mode", ...stale]);
        if (oldDays.length) clean.push(["HDEL", "df:days", ...oldDays]);
        if (clean.length) await db(clean);
        let reports = [];
        if (ids && ids.length) { const [vals] = await db([["MGET", ...ids.map((k) => "df:r:" + k)]]); reports = (vals || []).filter(Boolean).map((v) => JSON.parse(v)); }
        const by = (m) => online.filter((k) => modes[k] === m).length;
        const today = dayKey(now);
        const stats = {
          online: online.length,
          inGame: online.filter((k) => modes[k] && modes[k] !== "menu").length,
          byMode: { solo: by("solo"), mp: by("mp"), p2: by("p2"), menu: by("menu") },
          peak: pk ? JSON.parse(pk) : { n: 0, t: 0 },
          total: { all: +(tot.all || 0), solo: +(tot.solo || 0), mp: +(tot.mp || 0), p2: +(tot.p2 || 0) },
          today: +(days[today] || 0),
          days: Object.keys(days).sort().slice(-7).map((d) => ({ d, n: +days[d] })),
        };
        const leg = pairs(legArr), vdays = pairs(vdayArr);
        stats.visitors = {
          unique: +(visU || 0), visits: +(visN || 0), today: +(visToday || 0),
          days: Object.keys(vdays).sort().slice(-7).map((d) => ({ d, n: +vdays[d] })),
          legacy: { players: +(leg.players || 0), visits: +(leg.visits || 0), games: +(leg.games || 0) },
        };
        return send({ ok: true, stats, reports, now });
      }
      case "shot": {
        if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
        const id = str(b.id, 40);
        if (!ID_RE.test(id)) return send({ error: "bad" }, 400);
        const [shot] = await db([["GET", "df:s:" + id]]);
        return shot ? send({ ok: true, shot }) : send({ error: "none" }, 404);
      }
      case "del": {
        if (b.key !== ADMIN_KEY) return send({ error: "auth" }, 401);
        const id = str(b.id, 40);
        if (!ID_RE.test(id)) return send({ error: "bad" }, 400);
        await db([["ZREM", "df:rep", id], ["DEL", "df:r:" + id, "df:s:" + id]]);
        return send({ ok: true });
      }
    }
    return send({ error: "action" }, 400);
  } catch (e) {
    return send({ error: "server", detail: String(e && e.message || e).slice(0, 120) }, 500);
  }
}
