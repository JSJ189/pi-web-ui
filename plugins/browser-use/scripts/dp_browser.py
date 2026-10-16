#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
browser-use — DrissionPage 常驻浏览器控制后端

原理:
  每次调用通过 Chromium(port) 连接或启动一个常驻 Chrome(默认端口 9333)。
  浏览器进程在命令结束后保持运行，多次调用共享同一个浏览器窗口：
  标签页、登录态、页面滚动状态全部持续存在，可反复 open / snapshot / click / input。
  页面快照只采集人类可见元素(链接/按钮/输入框/下拉/文本/标题/图片)，
  不包含 CSS / JS / 内部实现信息，极其节省 Token。

用法:
  python dp_browser.py <命令> [参数...]    (全部命令输出 JSON)
  或: python dp_browser.py help
"""

import json
import os
import re
import subprocess
import sys
import time
import traceback
from collections import Counter
from pathlib import Path
from typing import NoReturn

SCRIPT_DIR = Path(__file__).resolve().parent
PLUGIN_DIR = SCRIPT_DIR.parent
CMD = ""


# ---------------------------------------------------------------- 输出辅助


def out(obj, code=0) -> NoReturn:
    print(json.dumps(obj, ensure_ascii=False, default=str))
    sys.exit(code)


def fail(msg, hint=None) -> NoReturn:
    d = {"ok": False, "cmd": CMD, "error": msg}
    if hint:
        d["hint"] = hint
    out(d, 1)


# ---------------------------------------------------------------- 依赖引导


def _has_dp(py):
    try:
        return (
            subprocess.run(
                [str(py), "-c", "import DrissionPage"],
                capture_output=True,
                timeout=30,
            ).returncode
            == 0
        )
    except Exception:
        return False


def _ensure_python():
    """返回带 DrissionPage 的解释器路径。
    当前解释器可用时返回 None；否则优先查找 cwd 的 .venv，最后在插件目录自建 .venv。
    """
    if _has_dp(sys.executable):
        return None
    # 查找常见项目 venv
    for cand in (Path.cwd() / ".venv", Path.cwd() / "venv"):
        py = cand / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if py.exists() and _has_dp(py):
            return str(py)
    # 插件独立 venv
    venv = PLUGIN_DIR / ".venv"
    py = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not py.exists():
        print(
            ">>> DrissionPage 未安装，首次使用自动创建虚拟环境并安装(约 30 秒，需联网)...",
            file=sys.stderr,
        )
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
        subprocess.run(
            [
                str(py),
                "-m",
                "pip",
                "install",
                "-q",
                "--disable-pip-version-check",
                "drissionpage",
            ],
            check=True,
        )
    return str(py)


# ---------------------------------------------------------------- 浏览器


def get_browser(port):
    from DrissionPage import Chromium, ChromiumOptions  # type: ignore[reportMissingImports]

    ud = os.environ.get("DP_USER_DATA", "")
    if ud:
        # 指定独立用户目录，避免与本机普通 Chrome 单实例锁冲突
        Path(ud).mkdir(parents=True, exist_ok=True)
        co = ChromiumOptions().set_local_port(port).set_user_data_path(ud)
        return Chromium(co)
    return Chromium(port)


def need_tab(browser):
    tabs = browser.get_tabs()
    if not tabs:
        fail("没有打开的标签页 — 先运行: open <url> 或 new <url>")
    return browser.latest_tab


# ---------------------------------------------------------------- 定位

LOC_PREFIXES = ("css:", "xpath:", "x:", "text:", "t:", "tag:", "@")
_CSSISH = re.compile(r"^[a-z][a-z0-9-]*$")


def resolve_loc(s):
    """把输入转成 DrissionPage 定位串:
    带前缀的(css:/xpath:/text:/@ 等)原样透传;
    裸 #id/.class/[attr]/标签名 当 css; 其余当 text 包含匹配。
    """
    s = s.strip()
    if s.startswith(LOC_PREFIXES):
        return s
    if s[0] in "#.[:" or _CSSISH.match(s):
        return "css:" + s
    return "text:" + s


def find_ele(tab, loc, timeout=8):
    return tab.ele(resolve_loc(loc), timeout=timeout)


# ---------------------------------------------------------------- 快照 JS

SNAPSHOT_JS = r"""
const SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,' +
  '[contenteditable=""],[contenteditable="true"],summary,details,' +
  '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],' +
  '[role="menuitem"],[role="switch"],[role="searchbox"],[role="combobox"],[role="slider"]';
