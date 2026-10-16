// Injected into the proxied DSH page by lib/bridge.js.
//
// Goal: clicking a file path inside the official DSH UI opens it in VS Code
// (Alt/Cmd+click opens a native diff instead). The official UI renders file
// rows through React click handlers with no <a href>, so this script works in
// two layers:
//   1. best effort — inspect the clicked element and its ancestors for a path
//      and call the bridge;
//   2. always — report a compact description of every click to the bridge, so
//      `GET /__bridge/log` shows exactly what the real DOM looks like.
//
// Matching is deliberately strict: a status line such as
// "32 轮 258 步 · 168 tok/s69.3M tok" must never be mistaken for a file, so a
// text node has to BE a path (not merely contain one), an extension must start
// with a letter, and an attribute match returns only the matched span.
(() => {
  if (typeof window === "undefined" || !window.__DSH_BRIDGE__) return;
  const cfg = window.__DSH_BRIDGE__;
  if (window.__dshBridgeInstalled) return;
  window.__dshBridgeInstalled = true;

  // Mutable on purpose: a page can outlive the bridge that served it, and the
  // token it was loaded with is then stale (see `refreshToken`).
  let token = cfg.token;
  const MAX_REPORTS = 40;
  const RELOAD_KEY = "__dshBridgeReloadedAt";
  let reports = 0;

  // One path-shaped token: at least one separator and a letter-led extension, e.g.
  // src/main/app.ts, /home/me/dsh workspace/测试清单.md.
  //
  // What a segment may contain is the whole question. It excludes whitespace, the
  // separators, `#` (which starts a line/anchor suffix) and `:` (which starts a line),
  // so non-ASCII letters ARE allowed — a file really can be called `测试清单.md`. A
  // segment MAY hold single spaces, because a working directory really can be called
  // `dsh workspace`, but only from the SECOND segment on: a leading space-bearing
  // segment would swallow the prose in front of a path (`Read src/api/server.ts`
  // would match from `Read`). Widening the class stays safe because the extension
  // rule is untouched — the first character after the dot must be a LETTER, which is
  // what keeps rejecting the status line `168 tok/s69.3M tok` (`.3M` starts with a
  // digit).
  const SEG = String.raw`[^\s/\\:*?"<>|#]+`;
  const SPACED_SEG = String.raw`${SEG}(?: ${SEG})*`;
  const EXT = String.raw`\.[^\W\d_][^\s/\\:*?"<>|#]{0,7}`;
  /** Whole-text form: the text IS the path, so even its first segment may hold a space. */
  const PATH_TOKEN = String.raw`(?:\.{0,2}\/)?${SPACED_SEG}(?:\/${SPACED_SEG})+${EXT}`;
  /** Attribute form: a path inside a longer value, so the first segment must be tight. */
  const ATTR_TOKEN = String.raw`(?:\.{0,2}\/)?${SEG}(?:\/${SPACED_SEG})+${EXT}`;
  // Three suffixes, in this order:
  //   `:12`, `:12:5`, `:12-45`  a line / column / range (a range takes its first line)
  //   `#L12`, `#L12-45`         the same, in the `#` form DSH's own file-reference
  //                             prompt teaches the model to write
  //   `#anything-else`          an ANCHOR: text the bridge looks up in the file when
  //                             the link is clicked, so the jump survives later edits
  const SUFFIX = String.raw`(?::(\d{1,6})(?:[-:]\d{1,5})?|#L(\d{1,6})(?:-L?\d{1,6})?|#([^\s#][^#]*?))?`;
  /** The whole text is the path, optionally wrapped in quotes or brackets. */
  const TEXT_SHAPE = new RegExp(String.raw`^[\s"'([<]*(${PATH_TOKEN})${SUFFIX}[\s"')\]>,;]*$`, "u");
  /** The path sits inside a longer attribute value; only the match is used. */
  const ATTR_SHAPE = new RegExp(String.raw`(?:^|[\s"'(=])(${ATTR_TOKEN})${SUFFIX}(?=$|[\s"')\],;])`, "u");

  /** The line and anchor one match carries (groups 2/3 are lines, group 4 an anchor). */
  const suffixOf = (match) => {
    const line = Number(match[2] ?? match[3]);
    const anchor = typeof match[4] === "string" ? match[4].trim() : "";
    return {
      ...(Number.isFinite(line) && line > 0 ? { line } : {}),
      ...(anchor === "" ? {} : { anchor }),
    };
  };

  /** A trailing `:N`, `:N-M` or `#LN` on any string, as a line number. */
  const LINE_TAIL = /(?::(\d{1,6})(?:-\d{1,6})?|#L(\d{1,6})(?:-L?\d{1,6})?)\s*$/u;
  /**
   * The line a label ends with, for when the path and the line arrive through
   * DIFFERENT channels.
   *
   * The official UI renders a path it resolved as `<button title="<path>">` whose
   * visible text is whatever label the author wrote — so
   * `[index.js:19-40](<dsh-web-bridge/lib/index.js#L19-L40>)` becomes a button with
   * `title="dsh-web-bridge/lib/index.js"` and text `index.js:19-40`. The title
   * carries the path and NO line, so without this the editor opens the file at the
   * top and the line the user actually wrote is thrown away.
   * @param value - the element's own text.
   * @returns the line number, or undefined.
   */
  const lineTail = (value) => {
    if (typeof value !== "string") return undefined;
    const match = value.match(LINE_TAIL);
    if (match === null) return undefined;
    const line = Number(match[1] ?? match[2]);
    return Number.isFinite(line) && line > 0 ? line : undefined;
  };

  /** A trailing `#anchor` on a label — the anchor half of the same split channel. */
  const ANCHOR_TAIL = /#([^\s#][^#]*?)\s*$/u;
  /**
   * The anchor a label ends with, for `[index.js#deriveToken](<…/index.js#deriveToken>)`:
   * the chip's `title` carries the path, the visible label carries the anchor.
   * `#L24` is a line, not an anchor, and is left to {@link lineTail}.
   * @param value - the element's own text.
   * @returns the anchor, or undefined.
   */
  const anchorTail = (value) => {
    if (typeof value !== "string") return undefined;
    const match = value.match(ANCHOR_TAIL);
    if (match === null) return undefined;
    const anchor = match[1].trim();
    if (anchor === "" || /^L\d{1,6}(?:-L?\d{1,6})?$/u.test(anchor)) return undefined;
    return anchor;
  };

  /** Whole-text match: the node's text has to be the path and nothing else. */
  const textTarget = (value) => {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (text.length < 3 || text.length > 160) return undefined;
    const match = text.match(TEXT_SHAPE);
    if (match === null) return undefined;
    return { path: match[1], ...suffixOf(match) };
  };

  /** Attribute match: the path may be embedded in prose, so only it is returned. */
  const attrTarget = (value) => {
    if (typeof value !== "string" || value.length > 300) return undefined;
    const match = value.match(ATTR_SHAPE);
    if (match === null) return undefined;
    return { path: match[1], ...suffixOf(match) };
  };

  const attributesOf = (el) => {
    const out = {};
    for (const name of el.getAttributeNames?.() ?? []) {
      if (name === "class" || name === "style") continue;
      const value = el.getAttribute?.(name);
      if (typeof value === "string" && value.length <= 300) out[name] = value;
    }
    return out;
  };

  /** Look for a usable path on the clicked element, then on its ancestors. */
  const findTarget = (start) => {
    for (let el = start, depth = 0; el && depth < 8; el = el.parentElement, depth += 1) {
      if (el === document.body) break;
      const attrs = attributesOf(el);
      // An attribute supplies the path; the element's own text may still supply
      // the line the attribute dropped (see `lineTail`).
      const at = (found, via) => ({
        ...found,
        ...(found.line === undefined && lineTail(el.textContent) !== undefined ? { line: lineTail(el.textContent) } : {}),
        ...(found.anchor === undefined && anchorTail(el.textContent) !== undefined ? { anchor: anchorTail(el.textContent) } : {}),
        via,
        el,
      });
      for (const key of ["data-review-file", "data-path", "data-file", "data-filepath"]) {
        const found = attrTarget(attrs[key]);
        if (found !== undefined) return at(found, key);
      }
      for (const key of ["title", "aria-label", "href"]) {
        const found = attrTarget(attrs[key]);
        if (found !== undefined) return at(found, key);
      }
      const found = textTarget(el.textContent);
      if (found !== undefined) return { ...found, via: "text", el };
    }
    return undefined;
  };

  const describe = (el) => ({
    tag: el.tagName?.toLowerCase(),
    cls: (el.getAttribute?.("class") ?? "").slice(0, 160),
    attrs: attributesOf(el),
    text: (el.textContent ?? "").trim().slice(0, 200),
  });

  /** Post to a bridge endpoint. The status matters: 403 means a stale token. */
  const call = async (path, body, useToken = token) => {
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bridge-token": useToken },
        body: JSON.stringify(body ?? {}),
      });
      const parsed = await response.json().catch(() => ({ ok: response.ok }));
      return { ...parsed, status: response.status };
    } catch (error) {
      return { ok: false, error: String(error), status: 0 };
    }
  };

  /**
   * Re-read this document's own HTML to pick up a token minted by a newer
   * activation of the bridge.
   *
   * The document outlives the bridge: restarting DSH remounts the plugin, and the
   * only way a loaded page can learn the new token is to read it from a fresh
   * response. Everything else keeps working across that restart — the proxied UI
   * needs no token — so without this the page looks perfectly healthy while every
   * click fails with `missing or wrong bridge token`.
   * @returns whether a different token was adopted.
   */
  const refreshToken = async () => {
    try {
      const response = await fetch(location.href, { cache: "no-store" });
      if (!response.ok) return false;
      const html = await response.text();
      const found = html.match(/__DSH_BRIDGE__=(\{.*?\});<\/script>/su);
      if (found === null) return false;
      const next = JSON.parse(found[1])?.token;
      if (typeof next !== "string" || next === "" || next === token) return false;
      token = next;
      cfg.token = next;
      window.__DSH_BRIDGE__.token = next;
      console.info("[dsh-web-bridge] renewed a stale bridge token");
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Last resort when the token cannot be renewed in place: reload the document
   * (which re-injects a fresh token), at most once per 20 seconds, so a bridge
   * that keeps refusing cannot put the tab in a reload loop.
   * @returns whether a reload was started.
   */
  const reloadOnce = () => {
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
      if (Number.isFinite(last) && Date.now() - last < 20000) return false;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      location.reload();
      return true;
    } catch {
      return false;
    }
  };

  const toast = (message, bad) => {
    const box = document.createElement("div");
    box.setAttribute?.(TOAST_ATTR, "");
    box.textContent = message;
    box.style.cssText = [
      "position:fixed",
      "left:12px",
      "bottom:12px",
      "z-index:2147483647",
      "max-width:70vw",
      "padding:8px 12px",
      "border-radius:8px",
      "font:12px/1.5 system-ui,sans-serif",
      "color:#fff",
      `background:${bad ? "#b3261e" : "#1f6f3f"}`,
      "box-shadow:0 2px 12px rgba(0,0,0,.35)",
      "white-space:pre-wrap",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 4000);
  };

  // ------------------------------------------------------------- affordance
  //
  // A path the official UI leaves inert — a bare `<code>` its own resolver did not
  // claim — looks exactly like any other snippet, so nobody knows it is clickable.
  // Marking what this script already recognizes is the whole fix, and it asks
  // nothing of DSH, of the model that wrote the message, or of the reader.
  const LINK_ATTR = "data-dsh-bridge-link";
  /** Where an element's original tooltip is parked while ours is in place. */
  const TITLE_ATTR = "data-dsh-bridge-title";
  const TOAST_ATTR = "data-dsh-bridge-toast";
  const STYLE_ID = "dsh-web-bridge-affordance";
  const OPT_OUT_KEY = "dsh-web-bridge:decorate";
  /** Elements examined per pass; streaming re-runs this often, so it stays small. */
  const SCAN_BUDGET = 4000;
  // Percent-encoded: a data URI inside a CSS url() must not carry raw angle
  // brackets, and `#` in the stroke colour would otherwise start a fragment.
  const LINK_ICON =
    "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E" +
    "%3Cpath d='M6.5 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h7a1.5 1.5 0 0 0 1.5-1.5V9' fill='none' stroke='%23000' stroke-width='1.7' stroke-linecap='round'/%3E" +
    "%3Cpath d='M10 2.5h3.5V6M13.5 2.5 8.5 7.5' fill='none' stroke='%23000' stroke-width='1.7' stroke-linecap='round'/%3E%3C/svg%3E\")";

  /** Interactive, editable, or our own chrome: never decorated. */
  const isInteractive = (el) => {
    for (let node = el, depth = 0; node !== null && node !== undefined && depth < 4; node = node.parentElement, depth += 1) {
      const tag = String(node.tagName ?? "").toLowerCase();
      if (tag === "button" || tag === "a" || tag === "input" || tag === "textarea" || tag === "select") return true;
      if (node.isContentEditable === true) return true;
      if (node.getAttribute?.(TOAST_ATTR) !== null && node.getAttribute?.(TOAST_ATTR) !== undefined) return true;
    }
    return false;
  };

  /** The computed display, when the environment can answer; undefined means "unknown". */
  const displayOf = (el) => {
    try {
      const view = el.ownerDocument?.defaultView ?? window;
      return typeof view.getComputedStyle === "function" ? view.getComputedStyle(el).display : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Whether this element is a path this script would open, and should therefore
   * look like one.
   *
   * Only INLINE flow qualifies: a `<div>` or `<li>` that happens to contain one
   * path is a layout box or a line of some viewer, where an underline is noise
   * rather than a hint. `textTarget` runs first because it is a cheap string
   * check, and `display` is read only for the few elements that pass it.
   * @param el - candidate element.
   * @param display - its computed display, when known.
   * @returns whether to decorate it.
   */
  const isPathElement = (el, display) => {
    if (el === null || typeof el !== "object") return false;
    if (textTarget(el.textContent) === undefined) return false;
    if (isInteractive(el)) return false;
    return typeof display !== "string" || display.startsWith("inline");
  };

  /** The tooltip, in the reader's language — the same rule the settings page uses. */
  const TITLE_TEXT =
    typeof navigator === "object" && String(navigator?.language ?? "").toLowerCase().startsWith("zh")
      ? "在编辑器中打开（Alt 或 ⌘ 点击看 diff）"
      : "Open in your editor (Alt or ⌘ click for a diff)";

  const decorate = (el) => {
    el.setAttribute?.(LINK_ATTR, "");
    // Never destroy a tooltip that was already there: `title` is one of the matcher's
    // own path sources, so clobbering it could break the click this mark advertises.
    const existing = el.getAttribute?.("title");
    if (typeof existing === "string" && existing !== "") el.setAttribute?.(TITLE_ATTR, existing);
    // No path-shaped token here on purpose: a tooltip must never become the thing
    // that resolves the click.
    el.setAttribute?.("title", TITLE_TEXT);
  };

  const undecorate = (el) => {
    el.removeAttribute?.(LINK_ATTR);
    const stashed = el.getAttribute?.(TITLE_ATTR);
    if (typeof stashed === "string") {
      el.setAttribute?.("title", stashed);
      el.removeAttribute?.(TITLE_ATTR);
    } else {
      el.removeAttribute?.("title");
    }
  };

  /** Bring one element in line with what its text says right now. */
  const sync = (el) => {
    if (el === null || typeof el !== "object") return;
    const marked = el.getAttribute?.(LINK_ATTR) !== null && el.getAttribute?.(LINK_ATTR) !== undefined;
    if (textTarget(el.textContent) === undefined) {
      if (marked) undecorate(el);
      return;
    }
    if (marked) return;
    if (isPathElement(el, displayOf(el))) decorate(el);
  };

  /**
   * Walk a subtree, looking only at leaves — the shape inline code actually has.
   *
   * The root is synced when it is itself a leaf: React appends the `<code>`
   * element holding a path directly, so a walk that only visited CHILDREN would
   * never see the common case. Nothing reads `textContent` on a container, so a
   * large added subtree costs one traversal and no string building.
   */
  const decorateSubtree = (root) => {
    if (root === null || typeof root !== "object" || root.nodeType !== 1) return;
    let budget = SCAN_BUDGET;
    const walk = (node) => {
      for (let child = node.firstElementChild; child !== null && child !== undefined; child = child.nextElementSibling) {
        budget -= 1;
        if (budget <= 0) return;
        if (child.firstElementChild === null || child.firstElementChild === undefined) sync(child);
        else walk(child);
      }
    };
    const leaf = root.firstElementChild === null || root.firstElementChild === undefined;
    if (leaf) sync(root);
    else walk(root);
  };

  const installStyle = () => {
    if (typeof document.getElementById === "function" && document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${LINK_ATTR}] {
        cursor: pointer;
        text-decoration: underline dotted currentColor;
        text-decoration-thickness: 1px;
        text-underline-offset: 2px;
        border-radius: 3px;
      }
      [${LINK_ATTR}]:hover {
        text-decoration-style: solid;
        background: color-mix(in srgb, currentColor 12%, transparent);
      }
      [${LINK_ATTR}]:hover::after {
        content: "";
        display: inline-block;
        width: .85em;
        height: .85em;
        margin-left: .28em;
        vertical-align: -.08em;
        background-color: currentColor;
        opacity: .6;
        -webkit-mask: ${LINK_ICON} center / contain no-repeat;
        mask: ${LINK_ICON} center / contain no-repeat;
      }
    `;
    (document.head ?? document.body)?.appendChild?.(style);
  };

  /**
   * Mark recognized paths now, and keep marking as the chat streams.
   *
   * Two escape hatches, neither needing a bridge restart: the injected config may
   * set `decorate: false`, and a user may run
   * `localStorage.setItem("dsh-web-bridge:decorate", "off")` in DevTools.
   */
  const startAffordance = () => {
    if (cfg.decorate === false) return;
    try {
      if (localStorage.getItem(OPT_OUT_KEY) === "off") return;
    } catch {
      /* private mode: decoration is harmless, keep it */
    }
    installStyle();
    const body = document.body;
    if (body === null || body === undefined) return;
    decorateSubtree(body);
    if (typeof MutationObserver !== "function") return;

    const pending = [];
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      for (const node of pending.splice(0, pending.length)) decorateSubtree(node);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        // Streaming replaces TEXT far more often than it adds elements, so a
        // character-data mutation has to be heard as well as a child list.
        if (record.type === "characterData") {
          if (record.target?.parentElement != null) pending.push(record.target.parentElement);
          continue;
        }
        for (const node of record.addedNodes ?? []) {
          if (node.nodeType === 1) pending.push(node);
          else if (node.parentElement != null) pending.push(node.parentElement);
        }
      }
      if (pending.length === 0 || scheduled) return;
      scheduled = true;
      setTimeout(flush, 120);
    }).observe(body, { childList: true, subtree: true, characterData: true });
  };

  /** Set while a click is being handed back to the Harness's own handler. */
  let handingBack = false;

  document.addEventListener(
    "click",
    async (event) => {
      // A handed-back click must reach the Harness untouched, or it would loop.
      if (handingBack) {
        handingBack = false;
        return;
      }
      const target = findTarget(event.target);
      const wantDiff = Boolean(event.altKey || event.metaKey);

      if (reports < MAX_REPORTS) {
        reports += 1;
        void call("/__bridge/report", {
          url: location.href.slice(0, 120),
          alt: wantDiff,
          found: target ? { path: target.path, line: target.line, anchor: target.anchor, via: target.via } : null,
          chain: [event.target, event.target?.parentElement, event.target?.parentElement?.parentElement]
            .filter(Boolean)
            .map(describe),
        });
      }

      if (!target) return;

      // Take the click over BEFORE the async work: React's onClick lives on the root
      // container, a descendant of `document`, so stopping propagation in the capture
      // phase is what keeps the Harness viewer from opening a second tab.
      const takenOver = takesOver(shellOf());
      if (takenOver) {
        event.preventDefault();
        event.stopPropagation();
      }

      const endpoint = wantDiff ? "/__bridge/diff" : "/__bridge/open";
      const request = { file: target.path, line: target.line, anchor: target.anchor, via: target.via };
      let reply = await call(endpoint, request);

      if (reply.status === 403) {
        // The page is older than the bridge serving it. Renew and retry once;
        // only if the renewal is impossible does this cost a reload.
        if (await refreshToken()) reply = await call(endpoint, request);
        else if (reloadOnce()) {
          toast("bridge: token 已过期，正在刷新页面…", false);
          return;
        }
      }

      // Three lines at most: what happened, what is actually on that line (or why
      // the number cannot be right), then the command that ran. The middle line is
      // what turns a wrong jump from a silent surprise into something readable.
      const segments = String(reply?.root ?? "").split("/").filter(Boolean);
      const where =
        reply?.resolvedBy === "scan" && segments.length > 0 ? `  （在 ${segments[segments.length - 1]}/ 下找到）` : "";
      const at = `${reply?.file ?? target.path}${reply?.line ? `:${reply.line}` : ""}`;
      const anchorNote =
        reply?.anchor === undefined
          ? ""
          : reply.anchorMissed === true
            ? ` · 锚点「${reply.anchor}」没找到${reply.anchorPartial === true ? "（文件太大，只搜了前 512KB）" : ""}`
            : reply.anchorMatches > 1
              ? ` · 锚点「${reply.anchor}」命中 ${reply.anchorMatches} 处，取第一处`
              : ` · 锚点「${reply.anchor}」命中 1 处`;
      const detail =
        reply?.ok === true && reply.lineText !== undefined
          ? `\n:${reply.line} 「${reply.lineText}」`
          : reply?.ok === true && reply.beyond === true
            ? `\n⚠ 文件只有 ${reply.total} 行，第 ${reply.line} 行不存在`
            : "";
      const alternatives = Array.isArray(reply?.candidates) ? `\n${reply.candidates.slice(0, 3).join("\n")}` : "";
      toast(
        reply?.ok
          ? `bridge: ${wantDiff ? "diff" : "open"} ${at}${where}${anchorNote}${detail}\n${reply.command ?? reply.uri ?? ""}`
          : `bridge: 失败 ${reply?.error ?? "unknown"}\n${target.path}${alternatives}`,
        !reply?.ok || reply?.beyond === true,
      );

      // We suppressed the Harness's own handler and then failed: give the click back,
      // so the worst case is "the Harness viewer opened as usual", never "nothing
      // happened". The one-shot flag keeps this from looping.
      if (takenOver && reply?.ok !== true && typeof target.el?.click === "function") {
        handingBack = true;
        try {
          target.el.click();
        } catch {
          handingBack = false;
        }
      }
    },
    true,
  );

  /**
   * Which shell this document is running in, as far as it can tell.
   *
   * MEASURED, not assumed: VS Code's Simple Browser is NOT an iframe — it navigates
   * the webview itself, so `window.top === window` there too. What actually separates
   * it from a plain browser tab is the user agent (`Code/1.141.0 … Electron/43.7.7`
   * versus a bare `Chrome/154`). `embedded` is kept as an OR because some other shell
   * may well use an iframe, and JetBrains' `JCEF` marker is included on the same
   * reasoning — unmeasured so far, and cheap to recognise if it shows up.
   * @returns `"ide"`, `"frame"` or `"browser"`.
   */
  const classifyShell = (ua, embedded) => {
    if (/electron|jcef|vscode|\bcode\//iu.test(String(ua ?? ""))) return "ide";
    return embedded === true ? "frame" : "browser";
  };

  /** This document's own answer to the same question. */
  const shellOf = () => {
    const ua = typeof navigator === "object" && navigator !== null ? String(navigator.userAgent ?? "") : "";
    let embedded = false;
    try {
      embedded = window.top !== window;
    } catch {
      embedded = true; // a cross-origin parent still means "embedded"
    }
    return classifyShell(ua, embedded);
  };

  /**
   * Whether a click we are about to handle should also suppress the Harness's own
   * handler for that element.
   *
   * Taking over removes the duplicate action (the Harness viewer tab) but is a
   * SYNCHRONOUS decision about an ASYNCHRONOUS outcome, so it is off by default and
   * `auto` only opts in where "open it in my editor" is obviously the intent: inside
   * an IDE shell. A failed open is handed back to the Harness either way.
   * @returns whether to take the click over.
   */
  const takesOver = (shell) => {
    const mode = cfg.hijackChip;
    if (mode === true || mode === "on") return true;
    if (mode !== "auto") return false;
    return shell === "ide" || shell === "frame";
  };

  /**
   * One line of environment facts per page load.
   *
   * Whether taking over the official chip is desirable depends on facts this page
   * knows and the bridge does not: is this document embedded in a shell (VS Code's
   * Simple Browser is an iframe inside a webview, a plain browser tab is not), and
   * what is it running in. Reporting them once — instead of guessing from a user
   * agent in the bridge — also makes `/__bridge/log` answer "which page did that
   * click come from" later.
   */
  const announce = () => {
    const shell = shellOf();
    let embedded = false;
    try {
      embedded = window.top !== window;
    } catch {
      embedded = true;
    }
    void call("/__bridge/report", {
      kind: "hello",
      url: location.href.slice(0, 120),
      shell,
      hijack: takesOver(shell),
      embedded,
      ua: (typeof navigator === "object" && navigator !== null ? String(navigator.userAgent ?? "") : "").slice(0, 200),
      ...(typeof document.referrer === "string" && document.referrer !== "" ? { referrer: document.referrer.slice(0, 120) } : {}),
    });
  };

  try {
    announce();
  } catch {
    /* the diagnostic must never be the thing that fails */
  }

  // Decoration never runs before the click bridge is armed, and never throws into
  // it: the affordance is a hint, the handler is the feature.
  try {
    startAffordance();
  } catch (error) {
    console.info("[dsh-web-bridge] affordance skipped", error);
  }

  // Exposed for the matcher regression test and for DevTools debugging. Last, because
  // it names every helper above — declaring it earlier put `announce` in its temporal
  // dead zone and took the whole click bridge down.
  window.__DSH_BRIDGE_MATCH__ = { textTarget, attrTarget, findTarget, TEXT_SHAPE, ATTR_SHAPE, isPathElement, sync, decorateSubtree, lineTail, anchorTail, announce, classifyShell, takesOver };
  console.info("[dsh-web-bridge] click bridge installed; alt/⌘+click opens a diff");
})();
