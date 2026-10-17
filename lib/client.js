// Client half. Two seats, one field implementation:
//
//   1. `settings.section` — the "DSH Web Bridge" page. It resolves the entry's
//      form through the shared `configForms` client service, so this page is
//      editable directly, not just informative.
//   2. `plugins.row.config` (key `<package>#<row id>`) — the same form on the
//      row's own configuration page, where the page owner hands the form in.
window.__ModuleLoader__.load({
  id: '@ni123niwjsj/dsh-web-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BUNDLE = '@ni123niwjsj/dsh-web-bridge';
    const ROW_ID = 'dsh-web-bridge';
    const ROW_CONFIG_KEY = `${BUNDLE}#${ROW_ID}`;
    // A settings namespace is the row's patch id, which is also
    // `entry.options.id` — `dsh-web-bridge` here. The Loader's tree node id
    // (`include:dsh-web-bridge`) and the plugins page's `<package>#<rowId>` slot
    // key are never namespaces; they stay in the list only as defensive
    // fallbacks, and are what the `tried:` diagnostic reports when nothing is
    // served.
    const ENTRY_IDS = [ROW_ID, `include:${ROW_ID}`, BUNDLE + '#' + ROW_ID];

    const TEXT = {
      zh: {
        title: 'DSH Web 桥接',
        running: '运行中',
        stopped: '未启动',
        failed: '启动失败',
        starting: '启动中',
        steps: [
          'VS Code：Ctrl+Shift+P → Simple Browser: Show → 粘贴上面的地址',
          '想固定布局：标签拖到右侧分栏，点一下那个组，再执行命令「锁定组」',
          'JetBrains / 其他 IDE：用内置 Web 预览或外部浏览器打开同一个地址',
        ],
        click: '点击跳转',
        copy: '复制',
        copied: '已复制',
        events: '最近事件',
        error: '错误',
        settings: '配置',
        searchRoots: '相对路径搜索目录',
        loading: '正在读取配置…',
        notServed: '这一行在当前部署里没有向本客户端公开配置（或宿主未提供 settings 通道）。',
        overridden: '已覆盖',
        isDefault: '默认',
        restore: '恢复默认',
        add: '添加',
        remove: '删除',
        save: '保存',
        discard: '放弃更改',
        saving: '保存中…',
        saved: '已保存。改到端口/上游/root/点击开关时桥接会按新配置重启，本页重载一次即可。',
        refused: '宿主拒绝了这次修改（校验未通过或版本已变），请刷新后重试。',
        saveFailed: '保存失败',
        needsRestart: '涉及端口/上游/root/点击开关的改动会重启桥接。',
        invalid: {
          port: '端口需为 1–65535 的整数',
          upstream: '格式应为 host:port，例如 127.0.0.1:3080',
          roots: '每个 root 必须是绝对路径',
          openCommand: '不能为空',
        },
        fields: {
          port: '端口',
          upstream: '上游地址',
          roots: 'root 目录',
          injectClickScript: '注入点击脚本',
          autoStart: '随 DSH 启动',
          openCommand: '打开文件的命令',
          launchMode: '打开方式',
          hijackChip: '接管官方胶囊',
          anchorPrompt: '给模型一段锚点提示词',
          diffModifier: 'diff 修饰键',
          diffHint: {
            alt: '默认。Linux 上很多窗口管理器会把 Alt+点击截走(那是"Alt+拖动移动窗口"那套),这时页面根本收不到。',
            ctrl: '适合 Linux:Ctrl+点击看 diff。',
            shift: 'Shift+点击看 diff。',
            always: '每一次点击都开 diff(没有"只打开文件"了)。',
          },
          decorate: '路径可点外观',
        },
        launchHint: { auto: 'auto：先编辑器 CLI，失败回退桌面 portal', editor: 'editor：只用 CLI', portal: 'portal：走 vscode:// + xdg-desktop-portal（Linux）' },
        hijackHint: { off: 'off：官方预览标签照常打开（默认）', auto: 'auto：只在 IDE 壳里接管（VS Code 等），浏览器里保持官方行为', on: 'on：总是接管，只开编辑器' },
        decorateHint: '给它认出来的行内路径加虚线下划线 + 手型光标，让人看得出能点',
      },
      en: {
        title: 'DSH Web Bridge',
        running: 'Running',
        stopped: 'Stopped',
        failed: 'Failed',
        starting: 'Starting',
        steps: [
          'VS Code: Ctrl+Shift+P → Simple Browser: Show → paste the address above',
          'For a fixed layout: drag the tab into a right-hand group, click that group, then run “Lock Group”.',
          'JetBrains / other IDEs: open the same address in the built-in web preview or an external browser.',
        ],
        click: 'Click to open',
        copy: 'Copy',
        copied: 'Copied',
        events: 'Recent events',
        error: 'Error',
        settings: 'Configuration',
        searchRoots: 'Relative-path search roots',
        loading: 'Loading configuration…',
        notServed: 'This row exposes no configuration to this client in this deployment (or the host serves no settings channel).',
        overridden: 'overridden',
        isDefault: 'default',
        restore: 'Restore default',
        add: 'Add',
        remove: 'Remove',
        save: 'Save',
        discard: 'Discard',
        saving: 'Saving…',
        saved: 'Saved. Changing port/upstream/roots/click switch restarts the bridge; reload this page once.',
        refused: 'The host refused the change (validation failed or the revision moved). Reload and retry.',
        saveFailed: 'Save failed',
        needsRestart: 'Port/upstream/roots/click-switch changes restart the bridge.',
        invalid: {
          port: 'Port must be an integer from 1 to 65535',
          upstream: 'Expected host:port, e.g. 127.0.0.1:3080',
          roots: 'Every root must be an absolute path',
          openCommand: 'Must not be empty',
        },
        fields: {
          port: 'Port',
          upstream: 'Upstream',
          roots: 'Root directories',
          injectClickScript: 'Inject click script',
          autoStart: 'Start with DSH',
          openCommand: 'Editor command',
          launchMode: 'Launch mode',
          hijackChip: 'Take over the file chip',
          anchorPrompt: 'Teach the model the anchor form',
          diffModifier: 'Diff modifier',
          diffHint: {
            alt: 'Default. Many Linux window managers swallow Alt+click (that is the "Alt+drag moves a window" gesture), so the page never sees it.',
            ctrl: 'The Linux-friendly choice: Ctrl+click for a diff.',
            shift: 'Shift+click for a diff.',
            always: 'Every click opens a diff (there is no plain open any more).',
          },
          decorate: 'Clickable-path styling',
        },
        launchHint: { auto: 'auto: editor CLI first, then the desktop portal', editor: 'editor: CLI only', portal: 'portal: vscode:// via xdg-desktop-portal (Linux)' },
        hijackHint: { off: 'off: the Harness viewer still opens too (default)', auto: 'auto: take over inside an IDE shell only, leave a plain browser alone', on: 'on: always take over, editor only' },
        decorateHint: 'Underline and pointer on recognised inline paths, so they look clickable',
      },
    };

    // ---------------------------------------------------------------- styles
    const muted = { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' };
    const mono = { fontFamily: 'var(--ds-font-family-code, ui-monospace, Menlo, monospace)', fontSize: 12 };
    const input = {
      background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.10))',
      border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.30))',
      borderRadius: 'var(--dsw-radius-xs, 4px)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      padding: '4px 8px',
      font: 'inherit',
      minWidth: 220,
    };
    const button = (disabled) => ({
      border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
      background: disabled ? 'transparent' : 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-3, rgba(127,127,127,.14)))',
      color: 'inherit',
      borderRadius: 'var(--dsw-radius-xs, 4px)',
      padding: '3px 10px',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      fontSize: 12,
    });

    const locale = () => ((navigator.language || 'en').toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en);
    const info = () => window.__DSH_WEB_BRIDGE__ || {};
    const stateLabel = (t, state) =>
      state === 'running' ? t.running : state === 'failed' ? t.failed : state === 'starting' ? t.starting : t.stopped;
    const dotColor = (state) => (state === 'running' ? '#2ea043' : state === 'failed' ? '#d1242f' : '#8b8b8b');
    const absolute = (value) => typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value));

    const FIELDS = [
      { key: 'port', kind: 'number', hint: '1–65535', check: (v) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? null : 'port') },
      { key: 'upstream', kind: 'text', hint: 'host:port', check: (v) => (/^[^\s/:]+:\d{1,5}$/u.test(String(v ?? '')) ? null : 'upstream') },
      { key: 'roots', kind: 'list', check: (v) => ((v ?? []).every(absolute) ? null : 'roots') },
      { key: 'injectClickScript', kind: 'boolean' },
      { key: 'decorate', kind: 'boolean', hintKey: 'decorateHint' },
      { key: 'hijackChip', kind: 'select', options: ['off', 'auto', 'on'] },
      { key: 'diffModifier', kind: 'select', options: ['alt', 'ctrl', 'shift', 'always'] },
      { key: 'anchorPrompt', kind: 'boolean' },
      { key: 'autoStart', kind: 'boolean' },
      { key: 'openCommand', kind: 'text', check: (v) => (String(v ?? '').trim() === '' ? 'openCommand' : null) },
      { key: 'launchMode', kind: 'select', options: ['auto', 'editor', 'portal'] },
    ];

    // ------------------------------------------------------------- fragments
    function CopyButton({ value, t }) {
      const [copied, setCopied] = React.useState(false);
      return h('button', {
        style: button(false),
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(value || '');
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* the address stays selectable */
          }
        },
      }, copied ? t.copied : t.copy);
    }

    function StatusHead({ t, url }) {
      const live = info();
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        h('div', { key: 'row', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('span', { key: 'dot', style: { width: 8, height: 8, borderRadius: 4, background: dotColor(live.state), flex: 'none' } }),
          h('strong', { key: 'label' }, `${t.title} · ${stateLabel(t, live.state)}`),
          live.startedAt ? h('span', { key: 'since', style: muted }, live.startedAt.replace('T', ' ').slice(0, 19)) : null,
        ]),
        h('div', { key: 'url', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('code', { key: 'code', style: { ...mono, padding: '4px 8px', borderRadius: 'var(--dsw-radius-xs, 4px)', background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.12))' } }, url || '—'),
          h(CopyButton, { key: 'copy', value: url, t }),
        ]),
        live.error ? h('div', { key: 'err', style: { color: '#d1242f' } }, `${t.error}: ${live.error}`) : null,
      ]);
    }

    function RootsEditor({ value, onChange, t, disabled }) {
      const list = value ?? [];
      const [draft, setDraft] = React.useState('');
      const add = () => {
        const next = draft.trim();
        if (next === '') return;
        onChange([...list, next]);
        setDraft('');
      };
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
        ...list.map((entry, index) =>
          h('div', { key: `r${index}`, style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
            h('code', { key: 'v', style: { ...mono, flex: 1 } }, entry),
            h('button', { key: 'x', style: button(disabled), disabled, onClick: () => onChange(list.filter((_, at) => at !== index)) }, t.remove),
          ]),
        ),
        h('div', { key: 'add', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
          h('input', {
            key: 'i',
            style: { ...input, minWidth: 260 },
            placeholder: '/absolute/path',
            value: draft,
            disabled,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') add();
            },
          }),
          h('button', { key: 'b', style: button(disabled || draft.trim() === ''), disabled: disabled || draft.trim() === '', onClick: add }, t.add),
        ]),
      ]);
    }

    /** The shared form body: identical on the settings page and the row page. */
    function ConfigFields({ t, state, mutate }) {
      const [draft, setDraft] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);

      const values = state?.value ?? {};
      const user = state?.user && typeof state.user === 'object' ? state.user : {};
      const writable = state?.writable !== false && state?.mode !== 'memory';
      const effective = (key) => (key in draft ? draft[key] : values[key]);
      const overridden = (key) => Object.prototype.hasOwnProperty.call(user, key);

      const ops = [];
      const errors = {};
      for (const field of FIELDS) {
        if (!(field.key in draft)) continue;
        const next = effective(field.key);
        if (JSON.stringify(next) === JSON.stringify(values[field.key])) continue;
        const problem = field.check?.(next) ?? null;
        if (problem !== null) errors[field.key] = t.invalid[problem];
        if (next === undefined || next === '') ops.push({ op: 'unset', path: [field.key] });
        else ops.push({ op: 'set', path: [field.key], value: next });
      }
      const dirty = ops.length > 0;
      const blocked = !writable || Object.keys(errors).length > 0 || busy;

      const save = async () => {
        setBusy(true);
        setNote(null);
        try {
          const accepted = await mutate(ops, state?.revision);
          if (accepted) {
            setDraft({});
            setNote(t.saved);
          } else {
            setNote(t.refused);
          }
        } catch (error) {
          setNote(`${t.saveFailed}: ${String(error?.message ?? error)}`);
        } finally {
          setBusy(false);
        }
      };

      const rows = FIELDS.map((field) => {
        const value = effective(field.key);
        const control =
          field.kind === 'boolean'
            ? h('input', { type: 'checkbox', checked: value === true, disabled: !writable, onChange: (event) => setDraft({ ...draft, [field.key]: event.target.checked }) })
            : field.kind === 'select'
              ? h('select', { style: input, value: value ?? field.options[0], disabled: !writable, onChange: (event) => setDraft({ ...draft, [field.key]: event.target.value }) },
                  field.options.map((option) => h('option', {
                    key: option,
                    value: option,
                    style: { backgroundColor: 'var(--dsw-alias-bg-layer-2, #2b2b2b)', color: 'var(--dsw-alias-label-primary, #e6e6e6)' },
                  }, option)))
              : field.kind === 'list'
                ? h(RootsEditor, { value, disabled: !writable, t, onChange: (next) => setDraft({ ...draft, [field.key]: next }) })
                : h('input', {
                    style: input,
                    type: field.kind === 'number' ? 'number' : 'text',
                    value: value ?? '',
                    disabled: !writable,
                    onChange: (event) => {
                      const raw = event.target.value;
                      setDraft({ ...draft, [field.key]: field.kind === 'number' ? (raw === '' ? undefined : Number(raw)) : raw });
                    },
                  });

        return h('div', { key: field.key, style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 } }, [
          h('div', { key: 'label', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
            h('span', { key: 'name' }, t.fields[field.key]),
            h('span', { key: 'badge', style: { ...muted, fontSize: 11 } }, `${overridden(field.key) ? t.overridden : t.isDefault} · `),
            overridden(field.key) && writable
              ? h('button', {
                  key: 'restore',
                  style: { ...button(false), fontSize: 11, padding: '1px 6px' },
                  onClick: () => mutate([{ op: 'unset', path: [field.key] }], state?.revision),
                }, t.restore)
              : null,
            field.hint ? h('span', { key: 'hint', style: { ...muted, fontSize: 11 } }, field.hint) : null,
          ]),
          h('div', { key: 'ctl' }, control),
          errors[field.key] ? h('div', { key: 'err', style: { color: '#d1242f', fontSize: 11 } }, errors[field.key]) : null,
          field.key === 'launchMode'
            ? h('div', { key: 'lh', style: { ...muted, fontSize: 11 } }, t.launchHint[value] ?? '')
            : field.key === 'diffModifier'
              ? h('div', { key: 'dh', style: { ...muted, fontSize: 11 } }, t.diffHint?.[value] ?? '')
              : field.key === 'hijackChip'
              ? h('div', { key: 'hh', style: { ...muted, fontSize: 11 } }, t.hijackHint[value] ?? '')
              : field.hintKey
                ? h('div', { key: 'gh', style: { ...muted, fontSize: 11 } }, t[field.hintKey] ?? '')
                : null,
        ]);
      });

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h('div', { key: 'fields' }, rows),
        h('div', { key: 'actions', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          h('button', { key: 'save', style: button(blocked || !dirty), disabled: blocked || !dirty, onClick: save }, busy ? t.saving : t.save),
          h('button', { key: 'discard', style: button(!dirty || busy), disabled: !dirty || busy, onClick: () => { setDraft({}); setNote(null); } }, t.discard),
          h('span', { key: 'hint', style: { ...muted, fontSize: 11 } }, t.needsRestart),
        ]),
        note ? h('div', { key: 'note', style: { fontSize: 12 } }, note) : null,
      ]);
    }

    /**
     * Resolve the shared form for whichever candidate namespace the host serves.
     *
     * `settings` serves *settings-document namespaces* (`llm-deepseek`,
     * `llm-pi-ai`, …) — official rows work because their row id and their
     * settings namespace happen to be the same string. A row that only declares
     * a Cordis Config may therefore have no namespace at all; the candidate list
     * and the served-namespace report exist so that case is visible instead of
     * silently missing a form.
     */
    function useSharedForm(forms) {
      const [, setTick] = React.useState(0);
      const entries = [];
      let served;
      if (forms && typeof forms.get === 'function') {
        for (const id of ENTRY_IDS) {
          try {
            const form = forms.get(id);
            entries.push({ id, form, status: form?.getSnapshot?.().status });
          } catch {
            /* not addressable in this deployment */
          }
        }
        try {
          const view = typeof forms.describe === 'function' ? forms.describe()?.getSnapshot?.() : undefined;
          served = (view?.view?.namespaces ?? []).map((entry) => entry.ns ?? String(entry));
        } catch {
          /* describe face unavailable */
        }
      }
      React.useEffect(() => {
        const disposers = entries.map((entry) => entry.form?.subscribe?.(() => setTick((value) => value + 1)));
        return () => disposers.forEach((dispose) => dispose?.());
      }, [forms]);
      const chosen = entries.find((entry) => entry.form?.getSnapshot?.().status === 'ready') ?? entries[0];
      return { entry: chosen, entries, served, snapshot: chosen?.form?.getSnapshot?.() };
    }

    /** The row configuration page: the page owner hands the form in as a prop. */
    function RowConfig({ view = 'page', form }) {
      const t = locale();
      const live = info();
      const url = live.url || (form?.state?.value?.port ? `http://127.0.0.1:${form.state.value.port}/` : undefined);

      if (view === 'summary') return h('span', { style: muted }, `${t.title}: ${url || '—'}`);

      // No form object at all means the row exposes nothing in THIS deployment — saying
      // "still reading the configuration…" forever is a lie the user cannot act on.
      if (form === undefined) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
          h(StatusHead, { key: 'head', t, url }),
          h('div', { key: 'notice', style: muted }, t.notServed),
        ]);
      }
      if (form.state.status === 'loading') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
          h(StatusHead, { key: 'head', t, url }),
          h('div', { key: 'notice', style: muted }, t.loading),
        ]);
      }
      if (form.state.status === 'unavailable') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
          h(StatusHead, { key: 'head', t, url }),
          h('div', { key: 'notice', style: muted }, t.notServed),
        ]);
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: 1.6 } }, [
        h(StatusHead, { key: 'head', t, url }),
        h('div', { key: 'upstream', style: muted }, `→ http://${live.upstream || form.state.value?.upstream || '127.0.0.1:3080'}/ · ${t.click}: ${live.injectClickScript === false ? 'off' : 'on'}`),
        searchRootsLine(t, live.searchRoots),
        h(ConfigFields, { key: 'form', t, state: form.state, mutate: form.mutate }),
      ]);
    }

    /** One muted line listing the live relative-path search directories. */
    function searchRootsLine(t, searchRoots) {
      const list = Array.isArray(searchRoots) ? searchRoots : [];
      if (list.length === 0) return null;
      const shown = list.slice(0, 5);
      return h('div', { key: 'roots', style: { ...muted, ...mono, fontSize: 11, wordBreak: 'break-all' } },
        `${t.searchRoots}: ${shown.join('  ')}${list.length > shown.length ? `  …+${list.length - shown.length}` : ''}`);
    }

    /** The settings-section page: live state, embed steps, and the same form. */
    function BridgeSettings({ forms }) {
      const t = locale();
      const live = info();
      const events = live.lastEvents ?? [];
      const shared = useSharedForm(forms);
      const url = live.url || (shared.snapshot?.value?.port ? `http://127.0.0.1:${shared.snapshot.value.port}/` : undefined);
      const ready = shared.snapshot?.status === 'ready';

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, lineHeight: 1.6 } }, [
        h(StatusHead, { key: 'head', t, url }),
        h('div', { key: 'upstream', style: muted }, `→ http://${live.upstream || shared.snapshot?.value?.upstream || '127.0.0.1:3080'}/ · ${t.click}: ${live.injectClickScript === false ? 'off' : 'on'}`),
        // Where a relative path will actually be looked for. This is the one thing
        // a `no such file under …` answer makes you ask, so it is visible without
        // opening DevTools: live session working directories included.
        searchRootsLine(t, live.searchRoots),
        ready
          ? h('div', { key: 'config' }, [
              h('div', { key: 'title', style: { fontWeight: 600, marginBottom: 6 } }, t.settings),
              h(ConfigFields, { key: 'fields', t, state: shared.snapshot, mutate: shared.entry.form.mutate.bind(shared.entry.form) }),
            ])
          : h('div', { key: 'config-missing', style: muted }, [
              h('div', { key: 'why' }, shared.entry === undefined || shared.snapshot?.status === 'unavailable' ? t.notServed : t.loading),
              h('div', { key: 'tried', style: { ...mono, marginTop: 4 } }, `tried: ${(shared.entries ?? []).map((entry) => `${entry.id}=${entry.status ?? 'none'}`).join(', ') || 'no configForms service'}`),
              h('div', { key: 'served', style: { ...mono, marginTop: 2 } }, `served namespaces: ${(shared.served ?? []).slice(0, 14).join(', ') || '(none reported)'}${(shared.served?.length ?? 0) > 14 ? ` …+${shared.served.length - 14}` : ''}`),
              h('div', { key: 'host', style: { ...mono, marginTop: 2 } }, `host namespaces: ${(info().namespaces ?? []).slice(0, 14).join(', ') || '(none reported)'}`),
            ]),
        h('ol', { key: 'steps', style: { margin: 0, paddingLeft: 20 } }, t.steps.map((step, index) => h('li', { key: index }, step))),
        events.length > 0
          ? h('div', { key: 'events' }, [
              h('div', { key: 'title', style: muted }, t.events),
              h('ul', { key: 'list', style: { margin: '4px 0 0', paddingLeft: 20, ...mono } },
                events.map((event, index) => h('li', { key: index }, `${(event.at || '').slice(11, 19)} ${event.kind} ${event.request?.file || event.url || ''}`))),
            ])
          : null,
      ]);
    }

    return {
      // `configForms` is the shared settings client every official settings page
      // injects; declaring it here guarantees the service is up before this
      // module applies, exactly as those pages do.
      inject: ['slots', 'configForms'],
      apply(ctx) {
        const forms = typeof ctx.get === 'function' ? ctx.get('configForms') : ctx.configForms;
        // Both slots belong to entries that mount later (the settings shell and the
        // plugin manager), so they do not exist yet when this module applies.
        // `slots.inject` defers the registration until the slot is declared — the
        // idiom the official pages use; calling `slots.register` directly throws
        // `slot "…" is not declared` and leaves this fiber FAILED.
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: ROW_ID, order: 60, label: 'DSH Web Bridge' },
          (props) => h(BridgeSettings, { ...props, forms }),
        ));
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
          { name: 'plugins.row.config', key: ROW_CONFIG_KEY },
          RowConfig,
        ));
      },
    };
  },
});
