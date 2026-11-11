// The route this page load was opened with. Navigation between routes is a full page load, so it is fixed for the page's lifetime.
import { parseRoute } from './router';

export const route = parseRoute(location.pathname, location.search);
