/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage.local directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   🌟 快捷访问网站配置 — 在这里增删改你的常用网站
   ---------------------------------------------------------------- */
const QUICK_LINKS = [
  { name: "ChatGPT", url: "https://chatgpt.com", icon: "https://chatgpt.com/favicon.ico" },
  { name: "Claude", url: "https://claude.ai", icon: "https://claude.ai/favicon.ico" },
  { name: "GitHub", url: "https://github.com", icon: "https://github.com/favicon.ico" },
  { name: "Google", url: "https://google.com", icon: "https://www.google.com/favicon.ico" },
  { name: "Gmail", url: "https://mail.google.com", icon: "https://mail.google.com/favicon.ico" },
  { name: "YouTube", url: "https://youtube.com", icon: "https://www.youtube.com/favicon.ico" },
  { name: "X", url: "https://x.com", icon: "https://x.com/favicon.ico" },
  { name: "Notion", url: "https://notion.so", icon: "https://notion.so/favicon.ico" },
];

// 渲染快捷访问栏
function renderQuickLinks() {
  const container = document.getElementById('quickLinksContainer');
  if (!container) return;

  container.innerHTML = QUICK_LINKS.map(link => `
    <div class="quick-link-item" data-url="${link.url}">
      <img class="quick-link-icon" src="${link.icon}" alt="${link.name}" onerror="this.style.display='none'">
      <div class="quick-link-name">${link.name}</div>
    </div>
  `).join('');

  // 点击打开新标签
  document.querySelectorAll('.quick-link-item').forEach(el => {
    el.addEventListener('click', () => {
      chrome.tabs.create({ url: el.dataset.url });
    });
  });
}

/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    openTabs = [];
  }
}

async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  let matches = allTabs.filter(t => t.url === url);

  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local
   ---------------------------------------------------------------- */

async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch { }
}

