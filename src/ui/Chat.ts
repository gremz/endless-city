import { el } from './dom';

const KEEP = 6;
const SHOW_FOR = 10;

/** Co-op chat: recent lines fade out in the corner; Enter opens a line to type in. */
export class Chat {
  private root: HTMLDivElement;
  private log: HTMLDivElement;
  private field: HTMLInputElement;
  private lines: { node: HTMLDivElement; at: number }[] = [];
  open = false;

  constructor(
    parent: HTMLElement,
    private send: (text: string) => void,
    private onToggle: (open: boolean) => void,
  ) {
    this.log = el('div.chat-log');
    this.field = el('input.chat-input', { maxlength: '200', placeholder: 'Say something… (Enter to send, Esc to cancel)' });
    this.field.hidden = true;
    this.root = el('div.chat', {}, [this.log, this.field]);
    parent.append(this.root);
    this.field.addEventListener('keydown', (e) => {
      // Keep typing out of the game.
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.field.value.trim();
        if (text) this.send(text);
        this.close();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
    this.field.addEventListener('keyup', (e) => e.stopPropagation());
    this.field.addEventListener('blur', () => this.close());
  }

  add(from: string, text: string, now: number): void {
    const node = el('div.chat-line', {}, [el('span.chat-from', { text: `${from}: ` }), text]);
    this.log.append(node);
    this.lines.push({ node, at: now });
    while (this.lines.length > KEEP) this.lines.shift()!.node.remove();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.field.hidden = false;
    this.field.value = '';
    this.root.classList.add('open');
    this.onToggle(true);
    // After the Enter that opened it has been handled.
    setTimeout(() => this.field.focus(), 0);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.field.hidden = true;
    this.root.classList.remove('open');
    this.field.blur();
    this.onToggle(false);
  }

  /** Fade old lines (all stay visible while typing). */
  update(now: number): void {
    for (const l of this.lines) {
      const age = now - l.at;
      l.node.style.opacity = this.open ? '1' : String(Math.max(0, Math.min(1, (SHOW_FOR - age) / 2)));
    }
  }
}
