// Edge Function Supabase : paiement SimplyPaye + réservations gratuites + réservations "payer plus tard"
// Déploiement : supabase functions deploy simplypaye --no-verify-jwt
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API = "https://api-simply-pay.net/api";
const MC = Deno.env.get("SIMPLYPAYE_MERCHANT_CODE") ?? "";
const KEY = Deno.env.get("SIMPLYPAYE_API_KEY") ?? "";
const SITE = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SEND_CALLBACK = Deno.env.get("SIMPLYPAYE_CALLBACK") === "1";
const MAIN_HOLD_HOURS = Math.min(Math.max(Number(Deno.env.get("HOLD_HOURS") ?? 48), 1), 168);
const db = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (m: string, s = 400) => json({ error: m }, s);

const MAIN: Record<string, [string, number, "FC" | "USD"]> = {
  standard: ["Standard", 5000, "FC"],
  vip: ["VIP", 10, "USD"],
  vvip: ["VVIP", 20, "USD"],
  sponsor: ["Sponsor", 50, "USD"],
  grand_sponsor: ["Grand Sponsor", 100, "USD"],
};
const MAIN_LIMIT_STANDARD = 300;

type Row = Record<string, any>;
const txt = (v: unknown, n = 200) => String(v ?? "").trim().slice(0, n);
const last9 = (p: unknown) => String(p ?? "").replace(/\D/g, "").slice(-9);
const phone243 = (p: string) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "243" + d.slice(1);
  return /^243\d{9}$/.test(d) ? d : "";
};
const tableOf = (kind: string) => (kind === "event" ? "orders" : "reservations");
const codeOf = (kind: string, id: string) => (kind === "event" ? "EV-" : "LRR-") + id.slice(0, 8).toUpperCase();
const descOf = (kind: string, row: Row) =>
  kind === "event"
    ? (row.items || []).map((i: Row) => `${i.name} × ${i.qty}`).join(", ")
    : Object.entries(MAIN).filter(([k]) => row[k]).map(([k, v]) => `${v[0]} × ${row[k]}`).join(", ");
const ticketOf = (kind: string, row: Row) => ({ id: row.id, code: codeOf(kind, row.id), name: row.name, desc: descOf(kind, row) });

const spHeaders = () => {
  const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (KEY) h["X-API-Key"] = KEY;
  return h;
};

async function expireHolds() {
  const now = new Date().toISOString();
  for (const t of ["orders", "reservations"]) {
    await db.from(t).update({ status: "cancelled" }).eq("hold", true).eq("status", "pending").is("pay_ref", null).lt("expires_at", now);
  }
}

// ---------- SimplyPaye ----------
async function spStatus(orderNumber: string) {
  const r = await fetch(`${API}/checkstatus-ordernumber/${encodeURIComponent(orderNumber)}`, { headers: spHeaders() });
  return (await r.json().catch(() => ({}))) as Record<string, string>;
}

async function verify(kind: string, row: Row) {
  if (row.status === "confirmed") return { status: "success", ticket: ticketOf(kind, row) };
  if (row.status === "cancelled") return { status: "cancelled" };
  if (!row.pay_ref) return { status: "pending" };
  const s = await spStatus(row.pay_ref);
  const st = String(s.status ?? s.code ?? "1");
  if (s.reference && String(s.reference) !== codeOf(kind, row.id)) return { status: "pending" };
  if (st === "0") {
    await db.from(tableOf(kind)).update({ status: "confirmed", hold: false }).eq("id", row.id).neq("status", "confirmed");
    return { status: "success", ticket: ticketOf(kind, row) };
  }
  if (st === "2") return { status: "failed" };
  if (st === "3") return { status: "cancelled" };
  return { status: "pending" };
}

