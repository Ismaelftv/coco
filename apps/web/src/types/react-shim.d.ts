/**
 * TEMPORÁRIO — declarações mínimas de tipos para React 19.
 *
 * Motivo: nesta sessão de desenvolvimento o registo npm estava inacessível e
 * `@types/react` / `@types/react-dom` não puderam ser instalados. Este ficheiro
 * cobre apenas a superfície de React usada pelo projeto, para que o
 * `tsc --noEmit` continue a verificar o código de domínio.
 *
 * Substituir por: `npm i -D @types/react @types/react-dom` e apagar este
 * ficheiro (registado em docs/04-pendentes.md).
 */

declare module 'react' {
  export type Key = string | number | bigint;
  export interface ReactElement<P = unknown> {
    type: unknown;
    props: P;
    key: string | null;
  }
  export type ReactNode =
    | ReactElement
    | string
    | number
    | bigint
    | boolean
    | null
    | undefined
    | Iterable<ReactNode>;

  export type SetStateAction<S> = S | ((prev: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export interface RefObject<T> {
    current: T;
  }
  export type RefCallback<T> = (instance: T | null) => void;
  export type Ref<T> = RefObject<T | null> | RefCallback<T> | null;
  export type DependencyList = readonly unknown[];
  export type EffectCallback = () => void | (() => void);

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, Dispatch<A>];
  export function useReducer<S, A, I>(
    reducer: (state: S, action: A) => S,
    initialArg: I,
    init: (arg: I) => S,
  ): [S, Dispatch<A>];
  export function useRef<T>(initial: T): RefObject<T>;
  export function useEffect(effect: EffectCallback, deps?: DependencyList): void;
  export function useLayoutEffect(effect: EffectCallback, deps?: DependencyList): void;
  export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: DependencyList): T;
  export function useMemo<T>(factory: () => T, deps: DependencyList): T;
  export function useId(): string;
  export function useDeferredValue<T>(value: T): T;
  export function useSyncExternalStore<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot?: () => T,
  ): T;

  export type FC<P = object> = (props: P) => ReactNode;
  export interface ProviderProps<T> {
    value: T;
    children?: ReactNode;
  }
  export interface Context<T> {
    Provider: FC<ProviderProps<T>>;
  }
  export function createContext<T>(defaultValue: T): Context<T>;
  export function useContext<T>(context: Context<T>): T;
  export function memo<P>(component: FC<P>): FC<P>;
  export const StrictMode: FC<{ children?: ReactNode }>;
  export const Fragment: FC<{ children?: ReactNode }>;

  // ----- Eventos -----
  export interface SyntheticEvent<T = Element, E = Event> {
    currentTarget: T;
    target: EventTarget;
    nativeEvent: E;
    defaultPrevented: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  }
  export interface KeyboardEvent<T = Element> extends SyntheticEvent<T, globalThis.KeyboardEvent> {
    key: string;
    code: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
  }
  export interface MouseEvent<T = Element> extends SyntheticEvent<T, globalThis.MouseEvent> {
    button: number;
  }
  export interface FocusEvent<T = Element> extends SyntheticEvent<T, globalThis.FocusEvent> {
    relatedTarget: EventTarget | null;
  }
  export interface ChangeEvent<T = Element> extends SyntheticEvent<T> {
    target: EventTarget & T;
  }
  export interface FormEvent<T = Element> extends SyntheticEvent<T> {}
  export interface DragEvent<T = Element> extends SyntheticEvent<T, globalThis.DragEvent> {
    dataTransfer: DataTransfer;
  }
  export interface ClipboardEvent<T = Element> extends SyntheticEvent<T, globalThis.ClipboardEvent> {
    clipboardData: DataTransfer;
  }
  export interface UIEvent<T = Element> extends SyntheticEvent<T, globalThis.UIEvent> {}

  type Handler<E> = (event: E) => void;

  export interface CSSProperties {
    [property: string]: string | number | undefined;
  }

  export interface DOMAttributes<T> {
    children?: ReactNode;
    dangerouslySetInnerHTML?: { __html: string };
    onClick?: Handler<MouseEvent<T>>;
    onMouseDown?: Handler<MouseEvent<T>>;
    onMouseEnter?: Handler<MouseEvent<T>>;
    onMouseLeave?: Handler<MouseEvent<T>>;
    onKeyDown?: Handler<KeyboardEvent<T>>;
    onKeyUp?: Handler<KeyboardEvent<T>>;
    onFocus?: Handler<FocusEvent<T>>;
    onBlur?: Handler<FocusEvent<T>>;
    onChange?: Handler<ChangeEvent<T>>;
    onInput?: Handler<FormEvent<T>>;
    onSubmit?: Handler<FormEvent<T>>;
    onScroll?: Handler<UIEvent<T>>;
    onDragOver?: Handler<DragEvent<T>>;
    onDragEnter?: Handler<DragEvent<T>>;
    onDragLeave?: Handler<DragEvent<T>>;
    onDrop?: Handler<DragEvent<T>>;
    onPaste?: Handler<ClipboardEvent<T>>;
    onCompositionStart?: Handler<SyntheticEvent<T>>;
    onCompositionEnd?: Handler<SyntheticEvent<T>>;
  }

  export interface AriaAttributes {
    [attribute: `aria-${string}`]: string | number | boolean | undefined;
  }

  export interface HTMLAttributes<T> extends DOMAttributes<T>, AriaAttributes {
    [attribute: `data-${string}`]: string | number | boolean | undefined;
    className?: string;
    id?: string;
    role?: string;
    style?: CSSProperties;
    tabIndex?: number;
    title?: string;
    hidden?: boolean;
    lang?: string;
    dir?: string;
    inert?: boolean;
    spellCheck?: boolean;
  }

  /** Atributos de formulário, ligação e media usados no projeto. */
  export interface AllHTMLAttributes<T> extends HTMLAttributes<T> {
    accept?: string;
    alt?: string;
    autoComplete?: string;
    autoFocus?: boolean;
    checked?: boolean;
    colSpan?: number;
    datetime?: string;
    dateTime?: string;
    disabled?: boolean;
    download?: string;
    form?: string;
    height?: number | string;
    href?: string;
    htmlFor?: string;
    max?: number | string;
    maxLength?: number;
    min?: number | string;
    multiple?: boolean;
    name?: string;
    placeholder?: string;
    readOnly?: boolean;
    rel?: string;
    required?: boolean;
    rows?: number;
    scope?: string;
    src?: string;
    start?: number;
    target?: string;
    type?: string;
    value?: string | number | readonly string[];
    width?: number | string;
    open?: boolean;
    align?: string;
  }

  export interface SVGAttributes<T> extends DOMAttributes<T>, AriaAttributes {
    className?: string;
    id?: string;
    role?: string;
    style?: CSSProperties;
    focusable?: boolean | 'true' | 'false';
    xmlns?: string;
    viewBox?: string;
    width?: number | string;
    height?: number | string;
    d?: string;
    fill?: string;
    fillRule?: string;
    clipRule?: string;
    stroke?: string;
    strokeWidth?: number | string;
    strokeLinecap?: 'butt' | 'round' | 'square';
    strokeLinejoin?: 'miter' | 'round' | 'bevel';
    opacity?: number | string;
    transform?: string;
    cx?: number | string;
    cy?: number | string;
    r?: number | string;
    rx?: number | string;
    x?: number | string;
    y?: number | string;
    x1?: number | string;
    x2?: number | string;
    y1?: number | string;
    y2?: number | string;
    points?: string;
    offset?: string;
    stopColor?: string;
    gradientUnits?: string;
  }

  export interface ClassAttributes<T> {
    key?: Key | null;
    ref?: Ref<T>;
  }
}

