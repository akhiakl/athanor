// The one PWA controller of this page.
import { createPwa } from './pwa';

export const pwa = createPwa(navigator as never, window);
