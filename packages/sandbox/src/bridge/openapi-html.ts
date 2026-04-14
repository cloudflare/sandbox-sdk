/**
 * Renders an OpenAPI 3.x schema object as a self-contained HTML page.
 *
 * No external dependencies — pure HTML/CSS/JS generated server-side.
 * The schema is embedded as JSON and rendered client-side via a small
 * inline script.
 */

export function renderOpenApiHtml(schema: Record<string, unknown>): string {
  const json = JSON.stringify(schema);

  return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc((schema.info as Record<string, string>)?.title ?? 'API Reference')}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #0f1117;
      --surface:   #1a1d27;
      --border:    #2a2d3a;
      --text:      #e2e8f0;
      --muted:     #8892a4;
      --accent:    #6366f1;
      --get:       #22c55e;
      --post:      #3b82f6;
      --put:       #f59e0b;
      --delete:    #ef4444;
      --patch:     #a855f7;
      --radius:    6px;
      --font-mono: ui-monospace, "Cascadia Code", "Fira Code", monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.6;
      display: flex;
      min-height: 100vh;
    }

    /* ── Sidebar ── */
    #sidebar {
      width: 260px;
      min-width: 260px;
      background: var(--surface);
      border-right: 1px solid var(--border);
      padding: 24px 0;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
    }
    #sidebar h1 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      padding: 0 20px 16px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #sidebar .version {
      font-size: 11px;
      color: var(--muted);
      font-weight: 400;
    }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 20px;
      cursor: pointer;
      border-left: 2px solid transparent;
      transition: background 0.15s, border-color 0.15s;
      text-decoration: none;
      color: var(--muted);
      font-size: 13px;
    }
    .nav-item:hover { background: rgba(255,255,255,0.04); color: var(--text); }
    .nav-item.active { border-left-color: var(--accent); color: var(--text); background: rgba(99,102,241,0.08); }

    /* ── Main ── */
    #main {
      flex: 1;
      padding: 40px 48px;
      max-width: 900px;
    }

    /* ── Info block ── */
    #info { margin-bottom: 48px; }
    #info h2 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
    #info p  { color: var(--muted); max-width: 680px; }
    #info .meta { display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; }
    #info .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 99px;
      border: 1px solid var(--border);
      color: var(--muted);
      font-family: var(--font-mono);
    }

    /* ── Endpoint card ── */
    .endpoint {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 16px;
      overflow: hidden;
    }
    .endpoint-header {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 18px;
      cursor: pointer;
      background: var(--surface);
      user-select: none;
      transition: background 0.15s;
    }
    .endpoint-header:hover { background: #1e2130; }
    .endpoint-header.open  { background: #1e2130; border-bottom: 1px solid var(--border); }

    .method {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 4px;
      min-width: 58px;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .method-get    { background: rgba(34,197,94,.15);  color: var(--get); }
    .method-post   { background: rgba(59,130,246,.15); color: var(--post); }
    .method-put    { background: rgba(245,158,11,.15); color: var(--put); }
    .method-delete { background: rgba(239,68,68,.15);  color: var(--delete); }
    .method-patch  { background: rgba(168,85,247,.15); color: var(--patch); }

    .endpoint-path {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text);
      flex: 1;
    }
    .endpoint-summary { font-size: 13px; color: var(--muted); }
    .chevron { color: var(--muted); font-size: 10px; transition: transform 0.2s; }
    .endpoint-header.open .chevron { transform: rotate(90deg); }

    /* ── Endpoint body ── */
    .endpoint-body { padding: 20px 18px; display: none; }
    .endpoint-body.open { display: block; }
    .endpoint-desc { color: var(--muted); margin-bottom: 16px; font-size: 13px; }

    /* ── Section labels ── */
    .section-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin: 20px 0 10px;
    }
    .section-label:first-child { margin-top: 0; }

    /* ── Params table ── */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      text-align: left;
      padding: 6px 10px;
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    tr:last-child td { border-bottom: none; }
    .param-name  { font-family: var(--font-mono); color: var(--text); }
    .param-in    { font-size: 11px; color: var(--muted); }
    .param-type  { font-family: var(--font-mono); font-size: 11px; color: var(--accent); }
    .required    { color: var(--delete); font-size: 10px; font-weight: 700; margin-left: 4px; }

    /* ── Response rows ── */
    .response-group { margin-bottom: 4px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .response-header {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 10px 14px;
      cursor: pointer;
      background: var(--surface);
      user-select: none;
      transition: background 0.15s;
      font-size: 13px;
    }
    .response-header:hover { background: #1e2130; }
    .response-header.open { border-bottom: 1px solid var(--border); }
    .response-detail { padding: 12px 14px; display: none; font-size: 13px; }
    .response-detail.open { display: block; }
    .response-detail .section-label { margin-top: 14px; }
    .response-detail .section-label:first-child { margin-top: 0; }
    .status-code {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
      min-width: 40px;
    }
    .s2xx { color: var(--get); }
    .s4xx { color: var(--put); }
    .s5xx { color: var(--delete); }
    .response-desc { color: var(--muted); flex: 1; }
    .response-content-type { font-size: 11px; color: var(--muted); font-family: var(--font-mono); }
    .resp-chevron { color: var(--muted); font-size: 10px; transition: transform 0.2s; margin-left: auto; }
    .response-header.open .resp-chevron { transform: rotate(90deg); }

    /* ── Code block ── */
    pre {
      background: #0a0c12;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      font-family: var(--font-mono);
      font-size: 12px;
      overflow-x: auto;
      color: var(--text);
      margin-top: 8px;
    }
    pre.example-block { margin-top: 4px; }

    /* ── Code samples ── */
    .code-samples { margin-top: 4px; }
    .code-sample-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted);
      font-family: var(--font-mono);
      margin-bottom: 2px;
    }
  </style>
</head>
<body>
  <nav id="sidebar"><h1 id="nav-title"></h1></nav>
  <main id="main"><div id="info"></div><div id="endpoints"></div></main>

  <script>
    const schema = ${json};

    // ── helpers ──────────────────────────────────────────────────────
    function esc(s) {
      return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function el(tag, attrs, ...children) {
      const e = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs ?? {})) {
        if (k === 'class') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else e.setAttribute(k, v);
      }
      for (const c of children) {
        if (c == null) continue;
        e.append(typeof c === 'string' ? document.createTextNode(c) : c);
      }
      return e;
    }
    function statusClass(code) {
      const n = parseInt(code);
      if (n >= 500) return 's5xx';
      if (n >= 400) return 's4xx';
      return 's2xx';
    }
    function schemaType(s) {
      if (!s) return '';
      if (s.$ref) return s.$ref.split('/').pop();
      if (s.type === 'array') return s.items ? schemaType(s.items) + '[]' : 'array';
      return s.format ? s.type + '<' + s.format + '>' : (s.type ?? '');
    }
    function resolveRef(ref) {
      const parts = ref.replace(/^#\\//, '').split('/');
      return parts.reduce((o, k) => o?.[k], schema);
    }
    function resolveResponse(resp) {
      return resp?.$ref ? resolveRef(resp.$ref) : resp;
    }

    // ── info ─────────────────────────────────────────────────────────
    const info = schema.info ?? {};
    document.title = info.title ?? 'API Reference';
    document.getElementById('nav-title').innerHTML =
      esc(info.title ?? 'API Reference') +
      (info.version ? \` <span class="version">v\${esc(info.version)}</span>\` : '');

    const infoEl = document.getElementById('info');
    infoEl.append(
      el('h2', {}, info.title ?? 'API Reference'),
      el('div', {class:'meta'},
        info.version ? el('span', {class:'badge'}, 'v' + info.version) : null,
        el('span', {class:'badge'}, 'OpenAPI ' + (schema.openapi ?? '3.x')),
      ),
      info.description ? el('p', {html: esc(info.description).replace(/\`([^\`]+)\`/g, '<code>$1</code>')}) : null,
    );

    // ── endpoints ────────────────────────────────────────────────────
    const container = document.getElementById('endpoints');
    const nav = document.getElementById('sidebar');
    const methods = ['get','post','put','patch','delete'];

    for (const [path, pathItem] of Object.entries(schema.paths ?? {})) {
      for (const method of methods) {
        const op = pathItem[method];
        if (!op) continue;

        const id = method + '_' + path.replace(/[^a-z0-9]/gi, '_');

        // nav link
        const navLink = el('a', {class:'nav-item', href:'#'+id});
        navLink.append(
          el('span', {class:'method method-'+method}, method),
          el('span', {}, path),
        );
        nav.append(navLink);

        // card header
        const header = el('div', {class:'endpoint-header', id});
        header.append(
          el('span', {class:'method method-'+method}, method),
          el('span', {class:'endpoint-path'}, path),
          op.summary ? el('span', {class:'endpoint-summary'}, op.summary) : null,
          el('span', {class:'chevron'}, '▶'),
        );

        // card body
        const body = el('div', {class:'endpoint-body'});

        if (op.description) {
          body.append(el('p', {class:'endpoint-desc', html:
            esc(op.description).replace(/\`([^\`]+)\`/g,'<code>$1</code>')}));
        }

        // parameters
        const params = op.parameters ?? [];
        if (params.length) {
          body.append(el('div', {class:'section-label'}, 'Parameters'));
          const tbl = el('table', {});
          tbl.append(el('thead', {}, el('tr', {},
            el('th',{},'Name'), el('th',{},'In'), el('th',{},'Type'), el('th',{},'Description')
          )));
          const tbody = el('tbody', {});
          for (const p of params) {
            const nameCell = el('td', {class:'param-name'}, p.name);
            if (p.required) nameCell.append(el('span', {class:'required'}, '*'));
            tbody.append(el('tr', {},
              nameCell,
              el('td', {class:'param-in'}, p.in),
              el('td', {class:'param-type'}, schemaType(p.schema)),
              el('td', {class:'response-desc'}, p.description ?? ''),
            ));
          }
          tbl.append(tbody);
          body.append(tbl);
        }

        // request body
        if (op.requestBody) {
          body.append(el('div', {class:'section-label'}, 'Request Body'));
          const content = op.requestBody.content ?? {};
          for (const [ct, media] of Object.entries(content)) {
            body.append(el('div', {class:'param-in'}, ct));
            if (media.schema) {
              const resolved = media.schema.$ref ? resolveRef(media.schema.$ref) : media.schema;
              if (resolved?.properties) {
                const tbl = el('table', {});
                tbl.append(el('thead', {}, el('tr', {},
                  el('th',{},'Field'), el('th',{},'Type'), el('th',{},'Description')
                )));
                const tbody = el('tbody', {});
                const required = new Set(resolved.required ?? []);
                for (const [name, prop] of Object.entries(resolved.properties)) {
                  const nameCell = el('td', {class:'param-name'}, name);
                  if (required.has(name)) nameCell.append(el('span', {class:'required'}, '*'));
                  tbody.append(el('tr', {},
                    nameCell,
                    el('td', {class:'param-type'}, schemaType(prop)),
                    el('td', {class:'response-desc'}, prop.description ?? ''),
                  ));
                }
                tbl.append(tbody);
                body.append(tbl);
              }
            }
          }
        }

        // responses
        if (op.responses) {
          body.append(el('div', {class:'section-label'}, 'Responses'));
          const wrap = el('div', {});
          for (const [code, resp] of Object.entries(op.responses)) {
            const resolved = resolveResponse(resp);
            const hasContent = resolved?.content && Object.keys(resolved.content).length > 0;

            const group = el('div', {class:'response-group'});
            const respHeader = el('div', {class:'response-header'});
            respHeader.append(
              el('span', {class:'status-code ' + statusClass(code)}, code),
              el('span', {class:'response-desc'}, resolved?.description ?? ''),
              hasContent ? el('span', {class:'resp-chevron'}, '\u25B6') : null,
            );
            group.append(respHeader);

            if (hasContent) {
              const detail = el('div', {class:'response-detail'});
              for (const [ct, media] of Object.entries(resolved.content)) {
                detail.append(el('div', {class:'response-content-type'}, ct));

                // Render response schema fields
                if (media.schema) {
                  const resolvedSchema = media.schema.$ref ? resolveRef(media.schema.$ref) : media.schema;
                  if (resolvedSchema?.properties) {
                    detail.append(el('div', {class:'section-label'}, 'Schema'));
                    const tbl = el('table', {});
                    tbl.append(el('thead', {}, el('tr', {},
                      el('th',{},'Field'), el('th',{},'Type'), el('th',{},'Description')
                    )));
                    const tbody = el('tbody', {});
                    const required = new Set(resolvedSchema.required ?? []);
                    for (const [name, prop] of Object.entries(resolvedSchema.properties)) {
                      const nameCell = el('td', {class:'param-name'}, name);
                      if (required.has(name)) nameCell.append(el('span', {class:'required'}, '*'));
                      tbody.append(el('tr', {},
                        nameCell,
                        el('td', {class:'param-type'}, schemaType(prop)),
                        el('td', {class:'response-desc'}, prop.description ?? ''),
                      ));
                    }
                    tbl.append(tbody);
                    detail.append(tbl);
                  }
                }

                // Render response example
                if (media.example !== undefined) {
                  detail.append(el('div', {class:'section-label'}, 'Example'));
                  detail.append(el('pre', {class:'example-block'}, JSON.stringify(media.example, null, 2)));
                }
                if (media.examples) {
                  detail.append(el('div', {class:'section-label'}, 'Examples'));
                  for (const [exName, exObj] of Object.entries(media.examples)) {
                    const val = exObj?.value ?? exObj;
                    detail.append(el('pre', {class:'example-block'}, '// ' + exName + '\\n' + JSON.stringify(val, null, 2)));
                  }
                }
              }

              respHeader.addEventListener('click', () => {
                const open = respHeader.classList.toggle('open');
                detail.classList.toggle('open', open);
              });
              group.append(detail);
            }

            wrap.append(group);
          }
          body.append(wrap);
        }

        // x-codeSamples
        const samples = op['x-codeSamples'];
        if (samples && samples.length) {
          body.append(el('div', {class:'section-label'}, 'Example'));
          const samplesWrap = el('div', {class:'code-samples'});
          for (const sample of samples) {
            samplesWrap.append(
              el('div', {class:'code-sample-label'}, sample.label ?? sample.lang ?? 'Example'),
              el('pre', {}, sample.source),
            );
          }
          body.append(samplesWrap);
        }

        // toggle
        header.addEventListener('click', () => {
          const open = header.classList.toggle('open');
          body.classList.toggle('open', open);
          // sync nav highlight
          document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
          if (open) navLink.classList.add('active');
        });

        const card = el('div', {class:'endpoint'});
        card.append(header, body);
        container.append(card);
      }
    }

    // highlight nav on scroll
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          document.querySelectorAll('.nav-item').forEach(n => {
            n.classList.toggle('active', n.getAttribute('href') === '#' + id);
          });
        }
      }
    }, { threshold: 0.5 });
    document.querySelectorAll('.endpoint-header[id]').forEach(h => observer.observe(h));
  </script>
</body>
</html>`;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