declare module 'react/jsx-runtime' {
  import type {
    AllHTMLAttributes,
    ClassAttributes,
    Key,
    ReactElement,
    ReactNode,
    SVGAttributes,
  } from 'react';

  type HTMLProps<T> = AllHTMLAttributes<T> & ClassAttributes<T>;
  type SVGProps<T> = SVGAttributes<T> & ClassAttributes<T>;

  export namespace JSX {
    type Element = ReactElement;
    /** Permite componentes que devolvem qualquer ReactNode (TS ≥ 5.1). */
    type ElementType = string | ((props: never) => ReactNode);
    interface ElementChildrenAttribute {
      children: object;
    }
    interface IntrinsicAttributes {
      key?: Key | null;
    }
    type IntrinsicElements = {
      [K in keyof HTMLElementTagNameMap]: HTMLProps<HTMLElementTagNameMap[K]>;
    } & {
      [K in Exclude<keyof SVGElementTagNameMap, keyof HTMLElementTagNameMap>]: SVGProps<
        SVGElementTagNameMap[K]
      >;
    };
  }
  export function jsx(type: unknown, props: unknown, key?: Key): ReactElement;
  export function jsxs(type: unknown, props: unknown, key?: Key): ReactElement;
  export const Fragment: (props: { children?: ReactNode }) => ReactNode;
}

declare module 'react-dom/client' {
  import type { ReactNode } from 'react';
  export interface Root {
    render(children: ReactNode): void;
    unmount(): void;
  }
  export function createRoot(container: Element | DocumentFragment): Root;
}
