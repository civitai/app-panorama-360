// RunGateway over the orchestrator consumer API. baseUrl + fetch are
// injectable so an app can point it at a same-origin token-injecting proxy
// (e.g. the panorama dev harness's `/orch` Vite route) instead of the
// orchestrator origin.

import { retryFetch, type RetryFetchOptions } from './http.js';
import {
  docToGatewayResult,
  type MapDetailOptions,
  type OrchWorkflowDoc,
} from './orchestrator-types.js';
import type { GatewayResult, RunGateway } from './types.js';

export interface DirectGatewayOptions extends MapDetailOptions {
  /** e.g. '/orch' (dev proxy) or 'https://orchestration.civitai.com'. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /** Long-poll window for poll(); 0 disables. Default 10. */
  waitSeconds?: number;
  retry?: Omit<RetryFetchOptions, 'fetchImpl'>;
}

export class DirectGateway implements RunGateway {
  /** Latched when the server 400s an integer `wait` (older orchestrations). */
  private waitUnsupported = false;

  constructor(private readonly options: DirectGatewayOptions) {}

  private get workflowsUrl(): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/v2/consumer/workflows`;
  }

  private mapOptions(): MapDetailOptions {
    const { stepName, rewriteTraceUrl } = this.options;
    return {
      ...(stepName !== undefined && { stepName }),
      ...(rewriteTraceUrl !== undefined && { rewriteTraceUrl }),
    };
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    return retryFetch(
      url,
      {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...this.options.headers,
          ...init?.headers,
        },
      },
      { ...(this.options.fetchImpl && { fetchImpl: this.options.fetchImpl }), ...this.options.retry },
    );
  }

  private async readDoc(res: Response): Promise<OrchWorkflowDoc> {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Orchestrator ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }
    return (await res.json()) as OrchWorkflowDoc;
  }

  async submit(body: unknown): Promise<GatewayResult> {
    const res = await this.request(`${this.workflowsUrl}?wait=0`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return docToGatewayResult(await this.readDoc(res), this.mapOptions());
  }

  async poll(workflowId: string): Promise<GatewayResult> {
    const base = `${this.workflowsUrl}/${encodeURIComponent(workflowId)}`;
    const wait = this.options.waitSeconds ?? 10;
    if (wait > 0 && !this.waitUnsupported) {
      const res = await this.request(`${base}?wait=${wait}`);
      if (res.status !== 400) {
        return docToGatewayResult(await this.readDoc(res), this.mapOptions());
      }
      this.waitUnsupported = true;
      await res.text().catch(() => '');
    }
    const res = await this.request(base);
    return docToGatewayResult(await this.readDoc(res), this.mapOptions());
  }

  async cancel(workflowId: string): Promise<GatewayResult> {
    const url = `${this.workflowsUrl}/${encodeURIComponent(workflowId)}`;
    const res = await this.request(url, {
      method: 'PUT',
      body: JSON.stringify({ status: 'canceled' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Orchestrator ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }
    // The PUT may return the updated doc or an empty body — fall back to a GET.
    try {
      const doc = (await res.json()) as OrchWorkflowDoc;
      if (doc && typeof doc === 'object' && doc.status) {
        return docToGatewayResult(doc, this.mapOptions());
      }
    } catch {
      // fall through to GET
    }
    const refreshed = await this.request(url);
    return docToGatewayResult(await this.readDoc(refreshed), this.mapOptions());
  }
}