// Lance le paiement SimplyPaye d'une commande déjà enregistrée
async function startProvider(kind: string, row: Row, method: string, mmRaw: string, title = "") {
  const mm = phone243(mmRaw);
  if (method === "mobile" && !mm) return { error: "Numéro Mobile Money invalide (format 2438XXXXXXXX)" };
  let total = 0, currency = "CDF";
  if (kind === "main") {
    if (row.fc && row.usd) return { error: "Payez les billets en FC et en $ séparément." };
    total = row.fc || row.usd; currency = row.fc ? "CDF" : "USD";
  } else {
    const cs = Object.keys(row.amounts || {});
    if (cs.length !== 1) return { error: "Payez les billets en FC et en $ séparément." };
    total = row.amounts[cs[0]]; currency = cs[0] === "USD" ? "USD" : "CDF";
  }
  if (!(total > 0)) return { error: "Montant invalide" };
  const code = codeOf(kind, row.id);
  const body: Record<string, unknown> = method === "card"
    ? { shortCode: MC, amount: total, currency, description: `Billet ${title || "Le Restau du Rire"} ${code}`.slice(0, 100),
        approve: `${SITE}/?pay=ok`, cancel: `${SITE}/?pay=cancel`, decline: `${SITE}/?pay=decline` }
    : { merchantCode: MC, phone: mm, amount: String(total), currency, reference: code };
  if (SEND_CALLBACK) {
    const cb = `${SB_URL}/functions/v1/simplypaye?cb=1&ref=${code}`;
    if (method === "card") body.callback = cb; else body.callbackUrl = cb;
  }
  const r = await fetch(API + (method === "card" ? "/simply-production-card" : "/simply-production"),
    { method: "POST", headers: spHeaders(), body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  const orderNumber = d?.simply_pay?.orderNumber ?? d?.orderNumber ?? null;
  const paymentUrl = d?.payment_url ?? null;
  const ok = r.ok && (method === "card" ? !!paymentUrl : String(d?.status) === "1" && !!orderNumber);
  if (!ok) return { error: txt(d?.message, 160) || "Paiement refusé par SimplyPaye. Vérifiez le numéro et réessayez." };
  await db.from(tableOf(kind)).update({ pay_ref: orderNumber ?? d?.reference ?? null, pay_provider: "simplypaye", payer: mm || "Carte", rec: "SimplyPaye" }).eq("id", row.id);
  return { paymentUrl };
}

// ---------- Construction d'une commande (prix recalculés côté serveur) ----------
async function build(kind: string, b: Row, mode: "pay" | "free" | "hold") {
  if (kind === "main" && Deno.env.get("MAIN_OPEN") !== "1") return { error: "La billetterie de l'Édition 1.5 n'est pas encore ouverte." };
  const c = b.customer || {};
  const name = txt(c.name, 120), wa = txt(c.phone, 30);
  if (name.length < 3 || !wa) return { error: "Nom et numéro WhatsApp obligatoires" };
  const addr = {
    pays: txt(c.pays), province: txt(c.province), ville: txt(c.ville),
    commune: txt(c.commune), quartier: txt(c.quartier), avenue: txt(c.avenue), loc: txt(c.loc, 400),
  };
  if (Object.values(addr).some((v) => !v)) return { error: "Adresse complète obligatoire" };
  const q: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.qty || {})) {
    const n = Math.floor(Number(v));
    if (n > 0) q[k] = Math.min(n, 10);
  }
  if (!Object.keys(q).length) return { error: "Sélectionnez au moins un billet" };

  const id = crypto.randomUUID();
  const hold = mode === "hold";
  const base: Row = { id, name, phone: wa, email: txt(c.email) || null, seller: null, proof_path: null,
    status: mode === "free" ? "confirmed" : "pending", hold, payer: null, rec: null,
    pay_provider: mode === "pay" ? "simplypaye" : null };
  let hours = MAIN_HOLD_HOURS, title = "";

  if (kind === "main") {
    if (mode === "free") return { error: "Réservation gratuite indisponible" };
    const sums = { FC: 0, USD: 0 }; const cols: Record<string, number> = {}; let n = 0;
    for (const [k, v] of Object.entries(q)) {
      if (!MAIN[k]) return { error: "Catégorie inconnue" };
      sums[MAIN[k][2]] += MAIN[k][1] * v; cols[k] = v; n += v;
    }
    if (mode === "pay" && sums.FC && sums.USD) return { error: "Payez les billets en FC et en $ séparément." };
    if (cols.standard) {
      const { data } = await db.from("reservations").select("standard").neq("status", "cancelled");
      const taken = (data || []).reduce((a: number, r: Row) => a + (+r.standard || 0), 0);
      if (taken + cols.standard > MAIN_LIMIT_STANDARD) return { error: "Catégorie Standard complète." };
    }
    base.note = txt(c.note, 400);
    Object.assign(base, addr, { standard: 0, vip: 0, vvip: 0, sponsor: 0, grand_sponsor: 0 }, cols, { total: n, fc: sums.FC, usd: sums.USD });
  } else {
    const { data: ev } = await db.from("events").select("*").eq("id", txt(b.event_id, 60)).maybeSingle();
    if (!ev || ev.status !== "published") return { error: "Événement indisponible" };
    const modes = ev.modes || {};
    if (mode === "pay" && !modes.online) return { error: "Paiement en ligne indisponible pour cet événement" };
    if (mode === "hold" && !modes.hold) return { error: "Réservation sans paiement indisponible pour cet événement" };
    hours = Math.min(Math.max(Number(modes.hold_hours) || 48, 1), 168); title = ev.title;
    const { data: sold } = await db.from("orders").select("items").eq("event_id", ev.id).neq("status", "cancelled");
    const soldBy: Record<string, number> = {};
    (sold || []).forEach((o: Row) => (o.items || []).forEach((i: Row) => (soldBy[i.id] = (soldBy[i.id] || 0) + i.qty)));
    const amounts: Record<string, number> = {}; const items: Row[] = []; let n = 0;
    for (const [tid, qty] of Object.entries(q)) {
      const t = (ev.tickets || []).find((x: Row) => x.id === tid);
      if (!t) return { error: "Catégorie inconnue" };
      if (t.stock && (soldBy[tid] || 0) + qty > t.stock) return { error: `${t.name} : complet` };
      amounts[t.currency] = (amounts[t.currency] || 0) + t.price * qty; n += qty;
      items.push({ id: t.id, name: t.name, qty, price: t.price, currency: t.currency });
    }
    const totalAll = Object.values(amounts).reduce((a, v) => a + v, 0);
    if (mode === "free" && totalAll !== 0) return { error: "Cette commande n'est pas gratuite" };
    if (mode === "hold" && totalAll === 0) return { error: "Billets gratuits : réservez directement, sans attente." };
    if (mode === "pay" && (totalAll <= 0 || Object.keys(amounts).length > 1)) return { error: Object.keys(amounts).length > 1 ? "Payez les billets en FC et en $ séparément." : "Montant invalide" };
    Object.assign(base, { event_id: ev.id, kind: "reservation", address: addr, items, total_qty: n, amounts });
  }
  if (hold) base.expires_at = new Date(Date.now() + hours * 3600e3).toISOString();
  return { row: base, wa, title, hours };
}

