import {ArchiveClient} from "./archive-client.js";

const $ = (selector) => document.querySelector(selector);
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  comment: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-9.5A8.5 8.5 0 0 1 11.5 3h1a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 9h10M7 13h7"/>',
  post: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  archive: '<rect x="3" y="3" width="18" height="5" rx="1.5"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4"/>',
  search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  sort: '<path d="M8 4v16m-4-4 4 4 4-4M15 5h6M15 10h4M15 15h2"/>',
  up: '<path d="m6 11 6-6 6 6M12 5v14"/>',
  external: '<path d="M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.post}</svg>`;
document.querySelectorAll("[data-icon]").forEach((node) => { node.innerHTML = icon(node.dataset.icon); });
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
const number = (value) => new Intl.NumberFormat("bg-BG").format(value);
const date = (value, long = false) => new Intl.DateTimeFormat("bg-BG", {day:"numeric", month:long ? "long" : "short", year:"numeric", timeZone:"Europe/Sofia"}).format(new Date(value * 1000));
const labels = {all:"Всичко", comment:"Коментари", post:"Постове"};
let state = {type:"all", q:"", subreddit:"", year:"", sort:"newest", page:1};
let meta, searchTimer, listController, detailController, backend;
let selectedItem = "";

function readState() {
  const params = new URLSearchParams(location.search);
  state = {
    type: ["all", "post", "comment"].includes(params.get("type")) ? params.get("type") : "all",
    q: (params.get("q") || "").slice(0, 500), subreddit: params.get("subreddit") || "",
    year: params.get("year") || "",
    sort: ["newest", "oldest", "top", "bottom"].includes(params.get("sort")) ? params.get("sort") : "newest",
    page: Math.max(1, parseInt(params.get("page"), 10) || 1),
  };
}

function syncUrl(item = selectedItem, push = false) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) {
    if (value && !(key === "type" && value === "all") && !(key === "sort" && value === "newest") && !(key === "page" && value === 1)) params.set(key, value);
  }
  if (item) params.set("item", item);
  const query = params.toString();
  history[push ? "pushState" : "replaceState"](null, "", location.pathname + (query ? `?${query}` : ""));
}

function highlight(text) {
  if (!state.q.trim()) return escape(text);
  const terms = [...new Set(state.q.trim().split(/\s+/))].sort((a,b) => b.length - a.length);
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  let result = "", offset = 0;
  for (const match of String(text).matchAll(pattern)) {
    result += escape(text.slice(offset, match.index)) + `<mark>${escape(match[0])}</mark>`;
    offset = match.index + match[0].length;
  }
  return result + escape(text.slice(offset));
}

function urlAllowed(url) {
  try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; }
}

function external(url, text, className = "") {
  return urlAllowed(url) ? `<a class="${className}" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${text}</a>` : "";
}

function inline(text) {
  // Only explicit HTTP(S) links become HTML; archive HTML is always escaped.
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g;
  let result = "", offset = 0;
  for (const match of text.matchAll(pattern)) {
    result += highlight(text.slice(offset, match.index));
    result += external(match[2] || match[3], highlight(match[1] || match[3]));
    offset = match.index + match[0].length;
  }
  result += highlight(text.slice(offset));
  return result;
}

