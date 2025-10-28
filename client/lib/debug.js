function normalizeFlag(val) {
  // Rules: 1 = on, 0 = off, undefined (not set) = on; anything else -> on
  if (val === undefined) return true;
  const v = String(val).trim();
  if (v === '1') return true;
  if (v === '0') return false;
  return true;
}

function stringifyArg(arg) {
  try {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}

export function setupDebugOverlay() {
  const enabled = normalizeFlag(import.meta.env.VITE_DEBUG_OVERLAY);
  if (!enabled) return;

  const container = document.createElement('div');
  container.id = 'debug-overlay';
  container.style.position = 'fixed';
  container.style.bottom = '8px';
  container.style.right = '8px';
  container.style.width = '380px';
  container.style.height = '220px';
  container.style.background = 'rgba(0,0,0,0.85)';
  container.style.color = '#c8f7c5';
  container.style.font = '12px/1.4 monospace';
  container.style.zIndex = '2147483647';
  container.style.border = '1px solid rgba(255,255,255,0.2)';
  container.style.borderRadius = '6px';
  container.style.boxShadow = '0 2px 10px rgba(0,0,0,0.5)';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.pointerEvents = 'auto';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.style.padding = '6px 8px';
  header.style.background = 'rgba(255,255,255,0.06)';
  header.style.borderBottom = '1px solid rgba(255,255,255,0.12)';
  header.innerHTML = '<strong style="color:#fff;">Debug</strong>';

  const controls = document.createElement('div');
  function mkBtn(txt) {
    const b = document.createElement('button');
    b.textContent = txt;
    b.style.marginLeft = '6px';
    b.style.background = 'transparent';
    b.style.color = '#fff';
    b.style.border = '1px solid rgba(255,255,255,0.4)';
    b.style.borderRadius = '4px';
    b.style.font = '11px monospace';
    b.style.padding = '2px 6px';
    b.style.cursor = 'pointer';
    return b;
  }
  const btnClear = mkBtn('Clear');
  const btnHide = mkBtn('Hide');
  controls.appendChild(btnClear);
  controls.appendChild(btnHide);
  header.appendChild(controls);

  const body = document.createElement('div');
  body.style.flex = '1 1 auto';
  body.style.overflow = 'auto';
  body.style.padding = '6px 8px';
  body.style.whiteSpace = 'pre-wrap';

  container.appendChild(header);
  container.appendChild(body);
  document.body.appendChild(container);

  let paused = false;
  const maxLines = 400;
  function appendLine(level, args) {
    if (paused) return;
    const line = document.createElement('div');
    const time = new Date().toISOString().split('T')[1].replace('Z','');
    const text = args.map(stringifyArg).join(' ');
    const color = level === 'error' ? '#ffb3b3' : (level === 'warn' ? '#ffe9a6' : '#c8f7c5');
    line.style.color = color;
    line.textContent = `[${time}] ${level.toUpperCase()}: ${text}`;
    body.appendChild(line);
    while (body.childNodes.length > maxLines) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  }

  btnClear.addEventListener('click', () => { body.innerHTML = ''; });
  btnHide.addEventListener('click', () => { container.style.display = 'none'; });

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug?.bind(console) || console.log.bind(console),
  };

  console.log = (...a) => { try { appendLine('log', a); } catch {} original.log(...a); };
  console.warn = (...a) => { try { appendLine('warn', a); } catch {} original.warn(...a); };
  console.error = (...a) => { try { appendLine('error', a); } catch {} original.error(...a); };
  console.info = (...a) => { try { appendLine('log', a); } catch {} original.info(...a); };
  if (console.debug) {
    console.debug = (...a) => { try { appendLine('log', a); } catch {} original.debug(...a); };
  }

  window.addEventListener('error', (e) => {
    appendLine('error', [e.message, e.filename, e.lineno + ':' + e.colno]);
  });
  window.addEventListener('unhandledrejection', (e) => {
    appendLine('error', ['UnhandledRejection', e.reason]);
  });

  // Expose minimal API
  window.__debugOverlay = {
    clear: () => { body.innerHTML = ''; },
    hide: () => { container.style.display = 'none'; },
    show: () => { container.style.display = 'flex'; },
    pause: (v) => { paused = !!v; },
  };
}