async function antiSpam(kind: string, wa: string) {
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await db.from(tableOf(kind)).select("id", { count: "exact", head: true })
    .eq("phone", wa).eq("status", "pending").gte("created_at", since);
  return (count ?? 0) >= 3;
}

const amountsOf = (kind: string, row: Row) => (kind === "main" ? { FC: row.fc || 0, USD: row.usd || 0 } : row.amounts || {});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!MC || !SITE) return fail("Configuration serveur incomplète", 500);
  const url = new URL(req.url);

  // Callback SimplyPaye : on revérifie auprès de l'API, on ne fait pas confiance au contenu
  if (url.searchParams.get("cb")) {
    const b = await req.json().catch(() => ({}));
    const ref = txt(url.searchParams.get("ref") || b.reference || b.ref, 40);
    const kind = ref.startsWith("EV-") ? "event" : "main";
    if (ref) {
      const { data } = await db.from(tableOf(kind)).select("*").order("created_at", { ascending: false }).limit(500);
      const row = (data || []).find((r: Row) => codeOf(kind, String(r.id)) === ref);
      if (row) await verify(kind, row);
    }
    return json({ ok: true });
  }

  if (req.method !== "POST") return fail("Méthode non autorisée", 405);
  const b = await req.json().catch(() => null);
  if (!b) return fail("Requête invalide");
  const kind = b.kind === "event" ? "event" : "main";
  await expireHolds();

  // Statut d'un paiement
  if (b.action === "status") {
    const { data: row } = await db.from(tableOf(kind)).select("*").eq("id", txt(b.id, 60)).maybeSingle();
    if (!row || row.pay_provider !== "simplypaye") return fail("Commande introuvable", 404);
    return json(await verify(kind, row));
  }

  // Paiement immédiat
  if (b.action === "pay") {
    const method = b.method === "card" ? "card" : "mobile";
    if (method === "mobile" && !phone243(b.mm)) return fail("Numéro Mobile Money invalide (format 2438XXXXXXXX)");
    const r = await build(kind, b, "pay");
    if (r.error) return fail(r.error);
    if (await antiSpam(kind, r.wa!)) return fail("Trop de tentatives. Patientez quelques minutes.", 429);
    const { error: ie } = await db.from(tableOf(kind)).insert(r.row!);
    if (ie) return fail("Enregistrement impossible : " + ie.message, 500);
    const p = await startProvider(kind, r.row!, method, b.mm, r.title);
    if (p.error) { await db.from(tableOf(kind)).delete().eq("id", r.row!.id); return fail(p.error, 502); }
    return json({ id: r.row!.id, code: codeOf(kind, r.row!.id), kind, method, payment_url: p.paymentUrl ?? null });
  }

  // Réservation gratuite : billet confirmé tout de suite
  if (b.action === "free") {
    const r = await build("event", b, "free");
    if (r.error) return fail(r.error);
    if (await antiSpam("event", r.wa!)) return fail("Trop de tentatives. Patientez quelques minutes.", 429);
    const { error: ie } = await db.from("orders").insert(r.row!);
    if (ie) return fail("Enregistrement impossible : " + ie.message, 500);
    return json({ status: "success", ticket: ticketOf("event", r.row!) });
  }

  // Réservation sans paiement immédiat
  if (b.action === "hold") {
    const r = await build(kind, b, "hold");
    if (r.error) return fail(r.error);
    if (await antiSpam(kind, r.wa!)) return fail("Trop de tentatives. Patientez quelques minutes.", 429);
    const { error: ie } = await db.from(tableOf(kind)).insert(r.row!);
    if (ie) return fail("Enregistrement impossible : " + ie.message, 500);
    return json({ id: r.row!.id, kind, code: codeOf(kind, r.row!.id), desc: descOf(kind, r.row!),
      amounts: amountsOf(kind, r.row!), expires_at: r.row!.expires_at, hours: r.hours });
  }

  // Retrouver ses réservations en attente de paiement (nom + téléphone)
  if (b.action === "lookup") {
    const n = txt(b.name, 120).toLowerCase(), p = last9(b.phone);
    if (n.length < 3 || p.length < 9) return json({ holds: [] });
    const holds: Row[] = [];
    for (const k of ["main", "event"]) {
      const { data } = await db.from(tableOf(k)).select("*").eq("hold", true).eq("status", "pending");
      for (const row of data || []) {
        if (last9(row.phone) !== p || !String(row.name).toLowerCase().includes(n)) continue;
        let online = k === "main";
        if (k === "event") { const { data: ev } = await db.from("events").select("modes,title").eq("id", row.event_id).maybeSingle(); online = !!ev?.modes?.online; }
        holds.push({ id: row.id, kind: k, code: codeOf(k, row.id), desc: descOf(k, row), amounts: amountsOf(k, row), expires_at: row.expires_at, online });
      }
    }
    return json({ holds });
  }

  // Payer une réservation déjà faite
  if (b.action === "payhold") {
    const { data: row } = await db.from(tableOf(kind)).select("*").eq("id", txt(b.id, 60)).maybeSingle();
    if (!row || !row.hold || row.status !== "pending" || last9(row.phone) !== last9(b.phone)) return fail("Réservation introuvable ou expirée", 404);
    if (row.expires_at && new Date(row.expires_at) < new Date()) return fail("Réservation expirée", 410);
    let title = "";
    if (kind === "event") {
      const { data: ev } = await db.from("events").select("modes,title").eq("id", row.event_id).maybeSingle();
      if (!ev?.modes?.online) return fail("Paiement en ligne indisponible pour cet événement");
      title = ev.title;
    }
    const method = b.method === "card" ? "card" : "mobile";
    const p = await startProvider(kind, row, method, b.mm, title);
    if (p.error) return fail(p.error, 502);
    return json({ id: row.id, code: codeOf(kind, row.id), kind, method, payment_url: p.paymentUrl ?? null });
  }

  return fail("Action inconnue");
});
