import { DEFAULT_INSTANCE_ID, type HarnessId, type InstanceId, type SifEntry } from "@sinter/core";
import type { LedgerRow } from "@sinter/ledger";
import type { Ctx } from "./commands";
import { buildThreads } from "./tui/threads";

export interface GuiAction {
  action: "port" | "resume";
  harness: HarnessId;
  instanceId?: InstanceId;
  nativeId: string;
  target?: string;
  mode?: "auto" | "full" | "slim" | "compact";
}

export interface GuiServerOptions {
  port?: number;
  token?: string;
  onAction?: (action: GuiAction) => Promise<{ code: number; out: string; err: string }>;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function publicRow(row: LedgerRow) {
  return {
    harness: row.harness,
    instanceId: row.instanceId ?? DEFAULT_INSTANCE_ID,
    nativeId: row.nativeId,
    cwd: row.cwd,
    title: row.alias ?? row.title ?? row.firstPrompt ?? "Untitled session",
    updatedAt: row.updatedAt ?? row.createdAt,
    messageCount: row.messageCount,
    ghost: row.ghost,
    isSubagent: row.isSubagent,
    tags: row.tags,
    note: row.note,
  };
}

function entryText(entry: SifEntry): string {
  if (entry.kind === "user" || entry.kind === "assistant" || entry.kind === "toolResult") {
    return entry.content
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "thinking") return part.thinking;
        if (part.type === "toolCall") return `${part.name}(${typeof part.args === "string" ? part.args : JSON.stringify(part.args)})`;
        if (part.type === "image") return `[image: ${part.mimeType}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (entry.kind === "compaction") return entry.summary ?? "Conversation compacted";
  if (entry.kind === "note") return entry.text ?? entry.noteType;
  if (entry.kind === "modelChange") return `Model changed to ${entry.model}`;
  if (entry.kind === "subsession") return `Subsession: ${entry.agentName ?? entry.sessionRef}`;
  return "";
}

export function guiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sinter</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0d10; --panel:#12161b; --line:#252b33; --muted:#8b98a8; --text:#edf2f7; --accent:#f59e0b; --blue:#6eb4ff; }
    * { box-sizing:border-box } body { margin:0; font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); overflow:hidden }
    button,input,select { font:inherit } button { cursor:pointer }
    header { height:58px; display:flex; align-items:center; gap:14px; padding:0 20px; border-bottom:1px solid var(--line); background:#0e1115 }
    .brand { font-size:18px; font-weight:720; letter-spacing:.02em } .brand i { color:var(--accent); font-style:normal }
    .local { color:var(--muted); font-size:12px } .search { margin-left:auto; width:min(420px,42vw); background:#171c22; color:var(--text); border:1px solid var(--line); border-radius:9px; padding:9px 12px }
    main { height:calc(100vh - 58px); display:grid; grid-template-columns:200px minmax(320px,430px) 1fr }
    aside,.sessions { border-right:1px solid var(--line) } aside { padding:18px 12px; background:#0e1115 }
    .eyebrow { color:var(--muted); text-transform:uppercase; font-size:10px; letter-spacing:.14em; padding:0 9px 8px }
    .filter { width:100%; border:0; border-radius:8px; background:transparent; color:var(--muted); text-align:left; padding:9px; margin:1px 0 }
    .filter:hover,.filter.active { background:#1a2027; color:var(--text) } .filter b { float:right; font-weight:500 }
    .sessions { overflow:auto; background:var(--panel) } .session { padding:14px 16px; border-bottom:1px solid var(--line); cursor:pointer }
    .session:hover,.session.active { background:#1a2027 } .session.active { box-shadow:inset 3px 0 var(--accent) }
    .title { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:620 } .meta { color:var(--muted); margin-top:6px; display:flex; gap:8px; font-size:12px }
    .pill { color:var(--blue); background:#142337; border-radius:99px; padding:1px 7px }
    .detail { min-width:0; display:flex; flex-direction:column; background:#0d1014 }
    .detail-head { min-height:78px; border-bottom:1px solid var(--line); padding:14px 18px; display:flex; align-items:center; gap:12px }
    .detail-title { min-width:0; flex:1 } .detail-title h2 { margin:0; font-size:17px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis } .detail-title div { color:var(--muted); margin-top:4px; font-size:12px }
    .actions { display:flex; gap:8px; align-items:center } .actions button,.actions select { border:1px solid var(--line); border-radius:8px; padding:8px 10px; background:#171c22; color:var(--text) }
    .actions .primary { background:var(--accent); border-color:var(--accent); color:#171008; font-weight:700 }
    .transcript { overflow:auto; padding:20px; flex:1 } .entry { max-width:900px; margin:0 auto 16px; padding:14px 16px; border:1px solid var(--line); border-radius:11px; background:#12161b }
    .entry.user { border-color:#334155; background:#111923 } .role { color:var(--muted); text-transform:uppercase; font-size:10px; letter-spacing:.12em; margin-bottom:8px } pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace }
    .empty { color:var(--muted); display:grid; place-items:center; height:100%; text-align:center; padding:30px } .notice { position:fixed; right:18px; bottom:18px; max-width:520px; background:#1a2027; border:1px solid #3b4654; border-radius:9px; padding:12px 14px; display:none; white-space:pre-wrap }
    @media (max-width:850px) { main { grid-template-columns:0 42% 58% } aside { overflow:hidden; padding:0 } .actions select { display:none } }
  </style>
</head>
<body>
  <header><div class="brand"><i>◆</i> sinter</div><div class="local">local session workspace</div><input class="search" id="search" placeholder="Search sessions…"></header>
  <main><aside><div class="eyebrow">Harnesses</div><div id="filters"></div></aside><section class="sessions" id="sessions"></section><section class="detail" id="detail"><div class="empty">Choose a session to inspect its transcript and move it between harnesses.</div></section></main>
  <div class="notice" id="notice"></div>
  <script>
    const token = new URLSearchParams(location.search).get('token') || '';
    let all = [], targets = [], harness = 'all', selected = null;
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const api = async (path, options={}) => { const join = path.includes('?') ? '&' : '?'; const r = await fetch(path + join + 'token=' + encodeURIComponent(token), options); const x = await r.json(); if (!r.ok) throw new Error(x.error || r.statusText); return x; };
    const ago = iso => { if (!iso) return ''; const s=(Date.now()-new Date(iso))/1000; if(s<3600)return Math.max(1,Math.floor(s/60))+'m'; if(s<86400)return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; };
    function renderFilters(){ const counts={}; all.forEach(t=>t.hops.forEach(h=>counts[h.harness]=(counts[h.harness]||0)+1)); document.querySelector('#filters').innerHTML=['all',...Object.keys(counts).sort()].map(h=>'<button class="filter '+(h===harness?'active':'')+'" data-h="'+h+'">'+(h==='all'?'All sessions':esc(h))+' <b>'+(h==='all'?all.length:counts[h])+'</b></button>').join(''); document.querySelectorAll('.filter').forEach(b=>b.onclick=()=>{harness=b.dataset.h;renderFilters();renderSessions()}); }
    function visible(){ const q=document.querySelector('#search').value.toLowerCase().trim(); return all.filter(t=>(harness==='all'||t.hops.some(x=>x.harness===harness))&&(!q||JSON.stringify(t).toLowerCase().includes(q))); }
    function renderSessions(){ document.querySelector('#sessions').innerHTML=visible().map(t=>'<article class="session '+(selected===t.id?'active':'')+'" data-id="'+esc(t.id)+'"><div class="title">'+esc(t.tip.title)+'</div><div class="meta"><span class="pill">'+esc(t.tip.harness)+'</span><span>'+ago(t.tip.updatedAt)+'</span><span>'+(t.tip.messageCount||0)+' messages</span></div><div class="meta">'+esc(t.chain)+'</div></article>').join('')||'<div class="empty">No sessions match.</div>'; document.querySelectorAll('.session').forEach(x=>x.onclick=()=>openSession(x.dataset.id)); }
    async function openSession(id){ selected=id; renderSessions(); const t=all.find(x=>x.id===id), row=t.tip; document.querySelector('#detail').innerHTML='<div class="empty">Loading transcript…</div>'; try { const data=await api('/api/session?harness='+encodeURIComponent(row.harness)+'&instance='+encodeURIComponent(row.instanceId||'default')+'&id='+encodeURIComponent(row.nativeId)); const availableTargets=targets.filter(x=>x!==row.harness+'@'+(row.instanceId||'default')); document.querySelector('#detail').innerHTML='<div class="detail-head"><div class="detail-title"><h2>'+esc(row.title)+'</h2><div>'+esc(row.cwd||'')+' · '+esc(t.chain)+'</div></div><div class="actions"><button id="resume">Resume</button><select id="target">'+availableTargets.map(x=>'<option>'+esc(x)+'</option>').join('')+'</select><select id="mode"><option>auto</option><option>full</option><option>slim</option><option>compact</option></select><button class="primary" id="port">Port</button></div></div><div class="transcript">'+data.entries.map(e=>'<article class="entry '+esc(e.kind)+'"><div class="role">'+esc(e.kind)+(e.model?' · '+esc(e.model):'')+'</div><pre>'+esc(e.text)+'</pre></article>').join('')+'</div>'; document.querySelector('#resume').onclick=()=>act('resume',row); document.querySelector('#port').onclick=()=>act('port',row); } catch(e){ document.querySelector('#detail').innerHTML='<div class="empty">'+esc(e.message)+'</div>'; } }
    async function act(action,row){ try { const body={action,harness:row.harness,instanceId:row.instanceId,nativeId:row.nativeId}; if(action==='port'){body.target=document.querySelector('#target').value;body.mode=document.querySelector('#mode').value} const result=await api('/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); notice(([result.out,result.err].filter(Boolean).join('\\n')||'Done').trim()); if(action==='port') await load(); } catch(e){ notice(e.message); } }
    function notice(s){ const n=document.querySelector('#notice');n.textContent=s;n.style.display='block';setTimeout(()=>n.style.display='none',7000); }
    async function load(){ const data=await api('/api/sessions');all=data.threads;targets=data.targets||[];renderFilters();renderSessions();if(!selected&&all.length)openSession(all[0].id); }
    document.querySelector('#search').oninput=renderSessions; load().catch(e=>notice(e.message));
  </script>
</body></html>`;
}

export function startGuiServer(ctx: Ctx, options: GuiServerOptions = {}) {
  const token = options.token ?? crypto.randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/" && request.method === "GET")
        return new Response(guiHtml(), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        });
      if (url.searchParams.get("token") !== token) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/sessions" && request.method === "GET") {
        const threads = buildThreads(ctx.ledger().list({ includeSubagents: false }), ctx.ledger().lineage());
        const targets = (await ctx.registry.bindings())
          .filter((binding) => typeof binding.adapter.write === "function")
          .map((binding) => `${binding.harness}@${binding.instanceId}`);
        return json({ targets, threads: threads.map((thread) => ({ id: thread.id, chain: thread.hops.map((h) => h.instanceId && h.instanceId !== DEFAULT_INSTANCE_ID ? `${h.harness}@${h.instanceId}` : h.harness).join(" → "), tip: publicRow(thread.tip), hops: thread.hops.map(publicRow) })) });
      }
      if (url.pathname === "/api/session" && request.method === "GET") {
        const harness = url.searchParams.get("harness") as HarnessId | null;
        const instanceId = url.searchParams.get("instance") ?? DEFAULT_INSTANCE_ID;
        const nativeId = url.searchParams.get("id");
        if (!harness || !nativeId) return json({ error: "harness and id are required" }, 400);
        const row = ctx.ledger().get(harness, nativeId, instanceId);
        if (!row) return json({ error: "session not found" }, 404);
        try {
          const adapter = await ctx.registry.getInstance(harness, instanceId);
          const session = await adapter.read({ harness, instanceId, nativeId, nativePath: row.nativePath });
          return json({ entries: session.entries.map((entry) => ({ kind: entry.kind, model: entry.kind === "assistant" ? entry.model?.id : entry.kind === "modelChange" ? entry.model : undefined, text: entryText(entry) })) });
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 500);
        }
      }
      if (url.pathname === "/api/action" && request.method === "POST") {
        if (!options.onAction) return json({ error: "actions are unavailable" }, 501);
        try {
          const action = (await request.json()) as GuiAction;
          if (!action || !["port", "resume"].includes(action.action) || !action.harness || !action.nativeId)
            return json({ error: "invalid action" }, 400);
          const result = await options.onAction(action);
          return json(result, result.code === 0 ? 200 : 400);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }
      return json({ error: "not found" }, 404);
    },
  });
  return { server, token, url: `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(token)}` };
}
