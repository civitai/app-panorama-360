// Pure generation-state logic. No DOM — unit-tested in node (generation.test.ts).

import type { BlockWorkflowSnapshot, BuzzAccountType } from '@civitai/app-sdk/blocks';

/** Server cap mirror — prompts over this are rejected by the workflow schema. */
export const PROMPT_MAX = 1500;

// The pools a block can prefer + read: blue = free/earned, yellow = purchased,
// green = creator-earned. Platform-internal pools are never exposed to a block.
export const BUZZ_ACCOUNT_TYPES: readonly BuzzAccountType[] = ['blue', 'green', 'yellow'];

/** `'auto'` = let the host choose the funding order. */
export type AccountChoice = 'auto' | BuzzAccountType;

export const ACCOUNT_CHOICES: readonly AccountChoice[] = ['auto', 'blue', 'green', 'yellow'];

export function accountLabel(choice: AccountChoice): string {
  switch (choice) {
    case 'auto':
      return 'Auto';
    case 'blue':
      return 'Blue';
    case 'green':
      return 'Green';
    case 'yellow':
      return 'Yellow';
  }
}

/**
 * `spentAccountType` is the LARGEST-debit pool, not "the paid account" — a gen
 * covered mostly by free Buzz reports `blue`. `undefined` (old host / no
 * spend) → null so the caller can skip the "funded from…" note.
 */
export function spentAccountLabel(spent: BuzzAccountType | undefined): string | null {
  if (!spent) return null;
  return accountLabel(spent);
}

/**
 * Mirror of the manifest's page.buzzBudgetPerGen — only drives client copy;
 * the real ceiling is clamped and enforced server-side at mint.
 */
export const PAGE_BUZZ_BUDGET = 120;

/** The scope the page token must carry before a generation can be submitted. */
export const BUDGETED_SCOPE = 'ai:write:budgeted';

const TERMINAL: ReadonlySet<BlockWorkflowSnapshot['status']> = new Set([
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);

export function isTerminalStatus(status: BlockWorkflowSnapshot['status']): boolean {
  return TERMINAL.has(status);
}

/**
 * `ai:write:budgeted` is consent-gated: a fresh viewer's mint withholds it
 * until they grant, then the host pushes TOKEN_REFRESH with the scope.
 */
export function hasBudgetedScope(scopes: readonly string[] | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(BUDGETED_SCOPE);
}

/**
 * Substring heuristic — the snapshot has no structured error code, only free
 * text. Check {@link isDisallowedAccountError} FIRST: that message also
 * contains "buzz" and would misclassify as insufficient.
 */
export function isInsufficientBuzz(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('insufficient') ||
    m.includes('not enough') ||
    m.includes('budget') ||
    m.includes('balance') ||
    m.includes('buzz')
  );
}

/**
 * The server's domain-clamp rejection of a preferred accountType ("buzz
 * account '<type>' is not spendable for this app's content rating").
 */
export function isDisallowedAccountError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return m.includes('not spendable') || (m.includes('account') && m.includes('content rating'));
}

/** `null` → '—'. */
export function formatCost(cost: number | null | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return '—';
  return Math.round(cost).toLocaleString();
}

export function clampPrompt(raw: string): string {
  return raw.slice(0, PROMPT_MAX);
}

export function firstImageUrl(snapshot: BlockWorkflowSnapshot | null): string | null {
  if (!snapshot || !snapshot.imageUrls || snapshot.imageUrls.length === 0) return null;
  return snapshot.imageUrls[0] ?? null;
}

export type GenPhase =
  | 'idle'
  | 'needs-consent'
  | 'estimating'
  | 'submitting'
  | 'polling'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'insufficient'
  | 'account-rejected';

export function isBusyPhase(phase: GenPhase): boolean {
  return phase === 'estimating' || phase === 'submitting' || phase === 'polling';
}

/** Order matters: disallowed-account BEFORE insufficient (its message contains "buzz"). */
export function phaseForError(message: string | null | undefined): GenPhase {
  if (isDisallowedAccountError(message)) return 'account-rejected';
  if (isInsufficientBuzz(message)) return 'insufficient';
  return 'failed';
}

export function phaseForSnapshot(snapshot: BlockWorkflowSnapshot): GenPhase {
  switch (snapshot.status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'expired':
    case 'canceled':
      return phaseForError(snapshot.error);
    case 'pending':
    case 'processing':
      return 'polling';
  }
}
