// The one prefs store of this page (one storage listener, one source of truth).
import { createPrefs } from './prefs';

export const prefsStore = createPrefs();
