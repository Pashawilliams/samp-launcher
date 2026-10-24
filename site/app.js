(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NICK_RE = /^[A-Za-z0-9_\[\]\.\$@=()]{3,20}$/;
  const REFRESH_MS = 60_000;

  let config = { servers: [] }, status = null, history = { points: [] };
  let currentId = localStorage.getItem("samp.server") || null;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fresh = (url) => url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();

  async function getJSON(url) {
    const r = await fetch(fresh(url), { cache: "no-store" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), 2200);
  }

  function ago(ts) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return "только что";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " мин назад";
    const h = Math.floor(m / 60);
    return h + " ч " + (m % 60) + " мин назад";
  }

  const server = () => config.servers.find((s) => s.id === currentId) || config.servers[0];
  const live = () => status?.servers?.find((s) => s.id === server()?.id);

  function renderTabs() {
    const tabs = $("tabs");
    if (config.servers.length < 2) { tabs.hidden = true; return; }
    tabs.hidden = false;
    tabs.innerHTML = config.servers.map((s) =>
      `<button data-id="${esc(s.id)}" class="${s.id === server().id ? "on" : ""}">${esc(s.name)}</button>`).join("");
    tabs.querySelectorAll("button").forEach((b) => b.onclick = () => {
      currentId = b.dataset.id;
      localStorage.setItem("samp.server", currentId);
      render();
    });
  }

  function render() {
    const srv = server();
    if (!srv) return;
    const st = live();
    renderTabs();

    document.title = (st?.hostname || srv.name) + " — SA-MP Launcher";
    $("hostname").textContent = st?.hostname || srv.name;
    $("addr").textContent = `${srv.ip}:${srv.port}`;
    $("modalAddr").textContent = `${srv.ip}:${srv.port}`;
    $("updated").textContent = status ? "обновлено " + ago(status.updatedTs) : "нет данных статуса";

    const stEl = $("status");
    if (st?.online) {
      stEl.className = "status on";
      stEl.querySelector("span").textContent = "Онлайн" + (st.ping != null ? ` · ${st.ping} мс` : "");
    } else {
      stEl.className = "status off";
      stEl.querySelector("span").textContent = status ? "Сервер недоступен" : "Нет данных";
    }
    $("ver").textContent = st?.rules?.version ? "SA-MP " + st.rules.version : "";

    const pl = st?.online ? st.players : 0, mx = st?.maxPlayers || 0;
    $("players").textContent = st?.online ? `${pl} / ${mx}` : "—";
    $("bar").style.width = mx ? Math.min(100, (pl / mx) * 100) + "%" : "0";

    renderInfo(st);
    renderPlayers();
    renderChart(srv.id, mx);
  }

  function renderInfo(st) {
    const r = st?.rules || {};
    const web = r.weburl && !/invalid|sa-mp\.com$|^www\.sa-mp\.com/i.test(r.weburl) ? r.weburl : "";
    const rows = [
      ["Режим", st?.gamemode],
      ["Язык", st?.language],
      ["Карта", r.mapname],
      ["Время в игре", r.worldtime],
      ["Погода", r.weather],
      ["Lag compensation", r.lagcomp],
      ["Пароль", st ? (st.password ? "Да" : "Нет") : ""],
      ["Сайт", web ? `<a href="${esc(/^https?:/i.test(web) ? web : "http://" + web)}" target="_blank" rel="noopener">${esc(web)}</a>` : ""],
    ].filter(([, v]) => v !== undefined && v !== "" && v !== null);
    $("info").innerHTML = rows.length
      ? rows.map(([k, v]) => `<dt>${k}</dt><dd>${k === "Сайт" ? v : esc(v)}</dd>`).join("")
      : `<dt>Нет данных</dt><dd></dd>`;
  }

  function renderPlayers() {
    const st = live();
    const box = $("playerList");
    const q = $("plSearch").value.trim().toLowerCase();
    if (!st?.online) { $("plCount").textContent = ""; box.innerHTML = `<div class="empty">Сервер недоступен</div>`; return; }
    if (st.playerList == null) {
      $("plCount").textContent = `(${st.players})`;
      box.innerHTML = `<div class="empty">Сервер не отдаёт список игроков (SA-MP показывает его только при онлайне до 100)</div>`;
      return;
    }
    const list = st.playerList.filter((p) => p.name.toLowerCase().includes(q));
    $("plCount").textContent = `(${st.playerList.length})`;
    box.innerHTML = list.length
      ? list.map((p) => `<div class="pl"><span>${esc(p.name)}</span><b>${p.score}</b></div>`).join("")
      : `<div class="empty">${st.playerList.length ? "Никого не найдено" : "Сейчас на сервере никого нет, будьте первым!"}</div>`;
  }

  function renderChart(id, maxPlayers) {
    const box = $("chart"), legend = $("chartLegend");
    const now = Date.now() / 1000, from = now - 24 * 3600;
    const pts = (history.points || []).filter((p) => p.t >= from && p.p && id in p.p).map((p) => ({ t: p.t, v: p.p[id] }));
    if (pts.length < 2) {
      box.innerHTML = `<div class="empty">График появится после нескольких обновлений статуса</div>`;
      legend.innerHTML = "";
      return;
    }
    const W = 600, H = 180, pad = 6;
    const peak = Math.max(1, ...pts.map((p) => p.v));
    const top = Math.max(peak, Math.min(maxPlayers || peak, peak * 1.25));
    const x = (t) => pad + ((t - from) / (now - from)) * (W - pad * 2);
    const y = (v) => H - pad - (v / top) * (H - pad * 2);

    // разрываем линию там, где сервер был офлайн или был большой пропуск данных
    const segs = []; let cur = [];
    pts.forEach((p, i) => {
      const gap = i > 0 && p.t - pts[i - 1].t > 45 * 60;
      if (p.v < 0 || gap) { if (cur.length) segs.push(cur); cur = []; }
      if (p.v >= 0) cur.push(p);
    });
    if (cur.length) segs.push(cur);

    const paths = segs.map((s) => {
      const line = s.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
      const area = `${line}L${x(s[s.length - 1].t).toFixed(1)},${H - pad}L${x(s[0].t).toFixed(1)},${H - pad}Z`;
      return `<path d="${area}" fill="url(#g)"/><path d="${line}" fill="none" stroke="#ff8a00" stroke-width="2.2" stroke-linejoin="round"/>`;
    }).join("");
    const grid = [0.25, 0.5, 0.75].map((k) => `<line x1="0" x2="${W}" y1="${y(top * k)}" y2="${y(top * k)}" stroke="rgba(255,255,255,.06)"/>`).join("");
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff8a00" stop-opacity=".35"/><stop offset="1" stop-color="#ff8a00" stop-opacity="0"/></linearGradient></defs>
      ${grid}${paths}</svg>`;
    const valid = pts.filter((p) => p.v >= 0);
    legend.innerHTML = `<span>24 ч назад</span><span>пик: <b>${peak}</b> · среднее: <b>${valid.length ? Math.round(valid.reduce((a, p) => a + p.v, 0) / valid.length) : 0}</b></span><span>сейчас</span>`;
  }

  // ---- ник ----
  const nickEl = $("nick");
  nickEl.value = localStorage.getItem("samp.nick") || "";
  function checkNick(show) {
    const v = nickEl.value.trim();
    const ok = NICK_RE.test(v);
    nickEl.classList.toggle("bad", show && !ok);
    const hint = $("nickHint");
    if (show && !ok) {
      hint.className = "hint bad";
      hint.textContent = "Ник: 3–20 символов, латиница, цифры и _ [ ] . $ @ = ( )";
    } else {
      hint.className = "hint";
      hint.innerHTML = "Для RP-серверов формат Имя_Фамилия, например <b>Ivan_Petrov</b>";
    }
    return ok;
  }
  nickEl.addEventListener("input", () => { localStorage.setItem("samp.nick", nickEl.value.trim()); checkNick(nickEl.value.length > 0); });

  // ---- действия ----
  $("play").onclick = () => {
    const srv = server();
    if (nickEl.value && !checkNick(true)) { nickEl.focus(); return; }
    window.location.href = `samp://${srv.ip}:${srv.port}`;
    setTimeout(() => { $("modal").hidden = false; }, 900);
  };

  $("bat").onclick = () => {
    if (!checkNick(true)) { nickEl.focus(); toast("Сначала введите ник"); return; }
    const srv = server(), nick = nickEl.value.trim(), addr = `${srv.ip}:${srv.port}`;
    const bat = [
      "@echo off",
      `title SA-MP Launcher - ${addr}`,
      "echo Nastroyka nika i podklyuchenie k serveru...",
      `reg add "HKCU\\Software\\SAMP" /v "PlayerName" /t REG_SZ /d "${nick}" /f >nul 2>&1`,
      `set "GTA="`,
      `for /f "tokens=2,*" %%A in ('reg query "HKCU\\Software\\SAMP" /v "gta_sa_exe" 2^>nul ^| find "gta_sa_exe"') do set "GTA=%%B"`,
      `if defined GTA for %%F in ("%GTA%") do set "GTADIR=%%~dpF"`,
      `if defined GTADIR if exist "%GTADIR%samp.exe" (`,
      `  start "" "%GTADIR%samp.exe" "samp://${addr}"`,
      `  exit /b`,
      `)`,
      `start "" "samp://${addr}"`,
      "",
    ].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bat], { type: "application/octet-stream" }));
    a.download = `samp-${nick}-${srv.port}.bat`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Файл скачан, запустите его");
  };

  $("copy").onclick = async () => {
    const txt = $("addr").textContent;
    try { await navigator.clipboard.writeText(txt); }
    catch {
      const t = document.createElement("textarea"); t.value = txt; document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); } catch {} t.remove();
    }
    toast("IP скопирован: " + txt);
  };

  $("modalClose").onclick = () => { $("modal").hidden = true; };
  $("modal").onclick = (e) => { if (e.target.id === "modal") $("modal").hidden = true; };
  $("plSearch").addEventListener("input", renderPlayers);

  // ---- загрузка данных ----
  async function refresh() {
    try { status = await getJSON("data/status.json"); } catch (e) { console.warn(e); }
    try { history = await getJSON("data/history.json"); } catch (e) { console.warn(e); }
    render();
  }

  (async () => {
    try { config = await getJSON("servers.json"); }
    catch (e) { $("hostname").textContent = "Не удалось загрузить servers.json"; return; }
    if (config.clientUrl) { $("clientLink").href = config.clientUrl; $("modalClient").href = config.clientUrl; }
    await refresh();
    setInterval(refresh, REFRESH_MS);
    setInterval(() => { if (status) $("updated").textContent = "обновлено " + ago(status.updatedTs); }, 15_000);
  })();
})();
