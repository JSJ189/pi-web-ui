/** Static trusted markup. Credentials remain exclusively in noVNC's RFB exchange. */
export function desktopPage(): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote desktop</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101827;color:#e5edf8}*{box-sizing:border-box}body{margin:0;min-width:0}main{display:flex;flex-direction:column;height:100dvh;min-width:0;max-width:100%;padding:12px;gap:10px}h1{font-size:18px;margin:0}h2{font-size:14px;margin:0}header,nav,form,.setup-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;max-width:100%}button,input{font:inherit;padding:7px 10px;border:1px solid #657287;border-radius:5px;background:#202f45;color:#fff}button:disabled{opacity:.5}label{display:flex;align-items:center;gap:5px;min-width:0}input:not([type=checkbox]){min-width:0;max-width:100%;width:180px}p,li{margin:0;overflow-wrap:anywhere;word-break:break-word;font-size:13px}#screen{flex:1;min-width:0;min-height:150px;overflow:hidden;background:#000}#screen:fullscreen{height:100%;width:100%}[hidden]{display:none!important}#status,#setup-status{white-space:pre-wrap}button:focus-visible,input:focus-visible{outline:2px solid #8cc8ff}form,#setup{padding:8px;border:1px solid #657287}#setup{display:grid;gap:8px;min-width:0;max-width:100%}ol{margin:0;padding-left:24px}li+li{margin-top:6px}#install-log{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-height:160px;overflow:auto;overscroll-behavior:contain;font-size:12px}
</style></head><body><main>
<header><h1 data-i18n="title"></h1><button id="connect" disabled data-i18n="connect"></button><button id="disconnect" disabled data-i18n="disconnect"></button></header>
<p id="status" role="status" aria-live="polite"></p>
<section id="setup" aria-labelledby="setup-title">
<h2 id="setup-title" data-i18n="setup"></h2>
<ol><li id="assets-step"></li><li><p data-i18n="vncStep"></p><p id="platform-guide"></p><p id="vnc-state"></p></li><li id="enable-step"></li></ol>
<div class="setup-actions"><button id="check" data-i18n="check"></button><button id="install" disabled data-i18n="install"></button><button id="enable" disabled data-i18n="enable"></button><button id="disable" disabled data-i18n="disable"></button></div>
<p id="setup-status" role="status" aria-live="polite"></p><pre id="install-log" hidden></pre>
</section>
<p data-i18n="permission"></p>
<nav id="desktop-controls"><label><input id="viewonly" type="checkbox" checked><span data-i18n="viewonly"></span></label><label><input id="scale" type="checkbox" checked><span data-i18n="scale"></span></label><button id="fullscreen" data-i18n="fullscreen"></button><button id="cad" disabled>Ctrl Alt Del</button><button id="tab" disabled>Tab</button><button id="esc" disabled>Esc</button></nav>
<form id="credentials" hidden autocomplete="off"><label id="username-label" hidden><span data-i18n="username"></span><input id="username" autocomplete="off"></label><label id="password-label" hidden><span data-i18n="password"></span><input id="password" type="password" autocomplete="off"></label><label id="target-label" hidden><span data-i18n="target"></span><input id="target" autocomplete="off"></label><button type="submit" data-i18n="continue"></button></form>
<p data-i18n="credentialNote"></p>
<div id="screen" tabindex="-1"></div>
</main><script type="module">
const appUrl = path => new URL(path, document.baseURI);
const $ = id => document.getElementById(id);
const zh = (navigator.language || 'en').toLowerCase().startsWith('zh');
const messages = {
 title: ['设备远程桌面', 'Remote desktop'], connect: ['连接', 'Connect'], disconnect: ['断开', 'Disconnect'],
 setup: ['远程桌面设置', 'Remote desktop setup'], check: ['检查配置', 'Check setup'], install: ['安装 noVNC', 'Install noVNC'],
 enable: ['启用远程桌面', 'Enable remote desktop'], disable: ['停用', 'Disable'], checking: ['正在检查配置…', 'Checking configuration…'],
 assetsReady: ['noVNC 网页客户端已安装。', 'The noVNC web client is installed.'], assetsMissing: ['noVNC 网页客户端尚未安装，请点击“安装 noVNC”。', 'The noVNC web client is not installed. Select “Install noVNC”.'],
 vncStep: ['手动配置本机 VNC 服务，并启用认证、仅监听回环地址。', 'Manually configure a local VNC server with authentication and loopback-only listening.'],
 windows: ['Windows：按 TigerVNC、TightVNC 或 RealVNC 服务端文档配置。锁屏、UAC 与服务模式支持取决于产品和系统策略。', 'Windows: follow the server documentation for TigerVNC, TightVNC or RealVNC. Lock screen, UAC and service mode support depend on the product and system policy.'],
 mac: ['macOS：前往“系统设置 > 通用 > 共享”开启“屏幕共享”，按当前系统版本配置允许 VNC 查看器访问的认证与权限，并确认认证方式与 noVNC 兼容。', 'macOS: open System Settings > General > Sharing and enable Screen Sharing. Configure VNC viewer authentication and permissions for your macOS version, and confirm compatibility with noVNC.'],
 linux: ['Linux：X11 可使用 x0vncserver（需正确的 DISPLAY/Xauthority）；Wayland 需合成器支持的 VNC 后端（如适用环境的 wayvnc）。请核实认证兼容性。', 'Linux: X11 can use x0vncserver with the correct DISPLAY/Xauthority. Wayland requires a compositor-supported VNC backend, such as wayvnc where supported. Verify authentication compatibility.'],
 other: ['请按操作系统与 VNC 服务端文档手动配置桌面共享。', 'Manually configure desktop sharing using your OS and VNC server documentation.'],
 reachable: ['本机 VNC 端口可达；仍需验证认证与画面捕获。', 'The local VNC port is reachable; authentication and screen capture still need verification.'],
 unreachable: ['本机 VNC 端口不可达。请检查服务与回环地址配置后重新检查。', 'The local VNC port is unreachable. Check the service and loopback configuration, then check again.'],
 unknown: ['尚未确认本机 VNC 端口是否可达。', 'Local VNC reachability has not been confirmed.'],
 enabled: ['远程桌面已启用。', 'Remote desktop is enabled.'], disabled: ['远程桌面尚未启用；准备就绪后点击“启用”。', 'Remote desktop is disabled. Select “Enable” when setup is ready.'],
 environment: ['环境变量已强制启用远程桌面；停用需要在设备本机移除 PI_DEVICE_DESKTOP 并重启服务。', 'Remote desktop is enabled by the environment. To disable it, remove PI_DEVICE_DESKTOP on the device and restart the service.'],
 installing: ['正在安装 noVNC…', 'Installing noVNC…'], installed: ['noVNC 安装成功。', 'noVNC installation succeeded.'],
 installFailed: ['noVNC 安装失败，可查看日志后重试。', 'noVNC installation failed. Review the log and retry.'],
 saving: ['正在更新设置…', 'Updating settings…'], requestFailed: ['设置请求失败', 'Setup request failed'],
 ready: ['配置允许尝试连接。', 'Configuration permits a connection attempt.'], unavailable: ['尚不可连接，请完成设置并重新检查。', 'Not ready to connect. Complete setup and check again.'],
 permission: ['客户端只读不是权限控制；强制只读请在 VNC 服务端配置。', 'Client view only is not an access permission; enforce read-only on the VNC server.'],
 viewonly: ['客户端只读', 'View only'], scale: ['缩放', 'Scale'], fullscreen: ['全屏', 'Fullscreen'],
 username: ['VNC 用户', 'VNC username'], password: ['VNC 密码', 'VNC password'], target: ['目标', 'Target'], continue: ['继续', 'Continue'],
 credentialNote: ['凭据仅经 RFB 发送给本机 VNC 服务，不保存在设备中心。', 'Credentials are sent only through RFB to the local VNC server and are not stored by the device center.'],
 desktopControls: ['桌面控制', 'Desktop controls'], connecting: ['正在连接…', 'Connecting…'], connected: ['已连接', 'Connected'],
 disconnected: ['已断开', 'Disconnected'], interrupted: ['连接失败或中断，请检查本机 VNC 配置。', 'Connection failed or interrupted. Check local VNC configuration.'],
 authenticationFailed: ['VNC 认证失败', 'VNC authentication failed'], credentialsRequired: ['需要 VNC 凭据', 'VNC credentials required'],
 connectionError: ['连接错误', 'Connection error'], loadFailed: ['桌面加载失败', 'Desktop load failed'], fullscreenFailed: ['全屏失败', 'Fullscreen failed']
};
const t = key => messages[key][zh ? 0 : 1];
document.documentElement.lang = zh ? 'zh-CN' : 'en'; document.title = t('title');
for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
$('desktop-controls').setAttribute('aria-label', t('desktopControls')); $('screen').setAttribute('aria-label', t('title'));
let rfb = null, ready = false, available = false, RFB = null, config = null;
let busy = false, installing = false, pollTimer = null, disposed = false;
const status = text => { $('status').textContent = text; };
function controls() {
 $('connect').disabled = !available || !RFB || !!rfb || busy || installing;
 $('disconnect').disabled = !rfb;
 for (const key of ['cad', 'tab', 'esc']) $(key).disabled = !ready || $('viewonly').checked;
 $('check').disabled = busy || installing;
 $('install').disabled = !config || busy || installing || config.assetsAvailable;
 $('enable').disabled = !config || busy || installing || config.enabled;
 $('disable').disabled = !config || busy || installing || !config.enabled || config.environmentEnabled;
}
function clearCredentials() {
 for (const key of ['username','password','target']) $(key).value = '';
 $('credentials').hidden = true;
}
function stop() { const previous = rfb; rfb = null; ready = false; clearCredentials(); previous?.disconnect(); controls(); }
async function request(path, options = {}) {
 const response = await fetch(appUrl(path), { ...options, credentials: 'same-origin', cache: 'no-store' });
 if (!response.ok) throw new Error(t('requestFailed') + ' (' + response.status + ')');
 return response;
}
async function applyConfig(next) {
 if (disposed) return;
 config = next; available = config.available === true;
 if (!available && rfb) stop();
 $('assets-step').textContent = t(config.assetsAvailable ? 'assetsReady' : 'assetsMissing');
 $('platform-guide').textContent = t(config.os === 'win32' ? 'windows' : config.os === 'darwin' ? 'mac' : config.os === 'linux' ? 'linux' : 'other');
 $('enable-step').textContent = t(config.environmentEnabled ? 'environment' : config.enabled ? 'enabled' : 'disabled');
 $('vnc-state').textContent = t(config.vncReachable === true ? 'reachable' : config.vncReachable === false ? 'unreachable' : 'unknown');
 if (!rfb) status(t(available ? 'ready' : 'unavailable'));
 controls();
 if (available && !RFB) {
  RFB = (await import(appUrl('api/device-desktop/novnc/core/rfb.js').href)).default;
  if (!disposed) controls();
 }
}
function schedulePoll() {
 clearTimeout(pollTimer); pollTimer = null;
 if (installing && !disposed) pollTimer = setTimeout(() => { void checkSetup(); }, 1500);
}
async function checkSetup() {
 busy = true; controls();
 try {
  const next = await (await request('api/device-desktop/setup/status')).json();
  if (disposed) return;
  installing = next.installation?.state === 'running';
  const state = next.installation?.state;
  $('setup-status').textContent = state === 'running' ? t('installing') : state === 'succeeded' ? t('installed') : state === 'failed' ? t('installFailed') : '';
  $('install-log').textContent = typeof next.installation?.log === 'string' ? next.installation.log : '';
  $('install-log').hidden = !$('install-log').textContent;
  await applyConfig(next);
 } catch (error) { if (!disposed) $('setup-status').textContent = t('loadFailed') + ': ' + error.message; }
 finally { busy = false; controls(); schedulePoll(); }
}
async function action(kind, enabled) {
 if (busy || installing) return;
 busy = true; controls(); $('setup-status').textContent = t(kind === 'install' ? 'installing' : 'saving');
 try {
  const options = { method: 'POST' };
  if (kind === 'enable') { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify({ enabled }); }
  const response = await request('api/device-desktop/setup/' + kind, options);
  if (disposed) return;
  if (kind === 'install' && response.status === 202) installing = true;
  await checkSetup();
 } catch (error) { if (!disposed) $('setup-status').textContent = t('requestFailed') + ': ' + error.message; }
 finally { busy = false; controls(); schedulePoll(); }
}
$('check').onclick = () => { void checkSetup(); };
$('install').onclick = () => { void action('install'); };
$('enable').onclick = () => { void action('enable', true); };
$('disable').onclick = () => { void action('enable', false); };
$('connect').onclick = () => {
 if (!available || !RFB || busy || installing) return;
 stop();
 try {
  const url = appUrl('desktop-ws'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const client = new RFB($('screen'), url.href, { shared: true }); rfb = client;
  client.viewOnly = $('viewonly').checked; client.scaleViewport = $('scale').checked; client.resizeSession = false;
  status(t('connecting')); controls();
  client.addEventListener('connect', () => { if (rfb !== client) return; ready = true; status(t('connected')); controls(); });
  client.addEventListener('disconnect', event => { if (rfb !== client) return; rfb = null; ready = false; clearCredentials(); status(t(event.detail.clean ? 'disconnected' : 'interrupted')); controls(); });
  client.addEventListener('securityfailure', event => { if (rfb === client) status(t('authenticationFailed') + (event.detail.status ? ' (' + event.detail.status + ')' : '')); });
  client.addEventListener('credentialsrequired', event => {
   if (rfb !== client) return;
   clearCredentials();
   for (const key of ['username','password','target']) $(key + '-label').hidden = !event.detail.types.includes(key);
   $('credentials').hidden = false;
   const first = ['username','password','target'].find(key => event.detail.types.includes(key));
   if (first) $(first).focus();
   status(t('credentialsRequired'));
  });
 } catch (error) { stop(); status(t('connectionError') + ': ' + error.message); }
};
$('disconnect').onclick = () => { stop(); status(t('disconnected')); };
$('credentials').onsubmit = event => {
 event.preventDefault();
 if (rfb) { const credentials = {}; for (const key of ['username','password','target']) if (!$(key + '-label').hidden) credentials[key] = $(key).value; rfb.sendCredentials(credentials); }
 clearCredentials(); $('screen').focus();
};
$('viewonly').onchange = () => { if (rfb) rfb.viewOnly = $('viewonly').checked; controls(); };
$('scale').onchange = () => { if (rfb) rfb.scaleViewport = $('scale').checked; };
$('fullscreen').onclick = () => { const pending = document.fullscreenElement ? document.exitFullscreen() : $('screen').requestFullscreen(); pending.catch(error => status(t('fullscreenFailed') + ': ' + error.message)); };
$('cad').onclick = () => { if (ready && !$('viewonly').checked) rfb.sendCtrlAltDel(); };
$('tab').onclick = () => { if (ready && !$('viewonly').checked) rfb.sendKey(0xff09, 'Tab'); };
$('esc').onclick = () => { if (ready && !$('viewonly').checked) rfb.sendKey(0xff1b, 'Escape'); };
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(pollTimer); stop(); });
status(t('checking')); busy = true; controls();
try { await applyConfig(await (await request('api/device-desktop/status')).json()); }
catch (error) { status(t('loadFailed') + ': ' + error.message); }
await checkSetup();
</script></body></html>`;
}
