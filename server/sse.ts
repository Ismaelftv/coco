import type { StreamEvent } from '../shared/contract.ts';

/** Serializa um evento no formato text/event-stream (uma linha `data:` com JSON). */
export function formatSse(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
