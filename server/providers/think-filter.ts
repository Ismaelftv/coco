/**
 * Separa o raciocínio interno ("<think>…</think>") do texto da resposta em
 * streaming. Alguns servidores (llama.cpp, vLLM sem parser de raciocínio)
 * enviam-no no próprio conteúdo; o Ollama e o vLLM com parser enviam-no num
 * campo à parte, tratado no adaptador.
 *
 * As etiquetas podem chegar partidas entre fragmentos ("<thi" + "nk>").
 */
export interface ThinkFilter {
  push(chunk: string): { content: string; reasoning: string };
  flush(): { content: string; reasoning: string };
}

const OPEN = '<think>';
const CLOSE = '</think>';

export function createThinkFilter(): ThinkFilter {
  let inside = false;
  let pending = '';
  let atStart = true; // ignora espaços em branco antes da primeira etiqueta

  /** Quanto do fim de `s` pode ser o início de `tag` (para guardar e esperar). */
  const partialSuffix = (s: string, tag: string) => {
    for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
      if (tag.startsWith(s.slice(-n))) return n;
    }
    return 0;
  };

  function process(input: string, final: boolean) {
    let text = pending + input;
    pending = '';
    let content = '';
    let reasoning = '';
    while (text.length > 0) {
      const tag = inside ? CLOSE : OPEN;
      const idx = text.indexOf(tag);
      if (idx === -1) {
        const keep = final ? 0 : partialSuffix(text, tag);
        const out = text.slice(0, text.length - keep);
        pending = text.slice(text.length - keep);
        if (inside) reasoning += out;
        else content += out;
        break;
      }
      const before = text.slice(0, idx);
      if (inside) reasoning += before;
      else content += before;
      inside = !inside;
      text = text.slice(idx + tag.length);
      // Depois de fechar o raciocínio, remover a quebra de linha que o segue.
      if (!inside) text = text.replace(/^\s*\n/, '');
    }
    if (atStart && content) {
      const trimmed = content.replace(/^\s+/, '');
      if (trimmed) atStart = false;
      content = trimmed;
    }
    return { content, reasoning };
  }

  return {
    push: (chunk) => process(chunk, false),
    flush: () => process('', true),
  };
}
