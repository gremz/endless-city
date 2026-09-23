type TagOf<S extends string> = S extends `${infer T}.${string}`
  ? TagOf<T>
  : S extends `${infer T}#${string}`
    ? T
    : S;
type ElOf<S extends string> = TagOf<S> extends keyof HTMLElementTagNameMap
  ? HTMLElementTagNameMap[TagOf<S>]
  : HTMLDivElement;

/** Tiny DOM helper: el('button.btn.primary#go', { text: 'Go' }, children). The tag type is inferred from the spec. */
export function el<S extends string>(
  spec: S,
  props: Partial<Record<string, string>> = {},
  children: (Node | string)[] = [],
): ElOf<S> {
  const m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(spec);
  const node = document.createElement(m?.[1] || 'div');
  for (const part of (m?.[2] ?? '').match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '.') node.classList.add(part.slice(1));
    else node.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node as ElOf<S>;
}