function isVis(el) {
  if (el.getClientRects().length === 0) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
  if (parseFloat(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}
function textOf(el, n) { return (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, n) || null; }
try {
  const interactive = [];
  document.querySelectorAll(SEL).forEach(el => {
    if (!isVis(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'summary' && el.parentElement && el.parentElement.tagName === 'DETAILS') return;
    let value = null, checked = null;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      value = el.value;
      if (value !== undefined) {
        if (el.type === 'password') value = '\u2022'.repeat(Math.min(12, String(value).length));
        else value = String(value).slice(0, 60);
      }
      checked = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : null;
    }
    let label = null;
    if (el.labels && el.labels.length) label = textOf(el.labels[0], 80);
    interactive.push({
      i: interactive.length + 1,
      tag: tag,
      text: textOf(el, 200),
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      id: el.getAttribute('id'),
      href: el.hasAttribute('href') ? el.href : null,
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
      placeholder: el.getAttribute('placeholder'),
      value: value, checked: checked,
      disabled: el.disabled ? true : null,
      label: label
    });
  });

  const textSel = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dt,dd,figcaption';
  const headings = [], paragraphs = [];
  document.querySelectorAll(textSel).forEach(el => {
    if (!isVis(el)) return;
    if (el.closest(SEL)) return;
    if (el.querySelector(textSel)) return;
    const t = textOf(el, 160);
    if (!t) return;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) headings.push({level: +tag[1], text: t});
    else paragraphs.push({tag: tag, text: t});
  });

  const images = [];
  document.querySelectorAll('img').forEach(el => {
    if (!isVis(el)) return;
    const r = el.getBoundingClientRect();
    images.push({src: el.currentSrc || el.src || null,
                 alt: (el.alt || '').slice(0, 120) || null,
                 w: Math.round(r.width), h: Math.round(r.height)});
  });

  const iframes = [];
  document.querySelectorAll('iframe').forEach(el => {
    if (!isVis(el)) return;
    iframes.push({src: el.src || null, title: el.getAttribute('title')});
  });

  const page = {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || null,
    viewportW: innerWidth, viewportH: innerHeight,
    scrollY: Math.round(scrollY || 0),
    documentHeight: Math.max(document.body ? document.body.scrollHeight : 0,
                             document.documentElement.scrollHeight)
  };
  return JSON.stringify({page: page, interactive: interactive,
                         headings: headings, paragraphs: paragraphs,
                         images: images, iframes: iframes,
                         icap: interactive.length,
                         truncated: {
                           interactive: interactive.length >= 400,
                           headings: headings.length >= 60,
                           paragraphs: paragraphs.length >= 300,
                           images: images.length >= 100,
                           iframes: iframes.length >= 20
                         }});
} catch (e) {
  return JSON.stringify({error: String(e)});
}
"""

INDEX_JS = r"""
const SEL = 'a[href],button,input:not([type="hidden"]),select,textarea,' +
  '[contenteditable=""],[contenteditable="true"],summary,details,' +
  '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],' +
  '[role="menuitem"],[role="switch"],[role="searchbox"],[role="combobox"],[role="slider"]';
function isVis(el) {
  if (el.getClientRects().length === 0) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
  if (parseFloat(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}
const els = [];
document.querySelectorAll(SEL).forEach(el => {
  if (!isVis(el)) return;
  if (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS') return;
  els.push(el);
});
const N = arguments[0];
return els[N] || null;
"""

TAG_NAMES = {
    "a": "链接",
    "button": "按钮",
    "input": "输入框",
    "select": "下拉",
    "textarea": "文本域",
    "summary": "折叠",
    "details": "折叠框",
}


def snapshot_data(tab):
    last_err = None
    for attempt in range(4):
        try:
            try:
                tab.wait.doc_loaded(timeout=2)
            except Exception:
                pass
            raw = tab.run_js(SNAPSHOT_JS)
            data = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(data, dict):
                if "error" in data:
                    fail(f"页面 JS 异常: {data['error']}")
                return data
        except Exception as e:
            last_err = e
            time.sleep(0.4)
    fail(f"快照执行失败: {last_err}")


def snapshot_payload(tab, interactive_only):
    data = snapshot_data(tab)
    inter = data["interactive"]
    counts = Counter()
    for e in inter:
        key = TAG_NAMES.get(e["tag"])
        if key is None:
            key = f"role:{e['role']}" if e.get("role") else e["tag"]
        counts[key] += 1
    summary = " · ".join(f"{k} {v}" for k, v in counts.most_common())
    payload = {
        "ok": True,
        "cmd": CMD,
        "interactive_only": interactive_only,
        "page": data["page"],
        "count": len(inter),
        "summary": summary or "(无交互元素)",
        "elements": inter,
        "hint": "点击: click N(快照序号) 或 click 'text:文本' / click 'css:...'; 输入: input <定位> <文本>",
        "truncated": data["truncated"],
    }
    if not interactive_only:
        payload["headings"] = data["headings"]
        payload["paragraphs"] = data["paragraphs"]
        payload["images"] = data["images"]
        payload["iframes"] = data["iframes"]
    return payload


# ---------------------------------------------------------------- 命令实现


def _norm_url(url):
    """补全 scheme: 已有 scheme 的保留(data:/file:/about:/https: 等),
    host:port 补 http://,其余补 https://。"""
    if re.match(r"^[a-z][a-z0-9+.\-]*:", url, re.I):
        return url
    if re.match(r"^[a-zA-Z0-9.\-]+:\d+", url):
        return "http://" + url
    return "https://" + url


def cmd_open(browser, args):
    if not args:
        fail("open 需要网址参数: open <url>")
    url = _norm_url(args[0])
    tabs = browser.get_tabs()
    tab = browser.latest_tab if tabs else None
    if tab is None:
        tab = browser.new_tab()
    tab.get(url)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "url": tab.url,
            "title": tab.title,
            "tabs": len(browser.get_tabs()),
        }
    )


def cmd_new(browser, args):
    if not args:
        fail("new 需要网址参数: new <url>")
    url = _norm_url(args[0])
    tab = browser.new_tab(url)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "tab_id": tab.tab_id,
            "url": tab.url,
            "title": tab.title,
            "tabs": len(browser.get_tabs()),
        }
    )


