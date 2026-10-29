/** Static trusted markup. Credentials remain exclusively in noVNC's RFB exchange. */
export function desktopPage(): string {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设备远程桌面 · Remote desktop</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101827;color:#e5edf8}*{box-sizing:border-box}body{margin:0;min-width:0}main{display:flex;flex-direction:column;height:100dvh;min-width:0;max-width:100%;padding:12px;gap:10px}h1{font-size:18px;margin:0}header,nav,form{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;max-width:100%}button,input{font:inherit;padding:7px 10px;border:1px solid #657287;border-radius:5px;background:#202f45;color:#fff}button:disabled{opacity:.5}label{display:flex;align-items:center;gap:5px;min-width:0}input:not([type=checkbox]){min-width:0;max-width:100%;width:180px}p{margin:0;overflow-wrap:anywhere;word-break:break-word;font-size:13px}#screen{flex:1;min-width:0;min-height:150px;overflow:hidden;background:#000}#screen:fullscreen{height:100%;width:100%}[hidden]{display:none!important}#status{white-space:pre-wrap}button:focus-visible,input:focus-visible{outline:2px solid #8cc8ff}form{padding:8px;border:1px solid #657287}
</style></head><body><main>
<header><h1>设备远程桌面 · Remote desktop</h1><button id="connect" disabled>连接 Connect</button><button id="disconnect" disabled>断开 Disconnect</button></header>
<p id="status" role="status" aria-live="polite">正在检查本机配置… Checking configuration…</p>
<p>仅在设备明确启用后可用。客户端只读不是权限控制；强制只读请在 VNC 服务端配置。Client view only is not an access permission; enforce read-only on the VNC server.</p>
<nav aria-label="桌面控制 Desktop controls"><label><input id="viewonly" type="checkbox" checked>客户端只读 View only</label><label><input id="scale" type="checkbox" checked>缩放 Scale</label><button id="fullscreen">全屏 Fullscreen</button><button id="cad" disabled>Ctrl Alt Del</button><button id="tab" disabled>Tab</button><button id="esc" disabled>Esc</button></nav>
<form id="credentials" hidden autocomplete="off"><label id="username-label" hidden>VNC 用户 Username <input id="username" autocomplete="off"></label><label id="password-label" hidden>VNC 密码 Password <input id="password" type="password" autocomplete="off"></label><label id="target-label" hidden>Target <input id="target" autocomplete="off"></label><button type="submit">继续 Continue</button></form>
<p>凭据仅经 RFB 发送给本机 VNC 服务，不保存在设备中心。Credentials are sent only through RFB and are not stored by the device center.</p>
<div id="screen" aria-label="远程桌面 Remote desktop"></div>
</main><script type="module">
const appUrl = path => new URL(path, document.baseURI);
const $ = id => document.getElementById(id);
let rfb = null, ready = false, available = false;
const status = text => { $('status').textContent = text; };
function controls() {
 $('connect').disabled = !available || !!rfb;
 $('disconnect').disabled = !rfb;
 for (const key of ['cad', 'tab', 'esc']) $(key).disabled = !ready || $('viewonly').checked;
}
function clearCredentials() {
 for (const key of ['username','password','target']) $(key).value = '';
 $('credentials').hidden = true;
}
function stop() { const previous = rfb; rfb = null; ready = false; clearCredentials(); previous?.disconnect(); controls(); }
try {
 const response = await fetch(appUrl('api/device-desktop/status'), { credentials: 'same-origin' });
 if (!response.ok) throw new Error('配置查询失败 Configuration request failed (' + response.status + ')');
 const config = await response.json();
 available = config.available === true;
 status(available ? '可连接 Ready · OS: ' + config.os : '不可连接 Unavailable · OS: ' + config.os + ' · enabled=' + config.enabled + ' · endpoint=' + config.endpointConfigured + ' · assets=' + config.assetsAvailable + '。请在设备本机配置 VNC / Configure VNC locally.');
 const RFB = available ? (await import(appUrl('api/device-desktop/novnc/core/rfb.js').href)).default : null;
 $('connect').onclick = () => {
  stop();
  try {
   const url = appUrl('desktop-ws'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
   const client = new RFB($('screen'), url.href, { shared: true }); rfb = client;
   client.viewOnly = $('viewonly').checked; client.scaleViewport = $('scale').checked; client.resizeSession = false;
   status('正在连接 Connecting…'); controls();
   client.addEventListener('connect', () => { if (rfb !== client) return; ready = true; status('已连接 Connected'); controls(); });
   client.addEventListener('disconnect', event => { if (rfb !== client) return; rfb = null; ready = false; clearCredentials(); status(event.detail.clean ? '已断开 Disconnected' : '连接失败或中断 Connection failed or interrupted. Check local VNC configuration.'); controls(); });
   client.addEventListener('securityfailure', event => { if (rfb === client) status('VNC 认证失败 Authentication failed' + (event.detail.status ? ' (' + event.detail.status + ')' : '')); });
   client.addEventListener('credentialsrequired', event => {
    if (rfb !== client) return;
    clearCredentials();
    for (const key of ['username','password','target']) $(key + '-label').hidden = !event.detail.types.includes(key);
    $('credentials').hidden = false;
    const first = ['username','password','target'].find(key => event.detail.types.includes(key));
    if (first) $(first).focus();
    status('需要 VNC 凭据 VNC credentials required');
   });
  } catch (error) { stop(); status('连接错误 Connection error: ' + error.message); }
 };
 controls();
} catch (error) { available = false; controls(); status('桌面加载失败 Desktop load failed: ' + error.message); }
$('disconnect').onclick = () => { stop(); status('已断开 Disconnected'); };
$('credentials').onsubmit = event => {
 event.preventDefault();
 if (rfb) { const credentials = {}; for (const key of ['username','password','target']) if (!$(key + '-label').hidden) credentials[key] = $(key).value; rfb.sendCredentials(credentials); }
 clearCredentials(); $('screen').focus();
};
$('viewonly').onchange = () => { if (rfb) rfb.viewOnly = $('viewonly').checked; controls(); };
$('scale').onchange = () => { if (rfb) rfb.scaleViewport = $('scale').checked; };
$('fullscreen').onclick = () => { const pending = document.fullscreenElement ? document.exitFullscreen() : $('screen').requestFullscreen(); pending.catch(error => status('全屏失败 Fullscreen failed: ' + error.message)); };
$('cad').onclick = () => { if (ready && !$('viewonly').checked) rfb.sendCtrlAltDel(); };
$('tab').onclick = () => { if (ready && !$('viewonly').checked) rfb.sendKey(0xff09, 'Tab'); };
$('esc').onclick = () => { if (ready && !$('viewonly').checked) rfb.sendKey(0xff1b, 'Escape'); };
window.addEventListener('pagehide', stop);
</script></body></html>`;
}
