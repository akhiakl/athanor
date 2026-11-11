import { render } from 'preact';
import type { App } from '../app/app';
import { HudView } from './Hud';
import type { Hud } from './hud';
import './hud.css';

export const mountHud = (el: HTMLElement, app: App, hud: Hud): void => render(<HudView app={app} hud={hud} />, el);
