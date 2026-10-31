/**
 * The recorder script injected into every page of a recording (`context.addInitScript`). It is plain JavaScript kept in a string:
 * it must run in the page without any build step and must not depend on anything the page defines.
 *
 * Rules it keeps (tests prove them):
 *  - It reports through a platform-owned binding whose name is random per session. It keeps a private reference and deletes the global
 *    one at once, so the application cannot call it, replace it or read what it sends. Every message carries a session token as well.
 *  - It never reads the value of a password / one-time-code / card field: the message says "a secret was typed here" and nothing else.
 *  - It records the top page and the frames inside it (the platform works out which frame a message came from and how deep it is), ignores its own overlay (a closed shadow root with pointer-events none) and
 *    sends page text only where a step needs it, capped.
 *  - In inspect mode a click is swallowed in the capture phase (and the mouse and touch events before it), so the page never acts.
 * The script contains none of the literals the platform forbids in generated scripts.
 */
import { DYNAMIC_PATTERNS } from "./model.js";

export interface PageScriptConfig {
    /** Name of the exposed binding (random per session). */
    binding: string;
    /** Name of the control function the platform calls to switch inspect mode (random per session). */
    ctl: string;
    /** Session token every message carries. */
    token: string;
}

const SOURCE = String.raw`
(function () {
  "use strict";
  var CFG = __CFG__;
  // Frames report too (the platform knows which frame a message came from); only the top page reports its loads as page visits.
  var IN_FRAME = true; try { IN_FRAME = window.top !== window; } catch (e) { IN_FRAME = true; }
  var send = window[CFG.binding];
  if (typeof send !== "function") return;
  try { delete window[CFG.binding]; } catch (e) {}
  var DYN = __DYN__.map(function (p) { return new RegExp(p[0], p[1]); });
  function dyn(s) { for (var i = 0; i < DYN.length; i++) if (DYN[i].test(s)) return true; return false; }

  var seq = 0, markEl = null, markTimer = 0, pend = null, keyWatch = null;
  var inspect = { on: false, mode: "locator" };
  var host = null, box = null, lab = null, hoverEl = null;

  function post(ev) {
    ev.tok = CFG.token; ev.seq = ++seq; ev.url = location.href; ev.ts = Date.now();
    try { var r = send(ev); if (r && r.catch) r.catch(function () {}); } catch (e) {}
  }
  function norm(s) { return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim(); }
  function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s); }
  function arr(l) { return Array.prototype.slice.call(l); }

  // ---- secrets: a field like this is never read ------------------------------------------------
  function secretKind(el) {
    if (!el || el.tagName !== "INPUT") return "";
    var type = (el.getAttribute("type") || "text").toLowerCase();
    var ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (type === "password") return "password";
    if (/one-time-code/.test(ac)) return "otp";
    if (/cc-number/.test(ac)) return "card_number";
    if (/cc-csc/.test(ac)) return "card_cvc";
    if (/(current|new)-password/.test(ac)) return "password";
    var hint = [el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" ");
    if (/pass(word|wd|code)/i.test(hint)) return "password";
    if (/\botp\b|one.?time|verification code/i.test(hint)) return "otp";
    if (/cvv|cvc|security code/i.test(hint)) return "card_cvc";
    if (/card.?(number|no\b)/i.test(hint)) return "card_number";
    return "";
  }

  // ---- roles and accessible names (checked again by Playwright on the platform side) -----------
  var INPUT_ROLES = { button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox", text: "textbox", email: "textbox", tel: "textbox", url: "textbox" };
  function roleOf(el) {
    var r = el.getAttribute("role");
    if (r) return r.split(/\s+/)[0].toLowerCase();
    var t = el.tagName.toLowerCase();
    if (t === "a" || t === "area") return el.hasAttribute("href") ? "link" : "";
    if (t === "button") return "button";
    if (t === "input") {
      var ty = (el.getAttribute("type") || "text").toLowerCase();
      if ((ty === "text" || ty === "search" || ty === "email" || ty === "tel" || ty === "url") && el.hasAttribute("list")) return "combobox";
      return INPUT_ROLES[ty] || "";
    }
    if (t === "textarea") return "textbox";
    if (t === "select") return (el.multiple || el.size > 1) ? "listbox" : "combobox";
    if (/^h[1-6]$/.test(t)) return "heading";
    if (t === "img") return el.getAttribute("alt") === "" ? "" : "img";
    if (t === "ul" || t === "ol") return "list";
    if (t === "li") return "listitem";
    if (t === "nav") return "navigation";
    if (t === "main") return "main";
    if (t === "table") return "table";
    if (t === "dialog") return "dialog";
    return "";
  }
  function labelText(label) {
    var out = "";
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(c.tagName)) walk(c);
      }
    })(label);
    return norm(out);
  }
  function labelTexts(el) {
    var out = [], al = norm(el.getAttribute("aria-label"));
    if (al) out.push(al);
    var lb = el.getAttribute("aria-labelledby");
    if (lb) {
      var parts = lb.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? norm(n.textContent) : ""; }).filter(Boolean);
      if (parts.length) out.push(parts.join(" "));
    }
    if (el.labels) for (var i = 0; i < el.labels.length; i++) { var t = labelText(el.labels[i]); if (t) out.push(t); }
    return out;
  }
  var NAME_FROM_CONTENT = /^(button|link|heading|tab|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|radio|switch|treeitem|cell|row|columnheader|rowheader|listitem)$/;
  function accName(el) {
    var lt = labelTexts(el);
    var t = el.tagName.toLowerCase();
    if (t === "input" || t === "textarea" || t === "select") {
      if (lt.length) return lt[0];
      var ty = (el.getAttribute("type") || "").toLowerCase();
      if (t === "input" && (ty === "button" || ty === "submit" || ty === "reset")) return norm(el.value) || (ty === "submit" ? "Submit" : ty === "reset" ? "Reset" : "");
      if (ty === "image") return norm(el.getAttribute("alt"));
      return norm(el.getAttribute("title")) || norm(el.getAttribute("placeholder"));
    }
    if (lt.length && !el.labels) return lt[0];
    if (t === "img") return norm(el.getAttribute("alt")) || norm(el.getAttribute("title"));
    if (NAME_FROM_CONTENT.test(roleOf(el))) {
      var c = norm(el.textContent);
      if (c) return c;
      var im = el.querySelector("img[alt]");
      if (im && norm(im.getAttribute("alt"))) return norm(im.getAttribute("alt"));
    }
    return norm(el.getAttribute("title"));
  }

  // ---- candidate locators with match counts -----------------------------------------------------
  function cand(strategy, value, extra, list, el) {
    var c = { strategy: strategy, value: value, matches: list.length, hit: list.indexOf(el) >= 0 };
    if (extra) for (var k in extra) c[k] = extra[k];
    return c;
  }
  function structural(el) {
    var root = el.getRootNode && el.getRootNode().querySelectorAll ? el.getRootNode() : document;
    var parts = [], n = el;
    while (n && n.nodeType === 1) {
      var seg = n.tagName.toLowerCase();
      if (n.id && !dyn(n.id)) seg = "#" + cssEsc(n.id);
      else {
        var sibs = (n.parentNode && n.parentNode.children) ? arr(n.parentNode.children).filter(function (s) { return s.tagName === n.tagName; }) : [];
        if (sibs.length > 1) seg += ":nth-of-type(" + (sibs.indexOf(n) + 1) + ")";
      }
      parts.unshift(seg);
      var sel = parts.join(" > ");
      try { var l = root.querySelectorAll(sel); if (l.length === 1 && l[0] === el) return sel; } catch (e) {}
      if (seg.charAt(0) === "#") break;
      n = n.parentElement;
    }
    return parts.join(" > ");
  }
  function candidatesFor(el) {
    var out = [], root = el.getRootNode && el.getRootNode().querySelectorAll ? el.getRootNode() : document;
    var tag = el.tagName.toLowerCase(), formControl = tag === "input" || tag === "select" || tag === "textarea";
    var tid = el.getAttribute("data-testid");
    if (tid && tid.length <= 120) out.push(cand("testId", tid, null, arr(document.querySelectorAll("[data-testid]")).filter(function (e) { return e.getAttribute("data-testid") === tid; }), el));
    var all = arr(document.querySelectorAll("*"));
    var role = roleOf(el), name = role ? accName(el) : "";
    if (role && name && name.length <= 60) out.push(cand("role", role, { name: name, exact: true }, all.filter(function (e) { return roleOf(e) === role && accName(e) === name; }), el));
    if (formControl) {
      var lts = labelTexts(el).filter(function (t) { return t.length <= 60; });
      for (var i = 0; i < lts.length && i < 2; i++) (function (lt) {
        out.push(cand("label", lt, { exact: true }, all.filter(function (e) { return (e.tagName === "INPUT" || e.tagName === "SELECT" || e.tagName === "TEXTAREA") && labelTexts(e).indexOf(lt) >= 0; }), el));
      })(lts[i]);
      var ph = norm(el.getAttribute("placeholder"));
      if (ph && ph.length <= 60) out.push(cand("placeholder", ph, { exact: true }, all.filter(function (e) { return norm(e.getAttribute("placeholder")) === ph; }), el));
    } else {
      var tx = norm(el.textContent);
      if (tx && tx.length <= 60) out.push(cand("text", tx, { exact: true }, all.filter(function (e) {
        if (norm(e.textContent) !== tx) return false;
        for (var c = e.firstElementChild; c; c = c.nextElementSibling) if (norm(c.textContent) === tx) return false;
        return true;
      }), el));
    }
    var id = el.id;
    if (id && id.length <= 80) { var l1 = arr(root.querySelectorAll("#" + cssEsc(id))); out.push(cand("css", "#" + cssEsc(id), null, l1, el)); }
    var nm = el.getAttribute("name");
    if (nm && formControl) { var s2 = tag + '[name="' + esc(nm) + '"]'; out.push(cand("css", s2, null, arr(root.querySelectorAll(s2)), el)); }
    var path = structural(el);
    var l3 = []; try { l3 = arr(root.querySelectorAll(path)); } catch (e) {}
    out.push(cand("css", path, null, l3, el));
    return out;
  }
  function groupFor(el) {
    var t = el.tagName, sel, tagName;
    if (t === "UL" || t === "OL" || t === "TBODY") {
      var kids = arr(el.children).filter(function (c) { return c.tagName === "LI" || c.tagName === "TR"; });
      if (!kids.length) return null;
      tagName = kids[0].tagName.toLowerCase();
      sel = structural(el) + " > " + tagName;
    } else {
      var p = el.parentElement;
      if (!p || arr(p.children).filter(function (c) { return c.tagName === t; }).length < 2) return null;
      tagName = t.toLowerCase();
      sel = structural(p) + " > " + tagName;
    }
    var n = 0; try { n = document.querySelectorAll(sel).length; } catch (e) {}
    return n ? { css: sel, count: n } : null;
  }

  // ---- marking: lets the platform check which element a candidate really finds -----------------
  function unmark() { clearTimeout(markTimer); if (markEl) { try { markEl.removeAttribute("data-aitp-pick"); } catch (e) {} markEl = null; } }
  function mark(el) { unmark(); markEl = el; try { el.setAttribute("data-aitp-pick", "1"); } catch (e) {} markTimer = setTimeout(unmark, 2500); }

  // ---- event helpers ------------------------------------------------------------------------------
  function tgt(ev) {
    var p = ev.composedPath ? ev.composedPath() : [];
    var t = p.length ? p[0] : ev.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    if (!t || t.nodeType !== 1 || t === host) return null;
    return t;
  }
  var ROLE_INTERACTIVE = /^(button|link|checkbox|radio|tab|menuitem|menuitemcheckbox|menuitemradio|switch|option|combobox|textbox|searchbox|slider|treeitem)$/;
  function isInteractive(n) {
    var t = n.tagName;
    if (t === "A") return n.hasAttribute("href");
    if (t === "BUTTON" || t === "SELECT" || t === "TEXTAREA" || t === "SUMMARY" || t === "LABEL") return true;
    if (t === "INPUT") return (n.getAttribute("type") || "").toLowerCase() !== "hidden";
    var r = n.getAttribute("role");
    if (r && ROLE_INTERACTIVE.test(r.split(/\s+/)[0])) return true;
    return n.hasAttribute("onclick") || (n.isContentEditable && n.getAttribute("contenteditable") !== null);
  }
  function interactive(el) {
    var n = el, i = 0;
    while (n && i < 12) {
      if (n.nodeType === 1 && isInteractive(n)) return n;
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
      i++;
    }
    return null;
  }
  function disabled(el) { try { return el.matches(":disabled") || el.getAttribute("aria-disabled") === "true"; } catch (e) { return false; } }
  function inType(el) { return el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : ""; }
  var TEXTY = /^(text|email|search|tel|url|password|number|date|datetime-local|month|time|week|color)$/;

  // ---- typing: one fill per field with the final value; a secret's value is never read -----------
  function flushFill() {
    if (!pend) return;
    var p = pend; pend = null;
    var el = p.el;
    if (!el.isConnected) return;
    var ev = { t: "fill", tag: el.tagName.toLowerCase() };
    if (p.kind) ev.secretKind = p.kind;
    else ev.value = String(el.isContentEditable ? el.textContent : el.value).slice(0, 600);
    mark(el);
    ev.cands = candidatesFor(el);
    post(ev);
  }
  window.addEventListener("input", function (ev) {
    if (inspect.on) return;
    var el = tgt(ev); if (!el) return;
    var t = el.tagName;
    var ok = (t === "INPUT" && TEXTY.test(inType(el))) || t === "TEXTAREA" || (el.isContentEditable && el.getAttribute("contenteditable") !== null);
    if (!ok || disabled(el)) return;
    if (pend && pend.el !== el) flushFill();
    pend = { el: el, kind: secretKind(el) };
  }, true);
  window.addEventListener("focusout", function (ev) { if (pend && tgt(ev) === pend.el) flushFill(); }, true);
  window.addEventListener("change", function (ev) {
    if (inspect.on) return;
    var el = tgt(ev); if (!el) return;
    if (pend && pend.el === el) { flushFill(); return; }
    var t = el.tagName;
    if (t === "SELECT") {
      flushFill();
      if (disabled(el) || el.multiple) return;
      var o = el.selectedOptions && el.selectedOptions[0];
      if (!o) return;
      mark(el);
      post({ t: "select", tag: "select", value: (o.value !== "" ? o.value : norm(o.textContent)).slice(0, 600), cands: candidatesFor(el) });
    } else if (t === "INPUT") {
      var ty = inType(el);
      if (ty === "checkbox" || ty === "radio") {
        flushFill();
        if (disabled(el)) return;
        mark(el);
        post({ t: "check", tag: "input", checked: !!el.checked, cands: candidatesFor(el) });
      } else if (ty === "file") {
        // Only the file names: the content is never read. The test later takes a file of that name from the project's test files.
        if (disabled(el)) return;
        var names = arr(el.files || []).slice(0, 5).map(function (fl) { return String(fl.name).slice(0, 200); });
        if (!names.length) return;
        mark(el);
        post({ t: "upload", tag: "input", files: names, count: (el.files || []).length, cands: candidatesFor(el) });
      }
    }
  }, true);

  // ---- clicks ----------------------------------------------------------------------------------
  window.addEventListener("click", function (ev) {
    if (!ev.isTrusted) return;
    var raw = tgt(ev); if (!raw) return;
    if (inspect.on) { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); pick(raw); return; }
    flushFill();
    var el = interactive(raw);
    if (!el) { try { if (getComputedStyle(raw).cursor === "pointer") el = raw; } catch (e) {} }
    if (!el || disabled(el)) return;
    var t = el.tagName, ty = inType(el);
    if (t === "LABEL" && el.control) return;
    if (t === "SELECT" || t === "TEXTAREA" || el.isContentEditable) return;
    if (t === "INPUT" && !/^(button|submit|reset|image)$/.test(ty)) return;
    mark(el);
    post({ t: "click", tag: t.toLowerCase(), cands: candidatesFor(el) });
  }, true);
  window.addEventListener("submit", function () { post({ t: "act" }); }, true);
  // ---- drag and drop: the element picked up and the one it was dropped on (HTML5 drag events) ------
  var dragEl = null;
  window.addEventListener("dragstart", function (ev) { if (!ev.isTrusted || inspect.on) return; flushFill(); dragEl = tgt(ev); }, true);
  window.addEventListener("drop", function (ev) {
    if (!ev.isTrusted || inspect.on || !dragEl) return;
    var src = dragEl, dst = tgt(ev); dragEl = null;
    if (!dst || dst === src || !src.isConnected) return;
    mark(src);
    post({ t: "drag", tag: src.tagName.toLowerCase(), cands: candidatesFor(src), target: candidatesFor(dst) });
  }, true);
  window.addEventListener("dragend", function () { dragEl = null; }, true);

  // ---- keys: Enter, Escape and Tab only when they changed something -----------------------------
  function endKey(force) { if (keyWatch) keyWatch.resolve(force); }
  window.addEventListener("keydown", function (ev) {
    if (!ev.isTrusted || inspect.on) return;
    var k = ev.key;
    if (k !== "Enter" && k !== "Escape" && k !== "Tab") return;
    post({ t: "act" });
    flushFill();
    endKey(false);
    var el = tgt(ev) || document.activeElement;
    if (el && el.nodeType === 1) {
      var t = el.tagName, ty = inType(el);
      if (k === "Enter" && (t === "BUTTON" || t === "A" || t === "TEXTAREA" || t === "SUMMARY" || el.isContentEditable || (t === "INPUT" && /^(button|submit|reset|image|checkbox|radio)$/.test(ty)))) return;
    }
    var effect = false;
    var mo = new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) if (!(recs[i].type === "attributes" && recs[i].attributeName === "data-aitp-pick")) { effect = true; return; }
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    var onSubmit = function () { effect = true; resolve(true); };
    window.addEventListener("submit", onSubmit, true);
    var timer = setTimeout(function () { resolve(false); }, 250);
    function resolve(force) {
      clearTimeout(timer); mo.disconnect(); window.removeEventListener("submit", onSubmit, true); keyWatch = null;
      if (!effect && !force) return;
      var out = { t: "press", key: k };
      if (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement && el.isConnected) { mark(el); out.tag = el.tagName.toLowerCase(); out.cands = candidatesFor(el); }
      post(out);
    }
    keyWatch = { resolve: resolve };
  }, true);

  window.addEventListener("pagehide", function () {
    flushFill();
    endKey(true);
  }, true);

  // ---- inspector ---------------------------------------------------------------------------------
  function ensureOverlay() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;";
    var root = host.attachShadow({ mode: "closed" });
    box = document.createElement("div");
    box.style.cssText = "position:fixed;display:none;box-sizing:border-box;border:2px solid #0f766e;background:rgba(15,118,110,0.12);pointer-events:none;";
    lab = document.createElement("div");
    lab.style.cssText = "position:fixed;display:none;max-width:60vw;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:2px 6px;font:12px/16px monospace;background:#0f172a;color:#ffffff;pointer-events:none;";
    root.appendChild(box); root.appendChild(lab);
    document.documentElement.appendChild(host);
  }
  function hideOverlay() { hoverEl = null; if (box) box.style.display = "none"; if (lab) lab.style.display = "none"; if (host && host.parentNode) host.parentNode.removeChild(host); host = null; box = null; lab = null; }
  var ORDER = ["testId", "role", "label", "placeholder", "text", "css"];
  function quickLabel(el) {
    var cs = candidatesFor(el).filter(function (c) { return c.matches === 1 && c.hit; });
    cs.sort(function (a, b) { return ORDER.indexOf(a.strategy) - ORDER.indexOf(b.strategy); });
    var c = cs[0];
    if (!c) return el.tagName.toLowerCase();
    return c.strategy === "role" ? c.value + ' "' + c.name + '"' : c.strategy + ": " + c.value;
  }
  function showBox(el) {
    ensureOverlay();
    hoverEl = el;
    var r = el.getBoundingClientRect();
    box.style.left = r.left + "px"; box.style.top = r.top + "px"; box.style.width = r.width + "px"; box.style.height = r.height + "px"; box.style.display = "block";
    lab.textContent = quickLabel(el);
    lab.style.left = Math.max(0, r.left) + "px"; lab.style.top = (r.top > 22 ? r.top - 20 : r.bottom + 2) + "px"; lab.style.display = "block";
  }
  window.addEventListener("mouseover", function (ev) { if (!inspect.on) return; var e = tgt(ev); if (e) showBox(e); }, true);
  window.addEventListener("scroll", function () { if (inspect.on && hoverEl) showBox(hoverEl); }, true);
  ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend", "dblclick", "contextmenu", "auxclick"].forEach(function (n) {
    window.addEventListener(n, function (ev) { if (inspect.on) { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); } }, true);
  });
  function pick(el) {
    var sk = secretKind(el), tag = el.tagName.toLowerCase();
    var ev = { t: "pick", tag: tag, cands: candidatesFor(el), enabled: !disabled(el) };
    if (sk) ev.secretKind = sk;
    if (tag === "input" || tag === "textarea" || tag === "select") { if (!sk) ev.value = String(el.value == null ? "" : el.value).slice(0, 300); }
    else ev.text = norm(el.textContent).slice(0, 300);
    var g = groupFor(el);
    if (g) ev.group = g;
    mark(el);
    post(ev);
  }
  // ---- snapshot: what a tool sees of the page (read through the control function, never posted) ---------
  function isShown(el) {
    try {
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return false;
      var cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    } catch (e) { return false; }
  }
  function snapshotPage(max) {
    var found = arr(document.querySelectorAll("a[href],button,input,select,textarea,summary,[role],[onclick],[contenteditable]")).filter(function (el) {
      return el !== host && el.tagName !== "LABEL" && !(el.tagName === "INPUT" && inType(el) === "hidden") && isInteractive(el);
    });
    var shown = found.filter(isShown), rest = found.filter(function (el) { return !isShown(el); });
    var list = shown.concat(rest).slice(0, max);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i], tag = el.tagName.toLowerCase(), sk = secretKind(el);
      var d = { tag: tag, role: roleOf(el), name: accName(el), visible: isShown(el), enabled: !disabled(el), cands: candidatesFor(el) };
      if (sk) d.secretKind = sk;
      // A field a tool typed a stored credential into shows no value, whatever it holds or however the page shortened it.
      else if (el.hasAttribute("data-aitp-typed")) d.secretKind = "typed";
      else if (tag === "input" || tag === "textarea" || tag === "select") {
        var ty = inType(el);
        if (ty === "checkbox" || ty === "radio") d.checked = !!el.checked;
        else d.value = String(el.value == null ? "" : el.value).slice(0, 300);
      }
      out.push(d);
    }
    var body = document.body;
    return { url: location.href, title: document.title, text: body ? String(body.innerText || "").slice(0, 20000) : "", elements: out };
  }
  // A picture of the page must not show a secret: the fields are marked for the moment the picture is taken (and unmarked at once).
  function markSecrets(on) {
    var fields = arr(document.querySelectorAll("input"));
    for (var i = 0; i < fields.length; i++) {
      if (on) { if (secretKind(fields[i]) || fields[i].hasAttribute("data-aitp-typed")) fields[i].setAttribute("data-aitp-secret", "1"); }
      else fields[i].removeAttribute("data-aitp-secret");
    }
    return true;
  }
  Object.defineProperty(window, CFG.ctl, {
    value: function (s) {
      if (s && s.snapshot) return snapshotPage(Math.min(Number(s.max) || 60, 80));
      if (s && s.secretMark !== undefined) return markSecrets(!!s.secretMark);
      inspect.on = !!(s && s.on);
      inspect.mode = s && s.mode === "assertion" ? "assertion" : "locator";
      if (inspect.on) ensureOverlay(); else hideOverlay();
      return true;
    },
    enumerable: false, configurable: true
  });

  if (!IN_FRAME && location.href !== "about:blank") post({ t: "doc" });
})();
`;

/** The source to install in every page, with this session's names and the shared dynamic-value patterns filled in. */
export function recorderScript(cfg: PageScriptConfig): string {
    return SOURCE.replace("__CFG__", () => JSON.stringify(cfg)).replace("__DYN__", () => JSON.stringify(DYNAMIC_PATTERNS));
}