function bodyHtml(text) {
  if (!text.trim()) return '<p class="removed">Този пост няма допълнителен текст. Виж оригиналния линк по-долу.</p>';
  if (["[deleted]", "[removed]"].includes(text.trim())) return '<p class="removed">Съдържанието е изтрито или премахнато в източника.</p>';
  return text.split(/\n\s*\n/).map((paragraph) => {
    if (/^\s*>/.test(paragraph)) return `<blockquote>${inline(paragraph.replace(/^\s*> ?/gm, ""))}</blockquote>`;
    if (/^#{1,6}\s/.test(paragraph)) return `<h3>${inline(paragraph.replace(/^#{1,6}\s/, ""))}</h3>`;
    return `<p>${inline(paragraph)}</p>`;
  }).join("");
}

function renderCommunityButtons() {
  $("#communities").innerHTML = meta.communities.slice(0, 6).map((community, index) => `<button class="community-button ${state.subreddit === community.name ? "active" : ""}" data-community="${escape(community.name)}" aria-pressed="${state.subreddit === community.name}"><span class="community-symbol tone-${index % 4}">${escape(community.name.slice(0, 1).toUpperCase())}</span><span>r/${escape(community.name)}</span><span class="nav-count">${number(community.count)}</span></button>`).join("");
}

function renderControls() {
  for (const key of ["q", "subreddit", "year", "sort"]) {
    const element = $(key === "q" ? "#search" : `#${key}`);
    if (element.value !== String(state[key])) element.value = state[key];
  }
  document.querySelectorAll("[data-type]").forEach((button) => {
    button.classList.toggle("active", button.dataset.type === state.type);
    button.setAttribute("aria-pressed", String(button.dataset.type === state.type));
    if (button.classList.contains("nav-item")) {
      if (button.dataset.type === state.type) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
  $("#breadcrumb").textContent = labels[state.type];
  const filtered = state.q || state.subreddit || state.year;
  $("#results-title").textContent = filtered ? "Резултати от архива" : state.type === "all" ? (state.sort === "newest" ? "Последна активност" : "Всички записи") : labels[state.type];
  const chips = [["q", state.q && `Търсене: ${state.q}`], ["subreddit", state.subreddit && `r/${state.subreddit}`], ["year", state.year]];
  $("#active-filters").hidden = !filtered;
  $("#active-filters").innerHTML = chips.filter(([, value]) => value).map(([key, value]) => `<button class="filter-chip" data-clear="${key}" aria-label="Премахни ${escape(value)}">${escape(value)}${icon("close")}</button>`).join("") + '<button class="clear-filters" data-reset>Изчисти филтрите</button>';
  renderCommunityButtons();
}

function renderCard(item) {
  const isPost = item.kind === "post";
  const removed = ["[deleted]", "[removed]"].includes(item.body.trim());
  let domain = "";
  if (urlAllowed(item.source_url)) domain = new URL(item.source_url).hostname.replace(/^www\./, "");
  return `<article class="entry-card">
    <div class="score ${item.score < 0 ? "negative" : ""}" aria-label="Оценка: ${escape(item.score)}" title="Оценка при архивиране">${icon("up")}<span>${number(item.score)}</span></div>
    <div class="entry-content"><div class="entry-meta"><button class="subreddit-link" data-community="${escape(item.subreddit)}">r/${escape(item.subreddit)}</button><span class="meta-dot">•</span><time datetime="${new Date(item.created * 1000).toISOString()}">${date(item.created)}</time><span class="type-badge ${isPost ? "post" : ""}">${icon(item.kind)}${isPost ? "Пост" : "Коментар"}</span></div>
    ${isPost ? `<button class="post-title" data-open="${escape(item.id)}">${highlight(item.title)}</button>` : item.context ? `<button class="context-title" data-open="${escape(item.id)}" title="${escape(item.context)}"><span>В дискусията · </span>${highlight(item.context)}</button>` : ""}
    ${item.body ? `<p class="body-preview ${removed ? "removed" : ""}">${removed ? "Съдържанието е премахнато в източника." : highlight(item.body)}${item.truncated ? "…" : ""}</p>` : domain ? `<div class="external-domain">${icon("link")}${escape(domain)}</div>` : '<p class="body-preview removed">Пост без допълнителен текст.</p>'}
    <div class="entry-footer"><span>u/${escape(item.author)}</span>${isPost ? `<span class="reply-count">${icon("comment")}${number(item.num_comments)}</span>` : ""}${external(item.reddit_url, `В Reddit ${icon("external")}`, "reddit-link")}<button class="read-more" data-open="${escape(item.id)}" aria-label="Прочети ${isPost ? "поста" : "коментара"} от ${escape(date(item.created))}">Прочети ${icon("arrow")}</button></div></div></article>`;
}

function renderPagination(data) {
  const pagination = $("#pagination");
  pagination.hidden = data.pages <= 1;
  const pages = [...new Set([1, data.page - 1, data.page, data.page + 1, data.pages])].filter((page) => page >= 1 && page <= data.pages).sort((a,b) => a-b);
  let buttons = `<button class="page-button" data-page="${data.page - 1}" aria-label="Предишна страница" ${data.page === 1 ? "disabled" : ""}>←</button>`;
  pages.forEach((page, index) => {
    if (index && page - pages[index-1] > 1) buttons += '<span class="page-ellipsis">…</span>';
    buttons += `<button class="page-button ${page === data.page ? "active" : ""}" data-page="${page}" ${page === data.page ? 'aria-current="page"' : ""} aria-label="Страница ${page}">${number(page)}</button>`;
  });
  buttons += `<button class="page-button" data-page="${data.page + 1}" aria-label="Следваща страница" ${data.page === data.pages ? "disabled" : ""}>→</button>`;
  pagination.innerHTML = `<span>${number((data.page-1)*data.page_size+1)}–${number(Math.min(data.page*data.page_size, data.total))} от ${number(data.total)} записа</span><div class="page-buttons">${buttons}</div>`;
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {signal, cache: "no-cache"});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Неуспешно зареждане.");
  return data;
}

function archiveStatus(data) {
  const status = $("#archive-status");
  status.hidden = false;
  status.dataset.state = data.state;
  $("#retry-archive").hidden = data.state !== "error";
  const progress = $("#archive-progress");
  progress.hidden = ["ready", "error"].includes(data.state);
  const mb = (bytes) => (bytes / 1_000_000).toLocaleString("bg-BG", {maximumFractionDigits:1});
  if (data.state === "loading") {
    progress.value = data.total ? Math.round(data.loaded / data.total * 100) : 0;
    $("#archive-status-text").textContent = `Подготвяме търсенето · ${mb(data.loaded)} / ${mb(data.total)} MB`;
  } else if (data.state === "indexing") {
    progress.removeAttribute("value");
    $("#archive-status-text").textContent = "Данните са заредени. Подготвяме търсенето…";
  } else if (data.state === "ready") {
    $("#archive-status-text").textContent = data.cached === data.chunks ? "Готово за търсене · архивът е зареден от кеша" : "Целият архив е готов за търсене";
  } else if (data.state === "error") {
    $("#archive-status-text").textContent = data.message;
  }
}

async function loadItems(scroll = false) {
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  $("#results").setAttribute("aria-busy", "true");
  $("#result-count").textContent = "Търсене…";
  try {
    const data = await backend.query({...state}, controller.signal);
    if (controller.signal.aborted) return;
    state.page = data.page;
    syncUrl();
    $("#result-count").textContent = `${number(data.total)} ${data.total === 1 ? "запис" : "записа"}`;
    $("#results").innerHTML = data.items.length ? data.items.map(renderCard).join("") : `${emptyState("Няма намерени разговори", "Опитай с друга дума или премахни някой от филтрите.", "Изчисти филтрите", "data-reset")}`;
    renderPagination(data);
    if (scroll) $(".browser-section").scrollIntoView({block:"start", behavior:"instant"});
  } catch (error) {
    if (error.name === "AbortError") return;
    $("#result-count").textContent = "Няма връзка с архива";
    $("#results").innerHTML = emptyState("Архивът не се зареди", "Провери интернет връзката и опитай отново.", "Опитай отново", "data-retry");
    $("#pagination").hidden = true;
  } finally {
    if (listController === controller) $("#results").setAttribute("aria-busy", "false");
  }
}

function emptyState(title, description, action, attribute) {
  return `<div class="empty-state">${icon("search")}<h3>${title}</h3><p>${description}</p><button class="primary-button" ${attribute}>${action}</button></div>`;
}

function changeState(patch, scroll = false) {
  clearTimeout(searchTimer);
  state = {...state, q:$("#search").value.trim(), page:1, ...patch};
  renderControls();
  syncUrl();
  loadItems(scroll);
}

async function openDetail(id, push = true) {
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  selectedItem = id;
  if (push) syncUrl(id, true);
  $("#detail-content").innerHTML = '<h2 id="detail-title" class="detail-title">Зареждане…</h2><div class="loading-state"><span class="spinner"></span>Отваряме записа…</div>';
  if (!$("#detail").open) $("#detail").showModal();
  document.body.style.overflow = "hidden";
  $("#detail").scrollTop = 0;
  try {
    const item = await backend.detail(id, controller.signal);
    if (controller.signal.aborted) return;
    const isPost = item.kind === "post";
    $("#detail-content").innerHTML = `<div class="detail-meta"><span class="type-badge ${isPost ? "post" : ""}">${icon(item.kind)}${isPost ? "Пост" : "Коментар"}</span><strong>r/${escape(item.subreddit)}</strong><span>${date(item.created, true)}</span></div>
      <h2 class="detail-title" id="detail-title">${isPost ? highlight(item.title) : "Коментар от u/" + escape(item.author)}</h2>
      ${item.context ? `<div class="detail-context"><small>В ДИСКУСИЯТА</small>${highlight(item.context)}${item.post ? `<button class="parent-link" data-open="${escape(item.post.id)}">Отвори поста от архива ${"↗"}</button>` : ""}</div>` : ""}
      <div class="detail-body">${bodyHtml(item.body)}</div>
      <div class="detail-stats"><span><strong>${number(item.score)}</strong> оценка</span>${isPost ? `<span><strong>${number(item.num_comments)}</strong> коментара в Reddit</span>` : ""}<span>u/${escape(item.author)}</span></div>
      <div class="detail-actions">${external(item.reddit_url, `Отвори в Reddit ${icon("external")}`, "primary-button")}${isPost && item.source_url !== item.reddit_url ? external(item.source_url, `Оригинален линк ${icon("link")}`, "secondary-button") : ""}</div>
      ${item.parent && item.parent.id !== item.post?.id ? `<div class="detail-context"><small>ОТГОВОР КЪМ ЗАПАЗЕН КОМЕНТАР</small>${escape(item.parent.body.slice(0,180))}${item.parent.body.length > 180 ? "…" : ""}<button class="parent-link" data-open="${escape(item.parent.id)}">Виж предишния коментар ↗</button></div>` : ""}
      <p class="record-id">ID: ${escape(item.id)} · Оценката е запазена към момента на архивиране.</p>`;
  } catch (error) {
    if (error.name === "AbortError") return;
    $("#detail-content").innerHTML = `<h2 class="detail-title" id="detail-title">Записът не се зареди</h2><p>${escape(error.message)}</p><button class="primary-button" data-open="${escape(id)}">Опитай отново</button>`;
  }
}

function closeDetail(updateUrl = true) {
  detailController?.abort();
  selectedItem = "";
  $("#detail").close();
  document.body.style.overflow = "";
  if (updateUrl) syncUrl("");
}

async function initialize() {
  try {
    const manifest = await fetchJson(new URL("./bootstrap.json", import.meta.url));
    meta = manifest.meta;
    backend = new ArchiveClient(manifest, archiveStatus);
    for (const field of ["total", "comments", "posts"]) {
      $(`#stat-${field}`).textContent = number(meta[field]);
      $(`#nav-${field}`).textContent = number(meta[field]);
    }
    $("#community-count").textContent = meta.communities.length;
    $("#date-range").textContent = meta.total ? `${date(meta.first, true)} — ${date(meta.last, true)}` : "Няма записи в архива";
    $("#subreddit").innerHTML = '<option value="">Всички общности</option>' + meta.communities.map((community) => `<option value="${escape(community.name)}">r/${escape(community.name)} (${number(community.count)})</option>`).join("");
    $("#year").innerHTML = '<option value="">Всички години</option>' + meta.years.map((year) => `<option value="${year}">${year}</option>`).join("");
    readState();
    if (!meta.communities.some((x) => x.name === state.subreddit)) state.subreddit = "";
    if (!meta.years.includes(Number(state.year))) state.year = "";
    selectedItem = new URLSearchParams(location.search).get("item") || "";
    renderControls();
    await loadItems();
    // The small initial page is rendered before background archive loading starts.
    requestAnimationFrame(() => backend.start());
    if (selectedItem) openDetail(selectedItem, false);
  } catch {
    $("#date-range").textContent = "Няма връзка с архива";
    $("#result-count").textContent = "Неуспешно зареждане";
    $("#results").setAttribute("aria-busy", "false");
    $("#results").innerHTML = emptyState("Архивът не се зареди", "Провери интернет връзката и опитай отново.", "Опитай отново", "data-retry-init");
  }
}

$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  // Cancel the previous search immediately, before the debounce elapses.
  listController?.abort();
  searchTimer = setTimeout(() => changeState({q:$("#search").value.trim()}), 220);
});
$("#search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") changeState({q:$("#search").value.trim()});
});
for (const key of ["subreddit", "year", "sort"]) $(`#${key}`).addEventListener("change", (event) => changeState({[key]:event.target.value}));
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.hasAttribute("data-retry-init")) { initialize(); return; }
  if (!meta) return;
  if (button.dataset.type) changeState({type:button.dataset.type});
  if (button.hasAttribute("data-community")) changeState({subreddit:state.subreddit === button.dataset.community ? "" : button.dataset.community});
  if (button.dataset.open) openDetail(button.dataset.open);
  if (button.dataset.page) changeState({page:Number(button.dataset.page)}, true);
  if (button.dataset.clear) changeState({[button.dataset.clear]:""});
  if (button.hasAttribute("data-reset")) changeState({q:"", subreddit:"", year:""});
  if (button.hasAttribute("data-retry")) loadItems();
});
$("#all-communities").addEventListener("click", () => {
  $("#subreddit").scrollIntoView({block:"center", behavior:"instant"});
  $("#subreddit").focus();
  try { $("#subreddit").showPicker(); } catch { /* Focus is the fallback for older browsers. */ }
});
$("#close-detail").addEventListener("click", () => closeDetail());
$("#retry-archive").addEventListener("click", () => { backend?.start(); if (backend) loadItems(); });
$("#detail").addEventListener("cancel", (event) => { event.preventDefault(); closeDetail(); });
$("#detail").addEventListener("click", (event) => { if (event.target === $("#detail") && event.clientX < $("#detail").getBoundingClientRect().left) closeDetail(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$("#detail").open && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault(); $("#search").focus();
  }
});
window.addEventListener("popstate", () => {
  if (!meta) return;
  readState(); renderControls();
  const item = new URLSearchParams(location.search).get("item");
  if (item) openDetail(item, false); else closeDetail(false);
  loadItems();
});
initialize();
