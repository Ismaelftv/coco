/**
 * Escolha da sandbox. A ordem de preferência em `auto` é: contentor (se
 * disponível) → processo. O nível real é sempre confirmado por `probeSandbox`.
 */
import { ContainerSandbox, detectContainerEngine, type ContainerSandboxOptions } from './container-sandbox.ts';
import { probeSandbox, type IsolationVerdict } from './isolation.ts';
import { ProcessSandbox, type Sandbox } from './sandbox.ts';

export type SandboxChoice = 'auto' | 'container' | 'process';

export interface SandboxSelection {
  sandbox: Sandbox;
  verdict: IsolationVerdict;
  /** Motivos de alternativas descartadas (ex.: Docker indisponível). */
  skipped: string[];
}

export async function selectSandbox(choice: SandboxChoice = 'auto', container: ContainerSandboxOptions = { pull: true }): Promise<SandboxSelection> {
  const skipped: string[] = [];
  if (choice !== 'process') {
    const found = detectContainerEngine(container.engine);
    if (found.available) {
      try {
        const sandbox = ContainerSandbox.create({ engine: found.engine, ...container });
        return { sandbox, verdict: await probeSandbox(sandbox), skipped };
      } catch (e) {
        skipped.push((e as Error).message);
      }
    } else skipped.push(found.reason);
    if (choice === 'container') throw new Error(`Sandbox de contentor pedida mas indisponível: ${skipped.join('; ')}`);
  }
  const sandbox = new ProcessSandbox();
  return { sandbox, verdict: await probeSandbox(sandbox), skipped };
}