function shootConfetti(x, y) {
  const colors = [
    '#c8713a', '#e8a070', '#5a7a62', '#8aaa92',
    '#5a6b7a', '#8a9baa', '#d4b896', '#b35a5a',
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');
    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6;
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px;
      width: ${size}px; height: ${size}px; background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none; z-index: 9999;
      transform: translate(-50%, -50%); opacity:1;
    `;
    document.body.appendChild(el);

    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 120;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed - 80;
    const gravity = 200;
    const startTime = performance.now();
    const duration = 700 + Math.random() * 200;

    function frame(now) {
      const elapsed = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);
      if (progress >=1) { el.remove(); return; }
      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed**2;
      const opacity = progress <0.5 ?1 :1-(progress-0.5)*2;
      const rotate = elapsed *200 * (isCircle?0:1);
      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
}

function animateCardOut(card) {
  if (!card) return;
  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width/2, rect.top + rect.height/2);
  card.classList.add('closing');
  setTimeout(()=>{ card.remove(); checkAndShowEmptyState(); },300);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(()=>toast.classList.remove('visible'),2500);
}

function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;
  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining>0) return;
  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;
  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now = new Date();
  const diffMins = Math.floor((now-then)/60000);
  const diffHours = Math.floor((now-then)/3600000);
  const diffDays = Math.floor((now-then)/86400000);
  if (diffMins<1) return 'just now';
  if (diffMins<60) return diffMins+' min ago';
  if (diffHours<24) return diffHours+' hr'+(diffHours!==1?'s':'')+' ago';
  if (diffDays===1) return 'yesterday';
  return diffDays+' days ago';
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour<12) return 'Good morning';
  if (hour<17) return 'Good afternoon';
  return 'Good evening';
}

function getDateDisplay() {
  return new Date().toLocaleDateString('en-US',{
    weekday:'long', year:'numeric', month:'long', day:'numeric'
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

const FRIENDLY_DOMAINS = {
  'github.com':'GitHub','www.github.com':'GitHub','gist.github.com':'GitHub Gist',
  'youtube.com':'YouTube','www.youtube.com':'YouTube','music.youtube.com':'YouTube Music',
  'x.com':'X','www.x.com':'X','twitter.com':'X','www.twitter.com':'X',
  'reddit.com':'Reddit','www.reddit.com':'Reddit','old.reddit.com':'Reddit',
  'substack.com':'Substack','www.substack.com':'Substack',
  'medium.com':'Medium','www.medium.com':'Medium',
  'linkedin.com':'LinkedIn','www.linkedin.com':'LinkedIn',
  'stackoverflow.com':'Stack Overflow','www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com':'Hacker News',
  'google.com':'Google','www.google.com':'Google',
  'mail.google.com':'Gmail','docs.google.com':'Google Docs','drive.google.com':'Google Drive',
  'calendar.google.com':'Google Calendar','meet.google.com':'Google Meet','gemini.google.com':'Gemini',
  'chatgpt.com':'ChatGPT','www.chatgpt.com':'ChatGPT','chat.openai.com':'ChatGPT',
  'claude.ai':'Claude','www.claude.ai':'Claude','code.claude.com':'Claude Code',
  'notion.so':'Notion','www.notion.so':'Notion',
  'figma.com':'Figma','www.figma.com':'Figma',
  'slack.com':'Slack','app.slack.com':'Slack',
  'discord.com':'Discord','www.discord.com':'Discord',
  'wikipedia.org':'Wikipedia','en.wikipedia.org':'Wikipedia',
  'amazon.com':'Amazon','www.amazon.com':'Amazon',
  'netflix.com':'Netflix','www.netflix.com':'Netflix',
  'spotify.com':'Spotify','open.spotify.com':'Spotify',
  'vercel.com':'Vercel','www.vercel.com':'Vercel',
  'npmjs.com':'npm','www.npmjs.com':'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':'arXiv','www.arxiv.org':'arXiv',
  'huggingface.co':'Hugging Face','www.huggingface.co':'Hugging Face',
  'producthunt.com':'Product Hunt','www.producthunt.com':'Product Hunt',
  'xiaohongshu.com':'RedNote','www.xiaohongshu.com':'RedNote',
  'local-files':'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];
  if (hostname.endsWith('.substack.com')&&hostname!=='substack.com'){
    return capitalize(hostname.replace('.substack.com',''))+"'s Substack";
  }
  if (hostname.endsWith('.github.io')){
    return capitalize(hostname.replace('.github.io',''))+' (GitHub Pages)';
  }
  let clean = hostname.replace(/^www\./,'').replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/,'');
  return clean.split('.').map(capitalize).join(' ');
}

function capitalize(str){
  if (!str) return '';
  return str.charAt(0).toUpperCase()+str.slice(1);
}

function stripTitleNoise(title){
  if (!title) return '';
  title = title.replace(/^\(\d+\+?\)\s*/,'');
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g,' ');
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,'');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,'');
  title = title.replace(/\s+on X:\s*/,': ');
  title = title.replace(/\s*\/\s*X\s*$/,'');
  return title.trim();
}

function cleanTitle(title, hostname){
  if (!title||!hostname) return title||'';
  const friendly = friendlyDomain(hostname);
  const domain = hostname.replace(/^www\./,'');
  const seps = [' - ',' | ',' — ',' · ',' – '];
  for (const sep of seps){
    const idx = title.lastIndexOf(sep);
    if (idx===-1) continue;
    const suffix = title.slice(idx+sep.length).trim();
    const suffixLow = suffix.toLowerCase();
    if (
      suffixLow===domain.toLowerCase()||
      suffixLow===friendly.toLowerCase()||
      suffixLow===domain.replace(/\.\w+$/,'').toLowerCase()||
      domain.toLowerCase().includes(suffixLow)||
      friendly.toLowerCase().includes(suffixLow)
    ){
      const cleaned = title.slice(0,idx).trim();
      if (cleaned.length>=5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url){
  if (!url) return title||'';
  let pathname='',hostname='';
  try {const u=new URL(url);pathname=u.pathname;hostname=u.hostname;}catch{}
  const titleIsUrl = !title||title===url||title.startsWith(hostname)||title.startsWith('http');
  if ((hostname==='x.com'||hostname==='twitter.com'||hostname==='www.x.com')&&pathname.includes('/status/')){
    const username=pathname.split('/')[1];
    if (username) return titleIsUrl?`Post by @${username}`:title;
  }
  if (hostname==='github.com'||hostname==='www.github.com'){
    const parts=pathname.split('/').filter(Boolean);
    if (parts.length>=2){
      const [owner,repo,...rest]=parts;
      if (rest[0]==='issues'&&rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0]==='pull'&&rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0]==='blob'||rest[0]==='tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }
  if ((hostname==='www.youtube.com'||hostname==='youtube.com')&&pathname==='/watch'){
    if (titleIsUrl) return 'YouTube Video';
  }
  if ((hostname==='www.reddit.com'||hostname==='reddit.com'||hostname==='old.reddit.com')&&pathname.includes('/comments/')){
    const parts=pathname.split('/').filter(Boolean);
    const subIdx=parts.indexOf('r');
    if (subIdx!==-1&&parts[subIdx+1]){
      if (titleIsUrl) return `r/${parts[subIdx+1]} post`;
    }
  }
  return title||url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504-1.125 1.125 1.125Z" /></svg>`,
  focus: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   Filter real tabs
   ---------------------------------------------------------------- */
function getRealTabs(){
  return openTabs.filter(t=>{
    const url=t.url||'';
    return (
      !url.startsWith('chrome://')&&
      !url.startsWith('chrome-extension://')&&
      !url.startsWith('about:')&&
      !url.startsWith('edge://')&&
      !url.startsWith('brave://')
    );
  });
}

function checkTabOutDupes(){
  const tabOutTabs=openTabs.filter(t=>t.isTabOut);
  const banner=document.getElementById('tabOutDupeBanner');
  const countEl=document.getElementById('tabOutDupeCount');
  if (!banner) return;
  if (tabOutTabs.length>1){
    if (countEl) countEl.textContent=tabOutTabs.length;
    banner.style.display='flex';
  }else{
    banner.style.display='none';
  }
}


/* ----------------------------------------------------------------
   Overflow chips
   ---------------------------------------------------------------- */
function buildOverflowChips(hiddenTabs, urlCounts={}){
  const hiddenChips=hiddenTabs.map(tab=>{
    const label=cleanTitle(smartTitle(stripTitleNoise(tab.title||''),tab.url),'');
    const count=urlCounts[tab.url]||1;
    const dupeTag=count>1?` <span class="chip-dupe-badge">(${count}x)</span>`:'';
    const chipClass=count>1?' chip-has-dupes':'';
    const safeUrl=(tab.url||'').replace(/"/g,'&quot;');
    const safeTitle=label.replace(/"/g,'&quot;');
    let domain='';try{domain=new URL(tab.url).hostname;}catch{}
    const faviconUrl=domain?`https://www.google.com/s2/favicons?domain=${domain}&sz=16`:'';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl?`<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">`:''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');
  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   Domain card renderer
   ---------------------------------------------------------------- */
function renderDomainCard(group){
  const tabs=group.tabs||[];
  const tabCount=tabs.length;
  const isLanding=group.domain==='__landing-pages__';
  const stableId='domain-'+group.domain.replace(/[^a-z0-9]/g,'-');

  const urlCounts={};
  for (const tab of tabs) urlCounts[tab.url]=(urlCounts[tab.url]||0)+1;
  const dupeUrls=Object.entries(urlCounts).filter(([,c])=>c>1);
  const hasDupes=dupeUrls.length>0;
  const totalExtras=dupeUrls.reduce((s,[,c])=>s+c-1,0);

  const tabBadge=`<span class="open-tabs-badge">${ICONS.tabs}${tabCount} tab${tabCount!==1?'s':''} open</span>`;
  const dupeBadge=hasDupes?`<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">${totalExtras} duplicate${totalExtras!==1?'s':''}</span>`:'';

  const seen=new Set();
  const uniqueTabs=[];
  for (const tab of tabs) if (!seen.has(tab.url)){seen.add(tab.url);uniqueTabs.push(tab);}

  const visibleTabs=uniqueTabs.slice(0,8);
  const extraCount=uniqueTabs.length-visibleTabs.length;

  const pageChips=visibleTabs.map(tab=>{
    let label=cleanTitle(smartTitle(stripTitleNoise(tab.title||''),tab.url),group.domain);
    try{const p=new URL(tab.url);if(p.hostname==='localhost'&&p.port)label=`${p.port} ${label}`;}catch{}
    const count=urlCounts[tab.url];
    const dupeTag=count>1?` <span class="chip-dupe-badge">(${count}x)</span>`:'';
    const chipClass=count>1?' chip-has-dupes':'';
    const safeUrl=(tab.url||'').replace(/"/g,'&quot;');
    const safeTitle=label.replace(/"/g,'&quot;');
    let domain='';try{domain=new URL(tab.url).hostname;}catch{}
    const faviconUrl=domain?`https://www.google.com/s2/favicons?domain=${domain}&sz=16`:'';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl?`<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">`:''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('')+(extraCount>0?buildOverflowChips(uniqueTabs.slice(8),urlCounts):'');

  let actionsHtml=`
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close} Close all ${tabCount} tab${tabCount!==1?'s':''}
    </button>`;

  if (hasDupes){
    const dupeUrlsEncoded=dupeUrls.map(([u])=>encodeURIComponent(u)).join(',');
    actionsHtml+=`
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras!==1?'s':''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes?'has-amber-bar':'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding?'Homepages':(group.label||friendlyDomain(group.domain))}</span>
          ${tabBadge}${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   Saved for later column
   ---------------------------------------------------------------- */
async function renderDeferredColumn(){
  const col=document.getElementById('deferredColumn');
  const list=document.getElementById('deferredList');
  const empty=document.getElementById('deferredEmpty');
  const count=document.getElementById('deferredCount');
  const archive=document.getElementById('deferredArchive');
  const archiveCount=document.getElementById('archiveCount');
  const archiveList=document.getElementById('archiveList');
  if (!col) return;
  try{
    const {active,archived}=await getSavedTabs();
    if (active.length===0&&archived.length===0){col.style.display='none';return;}
    col.style.display='block';
    if (active.length>0){
      count.textContent=`${active.length} item${active.length!==1?'s':''}`;
      list.innerHTML=active.map(renderDeferredItem).join('');
      list.style.display='block';empty.style.display='none';
    }else{
      list.style.display='none';count.textContent='';empty.style.display='block';
    }
    if (archived.length>0){
      archiveCount.textContent=`(${archived.length})`;
      archiveList.innerHTML=archived.map(renderArchiveItem).join('');
      archive.style.display='block';
    }else{archive.style.display='none';}
  }catch(err){console.warn(err);col.style.display='none';}
}

function renderDeferredItem(item){
  let domain='';try{domain=new URL(item.url).hostname.replace(/^www\./,'');}catch{}
  const fav=`https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago=timeAgo(item.savedAt);
  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title||'').replace(/"/g,'&quot;')}">
          <img src="${fav}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title||item.url}
        </a>
        <div class="deferred-meta"><span>${domain}</span><span>${ago}</span></div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

function renderArchiveItem(item){
  const ago=item.completedAt?timeAgo(item.completedAt):timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title">${item.title||item.url}</a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   Main render
   ---------------------------------------------------------------- */
async function renderStaticDashboard(){
  const greet=document.getElementById('greeting');
  const date=document.getElementById('dateDisplay');
  if (greet) greet.textContent=getGreeting();
  if (date) date.textContent=getDateDisplay();

  // 👇 在这里渲染快捷访问栏
  renderQuickLinks();

  await fetchOpenTabs();
  const realTabs=getRealTabs();

  const LANDING_PAGE_PATTERNS=[
    {hostname:'mail.google.com',test:(p,h)=>!h.includes('#inbox/')&&!h.includes('#sent/')&&!h.includes('#search/')},
    {hostname:'x.com',pathExact:['/home']},
    {hostname:'www.linkedin.com',pathExact:['/']},
    {hostname:'github.com',pathExact:['/']},
    {hostname:'www.youtube.com',pathExact:['/']},
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS!=='undefined'?LOCAL_LANDING_PAGE_PATTERNS:[]),
  ];

  function isLandingPage(url){
    try{
      const p=new URL(url);
      return LANDING_PAGE_PATTERNS.some(rule=>{
        const hostMatch=rule.hostname?p.hostname===rule.hostname:rule.hostnameEndsWith?p.hostname.endsWith(rule.hostnameEndsWith):false;
        if (!hostMatch) return false;
        if (rule.test) return rule.test(p.pathname,url);
        if (rule.pathPrefix) return p.pathname.startsWith(rule.pathPrefix);
        if (rule.pathExact) return rule.pathExact.includes(p.pathname);
        return p.pathname==='/';
      });
    }catch{return false;}
  }

  domainGroups=[];
  const groupMap={};
  const landingTabs=[];
  const customGroups=typeof LOCAL_CUSTOM_GROUPS!=='undefined'?LOCAL_CUSTOM_GROUPS:[];

  function matchCustomGroup(url){
    try{
      const p=new URL(url);
      return customGroups.find(r=>{
        const hostMatch=r.hostname?p.hostname===r.hostname:r.hostnameEndsWith?p.hostname.endsWith(r.hostnameEndsWith):false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return p.pathname.startsWith(r.pathPrefix);
        return true;
      })||null;
    }catch{return null;}
  }

  for (const tab of realTabs){
    try{
      if (isLandingPage(tab.url)){landingTabs.push(tab);continue;}
      const custom=matchCustomGroup(tab.url);
      if (custom){
        const k=custom.groupKey;
        if (!groupMap[k]) groupMap[k]={domain:k,label:custom.groupLabel,tabs:[]};
        groupMap[k].tabs.push(tab);continue;
      }
      let host;
      if (tab.url.startsWith('file://')) host='local-files';
      else host=new URL(tab.url).hostname;
      if (!host) continue;
      if (!groupMap[host]) groupMap[host]={domain:host,tabs:[]};
      groupMap[host].tabs.push(tab);
    }catch{}
  }

  if (landingTabs.length>0) groupMap['__landing-pages__']={domain:'__landing-pages__',tabs:landingTabs};

  const landingHosts=new Set(LANDING_PAGE_PATTERNS.map(p=>p.hostname).filter(Boolean));
  const landingSuffix=LANDING_PAGE_PATTERNS.map(p=>p.hostnameEndsWith).filter(Boolean);
  function isPriority(host){
    if (landingHosts.has(host)) return true;
    return landingSuffix.some(s=>host.endsWith(s));
  }

  domainGroups=Object.values(groupMap).sort((a,b)=>{
    const aLand=a.domain==='__landing-pages__';
    const bLand=b.domain==='__landing-pages__';
    if (aLand!==bLand) return aLand?-1:1;
    const aP=isPriority(a.domain);
    const bP=isPriority(b.domain);
    if (aP!==bP) return aP?-1:1;
    return b.tabs.length-a.tabs.length;
  });

  const section=document.getElementById('openTabsSection');
  const listEl=document.getElementById('openTabsMissions');
  const countEl=document.getElementById('openTabsSectionCount');
  const titleEl=document.getElementById('openTabsSectionTitle');

  if (domainGroups.length>0&&section){
    if (titleEl) titleEl.textContent='Open tabs';
    countEl.innerHTML=`${domainGroups.length} domain${domainGroups.length!==1?'s':''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    listEl.innerHTML=domainGroups.map(g=>renderDomainCard(g)).join('');
    section.style.display='block';
  }else if (section) section.style.display='none';

  const stat=document.getElementById('statTabs');
  if (stat) stat.textContent=openTabs.length;

  checkTabOutDupes();
  await renderDeferredColumn();
}

async function renderDashboard(){
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   Event handlers
   ---------------------------------------------------------------- */
document.addEventListener('click',async(e)=>{
  const el=e.target.closest('[data-action]');
  if (!el) return;
  const act=el.dataset.action;
  const card=el.closest('.mission-card');

  if (act==='close-tabout-dupes'){
    await closeTabOutDupes();
    playCloseSound();
    const banner=document.getElementById('tabOutDupeBanner');
    if (banner){banner.style.transition='opacity 0.4s';banner.style.opacity='0';setTimeout(()=>{banner.style.display='none';banner.style.opacity='1';},400);}
    showToast('Closed extra Tab Out tabs');
    return;
  }

  if (act==='expand-chips'){
    const over=el.parentElement.querySelector('.page-chips-overflow');
    if (over){over.style.display='contents';el.remove();}
    return;
  }

  if (act==='focus-tab'){
    await focusTab(el.dataset.tabUrl);
    return;
  }

  if (act==='close-single-tab'){
    e.stopPropagation();
    const url=el.dataset.tabUrl;
    if (!url) return;
    const all=await chrome.tabs.query({});
    const m=all.find(t=>t.url===url);
    if (m) await chrome.tabs.remove(m.id);
    await fetchOpenTabs();
    playCloseSound();
    const chip=el.closest('.page-chip');
    if (chip){
      const r=chip.getBoundingClientRect();
      shootConfetti(r.left+r.width/2,r.top+r.height/2);
      chip.style.transition='opacity 0.2s, transform 0.2s';
      chip.style.opacity='0';chip.style.transform='scale(0.8)';
      setTimeout(()=>{
        chip.remove();
        document.querySelectorAll('.mission-card:has(.mission-pages:empty)').forEach(c=>animateCardOut(c));
      },200);
    }
    const s=document.getElementById('statTabs');
    if (s) s.textContent=openTabs.length;
    showToast('Tab closed');
    return;
  }

  if (act==='defer-single-tab'){
    e.stopPropagation();
    const u=el.dataset.tabUrl;const t=el.dataset.tabTitle||u;
    if (!u) return;
    await saveTabForLater({url:u,title:t});
    const all=await chrome.tabs.query({});
    const m=all.find(t=>t.url===u);
    if (m) await chrome.tabs.remove(m.id);
    await fetchOpenTabs();
    const chip=el.closest('.page-chip');
    if (chip){chip.style.transition='opacity 0.2s, transform 0.2s';chip.style.opacity='0';chip.style.transform='scale(0.8)';setTimeout(()=>chip.remove(),200);}
    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  if (act==='check-deferred'){
    await checkOffSavedTab(el.dataset.deferredId);
    const item=el.closest('.deferred-item');
    if (item){item.classList.add('checked');setTimeout(()=>{item.classList.add('removing');setTimeout(()=>{item.remove();renderDeferredColumn();},300);},800);}
    return;
  }

  if (act==='dismiss-deferred'){
    await dismissSavedTab(el.dataset.deferredId);
    const item=el.closest('.deferred-item');
    if (item){item.classList.add('removing');setTimeout(()=>{item.remove();renderDeferredColumn();},300);}
    return;
  }

  if (act==='close-domain-tabs'){
    const id=el.dataset.domainId;
    const g=domainGroups.find(gg=>'domain-'+gg.domain.replace(/[^a-z0-9]/g,'-')===id);
    if (!g) return;
    const urls=g.tabs.map(t=>t.url);
    const exact=g.domain==='__landing-pages__'||!!g.label;
    if (exact) await closeTabsExact(urls);
    else await closeTabsByUrls(urls);
    if (card){playCloseSound();animateCardOut(card);}
    const i=domainGroups.indexOf(g);
    if (i!==-1) domainGroups.splice(i,1);
    const label=g.domain==='__landing-pages__'?'Homepages':(g.label||friendlyDomain(g.domain));
    showToast(`Closed ${urls.length} tab${urls.length!==1?'s':''} from ${label}`);
    const s=document.getElementById('statTabs');
    if (s) s.textContent=openTabs.length;
    return;
  }

  if (act==='dedup-keep-one'){
    const us=el.dataset.dupeUrls||'';
    const urls=us.split(',').map(decodeURIComponent).filter(Boolean);
    if (urls.length===0) return;
    await closeDuplicateTabs(urls,true);
    playCloseSound();
    el.style.transition='opacity 0.2s';el.style.opacity='0';setTimeout(()=>el.remove(),200);
    if (card){
      card.querySelectorAll('.chip-dupe-badge,.open-tabs-badge:contains(duplicate)').forEach(b=>{b.style.transition='opacity 0.2s';b.style.opacity='0';setTimeout(()=>b.remove(),200);});
      card.classList.remove('has-amber-bar');card.classList.add('has-neutral-bar');
    }
    showToast('Closed duplicates, kept one copy each');
    return;
  }

  if (act==='close-all-open-tabs'){
    const all=openTabs.filter(t=>t.url&&!t.url.startsWith('chrome')&&!t.url.startsWith('about:')).map(t=>t.url);
    await closeTabsByUrls(all);
    playCloseSound();
    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c=>{
      shootConfetti(c.getBoundingClientRect().left+c.offsetWidth/2,c.getBoundingClientRect().top+c.offsetHeight/2);
      animateCardOut(c);
    });
    showToast('All tabs closed. Fresh start.');
    return;
  }
});

document.addEventListener('click',(e)=>{
  const t=e.target.closest('#archiveToggle');
  if (!t) return;
  t.classList.toggle('open');
  const b=document.getElementById('archiveBody');
  if (b) b.style.display=b.style.display==='none'?'block':'none';
});

document.addEventListener('input',async(e)=>{
  if (e.target.id!=='archiveSearch') return;
  const q=e.target.value.trim().toLowerCase();
  const list=document.getElementById('archiveList');
  if (!list) return;
  try{
    const {archived}=await getSavedTabs();
    if (q.length<2){list.innerHTML=archived.map(renderArchiveItem).join('');return;}
    const res=archived.filter(i=>(i.title||'').toLowerCase().includes(q)||(i.url||'').toLowerCase().includes(q));
    list.innerHTML=res.map(renderArchiveItem).join('')||'<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  }catch(err){console.warn(err);}
});


/* ----------------------------------------------------------------
   INIT
   ---------------------------------------------------------------- */
renderDashboard();