def cmd_tabs(browser, args):
    tabs = browser.get_tabs()
    latest = browser.latest_tab if tabs else None
    lst = [
        {
            "i": n,
            "id": t.tab_id,
            "title": t.title or "",
            "url": t.url or "",
            "current": (latest is not None and t.tab_id == latest.tab_id),
        }
        for n, t in enumerate(tabs, 1)
    ]
    out({"ok": True, "cmd": CMD, "count": len(lst), "tabs": lst})


def cmd_switch(browser, args):
    if not args:
        fail("switch 需要一个参数: <序号|id|网址/标题片段>")
    target = args[0]
    tabs = browser.get_tabs()
    if not tabs:
        fail("没有打开的标签页")
    if target.isdigit():
        n = int(target)
        if not 1 <= n <= len(tabs):
            fail(f"标签页序号越界(当前共 {len(tabs)} 个)")
        tab = tabs[n - 1]
    else:
        tab = (
            next((t for t in tabs if t.tab_id == target), None)
            or next((t for t in tabs if target in (t.url or "")), None)
            or next((t for t in tabs if target in (t.title or "")), None)
        )
        if tab is None:
            fail(f"找不到标签页: {target}")
    browser.activate_tab(tab.tab_id)
    time.sleep(0.2)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "url": tab.url,
            "title": tab.title,
            "tabs": len(browser.get_tabs()),
        }
    )


def cmd_close(browser, args):
    tabs = browser.get_tabs()
    if not tabs:
        fail("没有打开的标签页")
    if args and args[0].isdigit():
        n = int(args[0])
        if not 1 <= n <= len(tabs):
            fail(f"标签页序号越界(当前共 {len(tabs)} 个)")
        tab = tabs[n - 1]
    else:
        tab = browser.latest_tab
    closed_url = tab.url
    before = len(browser.get_tabs())
    try:
        tab.close()
    except Exception:
        pass
    after = len(browser.get_tabs())
    if after >= before:
        fail("关闭标签页失败(标签页仍存在)")
    out({"ok": True, "cmd": CMD, "closed": closed_url, "tabs": after})


def cmd_url(browser, args):
    tab = need_tab(browser)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "url": tab.url,
            "title": tab.title,
            "tabs": len(browser.get_tabs()),
        }
    )


def cmd_back(browser, args):
    tab = need_tab(browser)
    tab.back()
    out({"ok": True, "cmd": CMD, "url": tab.url, "title": tab.title})


def cmd_forward(browser, args):
    tab = need_tab(browser)
    tab.forward()
    out({"ok": True, "cmd": CMD, "url": tab.url, "title": tab.title})


