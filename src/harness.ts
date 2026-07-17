// Dev harness entry, mounted only when VITE_DEV_HARNESS=true (main.ts
// dynamic-imports it, so the SDK's testing barrel never reaches a production
// build). Ordering is load-bearing: the transport singleton must allowlist
// this origin BEFORE the mock host installs, and the orch interceptor must
// wrap window.parent AFTER the mock host patched it.

import { registerElements } from './registry.js';
import {
  getHarnessMode,
  installHarnessTransport,
  installLiveHost,
  resolveLiveConfig,
  type HarnessMode,
} from './dev-transport.js';
import { installOrchestratorHost } from './orch-host.js';

export async function mountHarness(root: HTMLElement): Promise<void> {
  registerElements();
  const mode = getHarnessMode();

  if (mode === 'live') {
    const live = resolveLiveConfig();
    if (!live.ready) {
      renderLiveUnavailable(root, live.reason);
      return;
    }
    installLiveHost({ token: live.token, backendBaseUrl: live.backendBaseUrl });
    renderBanner(root, mode);
    mountApp(root);
    return;
  }

  installHarnessTransport();
  const { createMockHost, readMockHostUrlOptions } = await import('@civitai/blocks-react/testing');
  const options = readMockHostUrlOptions();
  const host = createMockHost({
    buzzBalance: { blue: 1500, green: 250, yellow: 6000 },
    // The SDK's default canned pick is a Flux model; this app filters to SDXL.
    cannedPicks: {
      Checkpoint: {
        versionId: 126688,
        modelId: 112902,
        modelName: 'DreamShaper XL',
        versionName: 'alpha2 (xl1.0)',
        baseModel: 'SDXL 1.0',
        modelType: 'Checkpoint',
      },
    },
    ...options,
  });
  host.install();
  if (mode === 'orch') installOrchestratorHost();

  renderBanner(root, mode);
  mountApp(root);
}

function mountApp(root: HTMLElement): void {
  root.appendChild(document.createElement('pano-app'));
}

const BANNER_TEXT: Record<HarnessMode, { text: string; color: string }> = {
  mock: { text: 'MOCK HOST · no real Buzz spent', color: '#3fb950' },
  orch: {
    text: 'ORCHESTRATOR HOST · every mode spends REAL Buzz (~15-180 depending on model)',
    color: '#ffa94d',
  },
  live: { text: 'LIVE HOST · spends REAL Buzz (hosted mode only)', color: '#ff6b6b' },
};

function renderBanner(root: HTMLElement, mode: HarnessMode): void {
  const banner = document.createElement('div');
  banner.dataset.harnessBanner = mode;
  const { text, color } = BANNER_TEXT[mode];
  banner.textContent = text;
  Object.assign(banner.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    zIndex: '10000',
    background: '#0d1117',
    color,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '12px',
    fontWeight: '600',
    textAlign: 'center',
    padding: '4px 8px',
    letterSpacing: '0.3px',
    borderBottom: '1px solid #30363d',
  } satisfies Partial<CSSStyleDeclaration>);
  root.appendChild(banner);
  document.body.style.paddingTop = '26px';
}

/** The endpoint the dev-only vite plugin registers (vite-plugin-civitai-setup.ts). */
const SETUP_ENDPOINT = '/__civitai/setup-dev-live';

/** Fail-safe LIVE screen — dev:live refuses to mount without a spendable dev token. */
function renderLiveUnavailable(root: HTMLElement, reason: string): void {
  const card = document.createElement('div');
  card.className = 'pn-card';
  card.style.maxWidth = '640px';
  card.style.margin = '48px auto';
  document.documentElement.dataset.theme = 'dark';

  const title = document.createElement('h1');
  title.className = 'pn-title';
  title.textContent = 'Live mode setup';

  const warning = document.createElement('div');
  warning.className = 'pn-alert pn-alert--warning';
  warning.textContent = `No dev block token set — live mode spends REAL Buzz, so it refuses to mount. ${reason}`;

  const field = document.createElement('div');
  field.className = 'pn-field';
  const label = document.createElement('span');
  label.className = 'pn-label';
  label.textContent = 'Your personal API key';
  const hint = document.createElement('span');
  hint.className = 'pn-desc';
  hint.innerHTML =
    'Create one at <a href="https://civitai.com/user/account" target="_blank" rel="noopener noreferrer">civitai.com/user/account</a>, paste it here, and the dev server mints the token + writes .env.development.local automatically.';
  const input = document.createElement('input');
  input.className = 'pn-input';
  input.type = 'password';
  input.placeholder = 'paste the key you just created';
  field.append(label, hint, input);

  const button = document.createElement('button');
  button.className = 'pn-btn';
  button.type = 'button';
  button.textContent = 'Set up automatically';

  const result = document.createElement('div');

  button.addEventListener('click', () => {
    void (async () => {
      const apiKey = input.value.trim();
      result.textContent = '';
      if (!apiKey) {
        result.appendChild(alert('error', 'Paste your personal API key first.'));
        return;
      }
      button.disabled = true;
      button.textContent = 'Setting up…';
      try {
        const res = await fetch(SETUP_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey }),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (res.ok && body.ok) {
          button.textContent = 'Done — restarting…';
          result.appendChild(alert('success', 'Env written; vite is restarting into live mode.'));
        } else {
          button.disabled = false;
          button.textContent = 'Set up automatically';
          result.appendChild(alert('error', body.error || `Setup failed (${res.status}).`));
        }
      } catch (e) {
        button.disabled = false;
        button.textContent = 'Set up automatically';
        result.appendChild(
          alert('error', `Could not reach the dev server. Is \`npm run dev:live\` running? ${e instanceof Error ? e.message : e}`),
        );
      }
    })();
  });

  const manual = document.createElement('details');
  const summary = document.createElement('summary');
  summary.className = 'pn-muted';
  summary.style.cursor = 'pointer';
  summary.textContent = 'Prefer to run the commands yourself?';
  const pre = document.createElement('pre');
  pre.className = 'pn-alert pn-alert--info';
  pre.style.overflowX = 'auto';
  pre.textContent = [
    'civitai login --token <your-personal-api-key>',
    'civitai app dev-token panorama-360 --env >> .env.development.local',
    'npm run dev:live',
  ].join('\n');
  manual.append(summary, pre);

  card.append(title, warning, field, button, result, manual);
  root.appendChild(card);
}

function alert(kind: 'success' | 'error', text: string): HTMLElement {
  const node = document.createElement('div');
  node.className = `pn-alert pn-alert--${kind}`;
  node.textContent = text;
  return node;
}
