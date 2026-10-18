/**
 * Parser incremental de text/event-stream (subconjunto da especificação WHATWG):
 * linhas `event:` e `data:` (várias `data:` são unidas por \n), comentários `:`,
 * CRLF/LF, e eventos despachados numa linha vazia. Fragmentos podem chegar
 * cortados a meio de uma linha.
 */
export interface RawSseEvent {
  event: string;
  data: string;
}

export interface SseParser {
  feed(chunk: string): RawSseEvent[];
  /** Despacha um evento pendente sem linha vazia final (fim de stream). */
  flush(): RawSseEvent[];
}

export function createSseParser(): SseParser {
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];

  const dispatch = (out: RawSseEvent[]) => {
    if (dataLines.length > 0) {
      out.push({ event: eventName || 'message', data: dataLines.join('\n') });
    }
    eventName = '';
    dataLines = [];
  };

  const processLine = (line: string, out: RawSseEvent[]) => {
    if (line === '') return dispatch(out);
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  };

  return {
    feed(chunk) {
      buffer += chunk;
      const out: RawSseEvent[] = [];
      let idx: number;
      while ((idx = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const line = buffer.slice(0, idx);
        const sepLen = buffer.startsWith('\r\n', idx) ? 2 : 1;
        // Um \r no fim do fragmento pode ser metade de \r\n: esperar pelo próximo.
        if (buffer[idx] === '\r' && idx === buffer.length - 1) break;
        buffer = buffer.slice(idx + sepLen);
        processLine(line, out);
      }
      return out;
    },
    flush() {
      const out: RawSseEvent[] = [];
      if (buffer) {
        processLine(buffer.replace(/\r$/, ''), out);
        buffer = '';
      }
      dispatch(out);
      return out;
    },
  };
}