def cmd_refresh(browser, args):
    tab = need_tab(browser)
    tab.refresh()
    out({"ok": True, "cmd": CMD, "url": tab.url, "title": tab.title})


def cmd_wait(browser, args):
    sec = float(args[0]) if args else 1.0
    time.sleep(sec)
    out({"ok": True, "cmd": CMD, "slept": sec})


def cmd_snapshot(browser, args):
    tab = need_tab(browser)
    interactive_only = any(a in ("-i", "--interactive") for a in args)
    out(snapshot_payload(tab, interactive_only))


def cmd_click(browser, args):
    tab = need_tab(browser)
    by_js = False
    rest = [a for a in args if a != "--js"]
    if len(rest) != len(args):
        by_js = True
    if not rest:
        fail("click 需要一个参数: 定位串 / 文本 / 快照序号")
    target = rest[0]
    if target.isdigit():
        el = tab.run_js(INDEX_JS, int(target) - 1)
        if el is None:
            fail(f"交互元素 #{target} 不存在 — 先运行 snapshot -i 查看当前序号")
        desc = f"#{target}(按快照序号)"
    else:
        el = find_ele(tab, target)
        if el is None:
            fail(
                f"找不到元素: {target}",
                "先运行 snapshot -i 看可见元素; 定位支持 text:文本 / css:选择器 / xpath:... / 数字序号",
            )
        desc = target
    try:
        el.click(by_js=by_js)
    except Exception as e:
        fail(f"点击失败: {e}", f"可尝试 click --js {target} 强制用 JS 点击")
    try:
        tab.wait.doc_loaded(timeout=3)
    except Exception:
        pass
    out(
        {
            "ok": True,
            "cmd": CMD,
            "target": desc,
            "by_js": by_js,
            "url": tab.url,
            "title": tab.title,
        }
    )


def cmd_input(browser, args):
    tab = need_tab(browser)
    if len(args) < 2:
        fail("input 需要两个参数: <定位> <文本>")
    loc, text = args[0], args[1]
    el = find_ele(tab, loc)
    if el is None:
        fail(f"找不到元素: {loc}", "先 snapshot -i 确认定位")
    try:
        el.click()
    except Exception:
        pass
    el.input(text, clear=True)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "target": loc,
            "len": len(text),
            "url": tab.url,
            "title": tab.title,
        }
    )


def cmd_select(browser, args):
    tab = need_tab(browser)
    if len(args) < 2:
        fail("select 需要两个参数: <定位> <选项文本/值/序号>")
    loc, opt = args[0], args[1]
    el = find_ele(tab, loc)
    if el is None:
        fail(f"找不到元素: {loc}")
    sel = el.select
    if sel is False:
        fail(f"{loc} 不是 <select> 下拉元素")
    errs = []
    for fn, kw in (
        (sel.by_text, dict(text=opt)),
        (sel.by_value, dict(value=opt)),
    ):
        try:
            fn(**kw)
            out({"ok": True, "cmd": CMD, "target": loc, "option": opt})
            return
        except Exception as e:
            errs.append(str(e))
    if opt.isdigit():
        try:
            sel.by_index(int(opt))
            out({"ok": True, "cmd": CMD, "target": loc, "option": f"#{opt}"})
            return
        except Exception as e:
            errs.append(str(e))
    fail(f'下拉没有匹配选项: {opt} ({"; ".join(errs[:2])})')


def cmd_check(browser, args):
    tab = need_tab(browser)
    if not args:
        fail(f"{CMD} 需要一个定位参数")
    loc = args[0]
    el = find_ele(tab, loc)
    if el is None:
        fail(f"找不到元素: {loc}")
    if el.tag != "input" and el.attr("role") not in (
        "checkbox",
        "radio",
        "switch",
    ):
        fail(f"{loc} 不是复选框/单选钮")
    el.check(uncheck=(CMD == "uncheck"))
    out({"ok": True, "cmd": CMD, "target": loc})


