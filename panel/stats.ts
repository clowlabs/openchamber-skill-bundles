import { formatTokens, liveLine, livePct, TOKENS_TITLE, tokensOf, type SkillCounts } from '../status/counts';
import { el } from './dom';

/** Detailed stats line for the full-screen page header. */
export function statsLine(c: SkillCounts): HTMLSpanElement {
  const n = c.bundlesOn?.length ?? 0;
  const text = c.fromOpencode
    ? `${liveLine(c)} · from opencode.json`
    : `${c.live} live / ${c.installed} installed (${livePct(c)}%) · ${n} ${n === 1 ? 'bundle' : 'bundles'} on · ~${formatTokens(tokensOf(c.chars))} tokens`;
  const line = el('span', 'sb-stats-line', text);
  line.title = `Live = skills agents can use (allowed in opencode.json). Installed = skill folders plus built-ins.\n${TOKENS_TITLE}`;
  return line;
}
