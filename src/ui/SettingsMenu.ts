import { DEFAULT_SETTINGS, type Settings } from '../core/settings';
import { el } from './dom';

type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

/** Settings panel shown from the title/pause menu. Every change applies immediately and persists. */
export class SettingsMenu {
  readonly root: HTMLDivElement;
  private form: HTMLDivElement;

  constructor(
    parent: HTMLElement,
    private settings: Settings,
    private onChange: () => void,
    private onBack: () => void,
  ) {
    this.form = el('div.settings-form');
    const back = el('button.btn.primary', { text: 'Back' });
    back.addEventListener('click', () => this.onBack());
    const reset = el('button.btn', { text: 'Reset to defaults' });
    reset.addEventListener('click', () => {
      Object.assign(this.settings, DEFAULT_SETTINGS);
      this.build();
      this.onChange();
    });
    const panel = el('div.menu-panel.settings-panel', {}, [el('h2.settings-title', { text: 'SETTINGS' }), this.form, el('div.menu-buttons', {}, [back, reset])]);
    this.root = el('div.menu.settings', {}, [panel]);
    this.root.hidden = true;
    parent.append(this.root);
    this.build();
  }

  show(): void {
    this.build();
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  private slider(label: string, key: NumKey, min: number, max: number, step: number, fmt = (v: number) => String(v)): HTMLElement {
    const value = el('span.set-value', { text: fmt(this.settings[key] as number) });
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(this.settings[key]) });
    input.addEventListener('input', () => {
      (this.settings[key] as number) = Number(input.value);
      value.textContent = fmt(Number(input.value));
      this.onChange();
    });
    return el('label.set-row', {}, [el('span.set-label', { text: label }), input, value]);
  }

  private check(label: string, key: BoolKey): HTMLElement {
    const input = el('input', { type: 'checkbox' });
    input.checked = this.settings[key] as boolean;
    input.addEventListener('change', () => {
      (this.settings[key] as boolean) = input.checked;
      this.onChange();
    });
    return el('label.set-row', {}, [el('span.set-label', { text: label }), input]);
  }

  /** Drop-down for a setting with a fixed set of values. */
  private select<K extends keyof Settings>(label: string, key: K, options: readonly (readonly [Settings[K], string])[]): HTMLElement {
    const sel = el('select');
    options.forEach(([v, t], i) => {
      const o = el('option', { value: String(i), text: t });
      if (this.settings[key] === v) o.selected = true;
      sel.append(o);
    });
    sel.addEventListener('change', () => {
      this.settings[key] = options[Number(sel.value)][0];
      this.onChange();
    });
    return el('label.set-row', {}, [el('span.set-label', { text: label }), sel]);
  }

  private build(): void {
    const s = this.settings;
    const color = el('input', { type: 'color', value: s.crosshairColor });
    color.addEventListener('input', () => {
      s.crosshairColor = color.value;
      this.onChange();
    });
    this.form.replaceChildren(
      el('div.set-group', { text: 'Mouse' }),
      this.slider('Sensitivity (CS scale)', 'sensitivity', 0.2, 8, 0.05, (v) => v.toFixed(2)),
      this.slider('Zoom sensitivity ratio', 'zoomSensitivityRatio', 0.3, 2, 0.05, (v) => v.toFixed(2)),
      this.check('Invert mouse Y', 'invertY'),
      el('div.set-group', { text: 'View' }),
      this.slider('Field of view (4:3 horizontal)', 'fov', 75, 110, 1),
      this.slider('Viewmodel FOV', 'viewmodelFov', 54, 80, 1),
      el('div.set-group', { text: 'Crosshair' }),
      el('label.set-row', {}, [el('span.set-label', { text: 'Color' }), color]),
      this.slider('Size', 'crosshairSize', 2, 16, 1),
      this.slider('Gap', 'crosshairGap', 0, 12, 1),
      this.slider('Thickness', 'crosshairThickness', 1, 5, 1),
      this.check('Center dot', 'crosshairDot'),
      this.check('Dynamic (shows spread)', 'crosshairDynamic'),
      el('div.set-group', { text: 'Audio' }),
      this.slider('Master volume', 'masterVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this.slider('Effects volume', 'sfxVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this.slider('Music volume', 'musicVolume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      el('div.set-group', { text: 'Graphics' }),
      this.select('Shadows', 'shadows', [
        [0, 'Off'],
        [1024, 'Medium'],
        [2048, 'High'],
      ]),
      this.slider('Render scale', 'renderScale', 0.5, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      this.select('Rain particles', 'rainParticles', [
        [0, 'Off'],
        [0.5, 'Low'],
        [1, 'High'],
      ]),
      this.check('Show FPS / debug overlay', 'showFps'),
      el('div.set-group', { text: 'Gameplay' }),
      this.check('Auto bunny-hop (hold space)', 'autoBhop'),
      this.select('Time of day', 'timeOfDay', [
        ['cycle', 'Day/night cycle'],
        ['day', 'Always day'],
        ['night', 'Always night'],
      ]),
      this.select('Weather', 'weather', [
        ['dynamic', 'Changing'],
        ['clear', 'Always clear'],
      ]),
    );
  }
}