def cmd_type(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("type 需要一个文本参数(向当前焦点元素输入)")
    tab.actions.type(args[0])
    out({"ok": True, "cmd": CMD, "len": len(args[0])})


MODIFIERS = {"CONTROL", "CTRL", "SHIFT", "ALT", "META", "COMMAND"}
ALIAS = {
    "ARROWDOWN": "DOWN",
    "ARROWUP": "UP",
    "ARROWLEFT": "LEFT",
    "ARROWRIGHT": "RIGHT",
    "ESC": "ESCAPE",
    "RETURN": "ENTER",
    "PAGEUP": "PAGE_UP",
    "PAGEDOWN": "PAGE_DOWN",
    "DEL": "DELETE",
    "INS": "INSERT",
    "SPACEBAR": "SPACE",
}
KEYS_HELP = (
    "ENTER ESCAPE TAB BACKSPACE DELETE SPACE UP DOWN LEFT RIGHT HOME END "
    "PAGE_UP PAGE_DOWN F1-F12 SHIFT CONTROL ALT 或组合如 ctrl+a"
)


def cmd_press(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("press 需要一个按键/组合，如 Enter、ctrl+a、Escape")
    combo = args[0]
    parts = [
        ALIAS.get(p.upper(), p.upper()) for p in combo.split("+") if p.strip()
    ]
    mods = [p for p in parts if p in MODIFIERS]
    rest = [p for p in parts if p not in MODIFIERS]
    a = tab.actions
    try:
        for m in mods:
            a.key_down(m)
        for r in rest:
            if len(r) == 1:
                a.type(r)
            else:
                a.key_down(r)
                a.key_up(r)
        for m in reversed(mods):
            a.key_up(m)
    except ValueError as e:
        fail(f"{e}  支持的按键: {KEYS_HELP}")
    try:
        tab.wait.doc_loaded(timeout=3)
    except Exception:
        pass
    out(
        {
            "ok": True,
            "cmd": CMD,
            "keys": combo,
            "url": tab.url,
            "title": tab.title,
        }
    )


def cmd_hover(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("hover 需要一个定位参数")
    el = find_ele(tab, args[0])
    if el is None:
        fail(f"找不到元素: {args[0]}")
    el.hover()
    out({"ok": True, "cmd": CMD, "target": args[0]})


def cmd_scroll(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("scroll 用法: top | bottom | up [px] | down [px] | to <y> | <px>")
    w = args[0].lower()
    y = None
    try:
        if w == "top":
            tab.scroll.to_top()
            y = tab.run_js("return Math.round(scrollY);")
        elif w == "bottom":
            tab.scroll.to_bottom()
            y = tab.run_js("return Math.round(scrollY);")
        elif w in ("up", "down"):
            n = int(args[1]) if len(args) > 1 else 600
            y = tab.run_js(
                f'window.scrollBy(0, {"-" if w == "up" else ""}{n}); return Math.round(scrollY);'
            )
        elif w == "to":
            y = tab.run_js(
                f"window.scrollTo(0, {int(args[1])}); return Math.round(scrollY);"
            )
        elif w.isdigit():
            y = tab.run_js(
                f"window.scrollBy(0, {int(w)}); return Math.round(scrollY);"
            )
        else:
            fail(f"未知滚动参数: {w}")
    except Exception as e:
        fail(f"滚动失败: {e}")
    out({"ok": True, "cmd": CMD, "action": w, "scrollY": int(y) if y else 0})


def cmd_wait_ele(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("wait_ele 需要定位参数")
    loc = args[0]
    timeout = float(args[1]) if len(args) > 1 else 10
    el = tab.ele(resolve_loc(loc), timeout=timeout)
    out(
        {
            "ok": el is not None,
            "cmd": CMD,
            "found": el is not None,
            "target": loc,
        },
        code=0 if el is not None else 1,
    )


def _sanitize(r, depth=0):
    if r is None or isinstance(r, (str, int, float, bool)):
        return r
    if depth > 3:
        return str(r)[:200]
    if isinstance(r, dict):
        return {k: _sanitize(v, depth + 1) for k, v in list(r.items())[:100]}
    if isinstance(r, (list, tuple)):
        return [_sanitize(x, depth + 1) for x in r[:100]]
    if hasattr(r, "tag"):
        return {"element": True, "tag": r.tag, "text": (r.text or "")[:200]}
    return str(r)[:500]


def cmd_js(browser, args):
    tab = need_tab(browser)
    if not args:
        fail("js 需要一段 JS 代码(函数体形式, 可用 return; 多行请加引号)")
    code = args[0]
    try:
        r = tab.run_js(code, as_expr=(CMD == "jsx"))
    except Exception as e:
        fail(f"JS 执行失败: {e}")
    out({"ok": True, "cmd": CMD, "result": _sanitize(r)})


def cmd_screenshot(browser, args):
    tab = need_tab(browser)
    path = None
    full = False
    for a in args:
        if a == "--full":
            full = True
        else:
            path = a
    if not path:
        path = str(Path.cwd() / f"browser_use_{int(time.time() * 1000)}.png")
    p = tab.get_screenshot(path=path, full_page=full)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "path": os.path.abspath(p) if p else os.path.abspath(path),
            "full_page": full,
        }
    )


def cmd_quit(browser, args):
    browser.quit(2, True)
    out(
        {
            "ok": True,
            "cmd": CMD,
            "note": "常驻浏览器已关闭，下次调用 open/new 会自动启动新实例",
        }
    )


COMMANDS = {
    "open": cmd_open,
    "new": cmd_new,
    "tabs": cmd_tabs,
    "switch": cmd_switch,
    "close": cmd_close,
    "url": cmd_url,
    "title": cmd_url,
    "back": cmd_back,
    "forward": cmd_forward,
    "refresh": cmd_refresh,
    "wait": cmd_wait,
    "snapshot": cmd_snapshot,
    "click": cmd_click,
    "input": cmd_input,
    "select": cmd_select,
    "check": cmd_check,
    "uncheck": cmd_check,
    "type": cmd_type,
    "press": cmd_press,
    "hover": cmd_hover,
    "scroll": cmd_scroll,
    "wait_ele": cmd_wait_ele,
    "js": cmd_js,
    "jsx": cmd_js,
    "screenshot": cmd_screenshot,
    "quit": cmd_quit,
}

HELP = """browser-use — 常驻 Chrome 浏览器控制后端
用法: python dp_browser.py <命令> [参数]   (输出 JSON; 失败 exit code 1)

导航 / 标签页
  open <url>            当前标签页打开网址(无标签页则新建; 自动补 https://)
  new <url>             新标签页打开
  tabs                  列出所有标签页(序号/标题/网址)
  switch <序号|id|片段>  切换标签页
  close [序号]          关闭标签页(默认当前)
  url | title           当前标签页网址和标题
  back | forward | refresh   后退 / 前进 / 刷新
  wait <秒>             等待

快照(只含人类可见元素, 不含 CSS/JS 内部实现)
  snapshot              页面可见内容: 交互元素 + 标题/正文/列表/图片/iframe
  snapshot -i           仅交互元素: 链接/按钮/输入框/下拉/复选框等(带数字序号)

交互
  click <定位|序号>     点击; 数字为 snapshot -i 的序号; --js 强制 JS 点击
  input <定位> <文本>   输入(先清空)
  select <定位> <选项>  下拉选择(按文本/值, 数字按序号)
  check <定位> | uncheck <定位>    勾选 / 取消勾选
  type <文本>           向当前焦点元素输入文本
  press <键|组合>       按键, 如 Enter / Escape / ctrl+a / shift+Tab
  hover <定位>          悬停
  scroll top|bottom|up|down [px]|to <y>|<px>    滚动页面
  wait_ele <定位> [秒]  等待元素出现(默认 10 秒)

JS / 其它
  js <代码>             执行 JS(函数体形式, 可用 return)
  jsx <表达式>          执行 JS 表达式
  screenshot [路径] [--full]    截图(PNG)
  quit                  关闭常驻浏览器(结束会话)
  help                  本帮助
"""


def parse_args(argv):
    port = int(os.environ.get("DP_BROWSER_PORT", "9333"))
    rest = list(argv)
    if rest and rest[0] == "--port" and len(rest) > 1:
        port = int(rest[1])
        rest = rest[2:]
    if not rest:
        out({"ok": False, "error": "未提供命令，运行: python dp_browser.py help"})
    return rest[0], rest[1:], port


def main():
    global CMD
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in (
        "utf-8",
        "utf8",
    ):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass

    if not os.environ.get("DP_BROWSER_REEXEC"):
        py = _ensure_python()
        if py:
            os.environ["DP_BROWSER_REEXEC"] = "1"
            sys.exit(
                subprocess.call(
                    [py, str(Path(__file__).resolve()), *sys.argv[1:]]
                )
            )

    cmd, args, port = parse_args(sys.argv[1:])
    CMD = cmd
    if cmd == "help":
        print(HELP)
        sys.exit(0)
    if cmd not in COMMANDS:
        out(
            {
                "ok": False,
                "cmd": cmd,
                "error": f"未知命令: {cmd}",
                "hint": "运行 python dp_browser.py help 查看全部可用命令",
            }
        )

    try:
        browser = get_browser(port)
        COMMANDS[cmd](browser, args)
    except SystemExit:
        raise
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
