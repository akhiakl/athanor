import { render } from 'preact';
import type { App } from '../app/app';
import { HudView } from './Hud';
import type { Pages } from '../app/pages';
import type { Session } from '../app/session';
import type { RenderClient } from '../render/client';
import type { Hud } from './hud';
import './hud.css';

export interface ExportContext { client: RenderClient; size: () => { w: number; h: number }; dpr: () => number; pages: Pages; session: Session; goHome: () => void }

export const mountHud = (el: HTMLElement, app: App, hud: Hud, exp: ExportContext): void => render(<HudView app={app} hud={hud} exp={exp} />, el);
